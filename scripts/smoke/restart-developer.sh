#!/usr/bin/env bash
# Smoke test 2 (docs/platform-implementation.md, steps 5-7): start restart-developer, restart
# the worker as soon as the ACP session exists, then check that the same session was resumed
# and the run completed.
# Acceptance #18: "Restarting the platform mid-run resumes the run".
# Usage: scripts/smoke/restart-developer.sh
source "$(dirname "$0")/lib.sh"

session_of() { { transcript "$TRANSCRIPT" | grep "\"type\":\"$1\"" || true; } | head -1 | field 'r.sessionId'; }

echo "Starting restart-developer ..."
RUN_ID=$(start_run restart-developer)
[ -n "$RUN_ID" ] || { echo "FAIL: the run did not start"; exit 1; }
echo "Run $RUN_ID — waiting for the ACP session (up to 3 minutes) ..."

TRANSCRIPT=""
SESSION=""
deadline=$((SECONDS + 180))
while [ $SECONDS -lt $deadline ]; do
  [ -n "$TRANSCRIPT" ] || TRANSCRIPT=$(transcript_path "$RUN_ID")
  if [ -n "$TRANSCRIPT" ]; then
    SESSION=$(session_of acp-session)
    [ -n "$SESSION" ] && break
  fi
  sleep 2
done
[ -n "$SESSION" ] || { echo "FAIL: no ACP session after 3 minutes (transcript: ${TRANSCRIPT:-<none yet>})"; exit 1; }
echo "ACP session $SESSION is running"

sleep 5 # let the agent get into its task before pulling the worker away
echo "Restarting the worker ..."
compose restart worker >/dev/null

echo "Waiting for the run to finish (up to 6 minutes) ..."
STATUS=$(wait_run "$RUN_ID" 360)
RESUMED_SESSION=$(session_of acp-session-resumed)
OUTPUT=$(api_get "/runs/$RUN_ID" | field 'r.output')

echo
echo "Status:          $STATUS"
echo "Output:          $OUTPUT"
echo "Resumed session: ${RESUMED_SESSION:-<none>}"
echo
check "run completed" test "$STATUS" = completed
check "task was resumed after the restart" test "$(count_entries "$TRANSCRIPT" task-resumed)" -ge 1
check "the same ACP session was resumed" test "$RESUMED_SESSION" = "$SESSION"
check "no failed resume" test "$(count_entries "$TRANSCRIPT" acp-resume-failed)" -eq 0
check "output counts one resumption" test "$(field 'r.resumed' <<<"$OUTPUT")" = 1
check "agent finished both files" grep -q "after.txt" <<<"$OUTPUT"
check_no_tokens "$TRANSCRIPT" "$RUN_ID"
check_no_leftovers
finish "the run survived the worker restart and resumed ACP session $SESSION (run $RUN_ID)"
