#!/usr/bin/env bash
# Smoke test 4 (docs/platform-implementation.md, step 14): with policy merge: ask the run waits
# for an approval request, survives a platform restart while waiting, and merges only after
# approval (or ends without merge after rejection).
# Acceptance #18: "The same with merge: ask after approving via tend approval approve".
#
# Before: as for pull-request-auto.sh, but develop-issue listed under `workflows` in
# policies/ask-before-merge.yaml of the configuration (TEND_CONFIG_PATH; the starter
# configuration lists it) and the server restarted.
# Usage: scripts/smoke/pull-request-ask.sh <issue number> [approve|reject]
#   Without a decision argument the script asks you before it decides.
source "$(dirname "$0")/lib.sh"

ISSUE=${1:?usage: $0 <issue number in $PLAYGROUND> [approve|reject]}
DECISION=${2:-}
if ! asks_for_develop_issue; then
  echo "ask-before-merge does not list develop-issue, so the merge would not ask."
  echo "Add it under workflows in $CONFIG/policies/ask-before-merge.yaml and restart the server."
  exit 1
fi

pending_request() { api_get "/approval-requests?status=pending" | field "r.items.find((a) => a.runId === '$RUN_ID')?.$1"; }

label_issue "$ISSUE"
echo "Waiting for the trigger to start a run (up to 3 minutes) ..."
RUN_ID=$(wait_triggered_run "$ISSUE" 180)
echo "Run $RUN_ID — waiting for the approval request (up to 20 minutes) ..."
REQUEST=""
deadline=$((SECONDS + 1200))
while [ $SECONDS -lt $deadline ]; do
  REQUEST=$(pending_request id)
  [ -n "$REQUEST" ] && break
  case "$(api_get "/runs/$RUN_ID" | field 'r.status')" in completed | failed) break ;; esac
  sleep 10
done
[ -n "$REQUEST" ] || { echo "FAIL: no approval request for run $RUN_ID"; api_get "/runs/$RUN_ID"; echo; exit 1; }
PR=$(api_get "/runs/$RUN_ID" | field 'r.steps?.map((s) => s.output?.pullRequest).find(Boolean) ?? ""')
PR=${PR:-$(pending_request pullRequest)}

echo
echo "Approval request $REQUEST: $(pending_request question)"
check "pull request is still open while waiting" test "$(pr_field "$PR" state)" = OPEN
check "tend status counts the pending approval" test "$(api_get /status | field 'r.pendingApprovals')" != 0
check "a notification announces the request" grep -q "approval.requested" <<<"$(api_get /notifications)"

echo "Restarting server and worker while the run waits ..."
compose restart server worker >/dev/null
sleep 20
check "request is still pending after the restart" test "$(pending_request id)" = "$REQUEST"
check "run is still waiting after the restart" test "$(api_get "/runs/$RUN_ID" | field 'r.status')" = running

if [ -z "$DECISION" ]; then
  read -r -p "Decide approval request $REQUEST — approve or reject? [approve/reject] " DECISION
fi
case "$DECISION" in approve | reject) ;; *) echo "FAIL: decision must be approve or reject"; exit 1 ;; esac
api_post "/approval-requests/$REQUEST/decision" "{\"decision\":\"$DECISION\"}" >/dev/null
echo "Decided: $DECISION — waiting for the run to finish (up to 5 minutes) ..."

STATUS=$(wait_run "$RUN_ID" 300)
OUTPUT=$(api_get "/runs/$RUN_ID" | field 'r.output')
echo
echo "Status: $STATUS"
echo "Output: $OUTPUT"
echo
check "run completed" test "$STATUS" = completed
check "output records the decision" test "$(field 'r.approval' <<<"$OUTPUT")" = "$DECISION"
if [ "$DECISION" = approve ]; then
  check "platform merged it (merged: true)" test "$(field 'r.merged' <<<"$OUTPUT")" = true
  check "pull request is merged on GitHub" test "$(pr_field "$PR" state)" = MERGED
else
  check "nothing merged (merged: false)" test "$(field 'r.merged' <<<"$OUTPUT")" = false
  check "pull request is still open on GitHub" test "$(pr_field "$PR" state)" = OPEN
fi
check_no_leftovers $(run_tasks "$RUN_ID")
finish "merge: ask waited across a restart and the run followed the decision '$DECISION' (run $RUN_ID, $PR)"
