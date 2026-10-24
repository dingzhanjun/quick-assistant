package agent

import (
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// LANIP is the IPv4 address this machine uses to reach the server (what a technician types to find the Pi). IPv4 only, on purpose:
// an IPv6 address is long, changes with privacy extensions and is useless for typing into a browser or an SSH command. The route
// is probed with a "udp4" dial (a plain "udp" dial would pick IPv6 whenever the server has an AAAA record); with no usable route
// it falls back to the first IPv4 address of any interface. Empty if the machine has no IPv4 address.
func LANIP(server string) string {
	if u, err := url.Parse(server); err == nil && u.Host != "" {
		host := u.Host
		if !strings.Contains(host, ":") || strings.HasSuffix(host, "]") { // no port given (an IPv6 literal also contains ":")
			if u.Scheme == "http" {
				host += ":80"
			} else {
				host += ":443"
			}
		}
		if c, err := net.DialTimeout("udp4", host, 2*time.Second); err == nil { // no packet is sent for UDP
			defer c.Close()
			if a, ok := c.LocalAddr().(*net.UDPAddr); ok && usableIPv4(a.IP) {
				return a.IP.String()
			}
		}
	}
	addrs, _ := net.InterfaceAddrs()
	return firstIPv4(addrs)
}

// usableIPv4: a real IPv4 address, not loopback (127.x) and not link-local (169.254.x, what a Pi gets when DHCP fails).
func usableIPv4(ip net.IP) bool {
	return ip != nil && ip.To4() != nil && !ip.IsLoopback() && !ip.IsLinkLocalUnicast()
}

func firstIPv4(addrs []net.Addr) string {
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok && usableIPv4(n.IP) {
			return n.IP.String()
		}
	}
	return ""
}

func Hostname() string { h, _ := os.Hostname(); return h }

// UptimeSeconds reads /proc/uptime (Linux); 0 elsewhere.
func UptimeSeconds() int {
	b, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return 0
	}
	f, err := strconv.ParseFloat(strings.Fields(string(b))[0], 64)
	if err != nil {
		return 0
	}
	return int(f)
}
