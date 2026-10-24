package agent

import (
	"strings"
	"sync"
)

// LogBuf keeps the last lines the agent logged, so "Show log" in the dashboard works without touching journald.
type LogBuf struct {
	mu    sync.Mutex
	lines []string
	max   int
	part  string
}

func NewLogBuf(max int) *LogBuf { return &LogBuf{max: max} }

func (l *LogBuf) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	s := l.part + string(p)
	parts := strings.Split(s, "\n")
	l.part = parts[len(parts)-1]
	for _, line := range parts[:len(parts)-1] {
		l.lines = append(l.lines, line)
	}
	if over := len(l.lines) - l.max; over > 0 {
		l.lines = l.lines[over:]
	}
	return len(p), nil
}

// Tail returns the last n lines.
func (l *LogBuf) Tail(n int) string {
	l.mu.Lock()
	defer l.mu.Unlock()
	lines := l.lines
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}
