# Deploying to an Ubuntu server (Docker Compose)

> **Simplest path:** `docker-compose.yml` pulls the ready-made public images from GHCR and needs no GitHub login or CI: see "Deploy it for your
> restaurant" in the [README](../README.md). This guide covers the developer pipeline (CI builds images into GHCR, `docker-compose.yml`,
> `scripts/deploy.sh`, automatic deploys), plus operations that apply to both: backups, scaling, tunnel mode, printers.

One server runs everything in containers (`docker-compose.yml`):

| Service | What it is |
|---|---|
| `caddy` *or* `cloudflared` | The single public entry point, chosen with `COMPOSE_PROFILES` in `.env` (see below). `caddy`: HTTPS via Let's Encrypt on ports 80/443. `cloudflared`: outbound-only Cloudflare Tunnel, no open ports |
| `web` | Next.js app (dashboard, admin, agent API) |
| `db` | Postgres 16, data in a Docker volume, **not** published to the network |
| `migrate` | One-shot job that applies DB migrations before `web` is replaced, on every deploy |
| `backup` | Dumps the database daily at 03:00 UTC to `./backups` (verified, newest 14 kept). No host cron needed |
| `worker` | A small separate program (`worker.cjs`, shipped inside the web image, no Next.js, about 15 MB idle): sends queued emails and texts with retries. Health check: its own `/health` |
| `agent` | Python LiveKit voice worker. Outbound connections only (LiveKit, and `web` over the internal network) |

Images are built **once, in CI**, pushed to GitHub Container Registry (GHCR), and the server only pulls them:
what runs in production is exactly what passed CI. Nothing is compiled on the server.

Voice and phone numbers stay on **LiveKit Cloud** (the agent connects out to it). Self-hosting LiveKit's
SIP stack is a much larger project and isn't covered here. Commands for third-party tools are from
memory; check each provider's current docs.

## 0. Choose how traffic reaches the server

| | `COMPOSE_PROFILES=caddy` | `COMPOSE_PROFILES=tunnel` |
|---|---|---|
| Needs | Public IP, ports 80/443 open, DNS A record | A Cloudflare account with your domain's DNS on Cloudflare |
| TLS | Caddy + Let's Encrypt | Cloudflare edge |
| Server IP exposed | Yes | No |
| Works behind home/office NAT | No | Yes |
| Extras | Nothing else to depend on | DDoS/WAF/rate-limit rules, optional Cloudflare Access in front of `/admin` |

Either way voice is unaffected: the agent connects *out* to LiveKit and reaches the web app over the
internal Docker network, so phone calls never go through Caddy or the tunnel. If Cloudflare is down the
dashboard is unreachable but the phone agent keeps working.

## 1. Server prep
- Ubuntu 22.04/24.04, about 2 GB RAM (web, agent and Postgres all run here; I haven't measured their real footprint).
  Nothing is built on the server in the normal flow, so it doesn't need build-sized memory.
- **Caddy mode:** DNS **A record** for your domain (e.g. `app.example.com`) pointing at the server's IP.
  Caddy can't get a certificate until this resolves, and repeated failed attempts can hit Let's Encrypt rate
  limits, so check DNS first. **Tunnel mode:** no A record; see "Cloudflare Tunnel setup" below.
- Install Docker Engine + the Compose plugin from Docker's official apt repository
  (docs.docker.com/engine/install/ubuntu), then `sudo usermod -aG docker $USER` and log in again.
- Firewall (Caddy mode; in tunnel mode allow only SSH, since nothing needs to be reachable inbound):
  ```
  sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw enable
  ```
  Note Docker can bypass ufw for ports it publishes. That's fine here because the compose file publishes
  only 80/443; don't add `ports:` to `db` or `web`.

## 2. Configure
```
# The server does NOT clone the repo. Copy the deployment files from your machine (see "Deployment files" below):
ssh you@server 'sudo mkdir -p /opt/quick-assistant && sudo chown $USER /opt/quick-assistant'
rsync -av --relative docker-compose.yml scripts/ you@server:/opt/quick-assistant/     # run in the repo root
# then, on the server:
cd /opt/quick-assistant && chmod +x scripts/*.sh     # scripts/ is only needed for deploy.sh (CI deploys); a plain install can skip it
cp .env.prod.example .env   # or copy your prepared .env here
chmod 600 .env
nano .env            # fill everything in; generate secrets with: openssl rand -hex 32
```
Required: `DOMAIN`, `COMPOSE_PROFILES` (`caddy` or `tunnel`; with neither, nothing is publicly reachable),
`IMAGE_PREFIX` (`ghcr.io/<github-user-or-org>/<repo>`, all lowercase),
`CLOUDFLARE_TUNNEL_TOKEN` (tunnel mode only), `POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`, `AGENT_API_KEY`, the `LIVEKIT_*` trio,
`DEEPGRAM_API_KEY`, and at least one of `OPENAI_API_KEY` / `DEEPSEEK_API_KEY`. Compose refuses to start if a
required one is missing. Use fresh secrets, never the dev ones. `.env` is gitignored; keep it that way.

`POSTGRES_PASSWORD` is only used when the database is first created. Changing it later does not change the
password inside an existing volume.

**Let the server pull private images from GHCR** (one time, as the user that runs deploys): create a GitHub
personal access token that can read packages (classic token with `read:packages`; fine-grained tokens may not
support packages, so check GitHub's current docs), then
`echo <token> | docker login ghcr.io -u <github-username> --password-stdin`. The login is stored in
`~/.docker/config.json`, so keep that file private. Packages pushed by CI are private by default. Keep them private
if your fork is private (the images contain your application code); for a public open-source fork you may make them public in the
package settings, and then the server needs no login. The images never contain secrets: `.env` files are excluded from the build and
real values are injected at runtime.

## 3. First deploy
CI must have run on `main` at least once so the images exist in GHCR (push your code; the `build-image` jobs build and
push them). Then on the server:
```
./scripts/deploy.sh latest             # deploys the newest main build (Dev server: `dev`)
docker compose --env-file .env -f docker-compose.yml ps
curl https://$DOMAIN/api/health        # {"ok":true}
```

**Always deploy with `scripts/deploy.sh`, not bare `docker compose up`**: the script sets `IMAGE_TAG` to the
commit being deployed, takes a backup, runs migrations before swapping containers, and waits for health. The
server never touches git: it runs the images of the commit you name, with the deployment files you copied.

Tip: `export COMPOSE_FILE=docker-compose.yml COMPOSE_ENV_FILES=.env` shortens read-only commands to
`docker compose ps`, `docker compose logs -f web`, etc.

Containers use `restart: unless-stopped` and Docker starts on boot, so everything comes back after a reboot.

### Cloudflare Tunnel setup (tunnel mode)
Menu names in the Cloudflare dashboard change; this is from memory.
1. Put your domain on Cloudflare (nameservers pointed at Cloudflare).
2. Zero Trust dashboard -> Networks -> Tunnels -> **Create a tunnel** (type: Cloudflared). Name it. Copy the
   **token** (it's the long string in the install command shown) into `.env` as
   `CLOUDFLARE_TUNNEL_TOKEN`. Skip Cloudflare's "install connector" step; the `cloudflared` container is the connector.
3. Add a **public hostname**: your `DOMAIN`, service type **HTTP**, URL **`web:3000`**. Cloudflare creates the
   proxied DNS record for you.
4. **Block the agent API publicly.** The agent calls `/api/agent/*` internally, so the internet never needs it.
   In Cloudflare -> Security -> WAF -> Custom rules, add: *URI Path starts with `/api/agent`* -> **Block**.
   (Caddy mode does this for you in the `caddyfile` config inside `docker-compose.yml`. The API key still protects it either way.)
5. `docker compose up -d`; the connector shows as healthy in the dashboard and `https://<DOMAIN>/api/health`
   returns `{"ok":true}`.
6. Optional: Cloudflare Access policy on `/admin*` (e.g. allow only your email) as a second lock.

Notes for tunnel mode: Cloudflare terminates TLS, so it can see traffic including login cookies. Real visitor
IPs arrive in the `CF-Connecting-IP` header (matters when rate limiting is added). Keep the email DNS records
for Resend (SPF/DKIM) as **DNS only**, not proxied. Treat the tunnel token as a secret.

## 4. Google sign-in
In Google Cloud Console, on the OAuth client add:
- Authorized JavaScript origin: `https://<DOMAIN>`
- Redirect URI: `https://<DOMAIN>/api/auth/callback/google`

In "Testing" status only listed test users can sign in; publish the consent screen before launch (basic
email/profile scopes don't need Google's full verification). Then `docker compose up -d` to pick up any
`.env` change.

**No Google account yet?** On a brand-new system set `PLATFORM_ADMIN_EMAILS` and `PLATFORM_ADMIN_PASSWORD` (at least 12 characters) in
`.env` and deploy: if no platform admin exists, the first listed email is created as a verified admin with that password and can
sign in with it on the normal login page. Set up Google sign-in, then **delete `PLATFORM_ADMIN_PASSWORD` and redeploy**: password
sign-in for admins works only while the variable is set. It never changes an account that already exists.

## 5. Email (Resend)
Verify a sending domain (add the DNS records they give you), create an API key, set `RESEND_API_KEY` and
`EMAIL_FROM` (e.g. `Quick Assistant <orders@yourdomain.com>`), re-run `up -d`. **Until this is done nobody
receives verification, reset or new-order emails**; they are only printed in `docker compose logs web`.

## 5b. Text messages (optional)
Set `SMS_PROVIDER=twilio` (with `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `SMS_FROM`) or `plivo` (`PLIVO_AUTH_ID`, `PLIVO_AUTH_TOKEN`,
`SMS_FROM`) and redeploy; `log` only prints messages to `docker compose logs web` (testing). US numbers must be registered with the
carriers (A2P 10DLC or a verified toll-free number). Without a provider the phone agent never offers to text. Customers who gave a number
are texted when the restaurant confirms the order, when the pickup time is changed, and when the order is cancelled; each restaurant can
switch it off in Settings -> Notifications. The texts link to the public order page `/orders/<token>`, which must be reachable from the
internet like the rest of the site (only `/api/agent/*` is blocked).

## 6. LiveKit + phone number
1. Create a LiveKit Cloud project; put URL, API key, secret in `.env`.
2. Get a phone number and SIP trunk (LiveKit Cloud numbers, or Twilio/Telnyx); create an **inbound trunk**
   and a **dispatch rule** that creates a room per call. The agent registers without a name, so it is
   dispatched to every new room automatically.
3. In the web app (Settings), add the same number in E.164 format (`+14155550123`) to the restaurant.
4. Place a real call. At the start of each call the agent logs `participant attributes: {...}`
   (`docker compose logs agent`); confirm the dialed number is there. The code reads
   `sip.trunkPhoneNumber`; if the attribute is named differently, fix `entrypoint()` in
   `apps/agent/src/order_agent/main.py`.

## 7. Smoke test
- Sign in with Google as an admin email, open `/admin`, choose the LLM, save.
- Create a restaurant, add menu items and the phone number.
- Call the number and order. Confirm: order appears on the board with a chime, the notification email
  arrives, the order number is read back.
- With texting on: say yes to the text, press the order's first button on the board (Confirm & Print / Start preparing) and check the
  message arrives; try **Change Pickup Time** and **Cancel** on test orders.

## Automatic deploys (optional)
On every push to `main`, `.github/workflows/ci.yml` runs: lint + build, then one `build-image` job per image (web,
migrate, agent; Docker's official build/push actions with GitHub's layer cache) pushes
`ghcr.io/<owner>/<repo>/<name>` tagged `latest` and with the full commit sha, then the `deploy` job SSHes to the
server and runs `scripts/deploy.sh <sha>`. Pull requests build the images but push nothing.
You can run the same script by hand any time (see the header of `scripts/deploy.sh`).

What the script does, in order, stopping at the first failure:
1. Back up the database (if it's running). Migrations aren't reversible, so this always comes first.
2. (no step: the server has no repo to check out; see "Deployment files")
3. Pull that commit's images. If this fails, the running site is untouched.
4. Run migrations on their own. If this fails, the running site is untouched and the old version keeps serving.
5. Replace the containers and wait for the web health check. If it never turns healthy the script fails, prints
   the web logs and the rollback command (at that point the old web container is already replaced).

The sha is strictly validated (40 hex characters) before it reaches Docker (an image tag), so a hostile SSH command
can't inject anything. Only the newest 5 tags of this project's images are kept on the server (others can be
re-pulled from GHCR); the script never prunes unrelated Docker images.

**It needs GitHub's servers to reach your server over SSH.** That works with a public IP and port 22 open.
It does **not** work for a server behind NAT, which is the main reason people use the Cloudflare tunnel. In that
case either deploy by hand (`ssh server ./scripts/deploy.sh`), tunnel SSH too (Cloudflare Access for SSH), or
use a self-hosted GitHub Actions runner on the server (pull-based, no inbound access needed). Ask if you want
the self-hosted runner variant added.

### One-time setup
**On the server**
1. Use a dedicated user, e.g. `deploy`, in the `docker` group (note: docker group access is effectively root on
   that machine, which is why the key below is locked to a single command).
2. Copy the deployment files into `/opt/quick-assistant` as described above. The server needs no GitHub access for
   the code, only a way to pull the images (a read-only token if they are private; see "Image pulls").
3. Create a key pair for CI on your own machine: `ssh-keygen -t ed25519 -f ci-deploy -N "" -C ci-deploy`.
   Add the public key to the server user's `~/.ssh/authorized_keys` **restricted to the deploy script**:
   ```
   restrict,command="/opt/quick-assistant/scripts/deploy.sh" ssh-ed25519 AAAA... ci-deploy
   ```
   Now that key can run nothing but the deploy script, even if it leaks (CI's command line is passed to the
   script, which accepts only a commit sha). Then delete the private key file locally
   once it's stored as a GitHub secret.
4. Get the server's host key: `ssh-keyscan -t ed25519 <host>` and confirm the fingerprint matches
   `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server.

**On GitHub** (repo Settings -> Environments -> New environment `Prod`, and a second one named `Dev`. Give each its OWN secrets (they are
different servers); on `Prod` optionally require reviewers and restrict it to the `main` branch, on `Dev` restrict it to `dev`)

| Kind | Name | Value |
|---|---|---|
| Environment secret | `DEPLOY_SSH_KEY` | contents of the CI **private** key (recommended). Leave unset to use a password instead |
| Environment secret | `DEPLOY_PASSWORD` | only if you log in with a password (see "Deploying with a password" below); ignored when `DEPLOY_SSH_KEY` is set |
| Environment secret | `DEPLOY_FINGERPRINT` | the server's host-key fingerprint, `SHA256:...` (run `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server) |
| Environment secret | `DEPLOY_HOST` | server hostname or IP |
| Environment secret | `DEPLOY_USER` | `deploy` |
| Environment secret | `DEPLOY_PATH` | `/opt/quick-assistant` (the folder on the server that holds `scripts/deploy.sh`) |
| Environment secret | `DEPLOY_URL` | `https://<DOMAIN>`, no trailing slash (CI checks `<DEPLOY_URL>/api/health` after deploying) |

The `build-image` jobs need no setup (it uses the built-in `GITHUB_TOKEN` and the workflow's `packages: write`
permission), so images are pushed even before these exist. Until they do, the `deploy` job fails on pushes to `main`. If you
don't want automatic deploys yet, delete the `deploy:` job from the workflow.

### When a push does NOT deploy
The `changes` job in CI compares the push with the previous commit of the branch. If only **documentation and tests** changed
(`*.md`, `docs/`, `LICENSE*`, `.gitignore`, `apps/web/tests`, `apps/web/e2e`, `apps/agent/tests`, `apps/agent/evals`, Go `*_test.go`
files), the images would be identical, so the `deploy` job is skipped and the servers are not touched. Tests and image builds
still run. Any other changed file, a first push, or rewritten history deploys as usual. To force a deploy after a docs-only
commit, put `[deploy]` in the commit message (or run `./scripts/deploy.sh <sha|latest|dev>` on the server).

### Rollback
Redeploy an older commit: `./scripts/deploy.sh <previous-40-char-sha>`. A failed deploy prints the exact command;
`.deployed-tag` holds the tag currently running; earlier shas are in the GitHub Actions history (or `git log` on your machine). Their images stay in GHCR (CI
never deletes them). Database migrations are **not** undone; if one must be reverted, restore the backup the
deploy took (`backups/`, command in `scripts/backup-db.sh`), accepting that data written since then is lost.

## Operating it
- **Update:** push to `main` (automatic deploy), or on the server run `./scripts/deploy.sh latest` (or a sha). New migrations
  apply automatically before the new web container starts.
- **Logs:** `docker compose logs -f web agent`.
- **Backups:** the `backup` service dumps the database daily at `BACKUP_HOUR` (UTC, default 03:00) and keeps the
  newest `BACKUP_KEEP` (default 14) in `./backups`. Each dump is verified (complete and readable) before it's kept,
  so a failed dump never leaves a fake backup. It only runs while the stack is up. Check it with
  `docker compose logs backup`; take one right now with `./scripts/backup-db.sh`. Files are root-owned, mode 600
  (they contain customer data), so copying needs sudo.
  **Copy backups off the server** (another machine or object storage), for example from the other machine:
  `rsync -a --rsync-path="sudo rsync" deploy@server:/opt/quick-assistant/backups/ ./quick-assistant-backups/`.
  A backup on the same disk doesn't survive losing the server.
  Restore (tested): `gunzip -c backups/<file>.sql.gz | docker compose --env-file .env -f docker-compose.yml exec -T db psql -U quickassistant quickassistant`
  into an empty database; practice it once on a spare box before you need it.
- **Never** run `docker compose down -v`: `-v` deletes the database volume. Plain `down` is safe.
- **Monitoring:** point an uptime monitor at `https://<DOMAIN>/api/health`.
- **Disk:** Docker logs, images and backups grow; check `df -h` now and then.

## Pre-launch checklist
- [ ] `COMPOSE_PROFILES` set; in tunnel mode the WAF rule blocking `/api/agent` exists
- [ ] Production secrets differ from dev; `.env` is `chmod 600` and not committed
- [ ] Server logged in to ghcr.io and `IMAGE_PREFIX` set; first `./scripts/deploy.sh` succeeded
- [ ] Backups verified in `./backups`, **copied off-server**, one restore tested
- [ ] If using automatic deploys: GitHub `Prod` (branch `main`) and `Dev` (branch `dev`) environments configured and one deploy run end to end
- [ ] Uptime monitor on `/api/health`
- [ ] Resend working (verification email arrives)
- [ ] If texting customers: SMS provider configured, US carrier registration done, a test text received
- [ ] `PLATFORM_ADMIN_PASSWORD` removed from `.env` once Google sign-in works
- [ ] Real test call placed end to end
- [ ] Call-recording / AI-disclosure wording reviewed for your regions
- [ ] Privacy policy and terms published
- [ ] Rate limiting on auth and agent endpoints (see `TODO.md`)

CI (`.github/workflows/ci.yml`): lint + build on every push/PR; images built on every push/PR (one job each) and pushed to GHCR only from `main`.


### Deploying with a password instead of an SSH key

The `deploy` job (it uses the `appleboy/ssh-action` action, pinned to a commit) also works with a password: set the `DEPLOY_PASSWORD` environment secret (and leave `DEPLOY_SSH_KEY`
unset). It still needs `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_FINGERPRINT`, `DEPLOY_PATH` and `DEPLOY_URL` above. If none of the
secrets are set the job skips itself and you deploy by hand (`ssh you@server /opt/quick-assistant/scripts/deploy.sh`).

A password is weaker than a key, so contain it:
- Use a **dedicated `deploy` user**, never your own admin account or root, and give it a long random password (it is
  only ever typed by GitHub). The user needs access to Docker and to the repo directory, nothing else.
- Make that user able to do only one thing. In `/etc/ssh/sshd_config`:

  ```
  Match User deploy
      ForceCommand /opt/quick-assistant/scripts/deploy.sh
      PasswordAuthentication yes
      AllowTcpForwarding no
      X11Forwarding no
  ```

  then `sudo systemctl reload ssh`. `deploy.sh` reads the commit sha CI sends from `SSH_ORIGINAL_COMMAND`, so even
  someone who learns the password can only run a deploy of a validated commit sha, not a shell. This also means you
  cannot log in as `deploy` for your own admin work; use your own account for that.
- A password login can be guessed by bots. Install `fail2ban`, keep the password long, and keep `PermitRootLogin no`.
- The password lives in GitHub's encrypted secrets like a key would; rotate it if anyone who could see it leaves.
- Switching to a key later is a two-minute change (steps above) and removes the guessing risk entirely: your own
  interactive logins can keep using a password.


### Branches and environments (main = Prod, dev = Dev)

| Branch | GitHub environment | What a push does |
|---|---|---|
| `main` | `Prod` | CI, then images tagged `latest` + the commit sha are pushed to GHCR, then the `deploy` job deploys to the Prod server |
| `dev` | `Dev` | CI, then images tagged `dev` + the commit sha are pushed, then the `deploy` job deploys to the Dev server |

- The `deploy` job picks the environment from the branch, so `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_PASSWORD`,
  `DEPLOY_FINGERPRINT`, `DEPLOY_PATH` and `DEPLOY_URL` are read from that environment. Create the same names in both
  with different values (Dev server vs Prod server). The name `latest` only ever moves on `main`.
- Pull requests only lint, test and build; nothing is pushed or deployed.
- Each server needs its own `.env` (own domain, own database password and secrets). Do not reuse the Prod secrets
  on Dev. Roll back by deploying an older sha.
- Nothing on the server checks that a sha belongs to a given branch (it has no repo). The environments keep Dev and Prod
  apart: Dev's secrets must point at the Dev server and Prod's at the Prod server.


### Deployment files (the server has no repo access)
The server only needs these, all from the repo root, kept in `/opt/quick-assistant` (or your `DEPLOY_PATH`):

| File | Why |
|---|---|
| `docker-compose.yml` | which containers run and their settings; the Caddyfile and the backup and retention scripts are inline in it |
| `scripts/deploy.sh`, `scripts/backup-db.sh` | only for the CI / `deploy.sh` path (a plain install does not need them) |
| `.env` | your secrets (never in git) |

The application itself is inside the images, so ordinary code changes need no file copying. **When a commit changes one
of the files above, copy the new version to the server BEFORE deploying that commit**, otherwise new images run with
old settings (for example a new service or environment variable would be missing). To see whether that is needed,
on your machine run: `git diff --stat <deployed-sha> <new-sha> -- docker-compose.yml scripts`
(`<deployed-sha>` is in `.deployed-tag` on the server). Update with the same `rsync` command as above.

### Image pulls
If your GHCR packages are private, log the server in once with a **read-only** token (a GitHub personal access token
with only `read:packages`): `echo <token> | docker login ghcr.io -u <github-user> --password-stdin`. Public packages
need no login.


### Scaling the voice agent
Each phone call runs in its own process inside an agent container. LiveKit sends a call to a connected worker that is
not "full"; the worker reports a load number and stops taking calls above `AGENT_LOAD_THRESHOLD` (LiveKit's default is
0.7 in production). Set these in `.env` (all optional; empty = LiveKit default):

| Variable | What it does |
|---|---|
| `AGENT_REPLICAS` | How many agent containers run (default 1). Each takes up to `AGENT_MAX_CALLS` calls. Same as `docker compose up -d --scale agent=N`. |
| `AGENT_MAX_CALLS` | Hard cap of simultaneous calls per container. The load then rises with the call count (so calls spread evenly over the containers) and jumps to 1.0 at the cap, so the container takes no more. **Set this:** CPU alone is a poor signal in speech-to-speech mode, where a worker only relays audio. Find the right number with a load test (LAUNCH_PLAN P4.4); start low (for example 20). |
| `AGENT_LOAD_THRESHOLD` | Load above which no new calls are accepted (default 0.7). |
| `AGENT_IDLE_PROCESSES` | Warm job processes kept ready so a new call starts without a cold start (LiveKit default: CPU count, at most 4). |
| `AGENT_JOB_MEMORY_WARN_MB` / `AGENT_JOB_MEMORY_LIMIT_MB` | Warn / kill when ONE call's process uses more memory than this (limit default 0 = none). |
| `AGENT_MEM_LIMIT` | Docker memory limit per container (default `1536m`); size it as roughly `AGENT_MAX_CALLS` x per-call memory + headroom. |
| `AGENT_DRAIN_SECONDS` | On a deploy or stop, the worker takes no new calls and waits this long for running calls to finish (default 900; calls last 8 minutes at most). |
| `AGENT_STOP_GRACE` | Docker's stop timeout (default `16m`). **Keep it above `AGENT_DRAIN_SECONDS`**, otherwise Docker kills calls in progress during a deploy. |
| `AGENT_PROMETHEUS_PORT` | Expose Prometheus metrics on this port (default off). |

Rolling out: `deploy.sh` replaces the agent containers, and running calls finish first (up to the drain time), so a deploy
does not drop calls, it just takes longer. Capacity planning: peak simultaneous calls / `AGENT_MAX_CALLS` = containers
needed (plus one spare). Per-restaurant limit: `MAX_CONCURRENT_CALLS_PER_TENANT` (web server, default 3).

### Live orders board
The orders board is pushed, not polled: a database trigger sends `pg_notify('orders_changed', <restaurant>)` and each web
process streams it to that restaurant's open boards over server-sent events (`/api/dashboard/orders/stream`). It works
with several web replicas. Requirements: the web process needs a **direct** Postgres connection for `LISTEN`; behind a
transaction-mode pooler (pgbouncer, Neon pooled URL) set `DATABASE_LISTEN_URL` to the direct address. Caddy is
configured to flush the stream; with Cloudflare the 20-second heartbeat keeps it open. If the live connection fails the
board shows "Reconnecting…" and polls every 5 seconds again.


### Several web servers (what is shared, what each process does)
- **Login rate limits** are counted in the database, so every web server shares one count per visitor.
- **Menu cache** (`MENU_CACHE_SECONDS`, default 10): each web server caches a restaurant's menu for the phone agent for a few
  seconds. A menu edit shows up on the server that handled it immediately and on the others within that time.
- **Background jobs** run in the dedicated `worker` service (the compose file sets `JOB_WORKER=off` on `web`; with no `JOB_WORKER`, as in
  development, every web process runs the loop). Watch it with `docker compose logs worker`, the web app's `GET /api/health/worker` (503 when due jobs wait
  more than 2 minutes: point an uptime monitor at it; the worker container's own health check uses the same rule) and the **Email & text queue** page in `/admin` (failed jobs, with Retry and Delete).
  `deploy.sh` warns when the worker is not healthy after a deploy. Queued emails are
  sent with retries, an email that still fails after 5 attempts is recorded in the audit log (`system.job_failed`), and
  an order that stays "new" for `UNACK_ALERT_MINUTES` (default 5) triggers one reminder email to the restaurant.
  Several servers never send the same email twice.
- **Row-level security** needs the migration user to be allowed to create the role `order_app` and to `SET ROLE` to it:
  the Docker setup (database user is a superuser) works as is. On a managed Postgres, run the migrations with a user that
  has `CREATEROLE` (the migration does `GRANT order_app TO CURRENT_USER`). The app's runtime user does not need extra rights.
- **Live orders board** needs a direct connection for `LISTEN`: set `DATABASE_LISTEN_URL` when `DATABASE_URL` points at a
  pooler (see "Live orders board").

## Kitchen print agents

Each restaurant's kitchen printer is driven by the Go agent in `apps/printer-agent` on a Raspberry Pi (see its README). Server side:
- `/api/print/*` must be reachable from the internet (the Pis call it); only `/api/agent/*` is blocked publicly. Long-polls last up to
  30 s, below Cloudflare's and Caddy's limits.
- The agent downloads are built into the web image (`apps/web/Dockerfile`, Go stage) and served by the web app at
  `https://<your domain>/printer/` (`order-printer-linux-{arm64,arm,amd64}`, `.sha256`, `VERSION`). Nothing to configure: the dashboard's
  SD-card setup and `/api/print/update` use them automatically, and a new agent version (bump `apps/printer-agent/VERSION`) reaches the
  Pis with the next web deploy. `/printer/*` must be publicly reachable like `/install-printer.sh`.
- `PRINT_AGENT_VERSION` + `PRINT_AGENT_BASE_URL` (both set; `docker-compose.yml` passes them through) override this to host the
  files elsewhere. Leave them empty normally.
- The installer is served by the web app at `/install-printer.sh`; the dashboard shows the full command with a pairing code.
