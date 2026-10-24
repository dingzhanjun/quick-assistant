package escpos

import (
	"bytes"
	"image"
	"image/color"
	"testing"
)

func blank(w, h int) *image.Gray {
	g := image.NewGray(image.Rect(0, 0, w, h))
	for i := range g.Pix {
		g.Pix[i] = 255
	}
	return g
}

func TestRasterBitsAndHeader(t *testing.T) {
	g := blank(10, 2)
	g.SetGray(0, 0, color.Gray{0}) // top-left ink
	g.SetGray(9, 1, color.Gray{0}) // bottom-right ink
	out, err := Raster(g)
	if err != nil {
		t.Fatal(err)
	}
	// GS v 0 m xL xH yL yH: width 10 px = 2 bytes, height 2
	want := []byte{0x1d, 'v', '0', 0, 2, 0, 2, 0, 0x80, 0x00, 0x00, 0x40}
	if !bytes.Equal(out, want) {
		t.Fatalf("got % x want % x", out, want)
	}
}

func TestRasterBandsAreContinuous(t *testing.T) {
	out, err := Raster(blank(8, 130))
	if err != nil {
		t.Fatal(err)
	}
	// two bands: 128 rows then 2 rows, each header 8 bytes + rows*1 byte
	if len(out) != 8+128+8+2 {
		t.Fatalf("length %d", len(out))
	}
	if out[6] != 128 || out[8+128+6] != 2 {
		t.Fatalf("band heights %d, %d", out[6], out[8+128+6])
	}
}

func TestRasterRejectsAbsurdImages(t *testing.T) {
	if _, err := Raster(blank(5000, 10)); err == nil {
		t.Fatal("5000 px wide accepted")
	}
	if _, err := Raster(image.NewGray(image.Rect(0, 0, 0, 0))); err == nil {
		t.Fatal("empty image accepted")
	}
}

func TestGreyAndColourInputAreThresholded(t *testing.T) {
	c := image.NewRGBA(image.Rect(0, 0, 8, 1))
	for x := 0; x < 8; x++ {
		v := uint8(255)
		if x < 4 {
			v = 60 // dark
		}
		c.Set(x, 0, color.RGBA{v, v, v, 255})
	}
	out, _ := Raster(c)
	if out[len(out)-1] != 0xf0 {
		t.Fatalf("got %08b", out[len(out)-1])
	}
}

func TestTicketStructure(t *testing.T) {
	out, err := Ticket(blank(8, 1), true)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(out, []byte{0x1b, '@'}) {
		t.Fatal("does not start with init")
	}
	if !bytes.HasSuffix(out, Cut()) {
		t.Fatal("does not end with a cut")
	}
	if !bytes.Contains(out, Beep()) {
		t.Fatal("no beep for a new order")
	}
	quiet, _ := Ticket(blank(8, 1), false)
	if bytes.Contains(quiet, Beep()) {
		t.Fatal("beep on a non-new ticket")
	}
}

func TestDocIsASCIIOnly(t *testing.T) {
	b := NewDoc().Line("Café ñ", false, false, 1).Bytes()
	if !bytes.Contains(b, []byte("Caf? ?\n")) {
		t.Fatalf("% q", b)
	}
}

func TestQRStoresData(t *testing.T) {
	b := NewDoc().QR("https://10.0.0.5:8080").Bytes()
	if !bytes.Contains(b, []byte("https://10.0.0.5:8080")) || !bytes.Contains(b, []byte{0x1d, '(', 'k', 3, 0, 0x31, 0x51, 0x30}) {
		t.Fatal("QR commands missing")
	}
}

func TestParseStatus(t *testing.T) {
	if s := ParseStatus(0x12, 0x00, 0x00); !s.Online || s.PaperOut || s.CoverOpen {
		t.Fatalf("%+v", s)
	}
	if s := ParseStatus(0x12, 0x04, 0x00); !s.CoverOpen || s.Online {
		t.Fatalf("cover: %+v", s)
	}
	if s := ParseStatus(0x12, 0x00, 0x60); !s.PaperOut || s.Online {
		t.Fatalf("paper: %+v", s)
	}
	if s := ParseStatus(0x1a, 0x00, 0x00); s.Online {
		t.Fatalf("offline bit: %+v", s)
	}
}
