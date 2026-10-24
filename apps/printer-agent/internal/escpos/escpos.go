// Package escpos builds the byte streams an ESC/POS thermal receipt printer understands: a raster picture (the
// ticket the server rendered), a few text lines (the local setup ticket), a QR code, a cut, and the status query.
package escpos

import (
	"bytes"
	"errors"
	"image"
	"image/draw"
	_ "image/png" // the server sends PNG
)

const (
	esc = 0x1b
	gs  = 0x1d
	dle = 0x10
)

// bandRows is how many pixel rows go into one GS v 0 command. Cheap printers choke on very tall images, so the
// picture is sent in bands (they print as one continuous image).
const bandRows = 128

// Init resets the printer.
func Init() []byte { return []byte{esc, '@'} }

// Feed advances the paper by n text lines (ESC d n).
func Feed(lines int) []byte { return []byte{esc, 'd', byte(lines)} }

// Cut is a partial cut after feeding a little, so the ticket clears the blade (GS V 66 n).
func Cut() []byte { return []byte{gs, 'V', 66, 3} }

// Beep sounds the buzzer where the printer has one (ESC BEL n t; ignored by printers without).
func Beep() []byte { return []byte{esc, 0x42, 2, 2} }

// Raster converts a picture to GS v 0 raster bands. A pixel is ink when it is darker than mid-grey (the server already
// thresholds to 1 bit; this also copes with grey or colour input).
func Raster(src image.Image) ([]byte, error) {
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= 0 || h <= 0 {
		return nil, errors.New("empty image")
	}
	if w > 2048 || h > 20000 {
		return nil, errors.New("image too large for a ticket")
	}
	gray := image.NewGray(image.Rect(0, 0, w, h))
	draw.Draw(gray, gray.Bounds(), src, b.Min, draw.Src)
	stride := (w + 7) / 8
	var out bytes.Buffer
	for y0 := 0; y0 < h; y0 += bandRows {
		rows := min(bandRows, h-y0)
		out.Write([]byte{gs, 'v', '0', 0, byte(stride), byte(stride >> 8), byte(rows), byte(rows >> 8)})
		for y := y0; y < y0+rows; y++ {
			line := make([]byte, stride)
			for x := 0; x < w; x++ {
				if gray.GrayAt(x, y).Y < 128 {
					line[x>>3] |= 0x80 >> (x & 7)
				}
			}
			out.Write(line)
		}
	}
	return out.Bytes(), nil
}

// Ticket is the full job for one copy of a rendered ticket: reset, picture, feed, cut (and a beep for new orders).
func Ticket(src image.Image, beep bool) ([]byte, error) {
	r, err := Raster(src)
	if err != nil {
		return nil, err
	}
	var out bytes.Buffer
	out.Write(Init())
	out.Write(r)
	out.Write(Feed(3))
	if beep {
		out.Write(Beep())
	}
	out.Write(Cut())
	return out.Bytes(), nil
}

// Doc builds a small text document (the setup / test tickets). Text is ASCII only: other characters become '?',
// because code pages differ between printers; anything fancy is a server-rendered picture instead.
type Doc struct{ buf bytes.Buffer }

func NewDoc() *Doc {
	d := &Doc{}
	d.buf.Write(Init())
	return d
}

func ascii(s string) []byte {
	out := make([]byte, 0, len(s))
	for _, r := range s {
		if r == '\n' || (r >= 0x20 && r < 0x7f) {
			out = append(out, byte(r))
		} else {
			out = append(out, '?')
		}
	}
	return out
}

// Line writes one line. `size` is 1 or 2 (double width and height).
func (d *Doc) Line(s string, bold bool, center bool, size int) *Doc {
	align := byte(0)
	if center {
		align = 1
	}
	b := byte(0)
	if bold {
		b = 1
	}
	sz := byte(0)
	if size >= 2 {
		sz = 0x11
	}
	d.buf.Write([]byte{esc, 'a', align, esc, 'E', b, gs, '!', sz})
	d.buf.Write(ascii(s))
	d.buf.WriteByte('\n')
	d.buf.Write([]byte{esc, 'E', 0, gs, '!', 0, esc, 'a', 0})
	return d
}

// QR prints a QR code (the printer's built-in generator, GS ( k). Version/size are chosen by the printer.
func (d *Doc) QR(data string) *Doc {
	if len(data) == 0 || len(data) > 400 {
		return d
	}
	n := len(data) + 3
	d.buf.Write([]byte{esc, 'a', 1})
	d.buf.Write([]byte{gs, '(', 'k', 4, 0, 0x31, 0x41, 0x32, 0}) // model 2
	d.buf.Write([]byte{gs, '(', 'k', 3, 0, 0x31, 0x43, 6})       // module size 6
	d.buf.Write([]byte{gs, '(', 'k', 3, 0, 0x31, 0x45, 0x31})    // error correction M
	d.buf.Write([]byte{gs, '(', 'k', byte(n), byte(n >> 8), 0x31, 0x50, 0x30})
	d.buf.WriteString(data)
	d.buf.Write([]byte{gs, '(', 'k', 3, 0, 0x31, 0x51, 0x30}) // print
	d.buf.Write([]byte{esc, 'a', 0})
	return d
}

// Bytes ends the document with a feed and a cut.
func (d *Doc) Bytes() []byte {
	out := append([]byte{}, d.buf.Bytes()...)
	out = append(out, Feed(3)...)
	return append(out, Cut()...)
}

// StatusQueries are the real-time status requests (DLE EOT n): printer, offline cause, paper roll sensor.
func StatusQueries() []byte {
	return []byte{dle, 4, 1, dle, 4, 2, dle, 4, 4}
}

// Status is what the three answers say.
type Status struct {
	Known     bool
	Online    bool
	PaperOut  bool
	CoverOpen bool
	Error     string
}

// ParseStatus reads the three answer bytes (printer, offline cause, paper sensor).
func ParseStatus(printer, offline, paper byte) Status {
	s := Status{Known: true, Online: printer&0x08 == 0}
	s.CoverOpen = offline&0x04 != 0
	s.PaperOut = paper&0x60 != 0 // roll paper end sensor
	if offline&0x40 != 0 {
		s.Error = "printer error"
		s.Online = false
	}
	if s.CoverOpen || s.PaperOut {
		s.Online = false
	}
	return s
}
