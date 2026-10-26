/** A point in time in the operator's locale; the exact timestamp stays machine-readable and on hover. */
export function Time({ value }: { value: string }) {
  return (
    <time dateTime={value} title={value}>
      {new Date(value).toLocaleString()}
    </time>
  );
}

/** How long before `now` (ms, e.g. when the list was read) `value` was, in the largest whole unit; the exact time stays on hover and in `dateTime`. */
export function Age({ value, now }: { value: string; now: number }) {
  const minutes = Math.max(0, Math.floor((now - new Date(value).getTime()) / 60_000));
  const age =
    minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : minutes < 48 * 60 ? `${Math.floor(minutes / 60)} h ago` : `${Math.floor(minutes / (24 * 60))} days ago`;
  return (
    <time dateTime={value} title={new Date(value).toLocaleString()}>
      {age}
    </time>
  );
}

/** How long after `now` `value` comes, e.g. a trigger's next check: `in 3 min`, `in 6 h`, `in 2 days`, `now` when due. */
export function In({ value, now }: { value: string; now: number }) {
  const minutes = Math.ceil((new Date(value).getTime() - now) / 60_000);
  const until = minutes <= 0 ? "now" : minutes < 60 ? `in ${minutes} min` : minutes < 48 * 60 ? `in ${Math.round(minutes / 60)} h` : `in ${Math.round(minutes / (24 * 60))} days`;
  return (
    <time dateTime={value} title={new Date(value).toLocaleString()}>
      {until}
    </time>
  );
}
