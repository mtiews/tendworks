import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

/** How close to the end of the page still counts as at the end, in CSS pixels. */
const NEAR_END = 80;

const page = () => document.documentElement;
const distanceToEnd = () => page().scrollHeight - page().clientHeight - page().scrollTop;
const reducedMotion = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const scrollToEnd = (smooth: boolean) => window.scrollTo({ top: page().scrollHeight, behavior: smooth && !reducedMotion() ? "smooth" : "auto" });

/**
 * Keeps the page at its end while `content` grows, as a chat client does, but only while the
 * operator is at or near the end: whoever scrolled up to read stays where they are until they
 * scroll back down. Once `ready`, the first content goes to the end at once. The returned
 * function goes to the end and follows again, e.g. after the operator sent a message.
 * Scrolling is smooth unless the operator prefers reduced motion.
 */
export function useFollowEnd(content: unknown, ready: boolean): () => void {
  const following = useRef(true);
  const opened = useRef(false);

  useEffect(() => {
    let last = page().scrollTop;
    const scrolled = () => {
      const top = page().scrollTop;
      // Scrolling up leaves the end; a smooth scroll on its way down keeps following.
      following.current = distanceToEnd() <= NEAR_END || (following.current && top >= last);
      last = top;
    };
    window.addEventListener("scroll", scrolled, { passive: true });
    return () => window.removeEventListener("scroll", scrolled);
  }, []);

  useLayoutEffect(() => {
    if (!ready) return;
    if (!opened.current) {
      opened.current = true;
      following.current = true;
      scrollToEnd(false);
    } else if (following.current) {
      scrollToEnd(true);
    }
  }, [content, ready]);

  return useCallback(() => {
    following.current = true;
    scrollToEnd(true);
  }, []);
}
