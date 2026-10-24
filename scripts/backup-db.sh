#!/usr/bin/env bash
# One backup right now, using the same code as the scheduled `backup` compose service (`backup_sh` in docker-compose.yml).
# Daily backups already happen automatically while the stack is up; this is for ad-hoc use (deploy.sh calls it).
# Files land in ./backups (root-owned, mode 600). Restore:
#   gunzip -c backups/<file>.sql.gz | docker compose -f docker-compose.yml exec -T db psql -U quickassistant quickassistant
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
exec docker compose --env-file "${ENV_FILE:-.env}" -f docker-compose.yml run --rm --no-deps backup once
