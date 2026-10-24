package agent

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"time"

	"github.com/quick-assistant/printer-agent/internal/escpos"
)

// Devices are the USB printers the kernel's usblp driver exposes as /dev/usb/lp0, lp1, ... Writing ESC/POS bytes to
// the device file prints; no libusb needed. Dir is /dev/usb in production and a temporary folder in tests (where a
// plain file stands in for the printer).
// drainTimeout bounds how long Write waits for the printer to accept the last chunk of a ticket.
const drainTimeout = 60 * time.Second

type Devices struct{ Dir string }

var keyRe = regexp.MustCompile(`^lp\d{1,2}$`)

// ValidKey: the server tells the agent which device to use, so the name is checked before it touches the filesystem.
func ValidKey(k string) bool { return keyRe.MatchString(k) }

func (d Devices) List() []string {
	m, _ := filepath.Glob(filepath.Join(d.Dir, "lp*"))
	var keys []string
	for _, p := range m {
		if k := filepath.Base(p); ValidKey(k) {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	return keys
}

func (d Devices) path(key string) (string, error) {
	if !ValidKey(key) {
		return "", fmt.Errorf("bad device name %q", key)
	}
	return filepath.Join(d.Dir, key), nil
}

// Write sends bytes to the printer.
func (d Devices) Write(key string, data []byte) error {
	p, err := d.path(key)
	if err != nil {
		return err
	}
	if _, err := os.Stat(p); err != nil {
		return fmt.Errorf("printer %s not found (is it plugged in and switched on?)", key)
	}
	f, err := os.OpenFile(p, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		return fmt.Errorf("cannot open printer %s: %w", key, err)
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return fmt.Errorf("writing to printer %s: %w", key, err)
	}
	// Do NOT close at once: the USB driver cancels the last in-flight transfer on close, cutting the ticket off (drain_linux.go).
	// A big picture takes as long as the printer needs to accept it, hence the generous limit.
	waitWritable(f, drainTimeout)
	if err := f.Close(); err != nil {
		return fmt.Errorf("closing printer %s: %w", key, err)
	}
	return nil
}

// Status asks the printer for its real-time status (DLE EOT). Printers that do not answer (or plain files in tests)
// give an unknown status, which is reported as online: the open succeeded, the next ticket will tell.
func (d Devices) Status(key string) escpos.Status {
	p, err := d.path(key)
	if err != nil {
		return escpos.Status{Error: err.Error()}
	}
	if _, err := os.Stat(p); err != nil {
		return escpos.Status{Known: true, Error: "printer not found"}
	}
	f, err := os.OpenFile(p, os.O_RDWR, 0)
	if err != nil {
		if errors.Is(err, os.ErrPermission) {
			return escpos.Status{Known: true, Error: "no permission to use the printer"}
		}
		return escpos.Status{Online: true}
	}
	defer f.Close()
	if _, err := f.Write(escpos.StatusQueries()); err != nil {
		return escpos.Status{Online: true}
	}
	waitWritable(f, 2*time.Second) // let the 9 query bytes really leave before reading / closing
	got := make(chan []byte, 1)
	go func() {
		buf := make([]byte, 3)
		n := 0
		for n < 3 {
			m, err := f.Read(buf[n:])
			n += m
			if err != nil {
				break
			}
		}
		got <- buf[:n]
	}()
	select {
	case b := <-got:
		if len(b) == 3 {
			return escpos.ParseStatus(b[0], b[1], b[2])
		}
	case <-time.After(700 * time.Millisecond):
	}
	return escpos.Status{Online: true}
}
