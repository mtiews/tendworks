import { useId, type ReactNode } from "react";

/**
 * A framed section with a title bar, the mission control panel (ADR 0027): its rows, tables
 * and tiles run edge to edge inside the frame. `aside` sits at the right of the title bar,
 * e.g. "streaming" or a count. The region is named by its title.
 */
export function Panel({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section className="panel" aria-labelledby={id}>
      <header className="panel-head">
        <h2 id={id}>{title}</h2>
        {aside !== undefined && <div className="panel-aside">{aside}</div>}
      </header>
      <div className="panel-body">{children}</div>
    </section>
  );
}

/** The panel's "live" mark: a pulsing dot with the word, for content that follows the platform as it changes. */
export function LiveMark({ children = "live" }: { children?: ReactNode }) {
  return <span className="live-mark">{children}</span>;
}
