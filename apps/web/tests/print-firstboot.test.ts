// Monitor-less setup files (cloud-init user-data / network-config for the SD card boot partition).
import assert from "node:assert/strict";
import { pbkdf2Sync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { buildFirstBootFiles, validateFirstBoot, type FirstBootInput } from "../src/lib/print/firstboot";

const base: FirstBootInput = {
  hostname: "kitchen-pi", timezone: "America/New_York", code: "K7QM-4TWX",
  server: "https://orders.example.com", base: "https://github.com/o/r/releases/download/printer-v1.0.0",
};
const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOxamplekeyxamplekeyxamplekeyxamplekeyxample1 me@laptop";

test("user-data is valid cloud-config with the first-boot installer", () => {
  const { userData, networkConfig } = buildFirstBootFiles(base);
  assert.ok(userData.startsWith("#cloud-config\n"));
  const y = parse(userData);
  assert.equal(y.hostname, "kitchen-pi");
  assert.equal(y.timezone, "America/New_York");
  assert.equal(networkConfig, null, "no Wi-Fi given: Ethernet needs no network-config");
  const files = Object.fromEntries(y.write_files.map((f: { path: string }) => [f.path, f]));
  assert.equal(files["/etc/order-printer-firstboot.conf"].content, "CODE=K7QM-4TWX\nSERVER=https://orders.example.com\nBASE=https://github.com/o/r/releases/download/printer-v1.0.0\n");
  assert.equal(files["/etc/order-printer-firstboot.conf"].permissions, "0600", "the code is private");
  assert.equal(files["/usr/local/sbin/order-printer-firstboot.sh"].permissions, "0755");
  assert.match(files["/usr/local/sbin/order-printer-firstboot.sh"].content, /^#!\/bin\/sh\n/);
  assert.match(files["/usr/local/sbin/order-printer-firstboot.sh"].content, /install-printer\.sh/);
  assert.match(files["/etc/systemd/system/order-printer-firstboot.service"].content, /ConditionPathExists=!\/opt\/order-printer\/order-printer/);
  assert.deepEqual(y.runcmd.at(-1), ["systemctl", "start", "--no-block", "order-printer-firstboot.service"]);
  assert.equal(y.ssh_pwauth, false);
  assert.equal(y.users[0].lock_passwd, true);
  assert.equal(y.users[0].ssh_authorized_keys, undefined, "no key given: nobody can log in");
  assert.equal(y.enable_ssh, undefined, "no key: the SSH server stays off");
});

test("an SSH key gives an engineer access (key only, never a password)", () => {
  const y = parse(buildFirstBootFiles({ ...base, sshKey: KEY }).userData);
  assert.deepEqual(y.users[0].ssh_authorized_keys, [KEY]);
  assert.equal(y.enable_ssh, true, "Raspberry Pi OS's documented switch for the SSH server (it is off by default)");
  assert.equal(y.users[0].lock_passwd, true);
  assert.ok(y.runcmd.some((c: unknown) => JSON.stringify(c) === JSON.stringify(["systemctl", "enable", "--now", "ssh"])));
});

test("Wi-Fi goes into network-config as a derived key, never the plain password", () => {
  const wifi = { ssid: "Cafe \"Wi-Fi\" #1", password: "correct horse battery", country: "US" };
  const { networkConfig, userData } = buildFirstBootFiles({ ...base, wifi });
  const y = parse(networkConfig!);
  const ap = y.network.wifis.wlan0["access-points"];
  assert.deepEqual(Object.keys(ap), [wifi.ssid], "odd characters in the name survive quoting");
  assert.equal(ap[wifi.ssid].password, pbkdf2Sync(wifi.password, wifi.ssid, 4096, 32, "sha1").toString("hex"));
  assert.equal(y.network.wifis.wlan0["regulatory-domain"], "US");
  assert.ok(!networkConfig!.includes(wifi.password) && !userData.includes(wifi.password));
  assert.ok(parse(userData).runcmd.some((c: unknown) => JSON.stringify(c).includes("do_wifi_country US")));
});

test("every field is validated (nothing can inject into the files or the shell script)", () => {
  const bad: [Partial<FirstBootInput>, RegExp][] = [
    [{ hostname: "Kitchen Pi" }, /Host name/], [{ hostname: "a;rm" }, /Host name/], [{ hostname: "-x" }, /Host name/],
    [{ code: "AB'; rm -rf /" }, /pairing code/], [{ server: "ftp://x.example.com" }, /http/], [{ base: "http://x.example.com/rel" }, /https/], [{ server: "https://x.example.com/ $(id)" }, /http/],
    [{ base: "https://x.example.com\nBASE=evil" }, /https/], [{ timezone: "A/B; rm" }, /time zone/],
    [{ sshKey: "ssh-ed25519 AAAA\nssh-rsa evil" }, /SSH/], [{ sshKey: "not a key" }, /SSH/],
    [{ wifi: { ssid: "", password: "correct horse", country: "US" } }, /Wi-Fi name/],
    [{ wifi: { ssid: "x", password: "short", country: "US" } }, /password/],
    [{ wifi: { ssid: "x", password: "correct horse", country: "usa" } }, /country/],
  ];
  for (const [patch, re] of bad) {
    const err = validateFirstBoot({ ...base, ...patch });
    assert.match(err ?? "", re, JSON.stringify(patch));
    assert.throws(() => buildFirstBootFiles({ ...base, ...patch }));
  }
  assert.equal(validateFirstBoot({ ...base, sshKey: KEY, wifi: { ssid: "Net", password: "correct horse", country: "GB" } }), null);
});

test("the embedded first-boot script is valid shell", () => {
  const y = parse(buildFirstBootFiles(base).userData);
  const script = y.write_files.find((f: { path: string }) => f.path.endsWith("order-printer-firstboot.sh")).content as string;
  const f = path.join(mkdtempSync(path.join(tmpdir(), "fb-")), "s.sh");
  writeFileSync(f, script);
  execFileSync("sh", ["-n", f]); // throws on a syntax error
});

// ---- the first-boot script itself, run for real in a sandbox (fake paths, stubbed curl / systemctl) ----
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";

function sandbox(curl: "ok" | "down", installer: "ok" | "fail" = "ok") {
  const dir = mkdtempSync(path.join(tmpdir(), "fbrun-"));
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  const stub = (name: string, body: string) => { writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(path.join(bin, name), 0o755); };
  // curl: fails (no network) or writes an installer that succeeds / fails (the installed "agent" is a file named order-printer)
  stub("curl", curl === "down" ? "exit 6" : `out=""; while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done
printf '%s\\n' '${installer === "ok" ? `touch "${dir}/order-printer"; chmod +x "${dir}/order-printer"; exit 0` : "exit 1"}' > "$out"`);
  stub("systemctl", `echo "$@" >> "${dir}/systemctl.log"`);
  stub("sleep", "exit 0");
  writeFileSync(path.join(dir, "conf"), "CODE=K7QM-4TWX\nSERVER=https://orders.example.com\nBASE=https://dl.example.com/v1\n");
  writeFileSync(path.join(dir, "lp0"), ""); // stands in for the printer device
  const script = (parse(buildFirstBootFiles(base).userData).write_files as { path: string; content: string }[]).find((f) => f.path.endsWith("firstboot.sh"))!.content;
  writeFileSync(path.join(dir, "firstboot.sh"), script);
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, FB_CONF: path.join(dir, "conf"), FB_BIN: path.join(dir, "order-printer"), FB_STATE: path.join(dir, "state"),
    FB_DEVS: path.join(dir, "lp*"), FB_TMP: path.join(dir, "installer.sh"), FB_TRIES: "2", FB_PAUSE: "0", FB_MAX_RUNS: "3",
  };
  const run = () => { try { execFileSync("sh", [path.join(dir, "firstboot.sh")], { env, stdio: "pipe" }); return 0; } catch (e) { return (e as { status: number }).status; } };
  return { dir, run, read: (f: string) => readFileSync(path.join(dir, f), "utf8"), has: (f: string) => existsSync(path.join(dir, f)) };
}

test("first boot: retries while the network is down, then gives up with a printed ticket and stops", () => {
  const s = sandbox("down");
  assert.deepEqual([s.run(), s.run(), s.run()], [1, 1, 1], "runs 1-3 fail and are retried");
  assert.equal(s.read("state/runs").trim(), "3");
  assert.match(s.read("state/last-error"), /cannot download the installer from https:\/\/orders\.example\.com/);
  assert.equal(s.has("state/failed"), false, "still trying");
  assert.equal(s.read("lp0"), "", "nothing printed yet");

  assert.equal(s.run(), 0, "run 4 gives up (exit 0, so systemd does not restart it)");
  assert.equal(s.has("state/failed"), true, "marker: the unit's ConditionPathExists stops it from starting again");
  assert.match(s.read("systemctl.log"), /disable order-printer-firstboot\.service/);
  const ticket = s.read("lp0");
  assert.match(ticket, /SETUP FAILED/);
  assert.match(ticket, /cannot download the installer/);
  assert.ok(ticket.startsWith("\x1b@") && ticket.includes("\x1dVB\x03"), "ESC/POS reset first, cut last");
});

test("first boot: a failing installer is retried and reported with its own reason", () => {
  const s = sandbox("ok", "fail");
  assert.equal(s.run(), 1);
  assert.match(s.read("state/last-error"), /the installer failed/);
  assert.equal(s.has("state/failed"), false);
});

test("first boot: success cleans up (code deleted) and later runs do nothing", () => {
  const s = sandbox("ok", "ok");
  assert.equal(s.run(), 0);
  assert.equal(s.has("order-printer"), true, "agent installed");
  assert.equal(s.has("conf"), false, "the pairing code is deleted");
  assert.equal(s.has("state"), false, "retry counter cleaned up");
  assert.equal(s.run(), 0, "already installed: exits at once");
  assert.equal(s.has("state"), false);
});

test("first boot: the unit does not start again once it has given up or installed", () => {
  const unit = (parse(buildFirstBootFiles(base).userData).write_files as { path: string; content: string }[]).find((f) => f.path.endsWith(".service"))!.content;
  assert.match(unit, /ConditionPathExists=!\/opt\/order-printer\/order-printer/);
  assert.match(unit, /ConditionPathExists=!\/var\/lib\/order-printer-firstboot\/failed/);
});
