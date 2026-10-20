import { Transcript } from "./transcript.js";
import { useTranscript, type OpenTranscriptStream, type TranscriptView } from "./use-transcript.js";
import type { TranscriptEntry } from "./transcript.js";

/**
 * A transcript read and, while `live`, followed live (`useTranscript`), rendered by the
 * transcript renderer, with what the operator needs to know around it: loading, missing,
 * empty, following live, and a live stream that was lost. Run steps and chats use it alike.
 */
export function LiveTranscript({
  read,
  open,
  live,
  missing = "No transcript was found.",
  onEnded,
}: {
  read: () => Promise<TranscriptEntry[]>;
  open: OpenTranscriptStream;
  live: boolean;
  /** What to say when there is no transcript. */
  missing?: string;
  /** Called when the stream says the task ended. */
  onEnded?: () => void;
}) {
  return <TranscriptOf view={useTranscript({ read, open, live, onEnded })} missing={missing} />;
}

/** A transcript as `useTranscript` gives it: loading, missing, empty, the entries, following live, lost. */
export function TranscriptOf({ view, missing = "No transcript was found." }: { view: TranscriptView; missing?: string | undefined }) {
  switch (view.phase) {
    case "loading":
      return <p className="muted">Loading the transcript…</p>;
    case "missing":
      return <p className="muted">{missing}</p>;
    case "failed":
      return <p className="message message-error">{view.error}</p>;
    case "shown":
      return (
        <>
          {view.entries.length === 0 ? <p className="muted">The transcript is empty so far.</p> : <Transcript entries={view.entries} />}
          {view.following && (
            <p className="live" role="status">
              Live
            </p>
          )}
          {view.lost !== undefined && <p className="message message-warn">The live transcript was lost: {view.lost} It shows what arrived until then.</p>}
        </>
      );
  }
}
