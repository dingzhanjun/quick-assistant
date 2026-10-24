package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/quick-assistant/printer-agent/internal/api"
	"github.com/quick-assistant/printer-agent/internal/escpos"
)

// fakeServer speaks the print protocol of the web app (see apps/web/src/app/api/print): a queue of work, ticket
// pictures, and a record of every result, command result and heartbeat the agent sent.
type fakeServer struct {
	t  *testing.T
	ts *httptest.Server

	mu         sync.Mutex
	queue      []api.Work
	images     map[string][]byte
	jobResults map[string][]string // job id -> "ok" | "fail: msg"
	cmdResults map[string][]string
	heartbeats []api.Heartbeat
	created    time.Time
	unauth     bool
	version    *api.UpdateInfo
}

func newFake(t *testing.T) *fakeServer {
	f := &fakeServer{t: t, created: time.Now(), images: map[string][]byte{}, jobResults: map[string][]string{}, cmdResults: map[string][]string{}}
	f.ts = httptest.NewServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.ts.Close)
	return f
}

func (f *fakeServer) handle(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.unauth || r.Header.Get("authorization") != "Bearer opa_test" {
		w.WriteHeader(401)
		return
	}
	p := r.URL.Path
	switch {
	case p == "/api/print/poll":
		// Work is served only after the agent's startup heartbeat has arrived. A real printer is a device file: the status
		// queries in that heartbeat simply go to the device. Here a plain file stands in for it, and a query written AFTER
		// a ticket would land over the start of that ticket (the heartbeat runs concurrently with the first poll, so that
		// happened now and then on slow CI machines). The heartbeat is only POSTed once its status queries are done. (If a
		// test makes the server fail, no heartbeat is recorded: then work is served after a short grace period instead.)
		if len(f.queue) == 0 || (len(f.heartbeats) == 0 && time.Since(f.created) < 750*time.Millisecond) {
			f.mu.Unlock()
			time.Sleep(20 * time.Millisecond)
			f.mu.Lock()
			w.WriteHeader(204)
			return
		}
		next := f.queue[0]
		f.queue = f.queue[1:]
		_ = json.NewEncoder(w).Encode(next)
	case strings.HasSuffix(p, "/image"):
		id := strings.Split(p, "/")[4]
		img, ok := f.images[id]
		if !ok {
			w.WriteHeader(404)
			return
		}
		w.Header().Set("content-type", "image/png")
		_, _ = w.Write(img)
	case strings.HasPrefix(p, "/api/print/jobs/") && strings.HasSuffix(p, "/result"):
		id := strings.Split(p, "/")[4]
		var b struct {
			OK    bool   `json:"ok"`
			Error string `json:"error"`
		}
		_ = json.NewDecoder(r.Body).Decode(&b)
		if b.OK {
			f.jobResults[id] = append(f.jobResults[id], "ok")
		} else {
			f.jobResults[id] = append(f.jobResults[id], "fail: "+b.Error)
		}
	case strings.HasPrefix(p, "/api/print/commands/") && strings.HasSuffix(p, "/result"):
		id := strings.Split(p, "/")[4]
		var b struct {
			OK     bool   `json:"ok"`
			Output string `json:"output"`
		}
		_ = json.NewDecoder(r.Body).Decode(&b)
		s := "fail: " + b.Output
		if b.OK {
			s = "ok: " + b.Output
		}
		f.cmdResults[id] = append(f.cmdResults[id], s)
	case p == "/api/print/heartbeat":
		var h api.Heartbeat
		_ = json.NewDecoder(r.Body).Decode(&h)
		f.heartbeats = append(f.heartbeats, h)
	case p == "/api/print/update":
		if f.version == nil {
			w.WriteHeader(204)
			return
		}
		_ = json.NewEncoder(w).Encode(f.version)
	default:
		w.WriteHeader(404)
	}
}

func (f *fakeServer) push(w api.Work) { f.mu.Lock(); f.queue = append(f.queue, w); f.mu.Unlock() }

func (f *fakeServer) jobResult(id string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.jobResults[id]...)
}
func (f *fakeServer) cmdResult(id string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.cmdResults[id]...)
}

func ticketPNG(t *testing.T) []byte {
	g := image.NewGray(image.Rect(0, 0, 16, 4))
	for i := range g.Pix {
		g.Pix[i] = 255
	}
	g.SetGray(1, 1, color.Gray{0})
	var b bytes.Buffer
	if err := png.Encode(&b, g); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

type env struct {
	f      *fakeServer
	a      *Agent
	devDir string
	lp0    string
	exec   [][]string
}

func newEnv(t *testing.T) *env {
	f := newFake(t)
	dir := t.TempDir()
	lp0 := filepath.Join(dir, "lp0")
	if err := os.WriteFile(lp0, nil, 0o644); err != nil { // a plain file stands in for /dev/usb/lp0
		t.Fatal(err)
	}
	e := &env{f: f, devDir: dir, lp0: lp0}
	e.a = &Agent{
		Cfg: Config{Server: f.ts.URL, Token: "opa_test"}, Server: api.New(f.ts.URL, "opa_test"), Dev: Devices{Dir: dir},
		State: NewState(t.TempDir()), Log: NewLogBuf(100), Version: "1.0.0",
		PollWait: time.Second, HeartbeatEvery: time.Hour,
		Exec: func(name string, args ...string) error {
			e.exec = append(e.exec, append([]string{name}, args...))
			return nil
		},
	}
	return e
}

// printed is what reached the "printer", without the status queries the heartbeat also sends to it.
func (e *env) printed() []byte {
	b, _ := os.ReadFile(e.lp0)
	return bytes.ReplaceAll(b, escpos.StatusQueries(), nil)
}

// runUntil runs the agent until cond is true (or fails after 5 s), then stops it.
func (e *env) runUntil(t *testing.T, cond func() bool) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- e.a.Run(ctx) }()
	deadline := time.After(5 * time.Second)
	for !cond() {
		select {
		case err := <-done:
			return err
		case <-deadline:
			cancel()
			t.Fatal("timed out waiting for the agent")
		case <-time.After(10 * time.Millisecond):
		}
	}
	cancel()
	<-done
	return nil
}

func job(id, kind string, copies int, dev string) api.Work {
	return api.Work{Type: "job", Job: &api.Job{ID: id, Kind: kind, Copies: copies, Device: &dev, Printer: "Kitchen"}}
}

func TestPrintsATicketAndConfirmsIt(t *testing.T) {
	e := newEnv(t)
	e.f.images["j1"] = ticketPNG(t)
	e.f.push(job("j1", "new", 1, "lp0"))
	e.runUntil(t, func() bool { return len(e.f.jobResult("j1")) > 0 })

	img, _ := png.Decode(bytes.NewReader(ticketPNG(t)))
	want, _ := escpos.Ticket(img, true)
	if !bytes.Equal(e.printed(), want) {
		t.Fatalf("printer got % x\nwant % x", e.printed(), want)
	}
	if got := e.f.jobResult("j1"); len(got) != 1 || got[0] != "ok" {
		t.Fatalf("results %v", got)
	}
}

func TestCopiesAreCappedAtThree(t *testing.T) {
	e := newEnv(t)
	e.f.images["j"] = ticketPNG(t)
	e.f.push(job("j", "reprint", 9, "lp0"))
	e.runUntil(t, func() bool { return len(e.f.jobResult("j")) > 0 })
	img, _ := png.Decode(bytes.NewReader(ticketPNG(t)))
	one, _ := escpos.Ticket(img, false)
	if !bytes.Equal(e.printed(), bytes.Repeat(one, 3)) {
		t.Fatalf("expected 3 copies, got %d bytes (one copy is %d)", len(e.printed()), len(one))
	}
}

func TestNeverPrintsTheSameTicketTwice(t *testing.T) {
	e := newEnv(t)
	e.f.images["dup"] = ticketPNG(t)
	e.f.push(job("dup", "new", 1, "lp0"))
	e.f.push(job("dup", "new", 1, "lp0")) // the server lost our acknowledgement and hands it out again
	e.runUntil(t, func() bool { return len(e.f.jobResult("dup")) >= 2 })
	img, _ := png.Decode(bytes.NewReader(ticketPNG(t)))
	one, _ := escpos.Ticket(img, true)
	if !bytes.Equal(e.printed(), one) {
		t.Fatalf("printed %d bytes, want exactly one ticket (%d)", len(e.printed()), len(one))
	}
	if got := e.f.jobResult("dup"); len(got) != 2 || got[1] != "ok" {
		t.Fatalf("results %v", got)
	}
}

func TestRememberedAcrossRestarts(t *testing.T) {
	dir := t.TempDir()
	NewState(dir).MarkPrinted("abc")
	if !NewState(dir).Printed("abc") {
		t.Fatal("a restart forgot a printed ticket")
	}
}

func TestFailuresAreReported(t *testing.T) {
	e := newEnv(t)
	e.f.images["missing-printer"] = ticketPNG(t)
	e.f.push(job("missing-printer", "new", 1, "lp7")) // no such device
	e.f.push(api.Work{Type: "job", Job: &api.Job{ID: "no-image", Kind: "new", Copies: 1}})
	e.f.images["bad-png"] = []byte("not a png")
	e.f.push(job("bad-png", "new", 1, "lp0"))
	e.f.push(job("traversal", "new", 1, "../../etc/passwd"))
	e.runUntil(t, func() bool {
		return len(e.f.jobResult("missing-printer")) > 0 && len(e.f.jobResult("no-image")) > 0 && len(e.f.jobResult("bad-png")) > 0 && len(e.f.jobResult("traversal")) > 0
	})
	for id, frag := range map[string]string{"missing-printer": "not found", "no-image": "download", "bad-png": "bad ticket picture", "traversal": "bad device name"} {
		got := e.f.jobResult(id)
		if len(got) != 1 || !strings.HasPrefix(got[0], "fail:") || !strings.Contains(got[0], frag) {
			t.Errorf("%s: %v (want a failure mentioning %q)", id, got, frag)
		}
	}
	if len(e.printed()) != 0 {
		t.Fatal("something was printed")
	}
	if e.a.State.Printed("bad-png") {
		t.Fatal("a failed ticket was remembered as printed")
	}
}

func TestDefaultsToTheFirstPrinterWhenTheServerNamesNone(t *testing.T) {
	e := newEnv(t)
	e.f.images["j"] = ticketPNG(t)
	e.f.push(api.Work{Type: "job", Job: &api.Job{ID: "j", Kind: "new", Copies: 1}})
	e.runUntil(t, func() bool { return len(e.f.jobResult("j")) > 0 })
	if len(e.printed()) == 0 {
		t.Fatal("nothing printed")
	}
}

func command(id, c string) api.Work {
	return api.Work{Type: "command", Command: &api.Command{ID: id, Command: c}}
}

func TestCommands(t *testing.T) {
	e := newEnv(t)
	e.a.Log.Write([]byte("first line\nsecond line\n"))
	e.f.push(command("log", "show-log"))
	e.f.push(command("redetect", "redetect-printers"))
	e.f.push(command("test", "test-print"))
	e.f.push(command("evil", "rm -rf /"))
	e.f.push(command("sh", "sh"))
	e.f.push(command("reboot", "reboot"))
	e.runUntil(t, func() bool { return len(e.f.cmdResult("reboot")) > 0 })

	if got := e.f.cmdResult("log"); len(got) != 1 || !strings.Contains(got[0], "second line") {
		t.Errorf("show-log: %v", got)
	}
	if got := e.f.cmdResult("redetect"); len(got) != 1 || !strings.Contains(got[0], "lp0") {
		t.Errorf("redetect: %v", got)
	}
	if got := e.f.cmdResult("test"); len(got) != 1 || !strings.HasPrefix(got[0], "ok") || !bytes.Contains(e.printed(), []byte("PRINT AGENT TEST")) {
		t.Errorf("test-print: %v / %q", got, e.printed())
	}
	for _, id := range []string{"evil", "sh"} {
		if got := e.f.cmdResult(id); len(got) != 1 || got[0] != "fail: unknown command" {
			t.Errorf("%s was not refused: %v", id, got)
		}
	}
	if len(e.exec) != 1 || strings.Join(e.exec[0], " ") != "sudo -n systemctl reboot" {
		t.Errorf("reboot ran %v", e.exec)
	}
}

func TestRestartCommandStopsTheLoop(t *testing.T) {
	e := newEnv(t)
	e.f.push(command("r", "restart-agent"))
	err := e.runUntil(t, func() bool { return false })
	if !errors.Is(err, ErrRestart) {
		t.Fatalf("got %v", err)
	}
	if got := e.f.cmdResult("r"); len(got) != 1 || !strings.HasPrefix(got[0], "ok") {
		t.Fatalf("result %v", got)
	}
}

func TestSetupTicketCommandOpensTheSetupPage(t *testing.T) {
	e := newEnv(t)
	sc := &fakeSetup{}
	e.a.Setup = sc
	e.f.push(command("s", "setup-ticket"))
	e.runUntil(t, func() bool { return len(e.f.cmdResult("s")) > 0 })
	if sc.opened != setupWindow {
		t.Fatalf("setup page opened for %v", sc.opened)
	}
	p := e.printed()
	if !bytes.Contains(p, []byte("PRINTER SETUP")) || !bytes.Contains(p, []byte("PIN: 123456")) || !bytes.Contains(p, []byte("paired")) {
		t.Fatalf("setup ticket: %q", p)
	}
}

type fakeSetup struct{ opened time.Duration }

func (f *fakeSetup) Enable(d time.Duration) string { f.opened = d; return "123456" }
func (f *fakeSetup) Port() string                  { return "8080" }

func TestHeartbeatReportsThePrintersAndTheMachine(t *testing.T) {
	e := newEnv(t)
	_ = os.WriteFile(filepath.Join(e.devDir, "lp1"), nil, 0o644)
	_ = os.WriteFile(filepath.Join(e.devDir, "notaprinter"), nil, 0o644)
	e.runUntil(t, func() bool { e.f.mu.Lock(); defer e.f.mu.Unlock(); return len(e.f.heartbeats) > 0 })
	hb := e.f.heartbeats[0]
	if hb.Version != "1.0.0" || hb.Hostname == "" || len(hb.Printers) != 2 || hb.Printers[0].Key != "lp0" || hb.Printers[1].Key != "lp1" {
		t.Fatalf("%+v", hb)
	}
	if hb.Printers[0].Online == nil || !*hb.Printers[0].Online {
		t.Fatalf("a printer that accepted the open should be online: %+v", hb.Printers[0])
	}
}

func TestRevokedTokenStopsTheAgent(t *testing.T) {
	e := newEnv(t)
	e.f.unauth = true
	err := e.runUntil(t, func() bool { return false })
	if !errors.Is(err, api.ErrUnauthorized) {
		t.Fatalf("got %v", err)
	}
}

func TestServerOutageIsRiddenOut(t *testing.T) {
	e := newEnv(t)
	e.f.images["late"] = ticketPNG(t)
	e.f.ts.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) })
	go func() {
		time.Sleep(1500 * time.Millisecond)
		e.f.ts.Config.Handler = http.HandlerFunc(e.f.handle)
		e.f.push(job("late", "new", 1, "lp0"))
	}()
	e.runUntil(t, func() bool { return len(e.f.jobResult("late")) > 0 })
}

func TestDeviceNamesAreValidated(t *testing.T) {
	for _, bad := range []string{"", "lp", "../lp0", "lp0/../../x", "lp0 ", "LP0", "lp123", "/dev/usb/lp0"} {
		if ValidKey(bad) {
			t.Errorf("%q accepted", bad)
		}
	}
	for _, ok := range []string{"lp0", "lp1", "lp12"} {
		if !ValidKey(ok) {
			t.Errorf("%q refused", ok)
		}
	}
	d := Devices{Dir: t.TempDir()}
	if err := d.Write("../x", []byte("x")); err == nil {
		t.Fatal("path traversal accepted")
	}
}

func TestLogBufKeepsTheLastLines(t *testing.T) {
	l := NewLogBuf(3)
	for _, s := range []string{"a\n", "b\nc", "\nd\ne\n"} {
		l.Write([]byte(s))
	}
	if got := l.Tail(10); got != "c\nd\ne" {
		t.Fatalf("%q", got)
	}
	if got := l.Tail(2); got != "d\ne" {
		t.Fatalf("%q", got)
	}
}

func TestConfigIsPrivate(t *testing.T) {
	p := filepath.Join(t.TempDir(), "sub", "config.json")
	if err := (Config{Server: "https://x", Token: "opa_secret"}).Save(p); err != nil {
		t.Fatal(err)
	}
	st, _ := os.Stat(p)
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("config mode %v", st.Mode().Perm())
	}
	c, err := LoadConfig(p)
	if err != nil || c.Token != "opa_secret" {
		t.Fatalf("%v %+v", err, c)
	}
}
