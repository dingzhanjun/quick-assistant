// order-printer is the kitchen print agent: a small program on a Raspberry Pi (or any Linux box) next to a USB receipt
// printer. It only ever connects OUTWARD to the restaurant platform (HTTPS long-poll), downloads each ticket as a
// picture and prints it. See PRINTING_PLAN.md.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/quick-assistant/printer-agent/internal/agent"
	"github.com/quick-assistant/printer-agent/internal/api"
	"github.com/quick-assistant/printer-agent/internal/escpos"
	"github.com/quick-assistant/printer-agent/internal/setup"
)

// set at build time: -ldflags "-X main.version=1.2.3"
var version = "dev"

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

var (
	configPath = env("ORDER_PRINTER_CONFIG", "/etc/order-printer/config.json")
	stateDir   = env("ORDER_PRINTER_STATE", "/var/lib/order-printer")
	devices    = agent.Devices{Dir: env("ORDER_PRINTER_DEV_DIR", "/dev/usb")}
	setupPort  = env("ORDER_PRINTER_PORT", "8080")
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	switch os.Args[1] {
	case "run":
		os.Exit(run())
	case "pair":
		os.Exit(pairCmd(os.Args[2:]))
	case "detect":
		keys := devices.List()
		if len(keys) == 0 {
			fmt.Println("no printer found under", devices.Dir)
			os.Exit(1)
		}
		for _, k := range keys {
			fmt.Println(k)
		}
	case "test":
		os.Exit(testCmd())
	case "version", "--version":
		fmt.Println(version)
	default:
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `order-printer `+version+`
  order-printer pair <CODE> --server <URL>   pair with the restaurant account (code from Settings -> Kitchen printing)
  order-printer run                          run the agent (the systemd service does this)
  order-printer detect                       list USB printers found
  order-printer test                         print a local test ticket
  order-printer version
`)
}

// pairWith exchanges the code for the agent token and writes the config.
func pairWith(ctx context.Context, server, code string) (*agent.Config, error) {
	var devs []api.PairDevice
	for _, k := range devices.List() {
		devs = append(devs, api.PairDevice{Key: k})
	}
	client := api.New(server, "")
	res, err := client.Pair(ctx, api.PairRequest{Code: code, Version: version, Hostname: agent.Hostname(), LanIP: agent.LANIP(server), Devices: devs})
	if err != nil {
		return nil, err
	}
	cfg := &agent.Config{Server: strings.TrimRight(server, "/"), Token: res.Token, AgentID: res.AgentID, Restaurant: res.Restaurant}
	if err := cfg.Save(configPath); err != nil {
		return nil, fmt.Errorf("paired, but could not save %s: %w", configPath, err)
	}
	return cfg, nil
}

func pairCmd(args []string) int {
	fs := flag.NewFlagSet("pair", flag.ExitOnError)
	server := fs.String("server", os.Getenv("ORDER_PRINTER_SERVER"), "server address, e.g. https://orders.example.com")
	// the code comes first (order-printer pair CODE --server URL); flags may follow it
	var code string
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		code, args = args[0], args[1:]
	}
	_ = fs.Parse(args)
	if code == "" && fs.NArg() > 0 {
		code = fs.Arg(0)
	}
	if code == "" || *server == "" {
		fmt.Fprintln(os.Stderr, "usage: order-printer pair <CODE> --server <URL>")
		return 2
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cfg, err := pairWith(ctx, *server, code)
	if err != nil {
		fmt.Fprintln(os.Stderr, "pairing failed:", err)
		return 1
	}
	fmt.Printf("paired with %s (%d printer(s) found). Start the agent: sudo systemctl restart order-printer\n", cfg.Restaurant, len(devices.List()))
	return 0
}

func testCmd() int {
	keys := devices.List()
	if len(keys) == 0 {
		fmt.Fprintln(os.Stderr, "no printer found under", devices.Dir)
		return 1
	}
	doc := escpos.NewDoc().Line("PRINTER TEST", true, true, 2).Line("order-printer "+version, false, true, 1).Line("host "+agent.Hostname(), false, true, 1)
	if err := devices.Write(keys[0], doc.Bytes()); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	fmt.Println("test ticket sent to", keys[0])
	return 0
}

// run: the long-lived service. Without a config it is UNPAIRED: it prints a setup ticket and keeps the local setup page
// open until someone pairs it (through that page or `order-printer pair`).
func run() int {
	logs := agent.NewLogBuf(300)
	log.SetOutput(io.MultiWriter(os.Stderr, logs))
	log.SetFlags(log.LstdFlags)
	log.Printf("order-printer %s starting (%s/%s)", version, runtime.GOOS, runtime.GOARCH)

	state := agent.NewState(stateDir)
	exe, _ := os.Executable()
	if state.StartupCheck(exe) {
		log.Printf("the updated agent never reached the server; restored the previous version")
		return 1
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	var mu sync.Mutex
	var current *agent.Agent
	var cfgNow *agent.Config
	repair := make(chan struct{}, 1) // a new config was written: restart the worker with it

	srv := setup.New(setupPort)
	srv.AlwaysOn = func() bool {
		mu.Lock()
		defer mu.Unlock()
		return current == nil || cfgNow == nil || current.OfflineFor() > 3*time.Minute
	}
	srv.Status = func() setup.Status {
		mu.Lock()
		defer mu.Unlock()
		st := setup.Status{Version: version, Hostname: agent.Hostname(), Printers: devices.List()}
		if cfgNow != nil {
			st.Paired, st.Restaurant, st.Server = true, cfgNow.Restaurant, cfgNow.Server
			st.IP = agent.LANIP(cfgNow.Server)
		} else {
			st.IP = agent.LANIP("")
		}
		return st
	}
	srv.Pair = func(code, server string) error {
		c, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		if _, err := pairWith(c, server, code); err != nil {
			return err
		}
		select {
		case repair <- struct{}{}:
		default:
		}
		return nil
	}
	srv.WiFi = func(ssid, pass string) error {
		c, cancel := context.WithTimeout(ctx, 60*time.Second)
		defer cancel()
		out, err := exec.CommandContext(c, "sudo", "-n", "nmcli", "dev", "wifi", "connect", ssid, "password", pass).CombinedOutput()
		if err != nil {
			return errors.New(strings.TrimSpace(string(out)))
		}
		return nil
	}
	srv.TestPrint = func() error {
		keys := devices.List()
		if len(keys) == 0 {
			return errors.New("no printer found")
		}
		return devices.Write(keys[0], escpos.NewDoc().Line("PRINTER TEST", true, true, 2).Line("host "+agent.Hostname(), false, true, 1).Bytes())
	}
	go func() {
		if err := srv.ListenAndServe(ctx); err != nil {
			log.Printf("local setup page not available: %v", err)
		}
	}()

	ticketPrinted := false
	for ctx.Err() == nil {
		cfg, err := agent.LoadConfig(configPath)
		if err != nil {
			// UNPAIRED: print the setup ticket once, then wait for pairing
			mu.Lock()
			cfgNow, current = nil, nil
			mu.Unlock()
			log.Printf("not paired (%v). Waiting for pairing: run `order-printer pair <CODE> --server <URL>` or open the setup page on port %s", err, setupPort)
			if !ticketPrinted { // once per unpaired period, not every 10 s
				ticketPrinted = true
				printSetupTicket(srv, version)
			}
			select {
			case <-ctx.Done():
			case <-repair:
			case <-time.After(10 * time.Second): // also notice a config written by the CLI
			}
			continue
		}
		ticketPrinted = false
		client := api.New(cfg.Server, cfg.Token)
		a := &agent.Agent{
			Cfg: *cfg, Server: client, Dev: devices, State: state, Log: logs, Version: version, Setup: srv,
			Updater: &agent.Updater{Server: client, HTTP: agent.DefaultHTTP(), Exe: exe, Version: version, Arch: runtime.GOARCH, State: state},
		}
		mu.Lock()
		cfgNow, current = cfg, a
		mu.Unlock()
		log.Printf("paired with %s; running", cfg.Restaurant)

		runCtx, cancel := context.WithCancel(ctx)
		go func() {
			select {
			case <-repair:
				cancel() // re-paired from the setup page: restart with the new token
			case <-runCtx.Done():
			}
		}()
		err = a.Run(runCtx)
		cancel()
		switch {
		case errors.Is(err, agent.ErrRestart):
			return 0 // systemd starts us again (restart command, or the new version after an update)
		case errors.Is(err, api.ErrUnauthorized):
			log.Printf("the server revoked this agent. Pair it again with a new code.")
			_ = os.Rename(configPath, configPath+".revoked")
		case ctx.Err() != nil:
			return 0
		}
	}
	return 0
}

func printSetupTicket(srv *setup.Server, version string) {
	keys := devices.List()
	if len(keys) == 0 {
		return
	}
	pin := srv.Enable(24 * time.Hour)
	ip := agent.LANIP("")
	url := "https://" + ip + ":" + srv.Port()
	data := escpos.NewDoc().
		Line("PRINTER SETUP", true, true, 2).
		Line("host: "+agent.Hostname(), false, false, 1).
		Line("ip:   "+ip, false, false, 1).
		Line("version: "+version, false, false, 1).
		Line("NOT PAIRED", true, false, 1).
		Line("Setup page:", false, false, 1).
		Line(url, false, false, 1).
		Line("PIN: "+pin, true, true, 2).
		QR(url).Bytes()
	if err := devices.Write(keys[0], data); err != nil {
		log.Printf("could not print the setup ticket: %v", err)
	}
}
