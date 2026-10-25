/*
 * Which page `/` opens (ADR 0027): the overview or the runs, chosen per browser. Kept in
 * localStorage; where storage is unavailable (private mode, blocked) the choice holds for as
 * long as the page lives, and the overview is the default.
 */

export type StartPage = "overview" | "runs";

const KEY = "tendworks.start-page";
let remembered: StartPage | undefined;

export function startPage(): StartPage {
  try {
    const stored = window.localStorage.getItem(KEY);
    if (stored === "overview" || stored === "runs") return stored;
  } catch {
    // Storage is unavailable: fall through to the choice made in this page.
  }
  return remembered ?? "overview";
}

export function chooseStartPage(choice: StartPage): void {
  remembered = choice;
  try {
    window.localStorage.setItem(KEY, choice);
  } catch {
    // Not stored; `remembered` holds it for this page.
  }
}
