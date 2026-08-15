#!/usr/bin/env bash
set -euo pipefail

readonly repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly dump_file="${1:-}"
readonly project='gatherly_restore_drill'

if [[ -z "$dump_file" || ! -f "$dump_file" ]]; then
  echo 'Usage: scripts/restore-postgres-drill.sh /absolute/path/to/gatherly.dump' >&2
  exit 2
fi
if [[ -z "${RESTORE_POSTGRES_PASSWORD:-}" ]]; then
  echo 'RESTORE_POSTGRES_PASSWORD is required.' >&2
  exit 2
fi

cleanup() {
  docker compose \
    --project-name "$project" \
    --file "$repository_root/deploy/compose.restore-drill.yaml" \
    down --volumes
}
trap cleanup EXIT

docker compose \
  --project-name "$project" \
  --file "$repository_root/deploy/compose.restore-drill.yaml" \
  up --detach --wait restore-postgres

cat "$dump_file" | docker compose \
  --project-name "$project" \
  --file "$repository_root/deploy/compose.restore-drill.yaml" \
  exec --no-TTY restore-postgres \
  pg_restore \
    --username gatherly_restore \
    --dbname gatherly_restore \
    --no-owner \
    --no-privileges \
    --exit-on-error

docker compose \
  --project-name "$project" \
  --file "$repository_root/deploy/compose.restore-drill.yaml" \
  exec --no-TTY restore-postgres \
  psql \
    --username gatherly_restore \
    --dbname gatherly_restore \
    --set ON_ERROR_STOP=1 \
    --command 'SELECT COUNT(*) AS users FROM users;' \
    --command 'SELECT COUNT(*) AS events FROM events;' \
    --command 'SELECT COUNT(*) AS reservations FROM reservations;'

echo 'Restore drill database checks completed successfully.'
