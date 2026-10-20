/** A table as the operator reads it: one array of cell texts per row, the header row first. */
export function rows(table: HTMLElement): string[][] {
  return [...table.querySelectorAll("tr")].map((row) => [...row.querySelectorAll("th, td")].map(text));
}

/** What a cell says, with times as their exact timestamp (the operator sees them in their locale). */
function text(cell: Element): string {
  const copy = cell.cloneNode(true) as Element;
  for (const time of copy.querySelectorAll("time")) time.replaceWith(time.getAttribute("datetime") ?? "");
  return copy.textContent ?? "";
}
