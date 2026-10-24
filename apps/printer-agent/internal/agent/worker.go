package agent

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image/png"
	"log"
	"os"
	"os/exec"
	"runtime"
	"sort"
	"sync/atomic"
	"time"

	"github.com/quick-assistant/printer-agent/internal/api"
	"github.com/quick-assistant/printer-agent/internal/escpos"
)

// Server is the part of the API client the agent uses (an interface so tests can use a fake).
type Server interface {
	Poll(ctx context.Context, wait time.Duration) (*api.Work, error)
	Image(ctx context.Context, jobID string) ([]byte, error)
	JobResult(ctx context.Context, jobID string, ok bool, errMsg string) error
	CommandResult(ctx context.Context, id string, ok bool, output string) error
	Heartbeat(ctx context.Context, h api.Heartbeat) error
	LatestVersion(ctx context.Context) (*api.UpdateInfo, error)
}

// SetupControl is the local setup page as the worker sees it.
type SetupControl interface {
	// Enable opens the page for `d` and returns the PIN for this window.
	Enable(d time.Duration) (pin string)
	Port() string
}

// ErrRestart is returned by Run when the process should exit so systemd starts it again (restart command, update).
var ErrRestart = errors.New("restart requested")

type Agent struct {
	Cfg     Config
	Server  Server
	Dev     Devices
	State   *State
	Log     *LogBuf
	Version string
	Setup   SetupControl // may be nil
	Updater *Updater     // may be nil
	// Run executes a system command (reboot). Replaced in tests.
	Exec func(name string, args ...string) error

	PollWait       time.Duration
	HeartbeatEvery time.Duration
	UpdateEvery    time.Duration

	confirmed bool
	lastCheck time.Time
	lastOK    atomic.Int64 // unix nanoseconds of the last successful contact with the server
}

// OfflineFor is how long it has been since the server last answered (0 right after a success).
func (a *Agent) OfflineFor() time.Duration {
	t := a.lastOK.Load()
	if t == 0 {
		return 0
	}
	return time.Since(time.Unix(0, t))
}

func (a *Agent) defaults() {
	if a.PollWait == 0 {
		a.PollWait = 25 * time.Second
	}
	if a.HeartbeatEvery == 0 {
		a.HeartbeatEvery = 30 * time.Second
	}
	if a.UpdateEvery == 0 {
		a.UpdateEvery = 6 * time.Hour
	}
	if a.Exec == nil {
		a.Exec = func(name string, args ...string) error { return exec.Command(name, args...).Run() }
	}
	if a.State == nil {
		a.State = NewState(os.TempDir())
	}
	if a.Log == nil {
		a.Log = NewLogBuf(300)
	}
}

// Run is the agent's life: heartbeat in the background, long-poll for work in the foreground. It returns when the
// context ends, when the server revoked the token (api.ErrUnauthorized), or ErrRestart.
func (a *Agent) Run(ctx context.Context) error {
	a.defaults()
	hbCtx, stopHB := context.WithCancel(ctx)
	defer stopHB()
	go a.heartbeatLoop(hbCtx)

	a.lastOK.Store(time.Now().UnixNano())
	backoff := time.Second
	for ctx.Err() == nil {
		work, err := a.Server.Poll(ctx, a.PollWait)
		if err != nil {
			if errors.Is(err, api.ErrUnauthorized) {
				return err
			}
			if ctx.Err() != nil {
				break
			}
			log.Printf("poll failed: %v (retrying in %s)", err, backoff)
			sleep(ctx, backoff)
			backoff = min(backoff*2, 30*time.Second)
			continue
		}
		backoff = time.Second
		a.lastOK.Store(time.Now().UnixNano())
		if !a.confirmed {
			a.confirmed = true
			a.State.ConfirmUpdate() // talking to the server again: a self-update is proven
		}
		if work != nil {
			if err := a.handle(ctx, work); err != nil {
				return err
			}
		}
		if err := a.maybeUpdate(ctx); err != nil {
			return err
		}
	}
	return ctx.Err()
}

func (a *Agent) handle(ctx context.Context, w *api.Work) error {
	switch {
	case w.Type == "job" && w.Job != nil:
		a.handleJob(ctx, w.Job)
	case w.Type == "command" && w.Command != nil:
		return a.handleCommand(ctx, w.Command)
	default:
		log.Printf("ignoring unknown work type %q", w.Type)
	}
	return nil
}

func (a *Agent) pickDevice(want *string) (string, error) {
	if want != nil && *want != "" {
		if !ValidKey(*want) {
			return "", fmt.Errorf("bad device name %q", *want)
		}
		return *want, nil
	}
	if keys := a.Dev.List(); len(keys) > 0 {
		return keys[0], nil
	}
	return "", errors.New("no printer found (plug it in and switch it on)")
}

func (a *Agent) handleJob(ctx context.Context, j *api.Job) {
	if a.State.Printed(j.ID) {
		// the server lost our acknowledgement and handed the ticket out again: confirm, never print twice
		log.Printf("ticket %s was already printed; confirming", j.ID)
		_ = a.Server.JobResult(ctx, j.ID, true, "")
		return
	}
	fail := func(err error) {
		log.Printf("ticket %s (%s): %v", j.ID, j.Kind, err)
		_ = a.Server.JobResult(ctx, j.ID, false, err.Error())
	}
	key, err := a.pickDevice(j.Device)
	if err != nil {
		fail(err)
		return
	}
	raw, err := a.Server.Image(ctx, j.ID)
	if err != nil {
		fail(fmt.Errorf("download: %w", err))
		return
	}
	img, err := png.Decode(bytes.NewReader(raw))
	if err != nil {
		fail(fmt.Errorf("bad ticket picture: %w", err))
		return
	}
	one, err := escpos.Ticket(img, j.Kind == "new")
	if err != nil {
		fail(err)
		return
	}
	copies := min(max(j.Copies, 1), 3)
	if err := a.Dev.Write(key, bytes.Repeat(one, copies)); err != nil {
		fail(err)
		return
	}
	a.State.MarkPrinted(j.ID)
	log.Printf("printed ticket %s (%s) on %s, %d copy(ies)", j.ID, j.Kind, key, copies)
	if err := a.Server.JobResult(ctx, j.ID, true, ""); err != nil {
		log.Printf("could not confirm ticket %s (it is remembered and will not print twice): %v", j.ID, err)
	}
}

func (a *Agent) maybeUpdate(ctx context.Context) error {
	if a.Updater == nil || time.Since(a.lastCheck) < a.UpdateEvery {
		return nil
	}
	a.lastCheck = time.Now()
	v, err := a.Updater.Check(ctx)
	if err != nil {
		log.Printf("update check failed: %v", err)
		return nil
	}
	if v != "" {
		log.Printf("updated to %s; restarting", v)
		return ErrRestart
	}
	return nil
}

func (a *Agent) heartbeatLoop(ctx context.Context) {
	a.sendHeartbeat(ctx)
	t := time.NewTicker(a.HeartbeatEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			a.sendHeartbeat(ctx)
		}
	}
}

func (a *Agent) Heartbeat() api.Heartbeat {
	keys := a.Dev.List()
	ps := make([]api.PrinterStatus, 0, len(keys))
	for _, k := range keys {
		st := a.Dev.Status(k)
		p := api.PrinterStatus{Key: k, Error: st.Error}
		if st.Known || st.Online {
			on, po, co := st.Online, st.PaperOut, st.CoverOpen
			p.Online, p.PaperOut, p.CoverOpen = &on, &po, &co
		}
		ps = append(ps, p)
	}
	sort.Slice(ps, func(i, j int) bool { return ps[i].Key < ps[j].Key })
	return api.Heartbeat{
		Version: a.Version, Hostname: Hostname(), LanIP: LANIP(a.Cfg.Server), Printers: ps,
		Info: map[string]any{"os": runtime.GOOS, "arch": runtime.GOARCH, "go": runtime.Version(), "uptime_seconds": UptimeSeconds(), "devices": keys},
	}
}

func (a *Agent) sendHeartbeat(ctx context.Context) {
	if err := a.Server.Heartbeat(ctx, a.Heartbeat()); err != nil && ctx.Err() == nil {
		log.Printf("heartbeat failed: %v", err)
	}
}

func sleep(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}
