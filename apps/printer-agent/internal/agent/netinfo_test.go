package agent

import (
	"net"
	"strings"
	"testing"
)

func cidr(t *testing.T, s string) net.Addr {
	ip, n, err := net.ParseCIDR(s)
	if err != nil {
		t.Fatal(err)
	}
	n.IP = ip
	return n
}

func TestFirstIPv4SkipsIPv6LoopbackAndLinkLocal(t *testing.T) {
	addrs := []net.Addr{
		cidr(t, "::1/128"),                      // IPv6 loopback
		cidr(t, "2600:1700:abcd::5/64"),         // global IPv6: must NOT be reported
		cidr(t, "fe80::1c2b:3d4e:5f60:7182/64"), // IPv6 link-local
		cidr(t, "127.0.0.1/8"),                  // IPv4 loopback
		cidr(t, "169.254.12.34/16"),             // IPv4 link-local (DHCP failed)
		cidr(t, "192.168.1.47/24"),              // the real address
		cidr(t, "10.0.0.9/8"),                   // a second one: the first usable wins
	}
	if got := firstIPv4(addrs); got != "192.168.1.47" {
		t.Fatalf("got %q", got)
	}
}

func TestFirstIPv4EmptyWithoutIPv4(t *testing.T) {
	if got := firstIPv4([]net.Addr{cidr(t, "2600:1700::5/64"), cidr(t, "fe80::1/64")}); got != "" {
		t.Fatalf("an IPv6-only machine must report nothing, got %q", got)
	}
}

func TestLANIPIsNeverIPv6(t *testing.T) {
	// whatever route the test machine has (IPv4, IPv6-only server name, no network), the answer is empty or a dotted IPv4
	for _, server := range []string{"https://example.com", "http://[::1]:3000", "https://localhost", "", "not a url"} {
		got := LANIP(server)
		if got == "" {
			continue
		}
		ip := net.ParseIP(got)
		if ip == nil || ip.To4() == nil || strings.Contains(got, ":") {
			t.Errorf("LANIP(%q) = %q, not an IPv4 address", server, got)
		}
	}
}
