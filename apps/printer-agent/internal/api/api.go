// Package api is the print agent's client for the server's /api/print/* routes. Every call is OUTBOUND HTTPS with the
// agent's bearer token; the restaurant needs no open port.
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// ErrUnauthorized means the token was revoked or is unknown: the agent must be paired again.
var ErrUnauthorized = errors.New("the server does not accept this agent's token (revoked?)")

type Client struct {
	Server string // https://host, no trailing slash
	Token  string
	HTTP   *http.Client
}

func New(server, token string) *Client {
	return &Client{Server: strings.TrimRight(server, "/"), Token: token, HTTP: &http.Client{Timeout: 30 * time.Second}}
}

type Job struct {
	ID      string  `json:"id"`
	Kind    string  `json:"kind"`
	Copies  int     `json:"copies"`
	Device  *string `json:"device"`
	Printer string  `json:"printer"`
}

type Command struct {
	ID      string         `json:"id"`
	Command string         `json:"command"`
	Args    map[string]any `json:"args"`
}

// Work is what poll returns: one ticket or one service command.
type Work struct {
	Type    string   `json:"type"`
	Job     *Job     `json:"job"`
	Command *Command `json:"command"`
}

type PrinterStatus struct {
	Key       string `json:"key"`
	Online    *bool  `json:"online,omitempty"`
	PaperOut  *bool  `json:"paper_out,omitempty"`
	CoverOpen *bool  `json:"cover_open,omitempty"`
	Error     string `json:"error,omitempty"`
}

type Heartbeat struct {
	Version  string          `json:"version"`
	Hostname string          `json:"hostname"`
	LanIP    string          `json:"lan_ip"`
	Info     map[string]any  `json:"info,omitempty"`
	Printers []PrinterStatus `json:"printers"`
}

type PairRequest struct {
	Code     string       `json:"code"`
	Version  string       `json:"version"`
	Hostname string       `json:"hostname"`
	LanIP    string       `json:"lan_ip"`
	Devices  []PairDevice `json:"devices"`
}
type PairDevice struct {
	Key string `json:"key"`
}
type PairResponse struct {
	Token      string `json:"token"`
	AgentID    string `json:"agent_id"`
	Restaurant string `json:"restaurant"`
}

type UpdateInfo struct {
	Version string `json:"version"`
	BaseURL string `json:"base_url"`
}

func (c *Client) do(ctx context.Context, method, path string, body any, timeout time.Duration) (*http.Response, error) {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		rd = bytes.NewReader(b)
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	req, err := http.NewRequestWithContext(ctx, method, c.Server+path, rd)
	if err != nil {
		cancel()
		return nil, err
	}
	if body != nil {
		req.Header.Set("content-type", "application/json")
	}
	if c.Token != "" {
		req.Header.Set("authorization", "Bearer "+c.Token)
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		cancel()
		return nil, err
	}
	res.Body = &cancelBody{res.Body, cancel}
	if res.StatusCode == http.StatusUnauthorized {
		res.Body.Close()
		return nil, ErrUnauthorized
	}
	return res, nil
}

type cancelBody struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (b *cancelBody) Close() error { err := b.ReadCloser.Close(); b.cancel(); return err }

func expect(res *http.Response, codes ...int) error {
	for _, c := range codes {
		if res.StatusCode == c {
			return nil
		}
	}
	msg, _ := io.ReadAll(io.LimitReader(res.Body, 300))
	return fmt.Errorf("server answered %d: %s", res.StatusCode, strings.TrimSpace(string(msg)))
}

// Pair swaps the one-time pairing code for the agent token.
func (c *Client) Pair(ctx context.Context, p PairRequest) (*PairResponse, error) {
	res, err := c.do(ctx, "POST", "/api/print/pair", p, 30*time.Second)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusForbidden {
		return nil, errors.New("the pairing code is wrong, already used or expired (make a new one in Settings -> Kitchen printing)")
	}
	if err := expect(res, 200); err != nil {
		return nil, err
	}
	var out PairResponse
	return &out, json.NewDecoder(res.Body).Decode(&out)
}

// Poll long-polls for work; nil, nil means nothing arrived within `wait`.
func (c *Client) Poll(ctx context.Context, wait time.Duration) (*Work, error) {
	res, err := c.do(ctx, "GET", fmt.Sprintf("/api/print/poll?wait=%d", int(wait.Seconds())), nil, wait+20*time.Second)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNoContent {
		return nil, nil
	}
	if err := expect(res, 200); err != nil {
		return nil, err
	}
	var w Work
	if err := json.NewDecoder(res.Body).Decode(&w); err != nil {
		return nil, err
	}
	return &w, nil
}

// Image downloads a ticket picture (a 1-bit PNG, a few KB).
func (c *Client) Image(ctx context.Context, jobID string) ([]byte, error) {
	res, err := c.do(ctx, "GET", "/api/print/jobs/"+url.PathEscape(jobID)+"/image", nil, 30*time.Second)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if err := expect(res, 200); err != nil {
		return nil, err
	}
	return io.ReadAll(io.LimitReader(res.Body, 4<<20))
}

func (c *Client) JobResult(ctx context.Context, jobID string, ok bool, errMsg string) error {
	body := map[string]any{"ok": ok}
	if errMsg != "" {
		body["error"] = truncate(errMsg, 290)
	}
	res, err := c.do(ctx, "POST", "/api/print/jobs/"+url.PathEscape(jobID)+"/result", body, 30*time.Second)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	// 404: the ticket was already closed (a retry after a lost answer): fine
	return expect(res, 200, 404)
}

func (c *Client) CommandResult(ctx context.Context, id string, ok bool, output string) error {
	res, err := c.do(ctx, "POST", "/api/print/commands/"+url.PathEscape(id)+"/result", map[string]any{"ok": ok, "output": truncate(output, 19000)}, 30*time.Second)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	return expect(res, 200, 404)
}

func (c *Client) Heartbeat(ctx context.Context, h Heartbeat) error {
	res, err := c.do(ctx, "POST", "/api/print/heartbeat", h, 20*time.Second)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	return expect(res, 200)
}

// LatestVersion asks which agent version the server wants; nil = no update configured.
func (c *Client) LatestVersion(ctx context.Context) (*UpdateInfo, error) {
	res, err := c.do(ctx, "GET", "/api/print/update", nil, 20*time.Second)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNoContent {
		return nil, nil
	}
	if err := expect(res, 200); err != nil {
		return nil, err
	}
	var u UpdateInfo
	return &u, json.NewDecoder(res.Body).Decode(&u)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
