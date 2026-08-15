#!/usr/bin/env bash
set -euo pipefail

readonly required_commands=(docker nginx curl git flock)
readonly required_files=(
  /etc/nginx/gatherly-backend-upstream.inc
  /usr/local/sbin/gatherly-switch-upstream
  /srv/gatherly-backend/.env.production
  /var/lib/gatherly/last-backup-success
)

if [[ "$EUID" -ne 0 ]]; then
  echo 'Run this read-only preflight with sudo so nginx -t can read TLS files.' >&2
  exit 2
fi

failed=0
for command_name in "${required_commands[@]}"; do
  if ! command -v "$command_name" > /dev/null; then
    echo "missing_command=$command_name"
    failed=1
  fi
done

for file_name in "${required_files[@]}"; do
  if [[ ! -f "$file_name" ]]; then
    echo "missing_file=$file_name"
    failed=1
  fi
done

echo "docker_version=$(docker version --format '{{.Server.Version}}')"
echo "compose_version=$(docker compose version --short)"
echo "root_filesystem_free=$(df --output=pcent / | tail -1 | tr -d ' ')"
echo "docker_filesystem_free=$(df --output=pcent /var/lib/docker | tail -1 | tr -d ' ')"
echo "backup_age_seconds=$(( $(date +%s) - $(stat -c %Y /var/lib/gatherly/last-backup-success) ))"

nginx -t
docker info --format 'docker_root={{.DockerRootDir}} logging_driver={{.LoggingDriver}}'
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
ss --tcp --listening --numeric --process

exit "$failed"
