# GitHub access for agents

How to set up GitHub so that the platform's coding agents can only develop (push their own branches, open pull requests) and cannot push to, force-push or delete `main`, nor merge or approve pull requests. Merging stays with the platform: the merge gate on the control plane API merges with a separate platform token (ADR 0011 (the-platform-merges-through-a-gate-on-the-control-plane-api), ADR 0012 (the-merge-gate-decides-by-the-run-and-waits-for-approval-requests)). Installation and the other secrets: the operator guide (`docs/operator-guide.md`, pull request #52).

Facts on GitHub's behaviour are cited from docs.github.com and the GitHub changelog as of October 2026. Where GitHub documents nothing, this guide says so; the [check script](#verify) and the pull request smoke test are the proof.

## Why

Today the agent token (`TENDWORKS_AGENT_GITHUB_TOKEN`, `GH_TOKEN` in the sandbox) can merge its own pull request: the role description tells the agent not to, nothing enforces it (accepted risk, ADR 0010 (agent-runtime-prepares-the-workspace-and-collects-reported-artifacts)). Three facts make a token-only fix impossible:

- **Pushing implies merging.** Merging a pull request through REST needs the fine-grained permission Contents: write, the same permission `git push` needs; Pull requests: write alone creates, edits and reviews pull requests but does not merge ([permissions required for fine-grained tokens](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens): `PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge` under "Contents", `POST .../pulls` and `POST .../pulls/{pull_number}/reviews` under "Pull requests"). Without rules, a write collaborator may "create, merge, and close pull requests" ([personal repository permissions](https://docs.github.com/en/account-and-profile/reference/permission-levels-for-a-personal-account-repository)) and push to any branch, `main` included.
- **Rules apply to the actor, not the token.** Rulesets name roles, teams, apps or users as bypass actors ([creating rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository#granting-bypass-permissions-for-your-branch-or-tag-ruleset)); two tokens of the same user are the same actor. The agent needs its own GitHub identity.
- **Rules need the right plan.** Rulesets and protected branches are "available in public repositories with GitHub Free and GitHub Free for organizations, and in public and private repositories with GitHub Pro, GitHub Team, and GitHub Enterprise Cloud" ([about rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets), [about protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)). `mtiews/tendworks-playground` is private on a personal Free account: the rules API answers 403 "Upgrade to GitHub Pro or make this repository public to enable this feature."

## Target state

| | Agent | Platform |
| --- | --- | --- |
| Identity | its own account (machine user) or GitHub App, collaborator with write access | the repository owner (admin) |
| Token | `TENDWORKS_AGENT_GITHUB_TOKEN`, worker → sandbox | `TENDWORKS_PLATFORM_GITHUB_TOKEN`, server only |
| May | push branches other than `main`, open and update pull requests, comment | read issues (trigger), read and merge pull requests (merge gate) |
| Must not | push or force-push to `main`, delete it, merge, approve | push to `main` directly (bypass for pull requests only) |
| Enforced by | a branch ruleset on `main` that it cannot bypass | bypass list of that ruleset |

## Choose a setup

| Option | Rules on the repository | Agent identity and token | Cost | Fits |
| --- | --- | --- | --- | --- |
| **A. Public playground** (personal Free) | yes, public repositories get rulesets on Free | machine user as collaborator, **classic** token with `public_repo` | none | the playground now, if its content may be public |
| **B. GitHub Pro** on the personal account | yes, also private | machine user as collaborator, classic token with `repo` | Pro subscription ([plans](https://docs.github.com/en/get-started/learning-about-github/githubs-plans), prices on github.com/pricing) | private playground and later private repositories under `mtiews` |
| C. Free organization | public repositories only; private ones get no rulesets on Free for organizations (same availability statement) | machine user as member with the Write role, fine-grained token with the organization as resource owner | none | public repositories only; for private ones no better than today |
| D. Organization on Team | yes, also private | as C | billed per user ([plans](https://docs.github.com/en/get-started/learning-about-github/githubs-plans)); check on github.com/pricing whether the machine user takes a seat | several people, teams, fine-grained tokens for the agent |
| E. GitHub App, token per run (roadmap) | per plan as above | App installation token, minted by the platform, 1 hour, narrowed to one repository and the needed permissions ([installation tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)); Apps can be bypass actors | none | the long-term answer; needs platform code (architecture: "GitHub App installation token per repo and run") |
| Status quo | none | owner's own tokens | none | accepted risk: the agent can merge |

Why classic tokens in A and B: fine-grained tokens can only access resources of their resource owner (the user itself or an organization it belongs to), and GitHub lists "contribute to repositories where the user is an outside or repository collaborator" as an open gap ([fine-grained token limitations](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#fine-grained-personal-access-tokens-limitations)). A machine user that is a collaborator on `mtiews/...` therefore needs a classic token. Its scope reaches every repository the machine user can access, so invite it only where agents should work.

**Recommendation.** Start with **A** for the playground if nothing in it needs to stay private: free, and it proves the setup with the check script. When the first real private repository arrives, take **B** (same machine user, same steps, `repo` instead of `public_repo`); take **D** instead if more people or teams join. Move to **E** when the platform mints App tokens; then the classic token goes away. If the playground stays private on Free, nothing changes: the agent can merge (accepted risk, unchanged).

## Recommended setup (option A, B is the same)

The steps use the web UI; option names are GitHub's.

1. **Visibility (A only).** Playground → Settings → General → Danger Zone → Change repository visibility → Public. Check first that it holds no secrets or private data, including its history. Consequences: anyone can read code, issues and pull requests and open issues or comment. Only collaborators can label, so strangers cannot start runs (the trigger filters on `ready-for-agent`), but comments by strangers are text an agent may read (`gh issue view --comments`): treat them as untrusted input.
2. **Machine user.** Sign out (or use a private window) and create a new GitHub account, e.g. `mtiews-agent`, with an email address you control (each account needs its own). GitHub's terms allow one free machine account next to your personal account; you accept the terms for it and are responsible for its actions ([Terms of Service, account requirements](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service#3-account-requirements)). Secure it like any account (strong password, two-factor authentication).
3. **Invite it.** As `mtiews`: playground → Settings → Collaborators → Add people → the machine user ([inviting collaborators](https://docs.github.com/en/account-and-profile/setting-up-and-managing-your-personal-account-on-github/managing-access-to-your-personal-repositories/inviting-collaborators-to-a-personal-repository)). Accept the invitation as the machine user. Personal repositories have one collaborator level, which can push and merge ([permissions](https://docs.github.com/en/account-and-profile/reference/permission-levels-for-a-personal-account-repository)); the ruleset (step 5) takes merging away. Leave Settings → General → "Allow auto-merge" off.
4. **Agent token.** As the machine user: Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token (classic). Note `tendworks agent`, an expiration (e.g. 90 days), and only the scope **`public_repo`** (option A) or **`repo`** (option B). Not `workflow`: without it the token cannot add or change GitHub Actions workflow files ([scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)). Copy it into `deploy/.env` (step 7).
5. **Ruleset.** As `mtiews`: playground → Settings → sidebar "Code, planning, and automation" → Rules → Rulesets → New ruleset → New branch ruleset ([creating rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository); rule names from [available rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)):
   - Ruleset name: `main: merge by the platform only`; Enforcement status: **Active**.
   - Bypass list → Add bypass → **Repository admin** (that is `mtiews`; since May 2026 a single user can be added instead, [changelog](https://github.blog/changelog/2026-05-07-repository-rulesets-user-bypass-and-branch-renaming/)) → Add Selected → next to "Always allow" choose **For pull requests only**: the platform may merge pull requests past the rules but cannot push to `main` directly. Do not add the write role or the machine user.
   - Target branches → Add a target → Include default branch.
   - Rules: **Restrict deletions** (on by default), **Block force pushes** (on by default), **Require a pull request before merging** with **Required approvals: 1**, **Dismiss stale pull request approvals when new commits are pushed** and **Require approval of the most recent reviewable push**. Allowed merge methods must include Merge (the platform merges with a merge commit).
   - Create.

   Why this blocks the agent: a pull request rule means changes reach `main` only through a pull request, so its direct push is rejected; with one required approval the agent cannot merge its own pull request, and "Pull request authors cannot approve their own pull requests" ([required reviews](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/approving-a-pull-request-with-required-reviews)). With 0 required approvals the agent could merge.
6. **Platform token.** As `mtiews`: Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token. Name `tendworks platform`, an expiration, Resource owner `mtiews`, Repository access → Only select repositories → the playground. Repository permissions: **Contents: Read and write** (merge), **Pull requests: Read and write**, **Issues: Read-only** (trigger); Metadata: Read-only is added automatically. Nothing else, in particular not Administration (it would let the token edit the ruleset).
7. **`deploy/.env`** (names as in `deploy/.env.example`):

   ```sh
   TENDWORKS_AGENT_GITHUB_TOKEN=<classic token of the machine user>
   TENDWORKS_PLATFORM_GITHUB_TOKEN=<fine-grained token of mtiews>
   ```

   Restart: `docker compose -f deploy/compose.yaml up -d` (compose recreates server and worker with the new environment).
8. **Verify** (next section), then the pull request smoke test (`docs/platform-implementation.md`, steps 8–12): the pull request is opened by the machine user and merged by `mtiews`.

Optional hardening: a `CODEOWNERS` with `* @mtiews` plus **Require review from Code Owners** stops the agent's approval from making someone else's pull request mergeable (see [remaining risks](#remaining-risks)). The **Restrict updates** rule ("only users with bypass permissions can push") is not needed; GitHub does not document how it treats pull request merges, so verify with the script if you add it.

### Later private repositories (option B or D)

Same steps without step 1: B uses `repo` in step 4; D creates the organization, adds the machine user as a member with the Write role ([repository roles](https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization)) and gives it a fine-grained token with the organization as resource owner, Contents and Pull requests read/write, only the target repositories. Each repository needs its ruleset (organization-wide rulesets are an Enterprise feature, [about rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)), and the trigger binding and both tokens must cover it (operator guide, target repository).

## Rotation and expiry

- Set an expiration on both tokens and a reminder before it. GitHub also removes tokens unused for a year ([managing tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)).
- Rotate: create the new token, replace it in `deploy/.env`, `docker compose -f deploy/compose.yaml up -d`, run the check script, then delete the old token. A running agent session keeps the old `GH_TOKEN` until its sandbox ends.
- Suspected leak of the agent token: delete it as the machine user (or remove the machine user as collaborator); the ruleset still kept it out of `main`. A leaked platform token can merge any open pull request: delete it at once.

## Verify

`scripts/check-github-agent-access.sh` checks the setup with the tokens from the environment or from `deploy/.env` (it reads only the two token lines, prints no token and passes none on a command line). Run it against the playground first:

```sh
scripts/check-github-agent-access.sh --env-file deploy/.env                 # read-only
scripts/check-github-agent-access.sh --env-file deploy/.env --write-tests   # also mutating checks
```

Options: `--repo OWNER/NAME` (default `$TEND_PLAYGROUND` or `mtiews/tendworks-playground`), `--branch NAME` (default `main`).

| Check | Expected |
| --- | --- |
| agent token identity (`GET /user`), classic token scopes | the machine user; no scope but `repo` or `public_repo` |
| agent permissions on the repository (`GET /repos/{owner}/{repo}`) | push yes, admin no |
| platform identity | a different login than the agent's |
| rules on `main` (`GET /repos/{owner}/{repo}/rules/branches/main`, [rules API](https://docs.github.com/en/rest/repos/rules#get-rules-for-a-branch)) | Restrict deletions, Block force pushes, pull request with ≥ 1 required approval |
| bypass (`current_user_can_bypass` of each ruleset, [ruleset API](https://docs.github.com/en/rest/repos/rules#get-a-repository-ruleset)) | agent `never`; platform `pull_requests_only` (or `always`) |
| `--write-tests`: push a branch `tendworks/access-check-<time>` | accepted |
| push a marker commit to `main` | rejected |
| open a pull request | accepted (not a draft: a draft cannot be merged anyway, so the merge check would pass for the wrong reason) |
| merge it through REST and through `gh pr merge` | refused |
| approve it | refused |
| cleanup | the pull request is closed and the branch deleted |

Every check prints PASS, FAIL or SKIP; the exit code is 1 on any FAIL. If something that must fail succeeds (a push to `main`, a merge, an approval), the script prints a framed FAIL with the exact commands to undo it. The script checks rulesets only, not classic branch protection. It does not try to delete or force-push `main`, since a successful attempt would damage the branch; the read-only rule check covers both. That the platform really merges past the rule is proven by the pull request smoke test, not by the script, which never merges.

## Remaining risks

- **Not documented: the synchronous merge endpoint and bypass.** The platform merges with `PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge` (`packages/human-interaction/src/pull-requests/github/github-pull-requests.ts`). Only the asynchronous merge API documents a switch, `bypass_rules` ("Whether to bypass repository rules that the authenticated actor is permitted to bypass", default false, [merge asynchronously](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request-asynchronously), [changelog](https://github.blog/changelog/2026-10-01-github-async-merge-api-generally-available/)); the synchronous endpoint says nothing about bypass. If smoke test step 12 fails with a rule violation, the adapter has to move to the asynchronous API with `bypass_rules: true`, or the platform has to approve before it merges (its approval counts: it is not the author). Not verified yet.
- **The agent can approve other people's pull requests.** It has write access, and approvals from people with write permissions count. A pull request by `mtiews` with the agent's approval becomes mergeable, also by the agent. Mitigation: code owner review (optional hardening above), or no pull requests by others in agent repositories. Approve agent work in Tendworks (`tend approval approve`), never as a GitHub review: an approved agent pull request could be merged by the agent itself.
- **Write access beyond `main`.** The agent can push to, and delete, every other branch, close pull requests, edit issues and labels. Restrict more with further rulesets if other branches matter.
- **Classic token reach.** `public_repo` lets the machine user act on every public repository on GitHub where anyone may (issues, comments, forks); `repo` covers every repository the machine user is invited to. Until the egress allowlist, a hijacked agent can use that.
- **Agents read their secrets** (operator guide, secrets): the token protects `main`, not the token itself.

## Answers in short

| Question | Answer |
| --- | --- |
| Permissions for push, pull request, comment | push: Contents write; create/update pull request: Pull requests write; comment: Issues or Pull requests write ([permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)) |
| Merging | REST merge needs Contents write, not Pull requests write; so any token that can push can merge, absent rules. GitHub publishes no per-mutation permissions for GraphQL (`gh pr merge` uses GraphQL): unverified, the script tests it |
| Rules that do it | ruleset on the default branch: Restrict deletions, Block force pushes, Require a pull request with ≥ 1 approval; bypass: Repository admin, for pull requests only. Classic branch protection on a personal repository cannot list bypass actors ("Actors may only be added to bypass lists when the repository belongs to an organization", [about protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)) but lets admins merge past it unless "Do not allow bypassing the above settings" is set |
| Merge queue | public organization repositories or Enterprise Cloud only ([merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)); not an option here |
| Plans | rulesets: public repositories on Free (personal and organization), private on Pro, Team, Enterprise Cloud |
| Identity | separate account (machine user, one free one allowed) or GitHub App; collaborator on a personal repository needs a classic token |
