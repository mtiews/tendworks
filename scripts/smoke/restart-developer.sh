#!/usr/bin/env bash
# Manual smoke test with the real Claude Code harness (docs/platform-implementation.md, steps 5-7):
# start restart-developer, restart the worker as soon as the ACP session exists, then check that
# the same session was resumed and the run completed.
#
# Needs the stack running with deploy/.env set up and TEND_API_TOKEN exported in this shell.
# Usage: scripts/smoke/restart-developer.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

URL="${TEND_URL:-http://localhost:8080}"
: "${TEND_API_TOKEN:?export TEND_API_TOKEN first (the same value as in deploy/.env)}"
compose() { docker compose -f deploy/compose.yaml "$@"; }

# Prints one field of the JSON on stdin, e.g. `field 'r.steps[0]?.transcript'`; prints nothing
# for empty or non-JSON input, so polling loops keep waiting instead of failing.
field() {
  node -e '
    let d = "";
    process.stdin.on("data", (c) => (d += c)).on("end", () => {
      let r;
      try { r = JSON.parse(d); } catch { return; }
      const v = new Function("r", "return " + process.argv[1])(r);
      process.stdout.write(v === undefined || v === null ? "" : String(v));
    });' "$1"
}

get_run() { curl -fsS "$URL/runs/$RUN_ID" -H "authorization: Bearer $TEND_API_TOKEN" || true; }
# MSYS_NO_PATHCONV keeps Git Bash on Windows from rewriting the container path.
transcript() { MSYS_NO_PATHCONV=1 compose exec -T worker cat "$TRANSCRIPT" 2>/dev/null || true; }
session_of() { { transcript | grep "\"type\":\"$1\"" || true; } | head -1 | field 'r.sessionId'; }

echo "Starting restart-developer ..."
RUN_ID=$(curl -fsS -X POST "$URL/runs" \
  -H "authorization: Bearer $TEND_API_TOKEN" -H 'content-type: application/json' \
  -d '{"workflow":"restart-developer"}' | field 'r.id')
[ -n "$RUN_ID" ] || { echo "FAIL: the run did not start"; exit 1; }
echo "Run $RUN_ID"

echo "Waiting for the ACP session (up to 3 minutes) ..."
TRANSCRIPT=""
SESSION=""
for _ in $(seq 1 90); do
  if [ -z "$TRANSCRIPT" ]; then
    TRANSCRIPT=$(get_run | field 'r.steps?.find((s) => s.transcript)?.transcript' | sed 's|^file://||')
  fi
  if [ -n "$TRANSCRIPT" ]; then
    SESSION=$(session_of acp-session)
    [ -n "$SESSION" ] && break
  fi
  sleep 2
done
[ -n "$SESSION" ] || { echo "FAIL: no ACP session after 3 minutes (transcript: ${TRANSCRIPT:-<none yet>})"; get_run; echo; exit 1; }
echo "ACP session $SESSION is running; transcript $TRANSCRIPT"

sleep 5 # let the agent get into its task before pulling the worker away
echo "Restarting the worker ..."
compose restart worker >/dev/null

echo "Waiting for the run to finish (up to 6 minutes) ..."
STATUS=""
for _ in $(seq 1 120); do
  STATUS=$(get_run | field 'r.status' || true)
  case "$STATUS" in completed | failed) break ;; esac
  sleep 3
done

RESUMED_SESSION=$(session_of acp-session-resumed)
RUN=$(get_run)
echo
echo "Run status:        $STATUS"
echo "Output:            $(echo "$RUN" | field 'JSON.stringify(r.output)')"
echo "task-resumed:      $(transcript | grep -c '"type":"task-resumed"' || true)"
echo "Resumed session:   ${RESUMED_SESSION:-<none>}"
echo "acp-resume-failed: $(transcript | grep -c '"type":"acp-resume-failed"' || true)"
echo "Leftover sandboxes: $(docker ps -aq --filter label=dev.tendworks.sandbox | wc -l)"
echo "Leftover volumes:   $(docker volume ls -q --filter label=dev.tendworks.volume | wc -l)"
echo

if [ "$STATUS" = completed ] && [ "$RESUMED_SESSION" = "$SESSION" ]; then
  echo "PASS: the run survived the restart and resumed ACP session $SESSION"
else
  echo "FAIL: see above; full transcript with: MSYS_NO_PATHCONV=1 docker compose -f deploy/compose.yaml exec worker cat $TRANSCRIPT"
  exit 1
fi
