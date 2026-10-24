// Package agent is the print agent proper: it polls the server, prints tickets, answers service commands, reports
// its state, and updates itself.
package agent

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// Config is what pairing leaves on disk (mode 0600: the token is the agent's credential).
type Config struct {
	Server     string `json:"server"`
	Token      string `json:"token"`
	AgentID    string `json:"agent_id"`
	Restaurant string `json:"restaurant"`
}

func LoadConfig(path string) (*Config, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var c Config
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, err
	}
	return &c, nil
}

func (c Config) Save(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(c, "", "  ")
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
