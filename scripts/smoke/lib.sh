# Shared helpers for the manual smoke tests with the real harness and GitHub
# (docs/platform-implementation.md). Source it; do not run it.
#
# Needs: the stack running with deploy/.env set up, TEND_API_TOKEN exported in the shell,
# Git Bash (on Windows) or any POSIX shell, node, docker, curl; the GitHub scripts also gh.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

URL="${TEND_URL:-http://localhost:8080}"
: "${TEND_API_TOKEN:?export TEND_API_TOKEN first (the same value as in deploy/.env)}"
PLAYGROUND="${TEND_PLAYGROUND:-mtiews/tendworks-playground}"
FAILED=0

compose() { docker compose -f deploy/compose.yaml "$@"; }

# Prints one field of the JSON on stdin, e.g. `field 'r.steps?.[0]?.transcript'`; prints
# nothing for empty or non-JSON input, so polling loops keep waiting instead of failing.
field() {
  node -e '
    let d = "";
    process.stdin.on("data", (c) => (d += c)).on("end", () => {
      let r;
      try { r = JSON.parse(d); } catch { return; }
      const v = new Function("r", "return " + process.argv[1])(r);
      process.stdout.write(v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
    });' "$1"
}

api_get() { curl -fsS "$URL$1" -H "authorization: Bearer $TEND_API_TOKEN" || true; }
api_post() {
  curl -fsS -X POST "$URL$1" -H "authorization: Bearer $TEND_API_TOKEN" \
    -H 'content-type: application/json' -d "$2"
}

# Starts a run of a workflow and prints its id.
start_run() { api_post /runs "{\"workflow\":\"$1\"}" | field 'r.id'; }

# Waits until run $1 is completed or failed (timeout $2 seconds) and prints the status.
wait_run() {
  local id=$1 deadline=$((SECONDS + $2)) status=""
  while [ $SECONDS -lt $deadline ]; do
    status=$(api_get "/runs/$id" | field 'r.status')
    case "$status" in completed | failed) break ;; esac
    sleep 5
  done
  echo "$status"
}

# Prints the container path of the first transcript of run $1 (empty while there is none).
transcript_path() { api_get "/runs/$1" | field 'r.steps?.find((s) => s.transcript)?.transcript' | sed 's|^file://||'; }

# Prints transcript $1; MSYS_NO_PATHCONV keeps Git Bash from rewriting the container path.
transcript() { [ -n "$1" ] && MSYS_NO_PATHCONV=1 compose exec -T worker cat "$1" 2>/dev/null || true; }

# Counts transcript entries of type $2 in transcript $1.
count_entries() { { transcript "$1" | grep -c "\"type\":\"$2\"" || true; } | head -1; }

# Records a check: check "<description>" <condition command...>
check() {
  local description=$1
  shift
  if "$@"; then
    echo "  ok    $description"
  else
    echo "  FAIL  $description"
    FAILED=1
  fi
}

# Checks that no sandbox container or session volume was left behind.
check_no_leftovers() {
  check "no leftover sandbox" test "$(docker ps -aq --filter label=dev.tendworks.sandbox | wc -l)" -eq 0
  check "no leftover session volume" test "$(docker volume ls -q --filter label=dev.tendworks.volume | wc -l)" -eq 0
}

# Shapes of GitHub and Anthropic credentials that must never show up in runs or transcripts.
TOKEN_PATTERN='gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{20,}'
no_token_in() { ! grep -Eq "$TOKEN_PATTERN" <<<"$1"; }

# Checks that no credential shape appears in transcript $1 or in run $2.
check_no_tokens() {
  local text
  text=$(transcript "$1")
  check "no credential in the transcript" no_token_in "$text"
  text=$(api_get "/runs/$2")
  check "no credential in the run" no_token_in "$text"
}

finish() {
  echo
  if [ "$FAILED" -eq 0 ]; then
    echo "PASS: $1"
  else
    echo "FAIL: $1 — see the checks above"
    exit 1
  fi
}

# Labels playground issue $1 ready-for-agent after making sure no other open issue carries
# the label (each one would start its own paid run).
label_issue() {
  local issue=$1 others
  others=$(gh issue list -R "$PLAYGROUND" --label ready-for-agent --state open --json number \
    --jq "[.[].number | select(. != $issue)] | join(\",\")")
  if [ -n "$others" ]; then
    echo "Other open issues are labelled ready-for-agent and would start runs too: $others"
    echo "Remove the label there first: gh issue edit <n> -R $PLAYGROUND --remove-label ready-for-agent"
    exit 1
  fi
  gh issue edit "$issue" -R "$PLAYGROUND" --add-label ready-for-agent >/dev/null
  echo "Labelled $PLAYGROUND#$issue ready-for-agent"
}

# Checks that the playground binding is active and waits (timeout $2 s) for the run it
# starts for issue $1; prints the run id.
wait_triggered_run() {
  local issue=$1 deadline=$((SECONDS + $2)) id=""
  local suspended
  suspended=$(api_get /triggers | field 'r.items.find((t) => t.name === "playground-ready-for-agent")?.suspended')
  if [ "$suspended" = true ]; then
    echo "The binding playground-ready-for-agent is suspended. Remove 'suspend: true' in" >&2
    echo "examples/config/triggers/playground-ready-for-agent.yaml and restart the server." >&2
    exit 1
  fi
  while [ $SECONDS -lt $deadline ]; do
    id=$(api_get /runs | field "r.items.find((x) => x.startedBy?.kind === 'trigger' && x.startedBy.issue?.number === $issue && x.startedBy.issue?.repository === '$PLAYGROUND')?.id")
    [ -n "$id" ] && break
    sleep 10
  done
  if [ -z "$id" ]; then
    echo "No run started for issue #$issue. Last trigger check:" >&2
    api_get /triggers | field 'r.items.find((t) => t.name === "playground-ready-for-agent")?.lastEvaluation' >&2
    echo >&2
    exit 1
  fi
  echo "$id"
}

# Prints a field of pull request $1 (URL) from GitHub, e.g. `pr_field <url> state`.
pr_field() { gh pr view "$1" --json "$2" --jq ".$2"; }
