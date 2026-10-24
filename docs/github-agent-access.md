# GitHub access for agents

How to give coding agents just enough GitHub access to develop: push branches and open pull requests. The platform itself performs no GitHub action besides reading issues (ADR 0024 (the-platform-has-no-pull-request-integration)); you review and merge pull requests in GitHub. It works with **one GitHub account on the Free plan**, for **public and private** repositories. It reduces the risk of agent changes reaching production; it does not rule it out. The remaining risks are listed below.

## What one account on Free can and cannot enforce

- A token's **permissions** can be narrowed per repository and per capability (fine-grained personal access token). That is the main lever.
- **Rules** on `main` (rulesets, branch protection) exist on Free only for **public** repositories. And since the agent token belongs to you, a rule cannot tell the agent from you.
- Pushing implies merging: `git push` and merging a pull request both need **Contents: write** ([permissions per endpoint](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)). On a private Free repository the agent token can therefore push to `main` and merge.

So the setup keeps production **out of the agent token's reach**: no access to workflows, Actions, secrets or settings, and releases that only you can start.

## Setup

### 1. Agent token (`TENDWORKS_AGENT_GITHUB_TOKEN`)

GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token:

| Setting | Value |
| --- | --- |
| Expiration | 30–90 days |
| Repository access | Only select repositories: the repositories the agent works on |
| Contents | Read and write (push branches) |
| Pull requests | Read and write (open pull requests) |
| Metadata | Read (set automatically) |
| **Everything else** | **No access**. Especially **Workflows** (cannot change `.github/workflows`), **Actions** (cannot start or re-run workflows), **Secrets**, **Environments**, **Administration** (cannot change settings) |

### 2. Platform token (`TENDWORKS_PLATFORM_GITHUB_TOKEN`)

A second fine-grained token, used only by the server to read issues for trigger bindings, never in a sandbox: same repositories, **Issues** read, **Metadata** read (set automatically), everything else no access. It cannot write anything.

Put both in `deploy/.env` (`chmod 600`) and recreate the stack with `docker compose -f deploy/compose.yaml up -d`; `restart` does not reload `.env`.

### 3. Keep production behind you, not behind `main`

Whatever the agent can push may end up on `main`, so nothing that reaches production should start from a push:

- **No deployment or release on push or tag.** The agent can push tags too (Contents: write). Start releases only with `on: workflow_dispatch`, a manual run. Starting a workflow needs **Actions: write**, which the agent token lacks ([permissions per endpoint](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)).
- **Production credentials** (Play Store key, deploy keys) only in the workflow that you start by hand, or not on GitHub at all: release from your own machine or a separate CI. On private Free repositories, environment secrets and required reviewers are not available ([deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)), so repository secrets are the only place on GitHub.
- **Look before you release.** A manual release builds whatever is on `main`, including changes the agent might have pushed directly. Check with `scripts/check-github-agent-access.sh --audit` (below), or release a commit you reviewed.

### 4. Public repositories only: a ruleset on `main`

Settings → Rules → Rulesets → New branch ruleset, target the default branch, **no bypass list**:

- Restrict deletions, Block force pushes
- Require a pull request before merging (0 approvals: you cannot approve your own pull requests, and the agent token is you)

This stops direct and force pushes to `main` by the agent token. You merge through pull requests. The agent token could merge too.

## Remaining risks

| Risk | Private Free | Public + ruleset | Reduced by |
| --- | --- | --- | --- |
| Agent pushes or force-pushes to `main` | possible | blocked | role description says push only the run branch, `--audit`, keep a clone as a backup |
| Agent merges its own pull request | possible | possible | role description says never merge; `--audit`; manual releases |
| Agent changes CI workflows | blocked | blocked | no Workflows permission |
| Agent starts a release or reads secrets | blocked | blocked | no Actions or Secrets permission, releases only manual |
| Agent changes code a release later builds | possible | possible, through a pull request | look before you release |
| Leaked agent token | the selected repositories, until it expires | same | short expiry, few repositories |
| Commits and pull requests show your name | always | always | the branch name `tendworks/issue-…` marks agent work |

Closing the gap fully needs a second identity (a machine user with a classic token, or a GitHub App token per run, see the roadmap) plus rules, which on private repositories need GitHub Pro.

## Verify

`scripts/check-github-agent-access.sh` checks the agent token. Run it against a test repository first. It reads the token from `--env-file` or `TENDWORKS_AGENT_GITHUB_TOKEN` and never prints it.

```bash
scripts/check-github-agent-access.sh --repo OWNER/NAME --env-file deploy/.env                # read-only checks
scripts/check-github-agent-access.sh --repo OWNER/NAME --env-file deploy/.env --write-tests  # also push tests, cleans up
scripts/check-github-agent-access.sh --repo OWNER/NAME --audit 30                            # commits on main without a merged pull request
```

| Check | Expected |
| --- | --- |
| Token reads the repository | PASS |
| Read secrets, settings or webhooks; start a workflow | refused (403) |
| `--write-tests`: push a branch, open and close a draft pull request | allowed |
| `--write-tests`: push a branch that changes `.github/workflows/` | refused |
| `--write-tests --test-main` (public with ruleset only): push to `main` | refused. If it goes through, the script prints how to revert |
| `--audit N`: last N commits on `main` | each belongs to a merged pull request, otherwise listed as a direct push |
