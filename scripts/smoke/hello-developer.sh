#!/usr/bin/env bash
# Smoke test 1 (docs/platform-implementation.md, steps 3-4): the developer agent runs Claude
# Code in a sandbox, answers, reports cost and leaves nothing behind.
# Acceptance #18: "Run status, transcript and cost are visible via tend run get".
# Usage: scripts/smoke/hello-developer.sh
source "$(dirname "$0")/lib.sh"

echo "Starting hello-developer ..."
RUN_ID=$(start_run hello-developer)
[ -n "$RUN_ID" ] || { echo "FAIL: the run did not start"; exit 1; }
echo "Run $RUN_ID — waiting for it to finish (up to 5 minutes) ..."
STATUS=$(wait_run "$RUN_ID" 300)
RUN=$(api_get "/runs/$RUN_ID")
TRANSCRIPT=$(transcript_path "$RUN_ID")
REPLY=$(echo "$RUN" | field 'r.output?.reply ?? r.steps?.[0]?.output?.reply')
COST=$(echo "$RUN" | field 'r.steps?.reduce((sum, s) => sum + (s.cost?.amount ?? s.cost?.usd ?? 0), 0)')

echo
echo "Status:     $STATUS"
echo "Reply:      $REPLY"
echo "Cost:       $COST"
echo "Transcript: $TRANSCRIPT"
echo
check "run completed" test "$STATUS" = completed
check "agent answered 'hello from the sandbox'" grep -qi "hello from the sandbox" <<<"$REPLY"
check "cost is reported and not zero" node -e "process.exit(Number('$COST') > 0 ? 0 : 1)"
check "transcript exists" test -n "$TRANSCRIPT"
check "transcript has an agent session" test "$(count_entries "$TRANSCRIPT" session-started)" -ge 1
check_no_tokens "$TRANSCRIPT" "$RUN_ID"
check_no_leftovers
finish "hello-developer ran Claude Code in a sandbox (run $RUN_ID; details: tend run get $RUN_ID)"
