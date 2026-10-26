import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/** How close to the end of the scrolled area still counts as at the end, in CSS pixels. */
const NEAR_END = 80;

const page = () => document.documentElement;
const reducedMotion = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The area that scrolls: the element given, else the page. */
function area(element: HTMLElement | null | undefined) {
  const root = element ?? page();
  return {
    events: element ?? window,
    top: () => root.scrollTop,
    distanceToEnd: () => root.scrollHeight - root.clientHeight - root.scrollTop,
    toEnd(smooth: boolean) {
      const options: ScrollToOptions = { top: root.scrollHeight, behavior: smooth && !reducedMotion() ? "smooth" : "auto" };
      if (element) element.scrollTo(options);
      else window.scrollTo(options);
    },
  };
}

/**
 * Keeps an area at its end while `content` grows, as a chat client does, but only while the
 * operator is at or near the end: whoever scrolled up to read stays where they are until they
 * scroll back down. The area is the element behind `scroller` (the workbench's chat on a
 * desktop), else the page (a phone). Once `ready`, the first content goes to the end at once.
 * The returned function goes to the end and follows again, e.g. after the operator sent a
 * message. Scrolling is smooth unless the operator prefers reduced motion.
 */
export function useFollowEnd(content: unknown, ready: boolean, scroller?: RefObject<HTMLElement | null>): () => void {
  const following = useRef(true);
  const opened = useRef(false);

  useEffect(() => {
    const scrolling = area(scroller?.current);
    let last = scrolling.top();
    const scrolled = () => {
      const top = scrolling.top();
      // Scrolling up leaves the end; a smooth scroll on its way down keeps following.
      following.current = scrolling.distanceToEnd() <= NEAR_END || (following.current && top >= last);
      last = top;
    };
    scrolling.events.addEventListener("scroll", scrolled, { passive: true });
    return () => scrolling.events.removeEventListener("scroll", scrolled);
  }, [scroller]);

  useLayoutEffect(() => {
    if (!ready) return;
    if (!opened.current) {
      opened.current = true;
      following.current = true;
      area(scroller?.current).toEnd(false);
    } else if (following.current) {
      area(scroller?.current).toEnd(true);
    }
  }, [content, ready, scroller]);

  return () => {
    following.current = true;
    area(scroller?.current).toEnd(true);
  };
}
