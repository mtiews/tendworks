import DOMPurify from "dompurify";
import { Marked, type Tokens } from "marked";
import { useMemo } from "react";

/*
 * Agent output is untrusted (spec #38, user story 50): it is rendered as Markdown without
 * any raw HTML, and the result is sanitized again. Two layers on purpose:
 *  1. The Markdown renderer escapes raw HTML instead of passing it through, renders images
 *     as their text (no request to another origin, no tracking pixel) and only links to
 *     http(s) and mailto URLs.
 *  2. DOMPurify keeps only the elements and attributes plain Markdown produces; anything
 *     else (scripts, event handlers, style attributes, other URL schemes) is dropped.
 * The page's Content Security Policy is the third layer.
 */

const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

/** `url` if it is an http(s) or mailto link, else `undefined`: a link an agent wrote never runs script. */
export function safeHref(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol) ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

const marked = new Marked({
  gfm: true,
  async: false,
  renderer: {
    html: ({ text }: Tokens.HTML | Tokens.Tag) => escape(text),
    image: ({ text }: Tokens.Image) => `<span class="image-placeholder">[image: ${escape(text)}]</span>`,
    link(this: { parser: { parseInline: (tokens: Tokens.Link["tokens"]) => string } }, { href, title, tokens }: Tokens.Link) {
      const label = this.parser.parseInline(tokens);
      const safe = safeHref(href);
      if (!safe) return label;
      return `<a href="${escape(safe)}"${title ? ` title="${escape(title)}"` : ""}>${label}</a>`;
    },
  },
});

const ALLOWED_TAGS = [
  "a", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "input", "li", "ol", "p", "pre",
  "span", "strong", "table", "tbody", "td", "th", "thead", "tr", "ul",
];

const purify = DOMPurify(window);
purify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    // Links leave the UI in a new tab that cannot reach back into it.
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
  if (node.tagName === "INPUT" && node.getAttribute("type") !== "checkbox") node.remove();
});

/** Sanitized HTML for the Markdown `text`. */
export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false });
  return purify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ["href", "title", "class", "type", "checked", "disabled", "start", "align"],
    ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i,
    ALLOW_DATA_ATTR: false,
  });
}

/** Agent output as Markdown, without raw HTML, sanitized. */
export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
