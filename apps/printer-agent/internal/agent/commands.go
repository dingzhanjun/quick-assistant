package agent

import (
	"bytes"
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/quick-assistant/printer-agent/internal/api"
	"github.com/quick-assistant/printer-agent/internal/escpos"
)

// The ONLY commands the agent obeys. The server has the same allow-list; anything else is refused here too, so a
// compromised server could still not make the agent run arbitrary programs.
var allowed = map[string]bool{
	"restart-agent": true, "test-print": true, "show-log": true, "update": true,
	"redetect-printers": true, "reboot": true, "setup-ticket": true,
}

const setupWindow = 15 * time.Minute

func (a *Agent) handleCommand(ctx context.Context, c *api.Command) error {
	log.Printf("service command: %s", c.Command)
	report := func(ok bool, out string) { _ = a.Server.CommandResult(ctx, c.ID, ok, out) }
	if !allowed[c.Command] {
		report(false, "unknown command")
		return nil
	}
	switch c.Command {
	case "restart-agent":
		report(true, "restarting")
		return ErrRestart
	case "show-log":
		report(true, a.Log.Tail(80))
	case "redetect-printers":
		a.sendHeartbeat(ctx)
		keys := a.Dev.List()
		report(true, fmt.Sprintf("%d printer(s): %s", len(keys), strings.Join(keys, ", ")))
	case "test-print":
		keys := a.Dev.List()
		if len(keys) == 0 {
			report(false, "no printer found")
			return nil
		}
		doc := escpos.NewDoc().
			Line("PRINT AGENT TEST", true, true, 2).
			Line("version "+a.Version, false, true, 1).
			Line("host "+Hostname(), false, true, 1).
			Line("ip "+LANIP(a.Cfg.Server), false, true, 1).
			Line(time.Now().Format("2006-01-02 15:04:05"), false, true, 1)
		if err := a.Dev.Write(keys[0], doc.Bytes()); err != nil {
			report(false, err.Error())
			return nil
		}
		report(true, "test ticket printed on "+keys[0])
	case "setup-ticket":
		keys := a.Dev.List()
		if len(keys) == 0 {
			report(false, "no printer found")
			return nil
		}
		if err := a.Dev.Write(keys[0], a.SetupTicket()); err != nil {
			report(false, err.Error())
			return nil
		}
		report(true, "setup ticket printed; the setup page is open for 15 minutes")
	case "update":
		if a.Updater == nil {
			report(false, "this agent cannot update itself")
			return nil
		}
		v, err := a.Updater.Check(ctx)
		switch {
		case err != nil:
			report(false, err.Error())
		case v == "":
			report(true, "already up to date ("+a.Version+")")
		default:
			report(true, "updated "+a.Version+" -> "+v+"; restarting")
			return ErrRestart
		}
	case "reboot":
		report(true, "rebooting the Pi")
		time.Sleep(time.Second)
		if err := a.Exec("sudo", "-n", "systemctl", "reboot"); err != nil {
			log.Printf("reboot failed: %v", err)
		}
	}
	return nil
}

// SetupTicket is the printed "where am I" ticket: address, version, pairing state, the PIN for the local setup page
// (valid 15 minutes, opens the page) and a QR code of its address. Holding it proves someone is at the printer.
func (a *Agent) SetupTicket() []byte {
	ip := LANIP(a.Cfg.Server)
	port := ":8080"
	pin := "------"
	if a.Setup != nil {
		pin = a.Setup.Enable(setupWindow)
		port = ":" + a.Setup.Port()
	}
	state := "NOT PAIRED"
	if a.Cfg.Token != "" {
		state = "paired: " + a.Cfg.Restaurant
	}
	url := "https://" + ip + port
	var b bytes.Buffer
	b.Write(escpos.NewDoc().
		Line("PRINTER SETUP", true, true, 2).
		Line("host: "+Hostname(), false, false, 1).
		Line("ip:   "+ip, false, false, 1).
		Line("version: "+a.Version, false, false, 1).
		Line(state, true, false, 1).
		Line("", false, false, 1).
		Line("Setup page:", false, false, 1).
		Line(url, false, false, 1).
		Line("PIN: "+pin, true, true, 2).
		Line("(valid 15 minutes)", false, true, 1).
		QR(url).Bytes())
	return b.Bytes()
}
