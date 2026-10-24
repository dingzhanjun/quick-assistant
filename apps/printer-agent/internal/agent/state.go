package agent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

const recentMax = 200

// State is the little the agent remembers across restarts: which tickets it already printed (the server retries a
// ticket whose acknowledgement got lost, and a ticket must never print twice) and whether a self-update is unproven.
type State struct {
	dir    string
	mu     sync.Mutex
	recent []string
}

func NewState(dir string) *State {
	s := &State{dir: dir}
	if b, err := os.ReadFile(filepath.Join(dir, "recent.json")); err == nil {
		_ = json.Unmarshal(b, &s.recent)
	}
	return s
}

func (s *State) Printed(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range s.recent {
		if r == id {
			return true
		}
	}
	return false
}

func (s *State) MarkPrinted(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.recent = append(s.recent, id)
	if len(s.recent) > recentMax {
		s.recent = s.recent[len(s.recent)-recentMax:]
	}
	if err := os.MkdirAll(s.dir, 0o755); err != nil {
		return
	}
	b, _ := json.Marshal(s.recent)
	_ = os.WriteFile(filepath.Join(s.dir, "recent.json"), b, 0o600)
}

// An update is "pending" from the moment the new binary is installed until it has talked to the server successfully.
// If the new binary keeps dying before that, StartupCheck puts the previous one back.
type pending struct {
	Attempts int `json:"attempts"`
}

func (s *State) markerPath() string { return filepath.Join(s.dir, "pending-update.json") }

func (s *State) BeginUpdate() error {
	if err := os.MkdirAll(s.dir, 0o755); err != nil {
		return err
	}
	b, _ := json.Marshal(pending{})
	return os.WriteFile(s.markerPath(), b, 0o600)
}

// ConfirmUpdate is called after the first successful contact with the server.
func (s *State) ConfirmUpdate() { _ = os.Remove(s.markerPath()) }

// StartupCheck runs first thing at start. After an update the new binary gets 3 starts to reach the server; then the
// previous binary (kept as <exe>.prev) is restored and true is returned: the caller exits so systemd starts the old one.
func (s *State) StartupCheck(exe string) (rolledBack bool) {
	b, err := os.ReadFile(s.markerPath())
	if err != nil {
		return false
	}
	var p pending
	_ = json.Unmarshal(b, &p)
	p.Attempts++
	if p.Attempts <= 3 {
		nb, _ := json.Marshal(p)
		_ = os.WriteFile(s.markerPath(), nb, 0o600)
		return false
	}
	_ = os.Remove(s.markerPath())
	if _, err := os.Stat(exe + ".prev"); err == nil {
		if os.Rename(exe+".prev", exe) == nil {
			return true
		}
	}
	return false
}
