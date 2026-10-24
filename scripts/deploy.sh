#!/usr/bin/env bash
# Deploys a build to this server: backup -> pull its images from GHCR -> migrate -> replace containers -> wait for healthy.
# The server has NO access to the git repo: this directory only holds the files you copied here by hand
# (docker-compose.yml, scripts/*, .env; see DEPLOY.md). The application itself comes in the images.
# This script is the OPTIONAL pipeline path (CI deploys, rollback by sha). A plain install just runs `docker compose up -d`.
#
#   ./scripts/deploy.sh <40-char-commit-sha>   deploy the images CI built for that commit (CI passes this; also how you roll back)
#   ./scripts/deploy.sh latest | dev           deploy the newest main / dev build (handy by hand; CI always sends a sha)
#
# Env: ENV_FILE (default .env).
# When run as an SSH forced command (see DEPLOY.md) the argument is read from SSH_ORIGINAL_COMMAND.
set -euo pipefail

# Everything lives in main() so bash has parsed the whole script before anyone replaces this file mid-run
# (bash reads scripts incrementally).
main() {
  cd "$(dirname "${BASH_SOURCE[0]}")/.."
  local env_file="${ENV_FILE:-.env}"
  dc() { docker compose --env-file "$env_file" -f docker-compose.yml "$@"; }
  die() { echo "!! $*" >&2; exit 1; }

  [ -f "$env_file" ] || die "missing $env_file"

  # What to deploy: a full commit sha, or the moving tags `latest` (main builds) / `dev` (dev builds). Strictly
  # validated: it ends up in an image tag. CI always passes the sha.
  local tag_re='^([0-9a-f]{40}|latest|dev)$' arg="${1:-}"
  if [ -z "$arg" ] && [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then
    arg="${SSH_ORIGINAL_COMMAND##* }"
    [[ "$arg" =~ $tag_re ]] || arg=""
  fi
  [ -n "$arg" ] || die "usage: deploy.sh <40-char commit sha> | latest | dev"
  [[ "$arg" =~ $tag_re ]] || die "argument must be a full 40-character commit sha, or latest, or dev"
  local tag="$arg"
  export IMAGE_TAG="$tag"

  local prev="none"
  [ -f .deployed-tag ] && prev="$(cat .deployed-tag)"
  echo "==> deploying: $tag   (currently running: $prev)"

  # Migrations run on every deploy and aren't reversible, so always back up first.
  if [ -n "$(dc ps -q --status running db 2>/dev/null)" ]; then
    echo "==> backing up database"
    ENV_FILE="$env_file" ./scripts/backup-db.sh
  else
    echo "==> database not running; skipping backup (first deploy?)"
  fi

  # Order matters: get the images, migrate, and only then replace the running containers. If the
  # pull or the migration fails, the previous version keeps serving traffic untouched.
  echo "==> pulling images"
  dc pull web migrate agent || die "pull failed (is CI done pushing $tag? are the GHCR packages public (or the server logged in to ghcr.io)? did you copy the newer docker-compose.yml?); the running site was not touched"

  echo "==> applying database migrations"
  dc run --rm migrate || die "migration failed; the running site was not touched. Restore from backups/ only if needed."

  echo "==> starting new containers"
  dc up -d --no-build || { dc logs --tail 60 web >&2 || true; die "docker compose up failed"; }

  echo "==> waiting for web to become healthy"
  local cid status="unknown"
  cid="$(dc ps -q web)"
  for _ in $(seq 1 60); do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid")"
    if [ "$status" = "healthy" ]; then
      echo "$tag" > .deployed-tag
      # Keep the newest 5 tags of OUR images for fast rollback (older ones can be re-pulled from GHCR).
      # Deliberately not `docker image prune -a`, which would delete other projects' unused images too.
      local name prefix
      prefix="$(dc config --images | grep '/web:' | sed 's#/web:.*##')"
      for name in web migrate agent; do
        docker image ls "$prefix/$name" \
          --format '{{.Repository}}:{{.Tag}}' | tail -n +6 | xargs -r docker rmi >/dev/null 2>&1 || true
      done
      # The worker that sends emails and texts: the site is already up, so a sick worker is a loud warning, not a failed deploy.
      local wcid wstatus="none"
      wcid="$(dc ps -q worker 2>/dev/null || true)"
      if [ -n "$wcid" ]; then
        for _ in $(seq 1 30); do
          wstatus="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$wcid")"
          [ "$wstatus" = "healthy" ] && break
          sleep 2
        done
        [ "$wstatus" = "healthy" ] || echo "!! the worker is not healthy (status: $wstatus): emails and texts may not be sent. Check: docker compose logs worker" >&2
      fi
      echo "==> deploy complete: $tag"
      return 0
    fi
    sleep 3
  done

  dc logs --tail 80 web >&2 || true
  echo "!! web did not become healthy (last status: $status)" >&2
  [ "$prev" = "none" ] || echo "!! to roll back: ./scripts/deploy.sh $prev" >&2
  exit 1
}

main "$@"
exit
