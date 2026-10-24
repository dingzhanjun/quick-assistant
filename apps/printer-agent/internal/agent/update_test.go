package agent

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/quick-assistant/printer-agent/internal/api"
)

func TestNewer(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want bool
	}{
		{"1.0.1", "1.0.0", true}, {"v1.2.0", "1.1.9", true}, {"1.0.0", "1.0.0", false}, {"1.0.0", "1.0.1", false},
		{"2.0", "1.9.9", true}, {"1.0.0", "dev", false}, {"1.0.0", "", false}, {"1.10.0", "1.9.0", true},
	} {
		if got := Newer(c.a, c.b); got != c.want {
			t.Errorf("Newer(%q, %q) = %v", c.a, c.b, got)
		}
	}
}

// release serves order-printer-linux-<arch> and its .sha256 like the GitHub release does.
func release(t *testing.T, arch string, bin []byte, sum string) *httptest.Server {
	if sum == "" {
		h := sha256.Sum256(bin)
		sum = hex.EncodeToString(h[:])
	}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/rel/order-printer-linux-" + arch:
			_, _ = w.Write(bin)
		case "/rel/order-printer-linux-" + arch + ".sha256":
			_, _ = w.Write([]byte(sum + "  order-printer-linux-" + arch + "\n"))
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(ts.Close)
	return ts
}

func updaterFor(t *testing.T, base string, version string) (*Updater, string, *fakeServer) {
	f := newFake(t)
	f.version = &api.UpdateInfo{Version: version, BaseURL: base + "/rel"}
	exe := filepath.Join(t.TempDir(), "order-printer")
	if err := os.WriteFile(exe, []byte("old binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	return &Updater{Server: api.New(f.ts.URL, "opa_test"), HTTP: http.DefaultClient, Exe: exe, Version: "1.0.0", Arch: "arm64", State: NewState(t.TempDir())}, exe, f
}

func TestUpdateInstallsAVerifiedBinaryAndKeepsTheOldOne(t *testing.T) {
	newBin := bytes.Repeat([]byte("N"), 2<<20)
	rel := release(t, "arm64", newBin, "")
	u, exe, _ := updaterFor(t, rel.URL, "1.1.0")
	v, err := u.Check(context.Background())
	if err != nil || v != "1.1.0" {
		t.Fatalf("v=%q err=%v", v, err)
	}
	got, _ := os.ReadFile(exe)
	if !bytes.Equal(got, newBin) {
		t.Fatal("binary not replaced")
	}
	if prev, _ := os.ReadFile(exe + ".prev"); string(prev) != "old binary" {
		t.Fatal("previous binary not kept")
	}
	if st, _ := os.Stat(exe); st.Mode().Perm()&0o100 == 0 {
		t.Fatal("new binary is not executable")
	}
	if _, err := os.Stat(u.State.markerPath()); err != nil {
		t.Fatal("update is not marked as unproven")
	}
}

func TestUpdateRefusesABadChecksum(t *testing.T) {
	rel := release(t, "arm64", bytes.Repeat([]byte("N"), 2<<20), "0000000000000000000000000000000000000000000000000000000000000000")
	u, exe, _ := updaterFor(t, rel.URL, "1.1.0")
	if v, err := u.Check(context.Background()); err == nil || v != "" {
		t.Fatalf("v=%q err=%v", v, err)
	}
	if got, _ := os.ReadFile(exe); string(got) != "old binary" {
		t.Fatal("binary was replaced despite a bad checksum")
	}
}

func TestUpdateRefusesATinyFile(t *testing.T) {
	rel := release(t, "arm64", []byte("<html>404 page</html>"), "")
	u, exe, _ := updaterFor(t, rel.URL, "1.1.0")
	if _, err := u.Check(context.Background()); err == nil {
		t.Fatal("a 20-byte file was installed")
	}
	if got, _ := os.ReadFile(exe); string(got) != "old binary" {
		t.Fatal("binary replaced")
	}
}

func TestNoUpdateWhenCurrentOrNotConfigured(t *testing.T) {
	rel := release(t, "arm64", bytes.Repeat([]byte("N"), 2<<20), "")
	u, _, _ := updaterFor(t, rel.URL, "1.0.0")
	if v, err := u.Check(context.Background()); v != "" || err != nil {
		t.Fatalf("v=%q err=%v", v, err)
	}
	u2, _, f := updaterFor(t, rel.URL, "9.9.9")
	f.version = nil
	if v, err := u2.Check(context.Background()); v != "" || err != nil {
		t.Fatalf("v=%q err=%v", v, err)
	}
}

func TestUpdateOnlyOverHTTPS(t *testing.T) {
	if _, err := safeBase("http://evil.example.com/rel"); err == nil {
		t.Fatal("plain http accepted")
	}
	if _, err := safeBase("https://github.com/x/releases/download/v1"); err != nil {
		t.Fatal(err)
	}
	if _, err := safeBase("file:///etc/passwd"); err == nil {
		t.Fatal("file URL accepted")
	}
}

func TestUpdateCommandRestartsOnSuccess(t *testing.T) {
	newBin := bytes.Repeat([]byte("N"), 2<<20)
	rel := release(t, "arm64", newBin, "")
	e := newEnv(t)
	u, exe, f := updaterFor(t, rel.URL, "1.5.0")
	f.ts.Close()
	e.a.Updater = &Updater{Server: e.a.Server, HTTP: http.DefaultClient, Exe: exe, Version: "1.0.0", Arch: "arm64", State: e.a.State}
	e.f.version = &api.UpdateInfo{Version: "1.5.0", BaseURL: rel.URL + "/rel"}
	e.f.push(command("u", "update"))
	err := e.runUntil(t, func() bool { return false })
	if err != ErrRestart {
		t.Fatalf("got %v", err)
	}
	_ = u
	if got, _ := os.ReadFile(exe); !bytes.Equal(got, newBin) {
		t.Fatal("not installed")
	}
}

// If the new binary cannot reach the server within 3 starts, the previous one comes back.
func TestRollbackAfterThreeFailedStarts(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "order-printer")
	_ = os.WriteFile(exe, []byte("new, broken"), 0o755)
	_ = os.WriteFile(exe+".prev", []byte("old, good"), 0o755)
	s := NewState(t.TempDir())
	if err := s.BeginUpdate(); err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 3; i++ {
		if s.StartupCheck(exe) {
			t.Fatalf("rolled back on start %d", i)
		}
	}
	if !s.StartupCheck(exe) {
		t.Fatal("did not roll back on the 4th start")
	}
	if got, _ := os.ReadFile(exe); string(got) != "old, good" {
		t.Fatalf("exe is %q", got)
	}
	if s.StartupCheck(exe) {
		t.Fatal("rolled back twice")
	}
}

func TestConfirmedUpdateIsNotRolledBack(t *testing.T) {
	s := NewState(t.TempDir())
	_ = s.BeginUpdate()
	s.StartupCheck("x")
	s.ConfirmUpdate()
	for i := 0; i < 10; i++ {
		if s.StartupCheck("x") {
			t.Fatal("rolled back a proven update")
		}
	}
}

func TestPollingConfirmsAnUpdate(t *testing.T) {
	e := newEnv(t)
	_ = e.a.State.BeginUpdate()
	e.runUntil(t, func() bool { _, err := os.Stat(e.a.State.markerPath()); return err != nil })
}
