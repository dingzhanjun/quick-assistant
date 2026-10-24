//go:build linux

package agent

import (
	"os"
	"syscall"
	"testing"
	"time"
)

// A descriptor that cannot take more output (a full pipe, like a printer still receiving) must make waitWritable WAIT until the
// reader makes room, and one that can take output must return at once.
func TestWaitWritableWaitsUntilTheOtherSideDrains(t *testing.T) {
	var fds [2]int
	if err := syscall.Pipe(fds[:]); err != nil {
		t.Fatal(err)
	}
	if err := syscall.SetNonblock(fds[1], true); err != nil {
		t.Fatal(err)
	}
	chunk := make([]byte, 4096)
	for { // fill the pipe until the kernel says it is full
		if _, err := syscall.Write(fds[1], chunk); err != nil {
			break
		}
	}
	w := os.NewFile(uintptr(fds[1]), "w")
	defer w.Close()
	r := os.NewFile(uintptr(fds[0]), "r")
	defer r.Close()

	go func() {
		time.Sleep(400 * time.Millisecond)
		buf := make([]byte, 1<<20)
		_, _ = r.Read(buf) // the "printer" finally accepts data
	}()
	start := time.Now()
	waitWritable(w, 5*time.Second)
	took := time.Since(start)
	if took < 300*time.Millisecond || took > 3*time.Second {
		t.Fatalf("waited %v; expected about 400 ms (until the reader drained the pipe)", took)
	}
}

func TestWaitWritableReturnsAtOnceWhenReadyAndHonoursTheTimeout(t *testing.T) {
	f, err := os.CreateTemp(t.TempDir(), "lp0")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	start := time.Now()
	waitWritable(f, 5*time.Second)
	if time.Since(start) > time.Second {
		t.Fatalf("a regular file is always writable, took %v", time.Since(start))
	}

	// full pipe, nobody reads: gives up after the timeout instead of hanging the agent forever
	var fds [2]int
	if err := syscall.Pipe(fds[:]); err != nil {
		t.Fatal(err)
	}
	_ = syscall.SetNonblock(fds[1], true)
	for {
		if _, err := syscall.Write(fds[1], make([]byte, 4096)); err != nil {
			break
		}
	}
	w := os.NewFile(uintptr(fds[1]), "w")
	defer w.Close()
	defer syscall.Close(fds[0])
	start = time.Now()
	waitWritable(w, 600*time.Millisecond)
	if d := time.Since(start); d < 500*time.Millisecond || d > 2*time.Second {
		t.Fatalf("timeout not honoured: %v", d)
	}
}
