import type { ControlPlane } from "@tendworks/shared";
import { approvalRequested } from "./approvals/approval-events.js";
import type { ApprovalRequest, ApprovalStore } from "./approvals/approval-store.js";
import { decideFor, type Policy } from "./policy.js";
import { MergeRefusedError, type PullRequestDetails, type PullRequests } from "./pull-requests/pull-requests.js";

type Schemas = ControlPlane.components["schemas"];
export type MergeRequest = Schemas["MergePullRequestRequest"];
export type PullRequestMerge = Schemas["PullRequestMerge"];

/**
 * Why a merge did not happen. `invalid`: the request cannot be served (no or unreported
 * pull request, unknown run, no applicable policy, unknown host). `rejected`: the
 * approval request was rejected. `conflict`: the run is not running. `refused`: the
 * repository refused. `unavailable`: the repository could not be asked.
 */
export type MergeRefusal = { reason: "invalid" | "rejected" | "conflict" | "refused" | "unavailable"; title: string; detail: string };
/** `pending`: the policy asks and the approval request is not decided yet; nothing is merged. */
export type MergeOutcome = { merged: PullRequestMerge } | { pending: PullRequestMerge } | { refused: MergeRefusal };

/** What the gate needs to know about a run, from orchestration's record of it. */
export interface GatedRun {
  id: string;
  workflow: string;
  status: "pending" | "running" | "completed" | "failed";
  /**
   * Links the run's agents reported; pull requests are named `pull-request`. Each with
   * the workspace its step handed to the agent, as the run's workflow set it.
   */
  artifacts: { name: string; url: string; workspace?: { repository: string; branch: string } }[];
  /** W3C trace context of the run; the events of its approval requests carry it. */
  traceparent?: string;
}

/** What the gate needs from a run as the control plane API describes it. */
export function toGatedRun(run: Schemas["run"]): GatedRun {
  return {
    id: run.id,
    workflow: run.workflow,
    status: run.status,
    artifacts: run.steps.flatMap((step) =>
      (step.artifacts ?? []).map(({ name, url }) => ({ name, url, ...(step.workspace ? { workspace: { ...step.workspace } } : {}) })),
    ),
    ...(run.traceparent === undefined ? {} : { traceparent: run.traceparent }),
  };
}

/** The artifact name under which agents report the pull request they opened. */
export const PULL_REQUEST_ARTIFACT = "pull-request";

export interface MergeGateOptions {
  /** The configured policies. */
  policies: Policy[];
  /** Orchestration's record of a run; the authority on its workflow, status and pull requests. */
  runs: (runId: string) => Promise<GatedRun | undefined>;
  /** The integration that merges pull requests at this URL, if any. */
  pullRequests: (url: string) => PullRequests | undefined;
  approvals: ApprovalStore;
  now?: () => Date;
  newId?: () => string;
}

export interface MergeGate {
  merge(request: MergeRequest): Promise<MergeOutcome>;
}

/**
 * The gate in front of merging a pull request. The caller only names the run and the
 * pull request; everything the decision rests on comes from the platform's own records
 * and the repository host: the run (running, reported this pull request), the host's
 * account of the pull request (it belongs to the repository of the workspace the run
 * gave its agent and merges from exactly that branch, not from a fork), the policies
 * that apply to its workflow, and, when they ask, the approval request for exactly this
 * merge. So no client, workflow or agent can merge past the policy by what it sends.
 */
export function createMergeGate({
  policies,
  runs,
  pullRequests,
  approvals,
  now = () => new Date(),
  newId = () => crypto.randomUUID(),
}: MergeGateOptions): MergeGate {
  const refused = (reason: MergeRefusal["reason"], title: string, detail: string): MergeOutcome => ({ refused: { reason, title, detail } });
  const failedAsking = (error: unknown): MergeOutcome => {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof MergeRefusedError) return refused("refused", "Pull request cannot be merged", message);
    return refused("unavailable", "Repository unavailable", message);
  };

  return {
    async merge({ run: runId, pullRequest }) {
      if (pullRequest === null || pullRequest === "") {
        return refused("invalid", "No pull request to merge", "`pullRequest` is null: the step before reported no pull request (did the agent open and report one?)");
      }
      const run = await runs(runId);
      if (!run) return refused("invalid", "Unknown run", `no run '${runId}' exists`);
      if (run.status !== "running") {
        return refused("conflict", "Run is not running", `run ${run.id} is ${run.status}; only a running run can merge its pull request`);
      }
      const reportedPullRequests = run.artifacts.filter((artifact) => artifact.name === PULL_REQUEST_ARTIFACT);
      const reported = reportedPullRequests.map((artifact) => artifact.url);
      if (!reported.includes(pullRequest)) {
        return refused(
          "invalid",
          "Pull request not reported by the run",
          `run ${run.id} reported no pull request ${pullRequest} (reported: ${reported.join(", ") || "none"})`,
        );
      }
      let host: string;
      try {
        host = new URL(pullRequest).host;
      } catch {
        return refused("invalid", "No pull request to merge", `'${pullRequest}' is not a URL`);
      }
      const integration = pullRequests(pullRequest);
      if (!integration) return refused("invalid", "No integration for this pull request", `no integration merges pull requests on ${host}`);

      // The agent only reports a URL; the repository host says what it points at.
      const notOwn = (detail: string) => refused("invalid", "Pull request is not from the run's workspace", detail);
      const workspace = reportedPullRequests.find((artifact) => artifact.url === pullRequest && artifact.workspace)?.workspace;
      if (!workspace) return notOwn(`run ${run.id} reported ${pullRequest} from a step without a workspace, so nothing ties it to a branch of the run`);
      let details: PullRequestDetails;
      try {
        details = await integration.describe(pullRequest);
      } catch (error) {
        return failedAsking(error);
      }
      const expected = repositoryOf(workspace.repository, new URL(pullRequest).hostname);
      const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
      if (!expected || !same(details.repository, expected) || !same(details.headRepository, expected) || details.headBranch !== workspace.branch) {
        return notOwn(
          `${pullRequest} merges from branch ${details.headBranch} of ${details.headRepository}, but run ${run.id} gave its agent branch ${workspace.branch} of ${workspace.repository}`,
        );
      }

      const verdict = decideFor(policies, { action: "merge", workflow: run.workflow });
      if (!verdict) {
        const configured = policies.map((policy) => policy.metadata.name).sort().join(", ") || "none";
        return refused("invalid", "No policy applies", `no policy applies to workflow '${run.workflow}' (configured: ${configured})`);
      }
      const { decision, policy } = verdict;

      let approvalRequest: ApprovalRequest | undefined;
      if (decision === "ask") {
        const time = now().toISOString();
        approvalRequest = await approvals.open(
          {
            id: newId(),
            runId: run.id,
            workflow: run.workflow,
            action: "merge",
            pullRequest,
            policy,
            question: `Merge ${pullRequest} for run ${run.id} of ${run.workflow}?`,
            status: "pending",
            ...(run.traceparent === undefined ? {} : { traceparent: run.traceparent }),
            createdAt: time,
          },
          (request) => approvalRequested(request, time),
        );
        if (approvalRequest.status === "pending") return { pending: { pullRequest, policy, decision, merged: false, approvalRequest } };
        if (approvalRequest.status === "rejected") {
          return refused("rejected", "Merge rejected", `approval request ${approvalRequest.id} to merge ${pullRequest} was rejected`);
        }
      }

      try {
        const { commit } = await integration.merge(pullRequest);
        return { merged: { pullRequest, policy, decision, merged: true, ...(commit ? { commit } : {}), ...(approvalRequest ? { approvalRequest } : {}) } };
      } catch (error) {
        return failedAsking(error);
      }
    },
  };
}

/** `<owner>/<name>` of a clone URL on `host`, e.g. `https://github.com/acme/app.git`; undefined for any other host or shape. */
function repositoryOf(cloneUrl: string, host: string): string | undefined {
  let url: URL;
  try {
    url = new URL(cloneUrl);
  } catch {
    return undefined;
  }
  if (url.hostname !== host) return undefined;
  const path = url.pathname.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "");
  return /^[^/]+\/[^/]+$/.test(path) ? path : undefined;
}
