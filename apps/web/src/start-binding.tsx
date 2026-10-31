import type { ControlPlane } from "@tendworks/shared";
import { useState, type ReactNode } from "react";
import { answer, reasonOf } from "./answers.js";
import { useApi } from "./api.js";
import { Confirmation } from "./confirm.js";
import { useLocation } from "./router.js";

type Trigger = ControlPlane.components["schemas"]["triggerList"]["items"][number];
type Started = ControlPlane.components["schemas"]["fireResult"]["items"][number];

export interface StartOptions {
  /**
   * Ask `Start <binding>?` before every start, also for a binding over one workspace or none
   * (e.g. where a mistaken tap is likely). Without it, only a binding over several workspaces asks.
   */
  alwaysConfirm?: boolean;
}

/**
 * Starting a manual binding (`POST /triggers/{name}/fire`, ADR 0028): its Start button, and
 * below it the confirmation or why the start failed. A binding over one workspace or none
 * starts on one tap; one over several first asks which of them, all preselected. With
 * `alwaysConfirm`, every start asks first. All workspaces is one firing without a workspace, a
 * subset one firing per chosen workspace, one after another, stopping at the first that fails.
 * One started run opens it; several open Runs. Other bindings fire on their own and get no
 * button, nor does any binding for read-only access.
 */
export function useStart(trigger: Trigger, { alwaysConfirm = false }: StartOptions = {}): { button?: ReactNode; below?: ReactNode } {
  const { client, canChange } = useApi();
  const { navigate } = useLocation();
  const [chosen, setChosen] = useState<ReadonlySet<string>>();
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string>();
  if (trigger.kind !== "manual" || !canChange) return {};
  const { name, workflow, workspaces } = trigger;
  const picksWorkspaces = workspaces.length > 1;
  const asks = picksWorkspaces || alwaysConfirm;

  const fire = async (only: readonly (string | undefined)[]) => {
    setBusy(true);
    setRefused(undefined);
    const started: Started[] = [];
    try {
      for (const workspace of only) {
        const body = workspace === undefined ? {} : { body: { workspace } };
        started.push(...(await answer(client.POST("/triggers/{name}/fire", { params: { path: { name } }, ...body }))).items);
      }
    } catch (failure: unknown) {
      const before = started.map((run) => (run.workspace === undefined ? run.runId : `${run.runId} in ${run.workspace}`)).join(", ");
      setBusy(false);
      setChosen(undefined);
      setRefused(before ? `${reasonOf(failure)}. Started before it: ${before}.` : reasonOf(failure));
      return;
    }
    const [first] = started;
    navigate(started.length === 1 && first ? `/runs/${encodeURIComponent(first.runId)}` : "/runs");
  };

  const start = () => {
    if (asks) {
      setRefused(undefined);
      setChosen(new Set(workspaces));
    } else void fire([undefined]);
  };

  const confirm = () => {
    const subset = workspaces.filter((workspace) => chosen?.has(workspace));
    void fire(subset.length === workspaces.length ? [undefined] : subset);
  };

  const toggle = (workspace: string, on: boolean) =>
    setChosen((current) => {
      const next = new Set(current);
      if (on) next.add(workspace);
      else next.delete(workspace);
      return next;
    });

  return {
    button: (
      <button type="button" aria-label={`Start ${name}`} aria-expanded={asks ? chosen !== undefined : undefined} disabled={trigger.suspended === true || busy} onClick={start}>
        Start
      </button>
    ),
    below:
      chosen !== undefined ? (
        <Confirmation
          title={`Start ${name}?`}
          confirmLabel={picksWorkspaces ? "Start runs" : "Start run"}
          busy={busy}
          canConfirm={!picksWorkspaces || chosen.size > 0}
          onConfirm={confirm}
          onCancel={() => setChosen(undefined)}
        >
          {picksWorkspaces ? (
            <fieldset className="binding-workspaces">
              <legend>Starts one run of {workflow} in each chosen workspace.</legend>
              {workspaces.map((workspace) => (
                <label key={workspace} className="checkbox">
                  <input type="checkbox" checked={chosen.has(workspace)} disabled={busy} onChange={(event) => toggle(workspace, event.target.checked)} />
                  {workspace}
                </label>
              ))}
            </fieldset>
          ) : (
            <p>{workspaces[0] === undefined ? `Starts one run of ${workflow}.` : `Starts one run of ${workflow} in ${workspaces[0]}.`}</p>
          )}
        </Confirmation>
      ) : refused ? (
        <p className="message message-error">{refused}</p>
      ) : undefined,
  };
}

/** A manual binding's Start button with its confirmation or refusal right below it, for a compact row or card. */
export function StartBinding({ trigger, ...options }: { trigger: Trigger } & StartOptions) {
  const start = useStart(trigger, options);
  return (
    <>
      {start.button}
      {start.below}
    </>
  );
}
