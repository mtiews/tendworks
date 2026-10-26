import { useEffect, useState } from "react";

/** The phone layout starts below 760px (ADR 0027). */
const PHONE = "(max-width: 759.98px)";

const query = () => (typeof window.matchMedia === "function" ? window.matchMedia(PHONE) : undefined);

/** Whether the window is phone-wide; follows resizing. Without `matchMedia` (view tests) the desktop layout shows. */
export function usePhone(): boolean {
  const [phone, setPhone] = useState(() => query()?.matches ?? false);
  useEffect(() => {
    const list = query();
    if (!list) return;
    const update = () => setPhone(list.matches);
    update();
    list.addEventListener?.("change", update);
    return () => list.removeEventListener?.("change", update);
  }, []);
  return phone;
}
