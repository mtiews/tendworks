# Agent workflow: from spec to merged pull request

How Tendworks works its own specs. A human designs a spec and hands it over; the
operator's trigger starts one agent run per ticket labeled `ready-for-agent`; each run
works its ticket on the spec's branch, waits for CI, and hands over the next ticket. The
last agent ticket marks the spec's pull request ready for review.

```text
 human, interactive            human             trigger                    agent, one run per ticket
 ───────────────────────────   ──────────────    ────────────────────────   ─────────────────────────────
 /grill-with-docs              /handover <S>     open issue labeled         /implement-issue <T>
   → /to-spec     (spec #S)      → frontier        ready-for-agent            claim, work on spec/<S>
   → /to-tickets  (#T1..#Tn)       ticket gets     → one run in a sandbox     /tdd, pnpm check, /code-review
   tickets labeled `specified`     the label                                  push, draft PR (first ticket)
                                       ▲                                      wait for CI, close #T
                                       └──── next frontier ticket ◄────────── hand over
                                                                              last one: PR ready for review
 human: review and merge the pull request
```

The core rule: **`ready-for-agent` only ever sits on a ticket that can start now, and on
at most one ticket of a spec.** The trigger is a plain label filter; the skills keep the
label honest.

## Labels

| Label | Set by | Meaning |
| --- | --- | --- |
| `specified` | `/to-tickets`, `/triage` (their `ready-for-agent` role, see [triage-labels.md](triage-labels.md)) | Fully specified, waiting for its turn. Starts nothing. |
| `ready-for-agent` | **only** the [handover rule](#handover-rule), applied by `/handover` or the previous run | Can start now. **The trigger.** Removed by the run that claims it. |
| `ready-for-human` | `/to-spec` on a spec, a human on a manual ticket, or a run that gave up | A human has to act. The agent never starts such a ticket. |

## Work item shapes

- **Spec** (#S): an issue with native sub-issues. A container, never implemented itself.
- **Ticket**: a sub-issue of a spec. One ticket is one agent run. Tickets block each other
  with GitHub's native issue dependencies (`blocked_by`, see [issue-tracker.md](issue-tracker.md)).
- **Human ticket**: a ticket labeled `ready-for-human`, e.g. a milestone acceptance on a
  real host. The agent skips it, and it does not keep the pull request from becoming ready.

An issue that is not a sub-issue of a spec is not worked by the agent.

## Handover rule

The one definition of which ticket gets `ready-for-agent`. Both `/handover` and
`/implement-issue` apply it to a spec #S; nothing else sets the label.

1. List the spec's open tickets with their labels and open blockers:

   ```bash
   gh api --paginate "repos/{owner}/{repo}/issues/<S>/sub_issues?per_page=100" \
     --jq '.[] | select(.state == "open") | {number, labels: [.labels[].name], open_blockers: .issue_dependencies_summary.blocked_by}'
   ```

   `open_blockers` counts only blockers that are still open, inside or outside the spec.
   Where it is `null`, read it per ticket:
   `gh api "repos/{owner}/{repo}/issues/<T>" --jq '.issue_dependencies_summary.blocked_by'`.

2. Agent tickets are the open tickets without `ready-for-human`. Decide in this order:

   | Situation | Outcome |
   | --- | --- |
   | an open ticket already carries `ready-for-agent` | **busy #T**: change nothing |
   | the lowest-numbered agent ticket with `open_blockers == 0` | **started #T** |
   | no agent ticket left | **done** |
   | agent tickets left, each with an open blocker | **stuck** |

3. **Start #T**: `gh issue edit <T> --add-label ready-for-agent`, then
   `gh issue edit <T> --remove-label specified` if #T carries it.

One ticket at a time, because every ticket of a spec commits to the same branch
`spec/<S>`: two runs at once would race on it.

The trigger fires **once per issue**. Labeling a ticket that already had a run does not
start it again (see [When something gets stuck](#when-something-gets-stuck)).

## The flow

### 1. Design (human, interactive)

`/grill-with-docs` pins the idea down; `/to-spec` publishes spec #S (labeled
`ready-for-human`, so it never triggers); `/to-tickets` publishes its tickets as
sub-issues with native blockers, labeled `specified`. Nothing runs yet.

### 2. Hand over (human)

`/handover <S>` (`.claude/skills/handover/`) checks the spec (tickets are sub-issues,
blockers are native, every agent ticket has acceptance criteria), shows the order the
agent will take, and applies the handover rule. It starts no work itself.

### 3. Trigger (operator's config repo)

The `tendworks-implement-issue` workflow in the operator's config repo fires for each open
issue labeled `ready-for-agent` and runs `/implement-issue <N>` in a sandbox with a clone
of this repo, Node 24, pnpm and betterleaks, but **no Docker**.

### 4. Implement (agent, one run per ticket)

`/implement-issue <N>` (`.claude/skills/implement-issue/`) runs unattended:

1. **Claims** #N (removes `ready-for-agent`); stops if #N is closed, was unlabeled, is a
   spec, is no ticket, or is a human ticket.
2. **Branch** `spec/<S>`, created from `origin/main` by the first ticket; later tickets
   continue it and merge `origin/main` in when it moved on.
3. **Builds** the ticket test-first with `/tdd`, runs the sandbox gate (`pnpm install`,
   `pnpm check`), reviews the ticket's diff with `/code-review` and fixes the findings.
4. **Commits and pushes** to `spec/<S>`. The first ticket opens a **draft pull request**
   `spec/<S>` → `main` that closes the spec's **agent tickets** (`Closes #<n>`); it names the
   spec (`Part of #<S>`) and the human tickets without a closing keyword.
5. **Waits for CI** on the pull request. Integration tests, coverage and e2e need Docker,
   so they run only there. A red CI is fixed in the same run, within a few attempts.
6. **Closes** #N with its acceptance criteria ticked, and reports the pull request as the
   run's `pull-request` artifact.
7. **Hands over** by the handover rule. When no agent ticket is left, it marks the pull
   request ready for review.

Decisions the agent takes on its own (where a skill would ask) go into the ticket's
closing comment.

Each run ends with markers on their own lines:

| Marker | Meaning |
| --- | --- |
| `RESOLVED #N` | ticket done, CI green, closed |
| `PR_OPENED #<pr>` | printed with `RESOLVED` by the last agent ticket: the pull request is ready for review |
| `BLOCKED #N` | gave up; #N is labeled `ready-for-human`, the spec pauses |
| `NOTHING_TO_DO #N` | not workable (closed, unlabeled, a spec, no ticket, or a human ticket) |

### 5. Merge (human)

Review the pull request and merge it; merging closes the agent tickets. Then finish the
human tickets (e.g. the acceptance), close them, and close the spec last.

## When something gets stuck

| Situation | What you see | What to do |
| --- | --- | --- |
| A ticket failed | ticket labeled `ready-for-human`, comments on it and on the spec | finish it on `spec/<S>` (by hand, or `/implement-issue <N>` locally), close it, then `/handover <S>` |
| Spec stuck | comment on the spec naming the held tickets | resolve the blockers, then `/handover <S>` |
| A run ended without a marker | the run's transcript in Tendworks | check it; if the ticket is unfinished, treat it like a failed ticket |
| Stop a spec | | remove `ready-for-agent` from its queued ticket before its run starts; `/handover <S>` continues later |

## Rules of thumb

- Blocking counts only as **native dependencies**; "Blocked by" text in a body is ignored
  by the rule. `/handover` offers to convert it.
- Keep a ticket small enough for one fresh context window.
- Never add `ready-for-agent` by hand; run `/handover`, which checks first.
