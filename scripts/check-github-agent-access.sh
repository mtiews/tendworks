#!/usr/bin/env bash
# shellcheck disable=SC2015 # pass, fail and echo always return 0, so `A && B || C` is safe
# Checks what a workspace's agent token can do on a GitHub repository.
# Setup and expected results: docs/github-agent-access.md.
#
# Usage: scripts/check-github-agent-access.sh --repo OWNER/NAME [--token-var NAME]
#          [--env-file PATH] [--write-tests [--test-main]] [--audit N]
#
#   --token-var    the variable holding the agent token, a TENDWORKS_AGENT_* name
#                  (default TENDWORKS_AGENT_PLAYGROUND_TOKEN, the playground workspace's)
#   --env-file     read that variable from this file (e.g. deploy/.env);
#                  otherwise from the environment. Nothing else in the file is read.
#   --write-tests  push test branches and open a draft pull request, then clean up
#   --test-main    with --write-tests: try to push to main (only for repositories with a
#                  ruleset on main; on a private Free repository the push goes through)
#   --audit N      list commits among the last N on main that belong to no merged pull request
#
# Needs bash (Git Bash on Windows), git and gh. The token reaches gh and git through
# environment variables only; it is never printed. Exit code 1 if any check fails.
set -euo pipefail

REPO="" TOKEN_VAR=TENDWORKS_AGENT_PLAYGROUND_TOKEN ENV_FILE="" WRITE=0 TEST_MAIN=0 AUDIT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO=${2:?--repo needs OWNER/NAME}; shift 2 ;;
    --token-var) TOKEN_VAR=${2:?--token-var needs a variable name}; shift 2 ;;
    --env-file) ENV_FILE=${2:?--env-file needs a path}; shift 2 ;;
    --write-tests) WRITE=1; shift ;;
    --test-main) TEST_MAIN=1; shift ;;
    --audit) AUDIT=${2:?--audit needs a number}; shift 2 ;;
    -h | --help) sed -n '3,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
done
[ -n "$REPO" ] || { echo "--repo OWNER/NAME is required" >&2; exit 2; }
[[ "$TOKEN_VAR" =~ ^TENDWORKS_AGENT_[A-Z0-9_]+$ ]] || { echo "--token-var must be a TENDWORKS_AGENT_* name, got: $TOKEN_VAR" >&2; exit 2; }

TOKEN="${!TOKEN_VAR:-}"
if [ -n "$ENV_FILE" ]; then
  TOKEN=$(sed -n "s/^$TOKEN_VAR=//p" "$ENV_FILE" | tail -1 | tr -d '\r"'"'")
fi
[ -n "$TOKEN" ] || { echo "no $TOKEN_VAR found" >&2; exit 2; }
export GH_TOKEN="$TOKEN" AGENT_GIT_TOKEN="$TOKEN"

FAILS=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAILS=$((FAILS + 1)); }
warn() { echo "WARN  $1"; }

# HTTP status of a GitHub API call with the agent token (2xx is reported as 200).
status() {
  local out
  if out=$(gh api "$@" 2>&1 >/dev/null); then echo 200; else { grep -o 'HTTP [0-9]*' <<<"$out" | tail -1 | cut -d' ' -f2; } || echo 000; fi
}
refused() { case "$1" in 403 | 404) return 0 ;; *) return 1 ;; esac; }

echo "Repository $REPO"
[ "$(status "repos/$REPO")" = 200 ] && pass "token reads the repository" || { fail "token cannot read the repository"; exit 1; }
refused "$(status "repos/$REPO/actions/secrets")" && pass "secrets refused" || fail "token can read secrets (Secrets permission)"
refused "$(status "repos/$REPO/actions/permissions")" && pass "settings refused" || fail "token can read settings (Administration permission)"
refused "$(status "repos/$REPO/hooks")" && pass "webhooks refused" || fail "token can read webhooks (Webhooks permission)"
case "$(status -X POST "repos/$REPO/actions/workflows/tendworks-access-check.yml/dispatches" -f ref=main)" in
  403) pass "starting workflows refused" ;;
  404) warn "starting workflows: inconclusive (GitHub answered 404); check that the token has no Actions permission" ;;
  *) fail "token may start workflows (Actions permission)" ;;
esac

if [ "$WRITE" = 1 ]; then
  WORK=$(mktemp -d)
  NAME="tendworks-access-check-$(date +%s)"
  cleanup() {
    for b in "$NAME" "$NAME-workflow"; do git -C "$WORK" push -q origin --delete "$b" >/dev/null 2>&1 || true; done
    rm -rf "$WORK"
  }
  trap cleanup EXIT
  # shellcheck disable=SC2016 # the credential helper's shell expands the token, not this one
  g() { git -C "$WORK" -c user.name=tendworks-access-check -c user.email=access-check@invalid \
          -c credential.helper= -c 'credential.helper=!f() { echo username=x-access-token; echo "password=$AGENT_GIT_TOKEN"; }; f' "$@"; }
  g init -q && g remote add origin "https://github.com/$REPO.git" && g fetch -q --depth 1 origin main
  BASE=$(g rev-parse FETCH_HEAD)

  g checkout -q -b "$NAME" "$BASE"
  date > "$WORK/.tendworks-access-check" && g add -A && g commit -q -m "Tendworks access check"
  if g push -q origin "$NAME" 2>/dev/null; then pass "pushes a branch"; else fail "cannot push a branch (Contents: write)"; fi

  PR=$(gh api -X POST "repos/$REPO/pulls" -f title="Tendworks access check" -f head="$NAME" -f base=main -F draft=true --jq .number 2>/dev/null || true)
  if [ -n "$PR" ]; then
    pass "opens a pull request (#$PR)"
    gh api -X PATCH "repos/$REPO/pulls/$PR" -f state=closed >/dev/null 2>&1 || warn "could not close pull request #$PR, close it by hand"
  else
    fail "cannot open a pull request (Pull requests: write)"
  fi

  g checkout -q -b "$NAME-workflow" "$BASE"
  mkdir -p "$WORK/.github/workflows"
  printf 'on: workflow_dispatch\njobs: {}\n' > "$WORK/.github/workflows/tendworks-access-check.yml"
  g add -A && g commit -q -m "Tendworks access check: workflow"
  if g push -q origin "$NAME-workflow" 2>/dev/null; then fail "token can change workflows (Workflows permission)"; else pass "changing workflows refused"; fi

  if [ "$TEST_MAIN" = 1 ]; then
    g checkout -q -b main-check "$BASE"
    date > "$WORK/.tendworks-access-check" && g add -A && g commit -q -m "Tendworks access check: main"
    if g push -q origin HEAD:main 2>/dev/null; then
      fail "token pushed to main: commit $(g rev-parse --short HEAD) is on main now"
      echo "      undo: git push --force origin $BASE:main   (or revert the commit on GitHub)"
    else
      pass "pushing to main refused"
    fi
  fi
fi

if [ "$AUDIT" -gt 0 ]; then
  echo "Commits on main without a merged pull request (last $AUDIT):"
  direct=0
  while read -r sha subject; do
    merged=$(gh api "repos/$REPO/commits/$sha/pulls" --jq '[.[] | select(.merged_at != null)] | length')
    [ "$merged" = 0 ] && { echo "      ${sha:0:7} $subject"; direct=$((direct + 1)); }
  done < <(gh api "repos/$REPO/commits?sha=main&per_page=$AUDIT" --jq '.[] | .sha + " " + (.commit.message | split("\n")[0])')
  [ "$direct" = 0 ] && echo "      none" || echo "      $direct direct push(es); the first commit of a repository always shows up here"
fi

[ "$FAILS" = 0 ] && echo "All checks passed." || { echo "$FAILS check(s) failed."; exit 1; }
