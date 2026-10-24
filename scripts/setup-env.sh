#!/usr/bin/env bash
# Creates deploy/.env from deploy/.env.example with a random API token, a different random
# read-only token and a random store password (TEND_API_TOKEN, TEND_API_READ_TOKEN,
# TEND_POSTGRES_PASSWORD). The file is readable and writable by its owner only (mode 600).
# An existing file is never overwritten.
#
# Usage: scripts/setup-env.sh [--env-file PATH]
#
#   --env-file  the file to create (default: deploy/.env next to this script's repository)
#
# Fill in the rest of the file afterwards (harness credential, repository tokens), then
# start the stack with `docker compose -f deploy/compose.yaml up -d --wait`.
# Needs bash (Git Bash on Windows) and /dev/urandom. Tokens and password are never printed.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
EXAMPLE="$ROOT/deploy/.env.example"
ENV_FILE="$ROOT/deploy/.env"
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) ENV_FILE=${2:?--env-file needs a path}; shift 2 ;;
    -h | --help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
done

if [ -e "$ENV_FILE" ]; then
  echo "$ENV_FILE already exists; not overwriting it. Edit it, or move it away to start over." >&2
  exit 1
fi

# 32 random bytes as 64 hex characters.
token() { od -An -tx1 -N32 /dev/urandom | tr -d ' \n'; }
API_TOKEN=$(token)
READ_TOKEN=$(token)
STORE_PASSWORD=$(token)
[ "${#API_TOKEN}" -eq 64 ] && [ "${#READ_TOKEN}" -eq 64 ] && [ "${#STORE_PASSWORD}" -eq 64 ] && [ "$API_TOKEN" != "$READ_TOKEN" ] || {
  echo "could not generate tokens from /dev/urandom" >&2
  exit 1
}

# The secrets reach awk through its environment, never through arguments, which other users
# of the host could see in the process list. umask and noclobber create the file with mode
# 600 and fail if it appeared in the meantime.
(
  umask 077
  set -C
  TEND_SETUP_API_TOKEN="$API_TOKEN" TEND_SETUP_READ_TOKEN="$READ_TOKEN" TEND_SETUP_STORE_PASSWORD="$STORE_PASSWORD" awk '
    /^TEND_API_TOKEN=$/ { print "TEND_API_TOKEN=" ENVIRON["TEND_SETUP_API_TOKEN"]; next }
    /^TEND_API_READ_TOKEN=$/ { print "TEND_API_READ_TOKEN=" ENVIRON["TEND_SETUP_READ_TOKEN"]; next }
    /^TEND_POSTGRES_PASSWORD=$/ { print "TEND_POSTGRES_PASSWORD=" ENVIRON["TEND_SETUP_STORE_PASSWORD"]; next }
    { print }
  ' "$EXAMPLE" >"$ENV_FILE"
) || {
  echo "could not create $ENV_FILE" >&2
  exit 1
}
chmod 600 "$ENV_FILE"

echo "Created $ENV_FILE with a new API token, read-only token and store password (mode 600)."
echo "Next: fill in the harness credential and repository tokens in it, then start the stack:"
echo "  docker compose -f deploy/compose.yaml up -d --wait"
