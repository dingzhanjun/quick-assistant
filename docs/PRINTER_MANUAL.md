# Kitchen printer: user manual

For restaurant owners and the person who installs the printer. No technical background needed for sections 1-5.

> **Status:** the software is finished and tested with simulated printers. It has **not yet been tried on a real Raspberry Pi
> and printer**. Steps marked ⚠ depend on real hardware behaving as expected; report anything that differs.

## 1. How it works

When a customer orders by phone, the ticket is made on our server and sent to a small computer (a **Raspberry Pi**) in your
kitchen. The Pi is plugged into the **receipt printer** by USB and prints the ticket within about a second.

```
phone order -> server makes the ticket -> Raspberry Pi in your kitchen -> USB -> receipt printer
```

- The Pi only calls out to the internet. **Nothing has to be opened on your router.**
- If the internet drops, tickets wait on the server and print when it is back. Nothing is lost.
- A ticket shows: the order number (large), the pickup time (large, "ASAP" or e.g. "6:30 PM"), the customer's name, each dish
  with quantity, chosen options and notes, and the total.
- Changed orders print with a **CHANGED (replaces #7)** banner; cancelled ones with a black **CANCELLED** banner (only if the
  original was printed).

## 2. What you need

| Item | Notes |
|---|---|
| Raspberry Pi 3, 4, 5 or Zero 2 W, power supply, microSD card (16 GB or more) | 1 GB of memory is plenty. A Pi with an Ethernet port is easiest. |
| USB receipt printer using ESC/POS | 80 mm (e.g. Epson TM-T20 / TM-T88, Xprinter, Rongta) or 58 mm paper. Tell us the exact model: some cheap models need an extra step (⚠). |
| Thermal paper rolls of the right width | |
| Ethernet cable (recommended) or the Wi-Fi name and password | Wi-Fi works but a cable is more reliable in a kitchen. |
| A computer with an SD card reader for the first setup | Only once. |
| Your dashboard login (restaurant **owner**) | Staff accounts cannot add printers. |

Place the Pi and printer away from the fryer and water, with the Pi's power plug where it will not be kicked out. One Pi can
drive one or two USB printers.

## 3. First-time setup

### Two ways to install

- **A. No computer needed at the restaurant (recommended):** you prepare the SD card at your desk with two files from the
  dashboard, post or carry it, and at the restaurant someone only plugs in the Pi, the printer and the network cable
  (section 3.1). Needs a Raspberry Pi OS **Trixie** (Debian 13) image.
- **B. With a laptop on site:** flash the card normally and paste one command over SSH (sections 3.2-3.3).

### 3.1 Option A: set up from the dashboard (SD card files)

1. Open **Raspberry Pi Imager**, choose your Pi model, **Raspberry Pi OS Lite (Trixie)** and the SD card. When asked about
   customisation, choose **No** (the dashboard files replace it). Write the card.
2. Sign in as owner → **Settings** → **Kitchen printing** → **Set up a new Pi without a monitor (SD card files)**.
3. Fill in: **Agent name** (e.g. Kitchen), **Pi host name** (e.g. `kitchen-pi`), and the restaurant's **Wi-Fi name, password and
   country** (leave Wi-Fi empty if the Pi will use a network cable). Optionally paste an engineer's **SSH public key**; without
   one nobody can log in to the Pi and you manage it from the dashboard.
4. Click **Create setup files**. A box appears with a **Download user-data** button and, if you gave Wi-Fi details, a **Download network-config** button. **Click each one** (a browser blocks automatic multiple downloads, so the page never starts them for you). If a file is missing afterwards, check the browser's download list or the address bar for a blocked-download notice, and click its button again: the files stay on the page until you leave it.
5. Check the downloaded file names: they must be exactly `user-data` and `network-config`, **without `.txt` or any other ending**.
   (On Windows turn on *View → Show → File name extensions* in File Explorer to see this; rename the files if needed.)
   Re-insert the card in your computer. A drive named **bootfs** appears. Copy the downloaded files onto it, **replacing** the
   files with the same names. Eject the card safely.
6. Put the card in the Pi and take it to the restaurant (or post it). The files contain a **one-time pairing code valid for 7
   days**: keep them private and boot the Pi within that time. If it expires, repeat steps 2-5 (a new code is made each time).
7. At the restaurant: connect the printer (switched on, paper loaded) by USB, plug in the network cable (if no Wi-Fi), then the
   power. **Nothing else.** After about 5 minutes the Pi has installed the agent and paired itself, the agent shows **Online**
   in the dashboard, and the **printer prints a short test ticket**. Go to section 3.4.

How it works: on the first boot the Pi reads `user-data`, joins the network, and a small service downloads the installer from
our server, installs the agent and pairs it with the code in the file. If the network is not up yet it keeps retrying every
minute. When done it deletes the code from the Pi. If pairing fails (code expired) the agent starts **unpaired** and prints
a setup ticket (section 7).

If the install itself cannot finish (no network, wrong Wi-Fi password, the server or the download address is unreachable), the Pi
keeps trying for **about an hour** (12 attempts). After that it **gives up and prints a "SETUP FAILED" ticket** with the reason
(for example "cannot download the installer from https://… (no network, or the server is down)") and stops retrying. To try again,
fix the cause (cable, Wi-Fi password, server address) and flash the card again with new files from the dashboard.

### 3.2 Option B: prepare the SD card (with a laptop on site)

1. Install **Raspberry Pi Imager** (raspberrypi.com/software).
2. Choose your Pi model, then **Raspberry Pi OS Lite (64-bit)** (32-bit on a Pi Zero or very old Pi), then your SD card.
3. Click **Edit settings** (the gear) and set: a **host name** (e.g. `kitchen-pi`), a **user name and password** (write them down),
   your **Wi-Fi name and password** if not using a cable, your **time zone**, and **enable SSH**.
4. Write the card, put it in the Pi, connect the printer (switched on, paper loaded) by USB, plug in the network cable, then
   the power. Wait about 2 minutes for the first start.

### 3.3 Option B: pairing code and install command

1. Sign in as owner → **Settings** → **Kitchen printing**. Under **Print agents**, type a name (e.g. `Kitchen`) and click **Get
   pairing code**. A box appears with the **code** (like `K7QM-4TWX`) and a **command to copy**. This code works **once** and
   for **15 minutes**; if it expires, click **New pairing code** next to the agent.
2. Connect to the Pi from your computer (Mac/Linux: Terminal; Windows: PowerShell):
   `ssh YOURUSER@kitchen-pi.local` (the user and host name from step 3.2; type the password). If that name is not found, look up
   the Pi's address in your router's device list and use `ssh YOURUSER@192.168.x.x`.
3. Paste the command from the dashboard and press Enter. It looks like:
   `curl -fsSL https://YOUR-SERVER/install-printer.sh | sudo sh -s -- K7QM-4TWX --server https://YOUR-SERVER --base https://...`
4. Wait about a minute. At the end it says **Done**. The installer downloads the program for your Pi's CPU, checks it, installs
   it as a service that starts by itself at every boot, and pairs it with your restaurant.

### 3.4 Check that it works

1. In **Settings → Kitchen printing** (the page refreshes by itself): the agent shows **Online** with the Pi's address, and a
   **printer** row appears (named "Kitchen") with status **Ready**. ⚠
2. Click **Test print** on the printer row. A TEST ticket should print within a few seconds.
3. Set the paper width (**80 mm** or **58 mm**) on the printer row and click **Save**. Test again if you changed it.
4. Place a real test order by phone. The ticket prints, and on the **Orders** board the order shows **Printed**.

## 4. Settings you control

In **Settings → Kitchen printing**:

- **When to print a new phone order**: *Immediately* (default), or *Only after the restaurant confirms it*: the new order's button on the
  Orders board then reads **Confirm & Print**, and the ticket is sent to the kitchen printer only when someone presses it (owner or staff).
  The same press moves the order to *preparing*; an order nobody confirms is never printed (and still triggers the "not acknowledged" reminder email).
- **Each printer**: name, paper width, number of **copies** (1-3), **On/Off** switch (Off = nothing prints on it), **Save**,
  **Test print**, **Remove**.

Click **Save printing settings** for the first two. Every change is recorded in the audit log.

## 5. Every day

- **Keep the printer switched on and loaded with paper.** Keep the Pi powered. Nothing else is needed.
- The **Orders** board shows for each order: **Printed**, **Printing…** (on its way), **Not printed** (e.g. waiting for staff
  to press **Confirm & Print**, if you chose that), or **Print failed**. These update live.
- **Reprint**: press **Reprint** on any order card (staff can too). The ticket prints again marked **REPRINT**.
- **Change Pickup Time**: if you move an order's pickup time on its card, the printed ticket is **not** reprinted automatically; press
  **Reprint** so the kitchen has a ticket with the new time (a reprint always shows the current pickup time).
- **Paper out / cover open**: the printer row in Settings shows it; refill and the waiting tickets print by themselves. ⚠
- **Power cut**: the Pi and printer start again by themselves; unprinted tickets are printed then.
- **Never unplug the Pi to restart it if you can avoid it**; use **Restart** or **Reboot** (section 6). If you must, wait 10
  seconds before plugging back in.

## 6. When something is wrong

Start in **Settings → Kitchen printing**: it shows what the Pi last reported.

| What you see | Likely cause and what to do |
|---|---|
| Agent shows **Offline** (red dot) | Pi has no power or no internet. Check its power light, network cable / Wi-Fi, router. It reconnects by itself. |
| Agent **Online**, printer **Agent offline** or **Printer not responding** | Printer is off, unplugged from the Pi, or in an error. Switch the printer off and on, reseat the USB cable, then click **Re-detect printers**. |
| **Out of paper** / **Cover open** | Fix and close; tickets in the queue then print. |
| Tickets print but are blank, cut off or garbled ⚠ | Wrong paper width setting (use the printer row), or paper loaded the wrong way round (the shiny side is the heat side, usually outwards). Run **Test print**. |
| **Print failed** on an order | The Pi could not reach the printer 5 times. Fix the printer, then press **Reprint** on the order. |
| An order stays on **Printing…** although the ticket came out | a second, old print agent (from a replaced Pi that was never revoked) is still on the list, and every ticket also waits for it | In Settings → Kitchen printing look for a second agent that is **Offline**: **Revoke** and **Delete** it. The board now shows **Printed** when the real printer printed, and **Waiting for the printer (offline)** when nothing has printed and the only printer is offline |
| Nothing prints, everything looks fine | Check the printer row's **On** switch is on, and the order was placed after the printer was added. |
| The printer printed **SETUP FAILED** | The Pi could not install the agent within about an hour. Read the reason on the ticket: check the network cable / Wi-Fi name and password, make sure the Pi can reach the internet, then flash the card again with new files (section 3.1). |
| **Waiting to pair** never changes | The code expired (15 minutes) or was typed wrongly: click **New pairing code** and run the command again. |
| You replaced the Pi or SD card | Add a new print agent (3.2), run the new command, then **Revoke** the old agent. The printer row is created again; remove the old one with **Remove**. |

### The Service buttons

Under each agent (visible to the owner, and to our support staff in the platform admin). There is **no remote shell**: only
these fixed actions, each recorded in the audit log. The agent must be **Online**; results appear a few seconds later.

| Button | What it does |
|---|---|
| Restart the agent | Restarts the program (not the whole Pi). First thing to try. |
| Print a test ticket | Prints a small ticket with the Pi's version, host name and address (proves the USB link). |
| Show the last log lines | Shows the agent's recent messages. Send these to support if asked. |
| Update the agent software | Installs the newest version (it also checks by itself every 6 hours). Keeps the old one in case of trouble. |
| Re-detect printers | Looks for printers again after you reconnect one. |
| Reboot the Pi | Restarts the Pi; printing resumes after about a minute. |
| Print the setup ticket | Prints the Pi's address and a PIN and opens the local setup page for 15 minutes (section 7). |

### Finding the Pi's address

The Service panel shows the Pi's **local IP**, **host name** and **version** (and when it was last heard from). A technician
can open the dashboard (or `/admin/printing` for platform admins) on a phone and read them there. No app to install.

## 7. If the Pi has no internet (local setup page)

For a Pi that cannot reach the server (wrong Wi-Fi password, new router, not yet paired). It works from a phone or laptop on the
**same network**.

1. Get the **setup ticket**: a new, unpaired Pi prints one by itself; otherwise press **Print the setup ticket** in the dashboard
   (needs internet) or power-cycle a Pi that is unpaired. It shows the **address**, **host name**, version, a **6-digit PIN** and
   a **QR code** (⚠ some printers do not print the QR; the address is also written out).
2. Open the address, e.g. `https://192.168.1.47:8080`, in a browser (scan the QR code or type it). Your browser warns about the
   certificate: this is expected for a private device. Choose to continue.
3. Enter the **PIN**. Five wrong PINs lock the page for 15 minutes; a new ticket unlocks it.
4. The page offers only: **status**, **pair** (server address + a new pairing code), **Wi-Fi** (network name and password; a
   network cable needs none), and **Print a test ticket**.

The page is switched **off** while the Pi is paired and online, so it cannot be reached in normal operation.

## 8. Moving, replacing or removing

- **Different network / new Wi-Fi password**: use section 7 (Wi-Fi), or put the Pi on a cable.
- **New printer, same Pi**: plug it in, **Re-detect printers**, then set the paper width and press **Test print**.
- **New Pi**: install it as in section 3 (option A again: new files, new code), then **Revoke** the old agent (it stops immediately and cannot print again).
- **Stop printing for now**: switch the printer row **Off**, or **Revoke** the agent.
- **Uninstall from a Pi** (on the Pi): `sudo systemctl disable --now order-printer`, then
  `sudo rm -rf /opt/order-printer /etc/order-printer /var/lib/order-printer /usr/local/bin/order-printer /etc/systemd/system/order-printer.service /etc/sudoers.d/order-printer /etc/udev/rules.d/99-order-printer.rules`
  and `sudo userdel orderprinter`.

## 9. Safety and privacy

- The Pi connects **outwards only** over encrypted HTTPS. No port is opened and nothing on your network can reach it except the
  PIN-protected setup page when you open it.
- Each Pi has its own secret key, which you can cancel at any time with **Revoke**. Tickets of one restaurant are never sent to
  another restaurant's Pi.
- Tickets contain the customer's name (as given on the call) and order, not their phone number.
- Tickets and their pictures are kept on our server for **30 days**, then deleted.
- Software updates are only accepted over https from our own server and only if they match their checksum.

## 10. For the installer: acceptance checklist

Tick each item on site; this is the real-hardware test the software is still waiting for.

- [ ] Pi boots headless and joins the network (cable and/or Wi-Fi). For option A: after about 5 minutes the agent is Online and a test ticket printed, with no keyboard or monitor. ⚠ (cloud-init on the real Trixie image; send us `/var/log/cloud-init-output.log` and `journalctl -u order-printer-firstboot` if not)
- [ ] `ls /dev/usb/` on the Pi shows `lp0` with the printer connected (if not: the printer needs the libusb fallback, tell us the model).
- [ ] Install command finishes with **Done**; `systemctl status order-printer` shows **active (running)**.
- [ ] Dashboard: agent **Online**, IP and version shown, printer **Ready**.
- [ ] **Test print** prints a TEST ticket in under 5 seconds, sharp, correct width, cut at the end.
- [ ] A phone test order prints within about 2 seconds, pickup time large.
- [ ] Cancel and change the test order by phone: CANCELLED / CHANGED tickets print.
- [ ] Pull the paper: status shows **Out of paper**; refill, the held ticket prints. Open the cover: **Cover open**. ⚠
- [ ] Unplug the network for 2 minutes during an order, then plug in: the ticket prints once, not twice.
- [ ] Unplug the Pi's power and restore it: it comes back by itself, no ticket lost or duplicated.
- [ ] **Show the last log lines**, **Restart the agent** and **Reboot the Pi** all work from the dashboard.
- [ ] **Print the setup ticket**: PIN works at `https://<ip>:8080`; QR scans (or note that it does not).
- [ ] **Revoke** the agent: the Pi stops printing; pair again with a new code.
- [ ] Note the printer model, paper width, print speed and anything odd, and send it to us.

## 11. Getting help

Send support: the restaurant name, what you see in **Settings → Kitchen printing** (a screenshot), the result of **Show the
last log lines**, and the time of the order that did not print.

For developers: technical details are in `PRINTING_PLAN.md` and `apps/printer-agent/README.md`.
