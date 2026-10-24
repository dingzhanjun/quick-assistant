//go:build linux

package agent

import (
	"os"
	"syscall"
	"time"
	"unsafe"
)

type pollFd struct {
	fd      int32
	events  int16
	revents int16
}

const pollOut = 0x4

// waitWritable blocks until the descriptor can take more output, or `timeout` has passed.
//
// Why this exists: the kernel's USB printer driver (usblp) returns from write() as soon as the LAST chunk is handed to the USB
// stack, not when the printer has accepted it, and close() then CANCELS whatever is still in flight. A ticket written and closed
// at once is therefore cut off after the first USB packets: the slip stops mid-way (no cut), and the printer is left inside a
// half-received command that swallows the first bytes of the next job (a stray "@" where the ESC should be, or a page of junk).
// The driver reports the descriptor writable again when that last transfer has completed, so polling for it before close()
// keeps the data from being truncated.
func waitWritable(f *os.File, timeout time.Duration) {
	rc, err := f.SyscallConn()
	if err != nil {
		return
	}
	_ = rc.Control(func(fd uintptr) {
		deadline := time.Now().Add(timeout)
		for {
			left := time.Until(deadline)
			if left <= 0 {
				return
			}
			if left > time.Second {
				left = time.Second // wake up now and then; a very long poll is easier to get wrong
			}
			p := pollFd{fd: int32(fd), events: pollOut}
			ts := syscall.NsecToTimespec(int64(left))
			n, _, errno := syscall.Syscall6(syscall.SYS_PPOLL, uintptr(unsafe.Pointer(&p)), 1, uintptr(unsafe.Pointer(&ts)), 0, 0, 0)
			if errno == syscall.EINTR {
				continue
			}
			if errno != 0 || n > 0 {
				return // writable (the last transfer completed), or poll is not supported here
			}
		}
	})
}
