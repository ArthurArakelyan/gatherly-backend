#!/usr/bin/env bash
set -euo pipefail

readonly repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly production_env="$repository_root/.env.production"
readonly backup_marker='/var/lib/gatherly/last-backup-success'
readonly temporary_directory="$(mktemp -d /tmp/gatherly-backup.XXXXXX)"
trap 'rm -rf -- "$temporary_directory"' EXIT

if [[ ! -f "$production_env" ]]; then
  echo "Missing $production_env" >&2
  exit 1
fi

set -a
# The production file is host-controlled shell-compatible KEY=value data.
# shellcheck disable=SC1090
source "$production_env"
set +a

: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY is required}"
: "${RESTIC_PASSWORD_FILE:?RESTIC_PASSWORD_FILE is required}"

readonly recorded_at="$(date --utc +%Y-%m-%dT%H:%M:%SZ)"
readonly dump_file="$temporary_directory/gatherly.dump"
readonly manifest_file="$temporary_directory/manifest.txt"

cd "$repository_root"
docker compose \
  --env-file .env.production \
  -f compose.yaml \
  exec --no-TTY postgres \
  pg_dump \
    --username "$POSTGRES_USER" \
    --dbname "$POSTGRES_DB" \
    --format custom \
    --no-owner \
    --no-privileges > "$dump_file"

docker run --rm --interactive \
  postgres:17-bookworm \
  pg_restore --list < "$dump_file" > /dev/null

{
  printf 'recorded_at_utc=%s\n' "$recorded_at"
  printf 'database=%s\n' "$POSTGRES_DB"
  printf 'application_revision=%s\n' "${APP_REVISION:-unknown}"
  printf 'dump_bytes=%s\n' "$(stat --format '%s' "$dump_file")"
  printf 'dump_sha256=%s\n' "$(sha256sum "$dump_file" | cut -d ' ' -f 1)"
} > "$manifest_file"

restic backup "$temporary_directory" \
  --tag gatherly \
  --tag postgresql \
  --host "$(hostname --fqdn)"

restic forget \
  --tag gatherly \
  --keep-daily 7 \
  --keep-weekly 4 \
  --keep-monthly 6 \
  --prune

install -d -o "$(id -u)" -g "$(id -g)" -m 0750 "$(dirname "$backup_marker")"
touch "$backup_marker"
echo "PostgreSQL backup completed at $recorded_at."
