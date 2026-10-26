---
name: implement-issue
description: "Autonomously work ONE issue labeled ready-for-agent: a ticket of a spec on the spec's branch (then hand over the next ticket), or a standalone issue on its own branch and pull request (fast path). Trigger/manual invocation only: /implement-issue <number>."
argument-hint: "<issue-number>"
disable-model-invocation: true
---

Work exactly one ticket: **#$ARGUMENTS** (#N below). The trigger started this run because
#N carries `ready-for-agent`. Read `docs/agents/agent-workflow.md` first: it holds the
flow and the **handover rule** this skill applies. One run, one issue, then stop.

Two shapes, told apart in section 1: a **ticket** of a spec (sections 2 to 7) and a
**standalone issue** without a parent (the [fast path](#fast-path-standalone-issue)).

`git` and `gh` are authenticated; you may edit files, run tools, commit, push, open and
edit pull requests, and manage issues. The sandbox has Node 24, pnpm and betterleaks, but
**no Docker**: integration tests, coverage and e2e run only in CI.

**You run unattended.** Nobody answers questions. Wherever a skill (`/tdd`,
`/code-review`, ...) says to confirm something with the user, decide it yourself from the
ticket, its spec, `CLAUDE.md`, `GLOSSARY.md` and `docs/adr/`, and note the decision for
the closing comment.

## 1. Claim it

    gh issue view <N> --json number,title,state,labels,body,comments
    gh api "repos/{owner}/{repo}/issues/<N>" --jq '{parent: .parent_issue_url, sub_issues: .sub_issues_summary.total}'

State the ticket's number and title. If it carries `ready-for-agent`, claim it:
`gh issue edit <N> --remove-label ready-for-agent`.

**Stop** if #N is closed, did not carry `ready-for-agent`, has sub-issues (a spec), or
carries `ready-for-human` (a human ticket). Comment the reason on #N (not for a closed
issue), output `NOTHING_TO_DO #<N>` on its own line, and stop.

Then branch on the parent:

- #N has no `parent`: a standalone issue. Follow the [fast path](#fast-path-standalone-issue)
  instead of sections 2 to 7.
- Otherwise the spec **#S** is the parent: `gh api "<parent_issue_url>" --jq .number`.

## 2. Get on the spec branch

    git fetch origin

- `origin/spec/<S>` exists: `git checkout -B spec/<S> origin/spec/<S>`. If `origin/main`
  has commits the branch lacks (`git rev-list --count HEAD..origin/main` > 0), run
  `git merge origin/main` and resolve the conflicts. Conflicts beyond you: [blocked](#if-you-cannot-finish).
- Otherwise: `git checkout -B spec/<S> origin/main`.

Remember the start: `BASE=$(git rev-parse HEAD)`. Run `pnpm install`.

Find the spec's pull request: `gh pr list --head spec/<S> --state open --json number,url,isDraft`.

## 3. Build it

Read #N in full and the spec (`gh issue view <S> --comments`), then `CLAUDE.md`,
`GLOSSARY.md`, the ADRs and docs that touch the area. Earlier tickets of the spec are
already on `spec/<S>`: treat them as done and build on that code.

1. Invoke `/tdd` and work red → green, one vertical slice at a time. Choose the seams
   yourself: the spec's testing decisions first, otherwise the ticket's acceptance
   criteria. Follow `CLAUDE.md`'s principles (contract-first, ports and adapters, ...).
   Keep the change to this ticket. Run the test files you touch as you go
   (`pnpm exec vitest run <file>`).
2. Run the gate once: `pnpm check` must be green. Do not run `pnpm coverage`,
   `pnpm test:integration` or `pnpm e2e`; they need Docker. Write integration and e2e
   tests where the ticket calls for them anyway: CI runs them.
3. Commit (see [Commits](#commits)), then invoke `/code-review` with the fixed point
   `$BASE` and #N as the spec. Fix what it finds, re-run the affected tests and
   `pnpm check`, and commit again.
4. Push: `git push -u origin spec/<S>`.

## 4. Open the pull request (first ticket only)

If the spec has no open pull request yet, open a draft one. Write the body with the
`pr` skill's template (Summary / Evidence / Merge Danger) for what the spec delivers,
followed by one `Closes #<n>` line for each **agent ticket** of the spec (its tickets without
`ready-for-human`), a `Part of #<S>` line for the spec, and one line naming the human
tickets **without** a closing keyword (e.g. `Acceptance: #<n> (human)`). The spec and its
human tickets stay open until the human finishes them; a merge must never close them:

    gh pr create --draft --base main --head spec/<S> --title "<spec title>" --body-file <file>

Comment the pull request's link on spec #S.

Report it as the run's artifact: write `[{"name": "pull-request", "url": "<pr url>"}]` to
`$TENDWORKS_ARTIFACTS` (also on later tickets, which reuse the open pull request).

## 5. Wait for CI

CI runs on every push to the pull request. Wait for the checks of the commit you pushed:

1. Until `gh pr view <pr> --json headRefOid --jq .headRefOid` equals `git rev-parse HEAD`
   and `gh pr checks <pr>` lists checks, poll every 30 seconds, for at most 5 minutes.
2. Then `timeout 540 gh pr checks <pr> --watch --interval 30`. Exit 8 or 124 means still
   pending: repeat it, for at most **60 minutes** in total. Exit 0 means green.

If no checks show up, or they still run after the time limit: [blocked](#if-you-cannot-finish).

If CI is red, read the failure (`gh run view <run-id> --log-failed`), fix it on the
branch, gate with `pnpm check`, commit, push, and wait again. At most **3 fix attempts**;
still red: [blocked](#if-you-cannot-finish).

## 6. Close the ticket

1. Tick the acceptance criteria you met in #N's body (`- [ ]` to `- [x]`):
   `gh issue edit <N> --body-file <file>`.
2. Close it with a comment naming the commits, the pull request, and the decisions you
   took on your own (e.g. the seams you chose):
   `gh issue close <N> --comment "Done by the agent on spec/<S> (<short-shas>), ships with #<pr>. Decisions: ..."`

Closing does not wait for the merge: the handover rule needs #N closed. The pull request
closes only the agent tickets when it is merged; the spec and its human tickets stay open.

## 7. Hand over

Apply the handover rule from `docs/agents/agent-workflow.md` to spec #S.

| Outcome | Then |
|---|---|
| started #T, or busy #T | output `RESOLVED #<N>` and stop |
| done | `gh pr ready <pr>`; comment on #S that the pull request is ready, naming any open human tickets. Update the pull request body's Summary and Evidence to the whole spec. Output `PR_OPENED #<pr>` and `RESOLVED #<N>`, each on its own line, and stop |
| stuck | comment on #S which agent tickets are held and by which open blockers. Output `RESOLVED #<N>` and stop |

## Fast path (standalone issue)

A human labeled an issue without a parent `ready-for-agent`. No spec, no handover: one
issue, one branch, one pull request. Section 1 (claim) and 3 (build) apply as written;
read #N in full instead of a spec, and take its acceptance criteria as the testing
decisions.

1. **Size check.** If #N has no acceptance criteria, or is too big for one fresh context
   window, do not start: [blocked](#if-you-cannot-finish) and recommend the spec route
   (`/to-spec`, `/to-tickets`) in the comment.
2. **Branch** `agent/<N>`: `git fetch origin`, then `git checkout -B agent/<N> origin/agent/<N>`
   if it exists (a retry), otherwise `git checkout -B agent/<N> origin/main`. Remember
   `BASE=$(git rev-parse HEAD)`, run `pnpm install`.
3. **Build** as in section 3 (steps 1 to 4), pushing `agent/<N>`.
4. **Pull request.** If `gh pr list --head agent/<N> --state open` finds none, open a
   draft one with the `pr` skill's template, titled like #N, ending with `Closes #<N>`
   (and no `Part of`): `gh pr create --draft --base main --head agent/<N> ...`.
5. **Wait for CI** as in section 5, with `agent/<N>` for `spec/<S>`.
6. **Finish.** Tick the met acceptance criteria in #N's body and comment on #N with the
   commits, the pull request and the decisions you took on your own. **Do not close
   #N**: merging the pull request closes it. Write the `pull-request` artifact as in
   section 4, then `gh pr ready <pr>`. Output `PR_OPENED #<pr>` and `RESOLVED #<N>`, each
   on its own line, and stop. Hand over nothing.

Failure works as [below](#if-you-cannot-finish), minus the spec: no comment on a spec, and
the branch is `agent/<N>`.

## If you cannot finish

Do not close #N and do not hand over another ticket: the spec waits for a human.

1. Leave the branch in its best state: commit only what passes `pnpm check`. If the work
   is pushed already (a red CI), say so.
2. Comment on #N: what blocks, what you tried, the state of `spec/<S>`.
3. `gh issue edit <N> --add-label ready-for-human`, and comment on #S that the spec is
   paused at #N.
4. If the pull request exists, report it as the artifact (section 4).
5. Output `BLOCKED #<N>` on its own line and stop.

## Commits

- English, imperative subject, the body says why. Reference the ticket (`#<N>`).
- No AI attribution: no `Co-Authored-By` trailers, no "Generated with" lines, no session links.
- Never `--no-verify`. The pre-commit hook scans for secrets with betterleaks; fix what it
  finds. Mark a known dummy value with `betterleaks:allow` and a reason.

## Rules

- Exactly one issue per run, then stop. Never ask; decide, or go [blocked](#if-you-cannot-finish).
- Set `ready-for-agent` only through the handover rule in section 7.
- Never push to `main`; work reaches `main` only through a pull request (the spec's, or the standalone issue's own).
- Never close #N before its work is pushed and CI is green.
