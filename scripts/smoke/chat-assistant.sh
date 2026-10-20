#!/usr/bin/env bash
# Smoke test 5 (docs/platform-implementation.md, chat smoke test, steps 15-18): an `assistant` chat with
# the real harness answers the three example questions of milestone 1b from the platform's
# live state, survives leaving and attaching from two clients, an idle sandbox and a
# platform restart mid-turn, and leaves nothing behind once it ends.
# Acceptance #33. The answers' correctness is judged by you: the script prints each question
# and answer next to the live state (`tend run list`, `tend agent list`, `tend trigger list`)
# taken when the question was sent.
#
# Before:
# - steps 1-3 of the Claude Code harness smoke test (sandbox image, deploy/.env with a
#   harness credential, TEND_API_TOKEN and TEND_API_READ_TOKEN, stack up), `pnpm build` (for
#   the tend CLI) and the scripted ACP image for the active run:
#   docker compose -f deploy/compose.yaml --profile test-images build sandbox-scripted-acp
# - the developer agent's binding scheduled: playground-ready-for-agent without
#   `suspend: true` and TENDWORKS_PLATFORM_GITHUB_TOKEN set (pull request smoke test, step 9),
#   with no open playground issue labelled ready-for-agent (each would start a paid run).
#   Another binding: TEND_SMOKE_BINDING=<name>.
# - Linux: TEND_PLATFORM_MCP_URL set to an address sandboxes reach the server's port at
#   (docs); the script checks it from a sandbox before the chat starts.
# - Optional: lower the idle wait. The script waits for the assistant's idle time
#   (spec.chat.idleMinutes, 5 in examples/config/agents/assistant.md). To wait less, set it
#   to 1 there, restart server and worker, and run with TEND_SMOKE_IDLE_MINUTES=1. Revert
#   afterwards.
#
# Not covered here: that a workflow agent cannot read the platform API is checked by the
# end-to-end test tests/e2e/sandbox-access.test.ts (developer profile's image on the
# sandbox network: 401 without token); run it against this stack with
#   pnpm vitest run --project e2e tests/e2e/sandbox-access.test.ts
#
# Usage: scripts/smoke/chat-assistant.sh   (about 15 minutes with the default idle time)
source "$(dirname "$0")/lib.sh"

BINDING="${TEND_SMOKE_BINDING:-playground-ready-for-agent}"
IDLE_MINUTES="${TEND_SMOKE_IDLE_MINUTES:-5}"
Q1="Is an agent running right now?"
Q2="Were the last runs successful?"
Q3="When does the developer agent run next?"

TMP=$(mktemp -d)
FOLLOW_PID=""
WATCHER_PID=""
cleanup() {
  touch "$TMP/leave"
  [ -z "$FOLLOW_PID" ] || kill "$FOLLOW_PID" 2>/dev/null || true
  [ -z "$WATCHER_PID" ] || kill "$WATCHER_PID" 2>/dev/null || true
  rm -rf "$TMP" 2>/dev/null || true
}
trap cleanup EXIT

tend() { node apps/cli/dist/main.js --url "$URL" "$@"; }
api_post_empty() { curl -fsS -X POST "$URL$1" -H "authorization: Bearer $TEND_API_TOKEN"; }
worker_env() { compose exec -T worker printenv "$1" 2>/dev/null | tr -d '\r'; }

# The live state the answers are judged against.
live_state() {
  echo "  live state at $(date -u +%H:%M:%S) UTC"
  echo "  \$ tend run list"
  tend run list 2>&1 | head -n 8 | sed 's/^/    /'
  echo "  \$ tend agent list"
  tend agent list 2>&1 | sed 's/^/    /'
  echo "  \$ tend trigger list"
  tend trigger list 2>&1 | sed 's/^/    /'
}

chat_field() { api_get "/chats/$CHAT" | field "$1"; }
chat_transcript() { transcript "/chats/$CHAT/transcript"; }

# Waits (timeout $1 s) until the chat waits for the next message or failed; prints the status.
wait_chat() {
  local deadline=$((SECONDS + $1)) status=""
  while [ $SECONDS -lt $deadline ]; do
    status=$(chat_field 'r.status')
    case "$status" in input-required | failed | ended) break ;; esac
    sleep 3
  done
  echo "$status"
}

# Sends a message to the chat (the chat must wait for one).
say() { api_post "/chats/$CHAT/messages" "{\"text\":\"$1\"}" >/dev/null; }

# Fails with the chat's reason when it did not get back to waiting for a message.
expect_waiting() {
  if [ "$1" != input-required ]; then
    echo "FAIL: the chat is ${1:-unreachable} instead of waiting for a message: $(chat_field 'r.message')"
    case "$(chat_field 'r.message')" in
      *"MCP servers over HTTP"*) echo "The harness image does not advertise MCP over HTTP; see the chat smoke test in docs/platform-implementation.md." ;;
    esac
    exit 1
  fi
}

# The titles of the tool calls of turn $1 (0-based; a turn starts with the first message or
# a further one), comma-separated.
turn_tools() {
  chat_transcript | field "(() => {
    const turns = [];
    for (const e of r.items) {
      if (e.type === 'task-started' || e.type === 'message-received') turns.push([]);
      else if (e.type === 'tool-call' && turns.length > 0) turns.at(-1).push(e.title);
    }
    return (turns[$1] ?? []).join(', ');
  })()"
}
PLATFORM_TOOL='tendworks.*(list_runs|get_run|list_triggers|list_agents)'
uses_platform_tool() { grep -Eq "$PLATFORM_TOOL" <<<"$1"; }
# Counts the chat's transcript entries of type $1 (0 when it cannot be read).
count_type() {
  local count
  count=$(chat_transcript | field "r.items.filter((e) => e.type === '$1').length")
  echo "${count:-0}"
}
# True when time $1 is before time $2 (false when either is missing).
before() { node -e 'process.exit(Date.parse(process.argv[1]) < Date.parse(process.argv[2]) ? 0 : 1)' "$1" "$2"; }
# True when log $1 shows question $2, sent by another client, and an agent answer after it.
answered_after() { awk -v q="$2" 'index($0, q) { seen = 1; next } seen && /^[0-9:]+  agent / { ok = 1 } END { exit !ok }' "$1"; }
asker_left_open() { [ "$ASKER_EXIT" -eq 0 ] && grep -q 'stays open' "$TMP/asker.log"; }
has_cost() { [ "$(field 'String((r.cost?.amount ?? r.cost?.usd ?? 0) > 0)' <<<"$CHAT_JSON")" = true ]; }

# --- Preconditions ---------------------------------------------------------------------

[ -f apps/cli/dist/main.js ] || { echo "The tend CLI is not built; run pnpm build first."; exit 1; }
api_get /agents | field 'r.items.map((a) => a.name).join(" ")' | grep -qw assistant ||
  { echo "The control plane lists no agent profile assistant (examples/config/agents/assistant.md)."; exit 1; }
docker image inspect tendworks/sandbox-scripted-acp:test >/dev/null 2>&1 ||
  { echo "Build the scripted ACP image first: docker compose -f deploy/compose.yaml --profile test-images build sandbox-scripted-acp"; exit 1; }

BINDING_STATE=$(api_get /triggers | field "(() => { const t = r.items.find((t) => t.name === '$BINDING'); return t ? (t.suspended ? 'suspended' : 'scheduled') : 'missing'; })()")
if [ "$BINDING_STATE" != scheduled ]; then
  echo "The trigger binding $BINDING is ${BINDING_STATE:-unknown}; question 3 needs it scheduled."
  echo "Remove 'suspend: true' in examples/config/triggers/$BINDING.yaml, set its token in deploy/.env and restart the server."
  exit 1
fi
if [ "$BINDING" = playground-ready-for-agent ] && command -v gh >/dev/null; then
  labelled=$(gh issue list -R "$PLAYGROUND" --label ready-for-agent --state open --json number --jq '[.[].number] | join(",")')
  if [ -n "$labelled" ]; then
    echo "Open playground issues labelled ready-for-agent would start paid runs: $labelled"
    echo "Remove the label first: gh issue edit <n> -R $PLAYGROUND --remove-label ready-for-agent"
    exit 1
  fi
fi

# The address the worker gives chat sessions for the platform MCP server, tried from a
# container of the assistant's sandbox image on the sandbox network, as a sandbox sees it.
MCP_URL=$(worker_env TEND_PLATFORM_MCP_URL)
READ_TOKEN=$(worker_env TEND_API_READ_TOKEN)
NETWORK=$(worker_env TEND_SANDBOX_NETWORK)
IMAGE=$(grep -E '^[[:space:]]*image:' examples/config/sandboxes/claude-code.yaml | awk '{print $2}')
[ -n "$MCP_URL" ] && [ -n "$READ_TOKEN" ] || { echo "The worker has no TEND_PLATFORM_MCP_URL or TEND_API_READ_TOKEN."; exit 1; }
docker network inspect "$NETWORK" >/dev/null 2>&1 ||
  docker network create --driver bridge --opt com.docker.network.bridge.enable_icc=false "$NETWORK" >/dev/null
echo "Checking the platform MCP server at $MCP_URL from a sandbox ..."
MCP_TOOLS=$(MSYS_NO_PATHCONV=1 MCP_URL="$MCP_URL" READ_TOKEN="$READ_TOKEN" docker run --rm --network "$NETWORK" \
  -e MCP_URL -e READ_TOKEN --entrypoint node "$IMAGE" -e '
    fetch(process.env.MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer " + process.env.READ_TOKEN },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }).then((r) => r.json()).then((b) => console.log(b.result.tools.map((t) => t.name).sort().join(" ")), (e) => console.log("unreachable: " + e.cause?.code));
  ' 2>&1 || true)
if [ "$MCP_TOOLS" != "get_run list_agents list_runs list_triggers" ]; then
  echo "FAIL: a sandbox cannot use the platform MCP server at $MCP_URL: $MCP_TOOLS"
  echo "On Linux set TEND_PLATFORM_MCP_URL (docs/platform-implementation.md, chat smoke test)."
  exit 1
fi
echo "  ok    a sandbox lists the platform tools: $MCP_TOOLS"

# --- An active run and a run step to follow ---------------------------------------------

echo
echo "Starting restart-scripted (scripted agent, about 90 seconds, no model cost) ..."
RUN_ID=$(start_run restart-scripted)
[ -n "$RUN_ID" ] || { echo "FAIL: the run did not start"; exit 1; }
deadline=$((SECONDS + 120))
while [ $SECONDS -lt $deadline ] && [ -z "$(transcript_path "$RUN_ID")" ]; do sleep 2; done
[ -n "$(transcript_path "$RUN_ID")" ] || { echo "FAIL: run $RUN_ID has no running agent step after 2 minutes"; exit 1; }
echo "Run $RUN_ID is running its agent step; following it with tend run logs --follow"
tend run logs "$RUN_ID" --follow >"$TMP/follow.log" 2>&1 &
FOLLOW_PID=$!

# --- Questions 1 and 2 through the API --------------------------------------------------

echo
echo "Q1: $Q1"
STATE1=$(live_state)
CHAT=$(api_post /chats "{\"agent\":\"assistant\",\"text\":\"$Q1\"}" | field 'r.id')
[ -n "$CHAT" ] || { echo "FAIL: the chat did not start"; exit 1; }
echo "Chat $CHAT — waiting for the answer (up to 5 minutes) ..."
expect_waiting "$(wait_chat 300)"
A1=$(chat_field 'r.message')
SESSION=$(chat_transcript | field "r.items.find((e) => e.type === 'session-started')?.sessionId")
FIRST_LOOK=$(chat_transcript | field "r.items.find((e) => e.type === 'tool-call' && /$PLATFORM_TOOL/.test(e.title))?.time")

echo "Q2: $Q2"
STATE2=$(live_state)
say "$Q2"
expect_waiting "$(wait_chat 300)"
A2=$(chat_field 'r.message')

# --- Leave and attach: a watching client and one that asks question 3 -------------------

echo "Q3: $Q3 (from a second client, while a first one watches)"
( while [ ! -f "$TMP/leave" ]; do sleep 1; done ) | tend chat attach "$CHAT" >"$TMP/watcher.log" 2>&1 &
WATCHER_PID=$!
sleep 5
STATE3=$(live_state)
ASKER_EXIT=0
printf '%s\n' "$Q3" | tend chat attach "$CHAT" >"$TMP/asker.log" 2>&1 || ASKER_EXIT=$?
A3=$(chat_field 'r.message')
sleep 3
touch "$TMP/leave"
wait "$WATCHER_PID" || true
SANDBOX_WHILE_WAITING=$(docker ps -q --filter "volume=tendworks-volume-$CHAT-session" | wc -l)

# --- Idle sandbox -------------------------------------------------------------------------

echo
echo "Waiting for the idle sandbox to go (idle time $IDLE_MINUTES minutes, up to $((IDLE_MINUTES + 3))) ..."
deadline=$((SECONDS + (IDLE_MINUTES + 3) * 60))
while [ $SECONDS -lt $deadline ] && [ "$(docker ps -aq --filter "volume=tendworks-volume-$CHAT-session" | wc -l)" -gt 0 ]; do sleep 10; done
SANDBOX_WHILE_IDLE=$(docker ps -aq --filter "volume=tendworks-volume-$CHAT-session" | wc -l)
VOLUMES_WHILE_IDLE=$(docker volume ls -q --filter "name=tendworks-volume-$CHAT" | wc -l)
STATUS_WHILE_IDLE=$(chat_field 'r.status')

# --- Platform restart mid-turn ------------------------------------------------------------

Q4="Is run $RUN_ID still running, and did it succeed? Answer in one sentence."
echo "Q4: $Q4 (the platform restarts while the agent works on it)"
STATE4=$(live_state)
RESUMED_BEFORE=$(count_type session-resumed)
say "$Q4"
deadline=$((SECONDS + 180))
while [ $SECONDS -lt $deadline ]; do
  [ "$(count_type session-resumed)" -gt "$RESUMED_BEFORE" ] && break
  sleep 1
done
STATUS_AT_RESTART=$(chat_field 'r.status')
echo "Restarting server and worker (chat status: $STATUS_AT_RESTART) ..."
compose restart server worker >/dev/null
compose up -d --wait server worker >/dev/null
expect_waiting "$(wait_chat 360)"
A4=$(chat_field 'r.message')

# --- End ----------------------------------------------------------------------------------

api_post_empty "/chats/$CHAT/end" >/dev/null
deadline=$((SECONDS + 60))
while [ $SECONDS -lt $deadline ] && [ "$(chat_field 'r.status')" != ended ]; do sleep 2; done
RUN_STATUS=$(wait_run "$RUN_ID" 120)
sleep 2
kill "$FOLLOW_PID" 2>/dev/null || true
wait "$FOLLOW_PID" 2>/dev/null || true
RUN_FINISHED=$(api_get "/runs/$RUN_ID" | field 'r.finishedAt')
RUN_TASKS=$(run_tasks "$RUN_ID")
CHAT_JSON=$(api_get "/chats/$CHAT")
TRANSCRIPT=$(chat_transcript)
TYPES=$(field 'r.items.map((e) => e.type).join(" ")' <<<"$TRANSCRIPT")

# --- Report -------------------------------------------------------------------------------

print_turn() {
  echo
  echo "=== Q$1: $2"
  echo "$3"
  echo "  tools the agent called: $(turn_tools $(($1 - 1)))"
  echo "  answer:"
  sed 's/^/    /' <<<"$4"
}
echo
echo "Questions and answers (judge them against the live state; the run step of $RUN_ID"
echo "and this chat are the agent sessions that were active):"
print_turn 1 "$Q1" "$STATE1" "$A1"
print_turn 2 "$Q2" "$STATE2" "$A2"
print_turn 3 "$Q3" "$STATE3" "$A3"
print_turn 4 "$Q4" "$STATE4" "$A4"
echo
echo "Run $RUN_ID: $RUN_STATUS, finished at $RUN_FINISHED; the agent first looked at $FIRST_LOOK"
echo "Chat $CHAT: $(field 'r.status' <<<"$CHAT_JSON"), cost $(field 'r.cost' <<<"$CHAT_JSON")"
echo "Transcript entry types: $TYPES"
echo

check "the run was still running when the agent first looked at the platform" before "$FIRST_LOOK" "$RUN_FINISHED"
for turn in 0 1 2; do
  check "question $((turn + 1)) was answered with a platform tool" uses_platform_tool "$(turn_tools $turn)"
done
check "tend run logs --follow streamed the run step until it ended" grep -q "ended" "$TMP/follow.log"
check "tend run logs --follow showed the session start" grep -q "session    started" "$TMP/follow.log"
check "the asking client saw the history" grep -qF "$Q1" "$TMP/asker.log"
check "the asking client left the chat open at the end of its input" asker_left_open
check "the watching client saw the history" grep -qF "$Q1" "$TMP/watcher.log"
check "the watching client saw the other client's question and the answer live" answered_after "$TMP/watcher.log" "$Q3"
check "the chat had a sandbox while it waited" test "$SANDBOX_WHILE_WAITING" -ge 1
check "the idle chat lost its sandbox" test "$SANDBOX_WHILE_IDLE" -eq 0
check "the idle chat kept its two volumes" test "$VOLUMES_WHILE_IDLE" -eq 2
check "the idle chat still waited for a message" test "$STATUS_WHILE_IDLE" = input-required
check "the platform restarted during the turn" test "$STATUS_AT_RESTART" = working
check "the interrupted turn was resumed" grep -qw task-resumed <<<"$TYPES"
check "the same ACP session was resumed every time" test -n "$SESSION" -a "$(field "[...new Set(r.items.filter((e) => e.type.startsWith('session-')).map((e) => e.sessionId))].join(' ')" <<<"$TRANSCRIPT")" = "$SESSION"
check "no failed resume" test "$(field "r.items.filter((e) => e.type === 'session-resume-failed').length" <<<"$TRANSCRIPT")" = 0
check "the chat answered all four turns" test "$(field "r.items.filter((e) => e.type === 'input-required').length" <<<"$TRANSCRIPT")" = 4
check "the chat ended" test "$(field 'r.status' <<<"$CHAT_JSON")" = ended
check "the chat has a cost" has_cost
check "the ended chat's transcript stays readable" test -n "$SESSION" -a -n "$TYPES"
check "the run's agent step names its task" test -n "$RUN_TASKS"
# The chat's and the run's sandboxes and volumes; $RUN_TASKS unquoted: one argument per task id.
check_no_leftovers "$CHAT" $RUN_TASKS
ALL_OUTPUT="$TRANSCRIPT$CHAT_JSON$(cat "$TMP/asker.log" "$TMP/watcher.log" "$TMP/follow.log")"
check "no credential shape in the chat, its transcript or the clients' output" no_token_in "$ALL_OUTPUT"
check "the read-only token appears nowhere" test "$(grep -cF "$READ_TOKEN" <<<"$ALL_OUTPUT")" -eq 0
check "the API token appears nowhere" test "$(grep -cF "$TEND_API_TOKEN" <<<"$ALL_OUTPUT")" -eq 0
echo
echo "Not checked here: a workflow agent cannot read the API (tests/e2e/sandbox-access.test.ts)."
finish "chat $CHAT answered from the platform's live state and survived leave/attach, idle and restart (judge the answers above)"
