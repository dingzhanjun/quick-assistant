//go:build !linux

package agent

import (
	"os"
	"time"
)

// The USB printer driver quirk (see drain_linux.go) is Linux-specific; elsewhere there is nothing to wait for.
func waitWritable(*os.File, time.Duration) {}
