#!/usr/bin/env bash
# Restores an archive of scripts/backup.sh into a stack without data: the store, the workflow
# engine's state and the transcripts. Afterwards the stack is stopped; start it with
#   docker compose -f deploy/compose.yaml up -d --wait
# Runs that were in progress at backup time continue. A store from an older release is
# migrated when the stack starts; a store from a newer release is refused by the server.
#
# Usage: scripts/restore.sh [--env-file PATH] [--project-name NAME] ARCHIVE
#
#   --env-file      the stack's env file (default: deploy/.env)
#   --project-name  the installation (default: as compose resolves it, e.g. COMPOSE_PROJECT_NAME)
#
# Refuses a running stack and a stack that holds data: stop and reset it first with
#   docker compose -f deploy/compose.yaml down -v      (deletes the stack's data)
# Session volumes are not in a backup: open chats and working tasks whose session volumes
# are gone start over with an empty workspace. Needs bash (Git Bash on Windows) and docker compose.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
. "$ROOT/scripts/lib/stack.sh"

ARCHIVE=
parse_stack_args "$@"
set -- ${ARGS[@]+"${ARGS[@]}"}
while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown argument: $1 (see --help)" >&2; exit 2 ;;
    *) [ -z "$ARCHIVE" ] || { echo "only one archive, please (see --help)" >&2; exit 2; }
      ARCHIVE=$1; shift ;;
  esac
done
[ -n "$ARCHIVE" ] || { echo "which archive? (see --help)" >&2; exit 2; }
[ -f "$ARCHIVE" ] || { echo "archive $ARCHIVE not found" >&2; exit 2; }

if [ -n "$(compose ps --status running -q)" ]; then
  echo "the stack is running; a restore goes only into a stopped stack without data." >&2
  echo "Reset it first (this deletes its data): docker compose -f deploy/compose.yaml down -v" >&2
  exit 1
fi

# Containers and volumes as compose names them, created without starting anything.
compose create
POSTGRES=$(container_of postgres)
INSTALLATION=$(docker_ inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$POSTGRES")
IMAGE=$(docker_ inspect --format '{{.Config.Image}}' "$POSTGRES")
STORE_VOLUME=$(volume_at "$POSTGRES" "$STORE_PATH")
ENGINE_VOLUME=$(volume_at "$(container_of temporal)" "$ENGINE_PATH")
TRANSCRIPTS_VOLUME=$(volume_at "$(container_of worker)" "$TRANSCRIPTS_PATH")

trap 'compose stop postgres >/dev/null 2>&1 || true' EXIT

# A helper container of the store's image checks that the stack holds no data, then unpacks
# the engine's state and the transcripts into their volumes, with the owners they had.
echo "Restoring $ARCHIVE into installation $INSTALLATION..."
docker_ run --rm -i --network none -e "TEND_INSTALLATION=$INSTALLATION" \
  -v "$STORE_VOLUME:/restore/store:ro" -v "$ENGINE_VOLUME:/restore/engine" -v "$TRANSCRIPTS_VOLUME:/restore/transcripts" \
  --entrypoint sh "$IMAGE" -c '
    set -e
    if [ -n "$(find /restore/store -name PG_VERSION)" ] || [ -e /restore/engine/temporal.db ] || [ -n "$(ls -A /restore/transcripts)" ]; then
      echo "installation $TEND_INSTALLATION already holds data; a restore goes only into a stack without data." >&2
      echo "Reset it first (this deletes its data): docker compose -f deploy/compose.yaml down -v" >&2
      exit 3
    fi
    mkdir /tmp/archive
    tar xzf - -C /tmp/archive
    grep -qx "format: tendworks-backup/1" /tmp/archive/manifest 2>/dev/null || {
      echo "not an archive of scripts/backup.sh (no manifest of format tendworks-backup/1)" >&2
      exit 4
    }
    for part in engine transcripts; do
      cp -a /tmp/archive/$part/. /restore/$part/
      chown "$(stat -c %u:%g /tmp/archive/$part)" /restore/$part
      chmod "$(stat -c %a /tmp/archive/$part)" /restore/$part
    done
    sed "s/^/  /" /tmp/archive/manifest
  ' <"$ARCHIVE"

# The store: a fresh database, then the dump into it in one transaction.
compose up -d --wait postgres
compose exec -T postgres sh -c '
  set -eo pipefail
  tar xzOf - store.dump | pg_restore --username tend --dbname tend --no-owner --single-transaction --exit-on-error
' <"$ARCHIVE"

echo "Restored installation $INSTALLATION from $ARCHIVE; the stack is stopped. Start it with:"
echo "  docker compose -f deploy/compose.yaml up -d --wait"
