// Package setup is the agent's local setup page, for a Pi that has no working network or no internet and cannot be
// reached through the dashboard. It is deliberately tiny: a PIN (printed on the setup ticket, so you must be at the
// printer), then only status, pairing, Wi-Fi, and a test print. It is HTTPS with a throw-away self-signed certificate
// (the PIN is the secret), listens on the LAN, and is OFF while the Pi is paired and online (a setup ticket opens it
// for 15 minutes). Wrong PINs lock it out.
package setup

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"embed"
	"errors"
	"fmt"
	"html/template"
	"math/big"
	"net"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
)

//go:embed page.html
var pageFS embed.FS

const (
	maxFails    = 5
	lockFor     = 15 * time.Minute
	sessionFor  = 15 * time.Minute
	defaultPort = "8080"
)

// Status is what the page shows.
type Status struct {
	Paired     bool
	Restaurant string
	Server     string
	Version    string
	Hostname   string
	IP         string
	Printers   []string
}

type Server struct {
	// Callbacks supplied by the agent.
	Status    func() Status
	AlwaysOn  func() bool // true while unpaired or cut off from the server
	Pair      func(code, server string) error
	WiFi      func(ssid, password string) error
	TestPrint func() error

	port string
	now  func() time.Time

	mu           sync.Mutex
	pin          string
	enabledUntil time.Time
	fails        int
	lockedUntil  time.Time
	sessions     map[string]time.Time
	tpl          *template.Template
}

func New(port string) *Server {
	if port == "" {
		port = defaultPort
	}
	s := &Server{port: port, now: time.Now, sessions: map[string]time.Time{}}
	s.tpl = template.Must(template.ParseFS(pageFS, "page.html"))
	s.pin = newPIN()
	return s
}

func newPIN() string {
	n, _ := rand.Int(rand.Reader, big.NewInt(1_000_000))
	return fmt.Sprintf("%06d", n.Int64())
}

func (s *Server) Port() string { return s.port }

// Enable opens the page for d with a fresh PIN (and clears a lockout: someone is physically at the printer).
func (s *Server) Enable(d time.Duration) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pin = newPIN()
	s.enabledUntil = s.now().Add(d)
	s.fails = 0
	s.lockedUntil = time.Time{}
	return s.pin
}

// PIN is the current PIN (printed on the setup ticket when the page is always on).
func (s *Server) PIN() string { s.mu.Lock(); defer s.mu.Unlock(); return s.pin }

func (s *Server) active() bool {
	s.mu.Lock()
	until := s.enabledUntil
	s.mu.Unlock()
	return s.now().Before(until) || (s.AlwaysOn != nil && s.AlwaysOn())
}

var (
	ssidRe = regexp.MustCompile(`^[^\x00-\x1f]{1,32}$`)
	codeRe = regexp.MustCompile(`^[A-Za-z0-9-]{4,20}$`)
)

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", s.guard(false, s.home))
	mux.HandleFunc("POST /login", s.login)
	mux.HandleFunc("POST /pair", s.guard(true, s.pair))
	mux.HandleFunc("POST /wifi", s.guard(true, s.wifi))
	mux.HandleFunc("POST /test", s.guard(true, s.test))
	return securityHeaders(mux)
}

func securityHeaders(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'")
		r.Body = http.MaxBytesReader(w, r.Body, 4096)
		h.ServeHTTP(w, r)
	})
}

// guard: the page must be switched on, and (for everything but the login form) the visitor must hold a session.
func (s *Server) guard(post bool, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.active() {
			http.Error(w, "The setup page is off. Press the setup button in the dashboard (Service) to print a setup ticket.", http.StatusNotFound)
			return
		}
		if !s.loggedIn(r) {
			if post {
				http.Redirect(w, r, "/", http.StatusSeeOther)
				return
			}
			s.render(w, map[string]any{"Login": true, "Locked": s.locked()})
			return
		}
		next(w, r)
	}
}

func (s *Server) locked() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.now().Before(s.lockedUntil)
}

func (s *Server) loggedIn(r *http.Request) bool {
	c, err := r.Cookie("sid")
	if err != nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	exp, ok := s.sessions[c.Value]
	if ok && s.now().After(exp) {
		delete(s.sessions, c.Value)
		return false
	}
	return ok
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	if !s.active() {
		http.NotFound(w, r)
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	s.mu.Lock()
	if s.now().Before(s.lockedUntil) {
		s.mu.Unlock()
		http.Error(w, "Too many wrong PINs. Locked for 15 minutes (a new setup ticket unlocks it).", http.StatusTooManyRequests)
		return
	}
	ok := subtle.ConstantTimeCompare([]byte(r.PostFormValue("pin")), []byte(s.pin)) == 1
	if !ok {
		s.fails++
		if s.fails >= maxFails {
			s.lockedUntil = s.now().Add(lockFor)
			s.pin = newPIN() // the old one is useless now
			s.fails = 0
		}
		s.mu.Unlock()
		time.Sleep(500 * time.Millisecond) // slows guessing down
		s.render(w, map[string]any{"Login": true, "Message": "Wrong PIN."})
		return
	}
	s.fails = 0
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	sid := fmt.Sprintf("%x", b)
	s.sessions[sid] = s.now().Add(sessionFor)
	s.mu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: "sid", Value: sid, Path: "/", HttpOnly: true, Secure: true, SameSite: http.SameSiteStrictMode, MaxAge: int(sessionFor.Seconds())})
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

func (s *Server) home(w http.ResponseWriter, r *http.Request) {
	st := Status{}
	if s.Status != nil {
		st = s.Status()
	}
	s.render(w, map[string]any{"Status": st, "Message": r.URL.Query().Get("m")})
}

func (s *Server) render(w http.ResponseWriter, data map[string]any) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_ = s.tpl.Execute(w, data)
}

func back(w http.ResponseWriter, r *http.Request, msg string) {
	http.Redirect(w, r, "/?m="+template.URLQueryEscaper(msg), http.StatusSeeOther)
}

func (s *Server) pair(w http.ResponseWriter, r *http.Request) {
	_ = r.ParseForm()
	code, server := strings.TrimSpace(r.PostFormValue("code")), strings.TrimSpace(r.PostFormValue("server"))
	if !codeRe.MatchString(code) || !strings.HasPrefix(server, "https://") && !strings.HasPrefix(server, "http://") {
		back(w, r, "Enter the pairing code and the server address (https://...).")
		return
	}
	if s.Pair == nil {
		back(w, r, "Pairing is not available.")
		return
	}
	if err := s.Pair(code, server); err != nil {
		back(w, r, "Pairing failed: "+err.Error())
		return
	}
	back(w, r, "Paired. The agent is starting.")
}

func (s *Server) wifi(w http.ResponseWriter, r *http.Request) {
	_ = r.ParseForm()
	ssid, pass := r.PostFormValue("ssid"), r.PostFormValue("password")
	if !ssidRe.MatchString(ssid) || len(pass) < 8 || len(pass) > 63 {
		back(w, r, "Wi-Fi name (1-32 characters) and password (8-63 characters) are required.")
		return
	}
	if s.WiFi == nil {
		back(w, r, "Wi-Fi setup is not available on this device. Use an Ethernet cable.")
		return
	}
	if err := s.WiFi(ssid, pass); err != nil {
		back(w, r, "Could not join that network: "+err.Error())
		return
	}
	back(w, r, "Joined the Wi-Fi network.")
}

func (s *Server) test(w http.ResponseWriter, r *http.Request) {
	if s.TestPrint == nil {
		back(w, r, "No printer available.")
		return
	}
	if err := s.TestPrint(); err != nil {
		back(w, r, "Test print failed: "+err.Error())
		return
	}
	back(w, r, "Test ticket sent to the printer.")
}

// selfSigned makes a throw-away certificate for the LAN page; browsers warn once, the PIN is the real protection.
func selfSigned() (tls.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	tpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: "order-printer"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(10 * 365 * 24 * time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames: []string{"localhost"},
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, err
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, nil
}

// ListenAndServe runs the page until ctx ends.
func (s *Server) ListenAndServe(ctx context.Context) error {
	cert, err := selfSigned()
	if err != nil {
		return err
	}
	srv := &http.Server{
		Addr: ":" + s.port, Handler: s.Handler(), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 20 * time.Second, WriteTimeout: 20 * time.Second,
		TLSConfig: &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12},
	}
	go func() {
		<-ctx.Done()
		c, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = srv.Shutdown(c)
	}()
	ln, err := net.Listen("tcp", srv.Addr)
	if err != nil {
		return err
	}
	if err := srv.ServeTLS(ln, "", ""); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
