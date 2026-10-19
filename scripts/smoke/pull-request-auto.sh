#!/usr/bin/env bash
# Smoke test 3 (docs/platform-implementation.md, steps 8-12): a labelled playground issue is
# picked up by the trigger, the developer agent opens a pull request and the platform merges
# it with policy merge: auto.
# Acceptance #18: "An issue in the playground repository matching the trigger binding leads
# to a merged pull request without manual intervention (merge: auto)".
#
# Before: TENDWORKS_PLATFORM_GITHUB_TOKEN in deploy/.env; `suspend: true` removed from
# examples/config/triggers/playground-ready-for-agent.yaml; develop-issue NOT listed in
# examples/config/policies/ask-before-merge.yaml; server restarted after config changes.
# Usage: scripts/smoke/pull-request-auto.sh <issue number in the playground repository>
source "$(dirname "$0")/lib.sh"

ISSUE=${1:?usage: $0 <issue number in $PLAYGROUND>}
if grep -q "develop-issue" examples/config/policies/ask-before-merge.yaml; then
  echo "ask-before-merge lists develop-issue, so the merge would wait for approval."
  echo "Remove it there and restart the server, or use scripts/smoke/pull-request-ask.sh."
  exit 1
fi

label_issue "$ISSUE"
echo "Waiting for the trigger to start a run (checks every minute; up to 3 minutes) ..."
RUN_ID=$(wait_triggered_run "$ISSUE" 180)
echo "Run $RUN_ID — waiting for agent and merge (up to 20 minutes) ..."
STATUS=$(wait_run "$RUN_ID" 1200)
RUN=$(api_get "/runs/$RUN_ID")
OUTPUT=$(field 'r.output' <<<"$RUN")
PR=$(field 'r.pullRequest' <<<"$OUTPUT")
BRANCH=$(field 'r.branch' <<<"$OUTPUT")
TRANSCRIPT=$(transcript_path "$RUN_ID")

echo
echo "Status:       $STATUS"
echo "Started by:   $(field 'r.startedBy' <<<"$RUN")"
echo "Output:       $OUTPUT"
echo "Pull request: ${PR:-<none>}"
echo
check "run completed" test "$STATUS" = completed
check "run was started by the trigger for #$ISSUE" test "$(field 'r.startedBy?.issue?.number' <<<"$RUN")" = "$ISSUE"
check "agent reported a pull request" test -n "$PR"
check "branch is fixed by the run" grep -Eq "^tendworks/issue-$ISSUE-[0-9a-f]{8}$" <<<"$BRANCH"
check "platform merged it (merged: true)" test "$(field 'r.merged' <<<"$OUTPUT")" = true
if [ -n "$PR" ]; then
  check "pull request is merged on GitHub" test "$(pr_field "$PR" state)" = MERGED
  check "pull request comes from the run's branch" test "$(pr_field "$PR" headRefName)" = "$BRANCH"
  check "pull request references the issue" grep -q "#$ISSUE" <<<"$(pr_field "$PR" body)"
  echo "        merged by: $(gh pr view "$PR" --json mergedBy --jq .mergedBy.login) (expected: the platform token's owner)"
fi
check "transcript shows the workspace checkout" test "$(count_entries "$TRANSCRIPT" workspace-checkout)" -ge 1
check_no_tokens "$TRANSCRIPT" "$RUN_ID"
check_no_leftovers
finish "issue #$ISSUE became merged pull request ${PR:-?} without manual steps (run $RUN_ID)"
