package setup

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

type rig struct {
	s      *Server
	h      http.Handler
	now    time.Time
	paired [][2]string
	wifi   [][2]string
	tests  int
}

func newRig(t *testing.T) *rig {
	r := &rig{now: time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)}
	r.s = New("0")
	r.s.now = func() time.Time { return r.now }
	r.s.Status = func() Status {
		return Status{Version: "1.0.0", Hostname: "pi", IP: "10.0.0.5", Printers: []string{"lp0"}}
	}
	r.s.Pair = func(code, server string) error { r.paired = append(r.paired, [2]string{code, server}); return nil }
	r.s.WiFi = func(ssid, pass string) error { r.wifi = append(r.wifi, [2]string{ssid, pass}); return nil }
	r.s.TestPrint = func() error { r.tests++; return nil }
	r.h = r.s.Handler()
	return r
}

func (r *rig) do(method, path string, form url.Values, cookie string) *httptest.ResponseRecorder {
	var body *strings.Reader
	if form != nil {
		body = strings.NewReader(form.Encode())
	} else {
		body = strings.NewReader("")
	}
	req := httptest.NewRequest(method, path, body)
	if form != nil {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	if cookie != "" {
		req.Header.Set("Cookie", "sid="+cookie)
	}
	w := httptest.NewRecorder()
	r.h.ServeHTTP(w, req)
	return w
}

func (r *rig) login(t *testing.T, pin string) string {
	w := r.do("POST", "/login", url.Values{"pin": {pin}}, "")
	for _, c := range w.Result().Cookies() {
		if c.Name == "sid" {
			return c.Value
		}
	}
	return ""
}

func TestPageIsOffUnlessOpened(t *testing.T) {
	r := newRig(t)
	if w := r.do("GET", "/", nil, ""); w.Code != 404 {
		t.Fatalf("closed page answered %d", w.Code)
	}
	if w := r.do("POST", "/login", url.Values{"pin": {r.s.PIN()}}, ""); w.Code != 404 {
		t.Fatalf("login on a closed page answered %d", w.Code)
	}
	r.s.AlwaysOn = func() bool { return true } // unpaired
	if w := r.do("GET", "/", nil, ""); w.Code != 200 || !strings.Contains(w.Body.String(), "PIN") {
		t.Fatalf("always-on page: %d", w.Code)
	}
}

func TestWindowExpires(t *testing.T) {
	r := newRig(t)
	r.s.Enable(15 * time.Minute)
	if r.do("GET", "/", nil, "").Code != 200 {
		t.Fatal("not open")
	}
	r.now = r.now.Add(16 * time.Minute)
	if r.do("GET", "/", nil, "").Code != 404 {
		t.Fatal("still open after the window")
	}
}

func TestPINLoginAndPages(t *testing.T) {
	r := newRig(t)
	pin := r.s.Enable(time.Hour)
	// nothing is reachable without logging in
	for _, p := range []string{"/pair", "/wifi", "/test"} {
		if w := r.do("POST", p, url.Values{"ssid": {"x"}}, ""); w.Code != http.StatusSeeOther || w.Header().Get("Location") != "/" {
			t.Fatalf("%s without a session: %d", p, w.Code)
		}
	}
	if len(r.paired)+len(r.wifi)+r.tests != 0 {
		t.Fatal("an unauthenticated request did something")
	}
	if r.login(t, "000000") != "" && pin != "000000" {
		t.Fatal("wrong PIN accepted")
	}
	sid := r.login(t, pin)
	if sid == "" {
		t.Fatal("right PIN refused")
	}
	home := r.do("GET", "/", nil, sid)
	if !strings.Contains(home.Body.String(), "10.0.0.5") || !strings.Contains(home.Body.String(), "lp0") {
		t.Fatalf("status page: %s", home.Body.String())
	}
	ck := r.do("POST", "/login", url.Values{"pin": {pin}}, "").Result().Cookies()[0]
	if !ck.HttpOnly || !ck.Secure || ck.SameSite != http.SameSiteStrictMode {
		t.Fatalf("cookie flags: %+v", ck)
	}
}

func TestWrongPINsLockItOut(t *testing.T) {
	r := newRig(t)
	pin := r.s.Enable(time.Hour)
	for i := 0; i < maxFails; i++ {
		r.do("POST", "/login", url.Values{"pin": {"bad" + string(rune('0'+i))}}, "")
	}
	if w := r.do("POST", "/login", url.Values{"pin": {pin}}, ""); w.Code != http.StatusTooManyRequests {
		t.Fatalf("locked page answered %d", w.Code)
	}
	if r.login(t, pin) != "" {
		t.Fatal("old PIN still works after the lockout")
	}
	r.now = r.now.Add(16 * time.Minute) // lockout over but the old PIN was replaced and the window ended
	newPin := r.s.Enable(time.Hour)     // a new setup ticket
	if newPin == pin {
		t.Log("(same PIN drawn twice by chance)")
	}
	if r.login(t, newPin) == "" {
		t.Fatal("a new setup ticket did not unlock")
	}
}

func TestSessionsExpire(t *testing.T) {
	r := newRig(t)
	pin := r.s.Enable(time.Hour)
	sid := r.login(t, pin)
	r.now = r.now.Add(16 * time.Minute)
	if w := r.do("GET", "/", nil, sid); strings.Contains(w.Body.String(), "10.0.0.5") {
		t.Fatal("expired session still sees the status page")
	}
}

func TestActionsValidateTheirInput(t *testing.T) {
	r := newRig(t)
	sid := r.login(t, r.s.Enable(time.Hour))
	r.do("POST", "/pair", url.Values{"code": {"ABCD-EFGH"}, "server": {"https://orders.example.com"}}, sid)
	if len(r.paired) != 1 || r.paired[0] != [2]string{"ABCD-EFGH", "https://orders.example.com"} {
		t.Fatalf("paired %v", r.paired)
	}
	for _, bad := range []url.Values{
		{"code": {"ABCD EFGH; rm -rf /"}, "server": {"https://x.example"}},
		{"code": {"ABCD-EFGH"}, "server": {"ftp://x.example"}},
		{"code": {""}, "server": {"https://x.example"}},
	} {
		r.do("POST", "/pair", bad, sid)
	}
	if len(r.paired) != 1 {
		t.Fatalf("bad pairing input reached the agent: %v", r.paired)
	}

	r.do("POST", "/wifi", url.Values{"ssid": {"Cafe WiFi"}, "password": {"correct horse"}}, sid)
	if len(r.wifi) != 1 {
		t.Fatalf("wifi %v", r.wifi)
	}
	for _, bad := range []url.Values{
		{"ssid": {"net\nwork"}, "password": {"correct horse"}},             // control character
		{"ssid": {strings.Repeat("a", 33)}, "password": {"correct horse"}}, // too long
		{"ssid": {"ok"}, "password": {"short"}},
		{"ssid": {""}, "password": {"correct horse"}},
	} {
		r.do("POST", "/wifi", bad, sid)
	}
	if len(r.wifi) != 1 {
		t.Fatalf("bad Wi-Fi input reached the agent: %v", r.wifi)
	}
	r.do("POST", "/test", url.Values{}, sid)
	if r.tests != 1 {
		t.Fatal("test print not triggered")
	}
}

func TestOnlyTheShortListOfRoutesExists(t *testing.T) {
	r := newRig(t)
	sid := r.login(t, r.s.Enable(time.Hour))
	for _, p := range []string{"/shell", "/exec", "/admin", "/etc/passwd", "/config", "/files", "/api/print/poll"} {
		for _, m := range []string{"GET", "POST"} {
			if w := r.do(m, p, url.Values{}, sid); w.Code != 404 && w.Code != 405 {
				t.Errorf("%s %s answered %d", m, p, w.Code)
			}
		}
	}
}

func TestSecurityHeaders(t *testing.T) {
	r := newRig(t)
	r.s.Enable(time.Hour)
	w := r.do("GET", "/", nil, "")
	if w.Header().Get("X-Frame-Options") != "DENY" || !strings.Contains(w.Header().Get("Content-Security-Policy"), "default-src 'none'") || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("%v", w.Header())
	}
}

func TestSelfSignedCertificate(t *testing.T) {
	if _, err := selfSigned(); err != nil {
		t.Fatal(err)
	}
}
