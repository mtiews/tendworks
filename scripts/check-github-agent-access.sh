#!/usr/bin/env bash
# shellcheck disable=SC2015 # pass and fail always return 0, so `A && pass || fail` is safe
# Checks that the agent token can only develop on a GitHub repository (push its own
# branches, open pull requests) and cannot push to, force-push or merge into the protected
# branch, nor approve pull requests; and that the platform token is a different identity
# that may bypass the rules to merge. Setup and background: docs/github-agent-access.md.
#
# Usage: scripts/check-github-agent-access.sh [--repo OWNER/NAME] [--branch NAME]
#                                             [--env-file PATH] [--write-tests]
#
#   --repo         repository to check (default: $TEND_PLAYGROUND or mtiews/tendworks-playground)
#   --branch       protected branch (default: main)
#   --env-file     read TENDWORKS_AGENT_GITHUB_TOKEN and TENDWORKS_PLATFORM_GITHUB_TOKEN from
#                  this file (e.g. deploy/.env) instead of the environment; nothing else in
#                  the file is read or executed
#   --write-tests  also run the mutating checks with the agent token: push a branch, open a
#                  pull request, try to push to the protected branch, merge and approve; then
#                  close the pull request and delete the branch. Run against the playground
#                  first.
#
# Needs: bash (Git Bash on Windows), git, gh. Tokens are passed to gh through GH_TOKEN and to
# git through a credential helper reading an environment variable; they are never printed
# and never appear on a command line. Exit code 1 if any check fails.
set -euo pipefail

REPO="${TEND_PLAYGROUND:-mtiews/tendworks-playground}"
BRANCH=main
ENV_FILE=""
WRITE_TESTS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO=${2:?--repo needs OWNER/NAME}; shift 2 ;;
    --branch) BRANCH=${2:?--branch needs a name}; shift 2 ;;
    --env-file) ENV_FILE=${2:?--env-file needs a path}; shift 2 ;;
    --write-tests) WRITE_TESTS=1; shift ;;
    -h | --help) sed -n '3,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
done

# Reads one variable from the env file without sourcing it.
read_env_var() {
  local line
  line=$(grep -E "^$1=" "$ENV_FILE" | tail -n 1 || true)
  line=${line#*=}
  line=${line%$'\r'}
  line=${line#\"}; line=${line%\"}
  line=${line#\'}; line=${line%\'}
  printf '%s' "$line"
}
if [ -n "$ENV_FILE" ]; then
  [ -r "$ENV_FILE" ] || { echo "cannot read $ENV_FILE" >&2; exit 2; }
  TENDWORKS_AGENT_GITHUB_TOKEN=$(read_env_var TENDWORKS_AGENT_GITHUB_TOKEN)
  TENDWORKS_PLATFORM_GITHUB_TOKEN=$(read_env_var TENDWORKS_PLATFORM_GITHUB_TOKEN)
fi
AGENT_TOKEN=${TENDWORKS_AGENT_GITHUB_TOKEN:-}
PLATFORM_TOKEN=${TENDWORKS_PLATFORM_GITHUB_TOKEN:-}
unset TENDWORKS_AGENT_GITHUB_TOKEN TENDWORKS_PLATFORM_GITHUB_TOKEN
[ -n "$AGENT_TOKEN" ] || { echo "TENDWORKS_AGENT_GITHUB_TOKEN is not set (environment or --env-file)" >&2; exit 2; }
command -v gh >/dev/null || { echo "gh is not installed" >&2; exit 2; }
command -v git >/dev/null || { echo "git is not installed" >&2; exit 2; }

FAILED=0
TMP=$(mktemp -d)
ERR="$TMP/stderr"
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; FAILED=1; }
skip() { printf 'SKIP  %s\n' "$1"; }
info() { printf '      %s\n' "$1"; }
loud() {
  FAILED=1
  printf '\n'
  printf '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n'
  printf '!! FAIL  %s\n' "$1"
  shift
  for line in "$@"; do printf '!!   %s\n' "$line"; done
  printf '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n\n'
}

# gh as one of the two tokens: `as agent api ...`, `as platform api ...`. GH_TOKEN takes
# precedence over the credentials stored by `gh auth login`.
as() {
  local who=$1
  shift
  local token=$AGENT_TOKEN
  [ "$who" = platform ] && token=$PLATFORM_TOKEN
  GH_TOKEN=$token GITHUB_TOKEN="" GH_HOST=github.com GH_PROMPT_DISABLED=1 gh "$@"
}

# Runs `as <who> api ...`; sets OUT (body or --jq result) and STATUS ("ok" or the HTTP
# status gh reports on failure) and never fails the script.
call() {
  if OUT=$(as "$@" 2>"$ERR"); then
    STATUS=ok
  else
    STATUS=$(grep -o 'HTTP [0-9]*' "$ERR" | tail -n 1 | cut -d' ' -f2 || true)
    STATUS=${STATUS:-error}
    OUT=$(cat "$ERR")
  fi
}

# git with the agent token from an environment variable (never on the command line) and
# no other credential helper, prompt or stored credential.
# shellcheck disable=SC2016 # the helper expands its variables when git runs it
agent_git() {
  CHECK_GIT_TOKEN=$AGENT_TOKEN CHECK_GIT_USER=${AGENT_LOGIN:-x-access-token} \
    GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never \
    git -C "$TMP/repo" -c credential.helper= \
    -c 'credential.helper=!f() { test "$1" = get && printf "username=%s\npassword=%s\n" "$CHECK_GIT_USER" "$CHECK_GIT_TOKEN"; }; f' \
    "$@"
}

PR_NUMBER=""
TEST_BRANCH=""
# shellcheck disable=SC2329 # invoked by the EXIT trap
cleanup() {
  if [ -n "$PR_NUMBER" ]; then
    if as agent api -X PATCH "repos/$REPO/pulls/$PR_NUMBER" -f state=closed >/dev/null 2>&1; then
      info "cleanup: closed pull request #$PR_NUMBER"
    else
      info "cleanup: could not close pull request #$PR_NUMBER; close it by hand"
    fi
  fi
  if [ -n "$TEST_BRANCH" ]; then
    if as agent api -X DELETE "repos/$REPO/git/refs/heads/$TEST_BRANCH" >/dev/null 2>&1; then
      info "cleanup: deleted branch $TEST_BRANCH"
    else
      info "cleanup: could not delete branch $TEST_BRANCH (already gone, or delete it by hand)"
    fi
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

echo "Repository: $REPO, protected branch: $BRANCH"
echo
echo "== Read-only checks"

# 1. Identity of the agent token.
AGENT_LOGIN=""
call agent api user --jq .login
if [ "$STATUS" = ok ] && [ -n "$OUT" ]; then
  AGENT_LOGIN=$OUT
  pass "agent token authenticates as $AGENT_LOGIN"
else
  fail "agent token: GET /user answered $STATUS"
fi

# Classic tokens list their scopes in X-OAuth-Scopes; fine-grained tokens send none.
SCOPES=$(as agent api -i user 2>/dev/null | tr -d '\r' | grep -i '^x-oauth-scopes:' | cut -d: -f2- | sed 's/^ *//' || true)
if [ -n "$SCOPES" ]; then
  info "agent token is a classic token with scopes: $SCOPES"
  extra=$(printf '%s' "$SCOPES" | tr ',' '\n' | sed 's/^ *//' | grep -vE '^(repo|public_repo|)$' || true)
  if [ -n "$extra" ]; then
    fail "agent token has scopes it does not need: $(printf '%s' "$extra" | paste -sd, -) (keep repo or public_repo only)"
  else
    pass "agent token has no scope beyond repository access"
  fi
fi

# 2. What the agent identity may do on the repository.
call agent api "repos/$REPO" --jq '[.permissions.admin, .permissions.maintain, .permissions.push, .private] | map(tostring) | join(" ")'
if [ "$STATUS" = ok ]; then
  read -r P_ADMIN P_MAINTAIN P_PUSH PRIVATE <<<"$OUT"
  info "agent permissions: admin=$P_ADMIN maintain=$P_MAINTAIN push=$P_PUSH (repository private=$PRIVATE)"
  [ "$P_PUSH" = true ] && pass "agent identity can push (needed for its branches)" || fail "agent identity cannot push to $REPO"
  [ "$P_ADMIN" = true ] && fail "agent identity is an admin of $REPO (admins can change or bypass rules)" || pass "agent identity is not an admin"
else
  fail "agent token cannot read $REPO (GET /repos answered $STATUS)"
fi

# 3. The platform token is a different identity.
PLATFORM_LOGIN=""
if [ -z "$PLATFORM_TOKEN" ]; then
  skip "platform identity: TENDWORKS_PLATFORM_GITHUB_TOKEN is not set"
else
  call platform api user --jq .login
  if [ "$STATUS" = ok ] && [ -n "$OUT" ]; then
    PLATFORM_LOGIN=$OUT
    info "platform token authenticates as $PLATFORM_LOGIN"
    if [ -n "$AGENT_LOGIN" ] && [ "$AGENT_LOGIN" = "$PLATFORM_LOGIN" ]; then
      fail "agent and platform token are the same identity ($AGENT_LOGIN): rules cannot tell them apart"
    else
      pass "agent ($AGENT_LOGIN) and platform ($PLATFORM_LOGIN) are different identities"
    fi
  else
    fail "platform token: GET /user answered $STATUS"
  fi
fi

# 4. Rules in force on the protected branch (rulesets only; classic branch protection is
#    not part of this answer).
RULESETS=""
call agent api "repos/$REPO/rules/branches/$BRANCH" --jq '.[] | "\(.type) \(.ruleset_id) \(.parameters.required_approving_review_count // "-")"'
if [ "$STATUS" != ok ]; then
  fail "no rules readable on $BRANCH (GET rules/branches answered $STATUS: $(head -n 1 <<<"$OUT"))"
  info "on a private repository of a personal Free account, rulesets are not available"
else
  RULES=$OUT
  has_rule() { grep -q "^$1 " <<<"$RULES"; }
  if [ -z "$RULES" ]; then
    fail "no active ruleset targets $BRANCH"
  else
    info "active rules on $BRANCH: $(cut -d' ' -f1 <<<"$RULES" | sort -u | paste -sd, -)"
  fi
  has_rule deletion && pass "rule: Restrict deletions" || fail "rule missing: Restrict deletions"
  has_rule non_fast_forward && pass "rule: Block force pushes" || fail "rule missing: Block force pushes"
  if has_rule pull_request; then
    approvals=$(grep '^pull_request ' <<<"$RULES" | cut -d' ' -f3 | sort -n | tail -n 1)
    if [ "${approvals:-0}" != "-" ] && [ "${approvals:-0}" -ge 1 ]; then
      pass "rule: Require a pull request before merging, $approvals required approval(s)"
    else
      fail "rule: Require a pull request before merging has 0 required approvals; the agent could merge its own pull request"
    fi
  else
    fail "rule missing: Require a pull request before merging"
  fi
  has_rule update && info "rule: Restrict updates is active too"
  RULESETS=$(cut -d' ' -f2 <<<"$RULES" | sort -u)
fi

# 5. Who may bypass those rulesets.
if [ -n "$RULESETS" ]; then
  for id in $RULESETS; do
    call agent api "repos/$REPO/rulesets/$id" --jq '"\(.name)\t\(.current_user_can_bypass)"'
    if [ "$STATUS" = ok ]; then
      name=${OUT%%$'\t'*}
      bypass=${OUT##*$'\t'}
      [ "$bypass" = never ] && pass "agent cannot bypass ruleset \"$name\"" || fail "agent can bypass ruleset \"$name\" ($bypass)"
    else
      fail "cannot read ruleset $id with the agent token ($STATUS)"
    fi
    if [ -n "$PLATFORM_TOKEN" ]; then
      call platform api "repos/$REPO/rulesets/$id" --jq '"\(.name)\t\(.current_user_can_bypass)"'
      if [ "$STATUS" = ok ]; then
        name=${OUT%%$'\t'*}
        bypass=${OUT##*$'\t'}
        case "$bypass" in
          pull_requests_only | always | exempt) pass "platform may bypass ruleset \"$name\" ($bypass)" ;;
          *) fail "platform cannot bypass ruleset \"$name\" ($bypass): it could not merge an unapproved pull request" ;;
        esac
        [ "$bypass" = always ] && info "consider \"For pull requests only\" for the platform, so it cannot push to $BRANCH directly"
      else
        fail "cannot read ruleset $id with the platform token ($STATUS)"
      fi
    fi
  done
fi

if [ "$WRITE_TESTS" != 1 ]; then
  echo
  echo "Mutating checks skipped (run with --write-tests, against the playground first)."
  [ "$FAILED" = 0 ] && echo "RESULT: PASS" || echo "RESULT: FAIL"
  exit "$FAILED"
fi

echo
echo "== Mutating checks with the agent token on $REPO"
[ -n "$AGENT_LOGIN" ] || { fail "agent identity unknown; mutating checks not run"; exit 1; }

STAMP="$(date -u +%Y%m%d%H%M%S)-$$"
mkdir -p "$TMP/repo"
git -C "$TMP/repo" init -q
agent_git remote add origin "https://github.com/$REPO.git"
if ! agent_git fetch -q --depth 1 origin "refs/heads/$BRANCH" 2>"$ERR"; then
  fail "agent token cannot fetch $BRANCH: $(tail -n 1 "$ERR")"
  exit 1
fi
BASE=$(agent_git rev-parse FETCH_HEAD)
agent_git read-tree "$BASE"
BLOB=$(printf 'Access check %s by scripts/check-github-agent-access.sh. Safe to delete.\n' "$STAMP" | agent_git hash-object -w --stdin)
agent_git update-index --add --cacheinfo "100644,$BLOB,.tendworks-access-check"
TREE=$(agent_git write-tree)
COMMIT=$(GIT_AUTHOR_NAME="tendworks access check" GIT_AUTHOR_EMAIL="access-check@invalid" \
  GIT_COMMITTER_NAME="tendworks access check" GIT_COMMITTER_EMAIL="access-check@invalid" \
  agent_git commit-tree "$TREE" -p "$BASE" -m "Access check $STAMP (do not merge)")

# 6. Push an own branch: expected to work.
TEST_BRANCH_NAME="tendworks/access-check-$STAMP"
if agent_git push -q origin "$COMMIT:refs/heads/$TEST_BRANCH_NAME" 2>"$ERR"; then
  TEST_BRANCH=$TEST_BRANCH_NAME
  pass "agent pushed its own branch $TEST_BRANCH"
else
  fail "agent cannot push a branch: $(tail -n 1 "$ERR")"
fi

# 7. Push to the protected branch: expected to be rejected.
if agent_git push -q origin "$COMMIT:refs/heads/$BRANCH" 2>"$ERR"; then
  loud "agent pushed directly to $BRANCH (commit $COMMIT on top of $BASE)" \
    "Revert as the repository owner (or with the ruleset disabled):" \
    "  git clone https://github.com/$REPO.git && cd ${REPO#*/}" \
    "  git push --force-with-lease=$BRANCH:$COMMIT origin $BASE:refs/heads/$BRANCH" \
    "Then fix the ruleset (docs/github-agent-access.md) and run this check again."
else
  pass "agent push to $BRANCH rejected: $(grep -m 1 -iE 'rule|protect|denied|declined|refus|error' "$ERR" | sed 's/^remote: *//' || true)"
fi

# 8. Open a pull request (not a draft: a draft cannot be merged anyway, which would make
#    the merge check below pass for the wrong reason).
if [ -n "$TEST_BRANCH" ]; then
  call agent api -X POST "repos/$REPO/pulls" -f "title=Access check $STAMP (do not merge)" \
    -f "head=$TEST_BRANCH" -f "base=$BRANCH" \
    -f "body=Opened by scripts/check-github-agent-access.sh to prove the agent cannot merge or approve. It closes this pull request and deletes the branch when done." \
    --jq .number
  if [ "$STATUS" = ok ]; then
    PR_NUMBER=$OUT
    pass "agent opened pull request #$PR_NUMBER"
  else
    fail "agent cannot open a pull request ($STATUS): $(head -n 1 <<<"$OUT")"
  fi
fi

if [ -n "$PR_NUMBER" ]; then
  # 9. Merge through REST: expected to be refused.
  call agent api -X PUT "repos/$REPO/pulls/$PR_NUMBER/merge" -f merge_method=merge --jq .sha
  if [ "$STATUS" = ok ]; then
    loud "agent merged pull request #$PR_NUMBER through the REST API (merge commit $OUT)" \
      "Revert as the repository owner (or with the ruleset disabled):" \
      "  git clone https://github.com/$REPO.git && cd ${REPO#*/}" \
      "  git revert -m 1 $OUT && git push origin HEAD:$BRANCH" \
      "or open the revert through the pull request page (Revert button)."
    PR_NUMBER=""
  else
    pass "agent merge through REST refused ($STATUS): $(grep -o '"message":"[^"]*"' <<<"$OUT" | head -n 1 || head -n 1 <<<"$OUT")"

    # 10. Merge through the GitHub CLI (GraphQL): expected to be refused.
    if as agent pr merge "$PR_NUMBER" --repo "$REPO" --merge >"$TMP/out" 2>"$ERR"; then
      sha=$(as agent api "repos/$REPO/pulls/$PR_NUMBER" --jq .merge_commit_sha 2>/dev/null || echo "<see the pull request>")
      loud "agent merged pull request #$PR_NUMBER with gh pr merge (merge commit $sha)" \
        "Revert as the repository owner (or with the ruleset disabled):" \
        "  git clone https://github.com/$REPO.git && cd ${REPO#*/}" \
        "  git revert -m 1 $sha && git push origin HEAD:$BRANCH"
      PR_NUMBER=""
    else
      pass "agent merge through gh pr merge refused: $(tail -n 1 "$ERR")"
    fi
  fi
fi

if [ -n "$PR_NUMBER" ]; then
  # 11. Approve: expected to be refused (authors cannot approve their own pull requests).
  call agent api -X POST "repos/$REPO/pulls/$PR_NUMBER/reviews" -f event=APPROVE --jq .id
  if [ "$STATUS" = ok ]; then
    loud "agent approved pull request #$PR_NUMBER (review $OUT)" \
      "Dismiss the approval as the repository owner:" \
      "  gh api -X PUT repos/$REPO/pulls/$PR_NUMBER/reviews/$OUT/dismissals -f message='access check' -f event=DISMISS"
  else
    pass "agent approval refused ($STATUS): $(grep -o '"message":"[^"]*"' <<<"$OUT" | head -n 1 || head -n 1 <<<"$OUT")"
  fi
fi

echo
[ "$FAILED" = 0 ] && echo "RESULT: PASS" || echo "RESULT: FAIL"
exit "$FAILED"
