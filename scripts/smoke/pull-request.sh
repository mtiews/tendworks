#!/usr/bin/env bash
# Smoke test 3 (docs/platform-implementation.md, pull request smoke test): a labelled
# playground issue is picked up by the trigger, the developer agent opens a pull request
# and reports it, and the run completes with it. The platform merges nothing; the pull
# request stays open for a human.
#
# Before: TENDWORKS_PLATFORM_GITHUB_TOKEN (issues read) and TENDWORKS_AGENT_GITHUB_TOKEN in
# deploy/.env; in the configuration (TEND_CONFIG_PATH, by default examples/config)
# `suspend: true` removed from triggers/playground-ready-for-agent.yaml; server restarted
# after config changes.
# Usage: scripts/smoke/pull-request.sh <issue number in the playground repository>
source "$(dirname "$0")/lib.sh"

ISSUE=${1:?usage: $0 <issue number in $PLAYGROUND>}
pr_field() { gh pr view "$1" --json "$2" --jq ".$2"; }

label_issue "$ISSUE"
echo "Waiting for the trigger to start a run (checks every minute; up to 3 minutes) ..."
RUN_ID=$(wait_triggered_run "$ISSUE" 180)
echo "Run $RUN_ID — waiting for the agent (up to 20 minutes) ..."
STATUS=$(wait_run "$RUN_ID" 1200)
RUN=$(api_get "/runs/$RUN_ID")
OUTPUT=$(field 'r.output' <<<"$RUN")
PR=$(field 'r.pullRequest' <<<"$OUTPUT")
BRANCH=$(field 'r.branch' <<<"$OUTPUT")
ARTIFACT=$(field 'r.steps[0]?.artifacts?.find((a) => a.name === "pull-request")?.url' <<<"$RUN")
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
check "the run ends after the agent step" test "$(field 'r.steps.length' <<<"$RUN")" = 1
check "the pull request is the step's artifact" test "$ARTIFACT" = "$PR"
check "branch is fixed by the run" grep -Eq "^tendworks/issue-$ISSUE-[0-9a-f]{8}$" <<<"$BRANCH"
if [ -n "$PR" ]; then
  check "pull request is open on GitHub, waiting for a human" test "$(pr_field "$PR" state)" = OPEN
  check "pull request comes from the run's branch" test "$(pr_field "$PR" headRefName)" = "$BRANCH"
  check "pull request references the issue" grep -q "#$ISSUE" <<<"$(pr_field "$PR" body)"
fi
check "transcript shows the workspace checkout" test "$(count_entries "$TRANSCRIPT" workspace-checkout)" -ge 1
check_no_tokens "$TRANSCRIPT" "$RUN_ID"
check_no_leftovers $(run_tasks "$RUN_ID")
finish "issue #$ISSUE became open pull request ${PR:-?} without manual steps (run $RUN_ID)"
