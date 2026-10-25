---
name: handover
description: "Hand a finished spec to the agent: check its tickets, then put ready-for-agent on the one ticket that can start now. Run after /to-tickets: /handover <spec-number>."
argument-hint: "<spec-number>"
disable-model-invocation: true
---

Hand spec **#$ARGUMENTS** (#S below) to the agent. This is the human's explicit "design
is done": the trigger fires on `ready-for-agent` alone, and this skill puts it on the
first ticket. It starts no work itself. Read `docs/agents/agent-workflow.md` first: it
holds the flow and the **handover rule** applied here.

## 1. Check that #S is a spec

    gh issue view <S> --json number,title,state,labels,body
    gh api "repos/{owner}/{repo}/issues/<S>" --jq '{parent: .parent_issue_url, sub_issues: .sub_issues_summary.total}'

- **Closed**: say so and stop.
- **Has a parent**: it is a ticket. Stop and name its spec; tickets start through their spec.
- **No sub-issues**: look for open issues naming #S as their parent (`## Parent`,
  `Part of #<S>`). Offer to link them (`gh issue edit <S> --add-sub-issue <T>`); without
  any, stop and point to `/to-tickets`.

## 2. Check the tickets

List the spec's open tickets (the query in the handover rule) and read each body.

1. **Blockers are native.** The rule reads only native dependencies. For a ticket whose
   body lists blockers (`## Blocked by`, `Blocked by: #<n>`) that are not native yet,
   offer to add them:

       id=$(gh api "repos/{owner}/{repo}/issues/<blocker>" --jq .id)
       gh api --method POST "repos/{owner}/{repo}/issues/<T>/dependencies/blocked_by" -F issue_id="$id"

2. **Show the plan**: the open tickets in number order, each with its open blockers and
   whether it is a human ticket (`ready-for-human`), so the user sees the order the
   agent will take.
3. **Flag oddities**: an agent ticket without acceptance criteria, a blocker cycle, an
   open blocker outside the spec, a ticket that already had an agent run (the trigger
   fires once per issue, so labeling it starts nothing), or more than one ticket
   carrying `ready-for-agent`. Ask how to proceed before handing over.

## 3. Hand it over

Apply the handover rule to #S.

| Outcome | Tell the user |
|---|---|
| started #T | the agent starts with #T; each finished ticket hands over the next, and the last marks the pull request ready for review |
| busy #T | #T already carries `ready-for-agent`: the spec is handed over already |
| done | no agent ticket is left; nothing to start |
| stuck | agent tickets remain, but each has an open blocker: show which |

For **started**, comment on the spec:
`gh issue comment <S> --body "Handed over to the agent, starting with #<T>."`
