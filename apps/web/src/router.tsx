import { createContext, useCallback, useContext, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";

/*
 * Client-side routing under /ui/ on the History API: every view has a real URL that can be
 * bookmarked, opened in a new tab and deep-linked, since the server answers any path under
 * /ui/ with the entry page. Small on purpose; the app has a handful of flat routes.
 */

export const BASE = "/ui";

interface Location {
  /** The path below /ui, e.g. `/runs/r-1`; `/` for the status page. */
  path: string;
  navigate: (to: string, options?: { replace?: boolean }) => void;
}

const RouterContext = createContext<Location | undefined>(undefined);

function current(): string {
  const { pathname } = window.location;
  const below = pathname.startsWith(BASE) ? pathname.slice(BASE.length) : pathname;
  return below === "" ? "/" : below;
}

export function Router({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(current);
  useEffect(() => {
    const update = () => setPath(current());
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  const navigate = useCallback((to: string, { replace = false }: { replace?: boolean } = {}) => {
    const url = `${BASE}${to}`;
    if (replace) window.history.replaceState(null, "", url);
    else window.history.pushState(null, "", url);
    setPath(current());
  }, []);
  const location = useMemo(() => ({ path, navigate }), [path, navigate]);
  return <RouterContext.Provider value={location}>{children}</RouterContext.Provider>;
}

export function useLocation(): Location {
  const location = useContext(RouterContext);
  if (!location) throw new Error("useLocation needs a <Router>");
  return location;
}

/**
 * Matches `path` against a pattern like `/runs/:runId`; answers the decoded parameters, or
 * `undefined` when it does not match.
 */
export function match(pattern: string, path: string): Record<string, string> | undefined {
  const expected = pattern.split("/");
  const actual = path.split("/");
  if (expected.length !== actual.length) return undefined;
  const parameters: Record<string, string> = {};
  for (const [index, part] of expected.entries()) {
    const given = actual[index] ?? "";
    if (part.startsWith(":")) {
      if (given === "") return undefined;
      parameters[part.slice(1)] = decodeURIComponent(given);
    } else if (part !== given) return undefined;
  }
  return parameters;
}

/** A link to a view: a real `<a href>` (new tab, copy link), navigating in place on a plain click. */
export function Link({ to, children, className, current: isCurrent }: { to: string; children: ReactNode; className?: string; current?: boolean }) {
  const { navigate } = useLocation();
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(to);
  };
  return (
    <a href={`${BASE}${to}`} onClick={onClick} className={className} aria-current={isCurrent ? "page" : undefined}>
      {children}
    </a>
  );
}
