# Shared by scripts/backup.sh and scripts/restore.sh: the compose stack of this checkout,
# as `docker compose -f deploy/compose.yaml` sees it. Source it after setting ROOT.
#
# Compose resolves the installation (project name) as always: --project-name, else
# COMPOSE_PROJECT_NAME from the environment or the env file, else `name:` in the compose file.
# The env file is deploy/.env unless --env-file names another one.

COMPOSE_ARGS=()
# Git Bash on Windows: docker is a Windows program, so hand it Windows paths and keep MSYS
# from rewriting container paths (/var/lib/...) in its arguments. A no-op on Linux.
native_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }
docker_() { MSYS_NO_PATHCONV=1 docker "$@"; }
compose() { docker_ compose -f "$(native_path "$ROOT/deploy/compose.yaml")" "${COMPOSE_ARGS[@]}" "$@"; }

# Parses --env-file and --project-name into COMPOSE_ARGS; leaves other arguments in ARGS.
parse_stack_args() {
  ARGS=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --env-file) [ -n "${2:-}" ] || { echo "--env-file needs a path" >&2; exit 2; }
        [ -f "$2" ] || { echo "env file $2 not found" >&2; exit 2; }
        COMPOSE_ARGS+=(--env-file "$(native_path "$(cd "$(dirname "$2")" && pwd)/$(basename "$2")")"); shift 2 ;;
      -p | --project-name) [ -n "${2:-}" ] || { echo "$1 needs a name" >&2; exit 2; }
        COMPOSE_ARGS+=(--project-name "$2"); shift 2 ;;
      *) ARGS+=("$1"); shift ;;
    esac
  done
}

# The id of a service's container (created, running or stopped), empty if there is none.
container_of() { compose ps -a -q "$1" 2>/dev/null | head -n 1; }

# The volume a container mounts at a path.
volume_at() {
  docker_ inspect --format "{{range .Mounts}}{{if eq .Destination \"$2\"}}{{.Name}}{{end}}{{end}}" "$1"
}

# Where the stack keeps its data, as mounted by its own containers.
STORE_PATH=/var/lib/postgresql
ENGINE_PATH=/home/temporal
TRANSCRIPTS_PATH=/var/lib/tendworks/transcripts
