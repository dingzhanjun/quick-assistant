package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Updater swaps the agent's own binary for a newer one. The server says which version it wants and where the files
// are (`/api/print/update`); the agent downloads `order-printer-linux-<arch>` and its `.sha256`, verifies the checksum,
// keeps the old binary as `<exe>.prev` and replaces itself. It then exits and systemd starts the new one; if the new
// one cannot reach the server in 3 starts, State.StartupCheck puts the old one back.
type Updater struct {
	Server  Server
	HTTP    *http.Client
	Exe     string // path of the running binary
	Version string
	Arch    string // GOARCH: arm64, arm, amd64
	State   *State
}

// Newer reports whether version a is higher than b (dotted numbers, an optional leading "v"). "dev" is never updated.
func Newer(a, b string) bool {
	if b == "dev" || b == "" {
		return false
	}
	pa, pb := nums(a), nums(b)
	for i := 0; i < max(len(pa), len(pb)); i++ {
		var x, y int
		if i < len(pa) {
			x = pa[i]
		}
		if i < len(pb) {
			y = pb[i]
		}
		if x != y {
			return x > y
		}
	}
	return false
}

func nums(v string) []int {
	var out []int
	for _, p := range strings.Split(strings.TrimPrefix(v, "v"), ".") {
		n, _ := strconv.Atoi(p)
		out = append(out, n)
	}
	return out
}

var shaRe = regexp.MustCompile(`^[0-9a-fA-F]{64}`)

// safeBase accepts https URLs (and plain http only for the local machine, which the tests use).
func safeBase(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return nil, errors.New("bad update URL")
	}
	if u.Scheme == "https" || (u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost")) {
		return u, nil
	}
	return nil, errors.New("update URL must be https")
}

func (u *Updater) get(ctx context.Context, rawURL string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", rawURL, nil)
	if err != nil {
		return nil, err
	}
	res, err := u.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("%s answered %d", rawURL, res.StatusCode)
	}
	return io.ReadAll(io.LimitReader(res.Body, limit))
}

// Check installs a newer version if there is one. Returns the new version, or "" when nothing changed.
func (u *Updater) Check(ctx context.Context) (string, error) {
	info, err := u.Server.LatestVersion(ctx)
	if err != nil || info == nil || !Newer(info.Version, u.Version) {
		return "", err
	}
	base, err := safeBase(info.BaseURL)
	if err != nil {
		return "", err
	}
	name := "order-printer-linux-" + u.Arch
	binURL := strings.TrimRight(base.String(), "/") + "/" + name
	sumText, err := u.get(ctx, binURL+".sha256", 1024)
	if err != nil {
		return "", fmt.Errorf("checksum: %w", err)
	}
	want := shaRe.FindString(strings.TrimSpace(string(sumText)))
	if want == "" {
		return "", errors.New("checksum file is not a sha256")
	}
	bin, err := u.get(ctx, binURL, 64<<20)
	if err != nil {
		return "", fmt.Errorf("download: %w", err)
	}
	sum := sha256.Sum256(bin)
	if !strings.EqualFold(hex.EncodeToString(sum[:]), want) {
		return "", errors.New("downloaded file does not match its checksum; not installing")
	}
	if len(bin) < 1<<20 {
		return "", errors.New("downloaded file is too small to be the agent; not installing")
	}
	tmp := u.Exe + ".new"
	if err := os.WriteFile(tmp, bin, 0o755); err != nil {
		return "", err
	}
	if err := u.State.BeginUpdate(); err != nil {
		os.Remove(tmp)
		return "", err
	}
	_ = os.Remove(u.Exe + ".prev")
	if err := os.Rename(u.Exe, u.Exe+".prev"); err != nil {
		os.Remove(tmp)
		return "", err
	}
	if err := os.Rename(tmp, u.Exe); err != nil {
		_ = os.Rename(u.Exe+".prev", u.Exe) // put the old one back
		return "", err
	}
	return info.Version, nil
}

// DefaultHTTP is the client used for downloads.
func DefaultHTTP() *http.Client { return &http.Client{Timeout: 3 * time.Minute} }
