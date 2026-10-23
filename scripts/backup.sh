#!/usr/bin/env bash
# Backs up a Tendworks stack into one dated archive <installation>-backup-<UTC time>.tar.gz:
# a dump of the store, the workflow engine's state and the transcripts, taken together while
# server, worker and engine are stopped, so runs in progress continue after a restore. The
# stack is down for the backup's duration (usually under a minute) and started again
# afterwards if it ran before. The archive is readable by its owner only (mode 600).
#
# Usage: scripts/backup.sh [--output-dir DIR] [--env-file PATH] [--project-name NAME]
#
#   --output-dir    where the archive goes (default: backups/ in this checkout)
#   --env-file      the stack's env file (default: deploy/.env)
#   --project-name  the installation (default: as compose resolves it, e.g. COMPOSE_PROJECT_NAME)
#
# Not in the archive: deploy/.env (back it up yourself, securely), your configuration (keep it
# in its own repository) and session volumes (workspaces of open chats and working tasks).
# Restore with scripts/restore.sh. Needs bash (Git Bash on Windows) and docker compose.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
. "$ROOT/scripts/lib/stack.sh"

OUTPUT_DIR="$ROOT/backups"
parse_stack_args "$@"
set -- ${SCRIPT_ARGS[@]+"${SCRIPT_ARGS[@]}"}
while [ $# -gt 0 ]; do
  case "$1" in
    --output-dir) OUTPUT_DIR=${2:?--output-dir needs a directory}; shift 2 ;;
    -h | --help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
done

POSTGRES=$(container_of postgres)
TEMPORAL=$(container_of temporal)
WORKER=$(container_of worker)
if [ -z "$POSTGRES" ] || [ -z "$TEMPORAL" ] || [ -z "$WORKER" ]; then
  echo "found no stack to back up; check --env-file / --project-name, or start it once with:" >&2
  echo "  docker compose -f deploy/compose.yaml up -d --wait" >&2
  exit 1
fi
INSTALLATION=$(docker_keeping_paths inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$POSTGRES")
IMAGE=$(docker_keeping_paths inspect --format '{{.Config.Image}}' "$POSTGRES")
ENGINE_VOLUME=$(volume_at "$TEMPORAL" "$ENGINE_PATH")
TRANSCRIPTS_VOLUME=$(volume_at "$WORKER" "$TRANSCRIPTS_PATH")
RUNNING=$(compose ps --status running --services)
was_running() { printf '%s\n' "$RUNNING" | grep -qx "$1"; }

mkdir -p "$OUTPUT_DIR"
ARCHIVE="$(cd "$OUTPUT_DIR" && pwd)/$INSTALLATION-backup-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
if [ -e "$ARCHIVE" ]; then
  echo "$ARCHIVE already exists; not overwriting it" >&2
  exit 1
fi

# Whatever happens below, leave the stack as it was: running if it ran, else stopped.
finish() {
  local status=$?
  rm -f "$ARCHIVE.partial"
  if was_running server || was_running worker; then
    echo "Starting the stack again..."
    compose up -d --wait || status=1
  elif ! was_running postgres; then
    compose stop postgres || status=1
  fi
  exit "$status"
}
trap finish EXIT

echo "Stopping server, worker and the workflow engine of installation $INSTALLATION..."
compose stop server worker temporal
compose up -d --wait postgres

RELEASE=$(git -C "$ROOT" describe --tags --always --dirty 2>/dev/null || echo unknown)
MANIFEST="format: tendworks-backup/1
installation: $INSTALLATION
created: $(date -u +%Y-%m-%dT%H:%M:%SZ)
release: $RELEASE"

# The dump streams into a helper container of the store's image, which packs it with the
# engine's state and the transcripts (mounted read-only) and streams the archive out.
echo "Writing $ARCHIVE..."
(
  umask 077
  set -C
  compose exec -T postgres pg_dump --username "$STORE_USER" --dbname "$STORE_DATABASE" --format custom |
    docker_keeping_paths run --rm -i --network none -e "TEND_BACKUP_MANIFEST=$MANIFEST" \
      -v "$ENGINE_VOLUME:/backup/engine:ro" -v "$TRANSCRIPTS_VOLUME:/backup/transcripts:ro" \
      --entrypoint sh "$IMAGE" -c '
        set -e
        cat > /backup/store.dump
        printf "%s\n" "$TEND_BACKUP_MANIFEST" > /backup/manifest
        cd /backup
        tar czf - manifest store.dump engine transcripts
      ' >"$ARCHIVE.partial"
)
mv "$ARCHIVE.partial" "$ARCHIVE"
chmod 600 "$ARCHIVE"

echo "Backed up installation $INSTALLATION to $ARCHIVE"
echo "Keep a copy off this host. Restore it with: scripts/restore.sh $ARCHIVE"
