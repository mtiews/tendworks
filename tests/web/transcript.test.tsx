import { createInMemoryAgentRuntime, createInMemoryRuns, type Run, type TranscriptEntry } from "@tendworks/control-plane";
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp, signedIn } from "./support/platform.js";

/*
 * The transcript renderer that run steps and chats share, seen through a run step's
 * transcript in the run detail.
 */

const time = "2026-10-19T10:00:00.000Z";

/** Opens the run detail of a run whose one agent step has the transcript `entries`, and answers that step's region. */
async function showTranscript(entries: Record<string, unknown>[], step: Partial<Run["steps"][number]> = {}) {
  const runs = createInMemoryRuns();
  runs.runs.set("run-1", {
    id: "run-1",
    workflow: "develop-issue",
    status: "running",
    input: {},
    steps: [{ name: "implement", reference: "/do/0/implement", status: "running", taskId: "task-1", transcript: "file:///t/task-1.jsonl", startedAt: time, ...step }],
    createdAt: time,
  });
  const agentRuntime = createInMemoryAgentRuntime();
  agentRuntime.transcripts.set(
    "task-1",
    entries.map((entry, position) => ({ time, position, ...entry }) as TranscriptEntry),
  );
  signedIn();
  const { user } = renderApp({ path: "/ui/runs/run-1", runs, agentRuntime });
  const region = await screen.findByRole("region", { name: "/do/0/implement" });
  const transcript = await within(region).findByRole("list", { name: "Transcript" });
  return { user, region, transcript };
}

describe("transcript", () => {
  it("joins consecutive message chunks into one message rendered as Markdown", async () => {
    const { transcript } = await showTranscript([
      { type: "message-chunk", text: "Here is **bo" },
      { type: "message-chunk", text: "ld** text:\n\n- one\n- two\n\n`code`" },
    ]);

    expect(within(transcript).getByText("bold").tagName).toBe("STRONG");
    expect(within(transcript).getAllByRole("listitem").map((item) => item.textContent)).toContain("one");
    expect(within(transcript).getByText("code").tagName).toBe("CODE");
  });

  it("renders hostile agent output inert: no raw HTML, no scripts, no script links, no images from other origins", async () => {
    const hostile = [
      "<script>window.hacked = true</script>",
      '<img src="https://evil.test/x.png" onerror="window.hacked = true">',
      '<a href="https://evil.test" onclick="window.hacked = true">click me</a>',
      '<div style="position:fixed">styled</div>',
      "[run this](javascript:window.hacked=true)",
      "[data](data:text/html;base64,PHNjcmlwdD4=)",
      "![tracker](https://evil.test/pixel.png)",
      "[fine](https://example.test/docs)",
    ].join("\n\n");
    const { region, transcript } = await showTranscript([{ type: "message-chunk", text: hostile }], {
      artifacts: [{ name: "evil", url: "javascript:window.hacked=true" }],
    });

    expect(region.querySelectorAll("script, img, iframe, object, embed, style, form").length).toBe(0);
    expect(region.querySelectorAll("[onerror], [onclick], [style]").length).toBe(0);
    for (const link of region.querySelectorAll("a")) expect(link.getAttribute("href")).toMatch(/^https:\/\/example\.test\//);
    expect((window as { hacked?: boolean }).hacked).toBeUndefined();
    // The raw HTML shows as text, the image as its description.
    expect(transcript.textContent).toContain("<script>window.hacked = true</script>");
    expect(transcript.textContent).toContain("[image: tracker]");
    expect(within(transcript).getByText("run this").tagName).not.toBe("A");
    const fine = within(transcript).getByRole("link", { name: "fine" });
    expect([fine.getAttribute("target"), fine.getAttribute("rel")]).toEqual(["_blank", "noopener noreferrer"]);
    expect(within(region).getByText("evil").tagName).not.toBe("A");
  });

  it("shows tool calls as collapsed rows with status that expand to their output on demand", async () => {
    const { user, transcript } = await showTranscript([
      { type: "tool-call", toolCallId: "call-1", title: "Run the tests", kind: "execute" },
      { type: "tool-result", toolCallId: "call-1", status: "failed", output: "<b>1 failing</b>" },
      { type: "tool-call", toolCallId: "call-2", title: "Write before.txt", kind: "edit" },
    ]);

    const tests = within(transcript).getByRole("button", { name: /Run the tests/ });
    expect(tests.getAttribute("aria-expanded")).toBe("false");
    expect(tests.textContent).toContain("failed");
    expect(within(transcript).queryByText("<b>1 failing</b>")).toBeNull();

    await user.click(tests);
    expect(tests.getAttribute("aria-expanded")).toBe("true");
    expect(within(transcript).getByText("<b>1 failing</b>")).toBeTruthy();

    await user.click(tests);
    expect(within(transcript).queryByText("<b>1 failing</b>")).toBeNull();

    // A call without its result yet is still running.
    expect(within(transcript).getByRole("button", { name: /Write before.txt/ }).textContent).toContain("running");
  });

  it("hides thoughts and harness output by default and shows them on request", async () => {
    const { user, region, transcript } = await showTranscript([
      { type: "thought-chunk", text: "Let me think " },
      { type: "thought-chunk", text: "about it." },
      { type: "harness-output", text: "warning: low disk" },
      { type: "message-chunk", text: "Done." },
    ]);

    expect(within(transcript).getByText("Done.")).toBeTruthy();
    expect(within(transcript).queryByText("Let me think about it.")).toBeNull();
    expect(within(transcript).queryByText("warning: low disk")).toBeNull();

    await user.click(within(region).getByRole("checkbox", { name: "Show thoughts" }));
    expect(within(transcript).getByText("Let me think about it.")).toBeTruthy();
    expect(within(transcript).queryByText("warning: low disk")).toBeNull();

    await user.click(within(region).getByRole("checkbox", { name: "Show harness output" }));
    expect(within(transcript).getByText("warning: low disk")).toBeTruthy();

    await user.click(within(region).getByRole("checkbox", { name: "Show thoughts" }));
    expect(within(transcript).queryByText("Let me think about it.")).toBeNull();
  });

  it("shows the task, turn ends with their cost, resumes as markers and how the task ended", async () => {
    const { transcript } = await showTranscript([
      { type: "task-started", agent: "developer", message: { messageId: "m-1", role: "ROLE_USER", parts: [{ text: "Fix issue #7" }] } },
      { type: "session-started", sessionId: "s-1", harness: { name: "claude-code", version: "2.1.0" } },
      { type: "usage", cost: { amount: 0.1, currency: "USD" } },
      { type: "usage", cost: { amount: 0.12, currency: "USD" } },
      { type: "turn-ended", reason: "completed" },
      { type: "task-resumed", agent: "developer", message: { messageId: "m-1", role: "ROLE_USER", parts: [{ text: "Fix issue #7" }] } },
      { type: "session-resumed", sessionId: "s-1" },
      { type: "session-resume-failed", sessionId: "s-1", reason: "the session expired" },
      { type: "message-received", message: { messageId: "m-2", role: "ROLE_USER", parts: [{ text: "Also add a test" }] } },
      { type: "permission", tool: "Bash", granted: true },
      { type: "plan", steps: [{ content: "Write the test", status: "completed" }, { content: "Fix it", status: "in-progress" }] },
      { type: "workspace-checkout", workspace: { repository: "https://example.test/acme/playground.git", branch: "agent/7" }, exitCode: 0, output: "Cloning…" },
      { type: "artifacts", artifacts: [{ name: "pull-request", url: "https://example.test/acme/playground/pull/8" }] },
      { type: "artifacts-ignored", problem: "not a list" },
      { type: "input-required", message: "Done.", cost: { amount: 0.2, currency: "USD" } },
      { type: "task-ended", state: "TASK_STATE_FAILED", message: "the harness ended unexpectedly", cost: { amount: 0.3, currency: "USD" } },
    ]);

    const text = [...transcript.children].map((item) => item.textContent?.replace(/\s+/g, " ").trim());
    expect(text).toEqual([
      "Task for developer: Fix issue #7",
      "Session started (claude-code 2.1.0)",
      "Turn completed · 0.12 USD",
      "Resumed the task after an interruption",
      "Resumed the session in a new sandbox; processes the agent started before are gone",
      "Could not resume the session (the session expired); started a new one on the kept workspace",
      "Also add a test",
      "Permission granted: Bash",
      "Plan: [completed] Write the test [in-progress] Fix it",
      "Checked out https://example.test/acme/playground.git agent/7 (exit code 0)",
      "Result: pull-request",
      "Results ignored: not a list",
      "Waiting for the next message · 0.2 USD so far",
      "Task failed: the harness ended unexpectedly · 0.3 USD",
    ]);
    expect(within(transcript).getByRole("link", { name: "pull-request" }).getAttribute("href")).toBe("https://example.test/acme/playground/pull/8");
  });
});
