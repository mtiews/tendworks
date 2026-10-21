import type { ReactNode } from "react";
import { safeHref } from "./markdown.js";

const URL_PATTERN = /https?:\/\/\S+/g;
/** Punctuation that ends a sentence or closes a parenthesis around a URL rather than belonging to it. */
const TRAILING_PUNCTUATION = /[.,;:!?)]+$/;

/**
 * `text` with each http(s) URL in it as a link that opens in a new tab (e.g. the pull request in
 * an approval request's question); everything else, other URL schemes included, stays text.
 */
export function LinkedText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let rest = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = match[0].replace(TRAILING_PUNCTUATION, "");
    const href = safeHref(url);
    if (!href) continue;
    parts.push(text.slice(rest, match.index));
    parts.push(
      <a key={match.index} href={href} target="_blank" rel="noopener noreferrer">
        {url}
      </a>,
    );
    rest = match.index + url.length;
  }
  parts.push(text.slice(rest));
  return <>{parts}</>;
}
