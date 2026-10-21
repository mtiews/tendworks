/** A point in time in the operator's locale; the exact timestamp stays machine-readable and on hover. */
export function Time({ value }: { value: string }) {
  return (
    <time dateTime={value} title={value}>
      {new Date(value).toLocaleString()}
    </time>
  );
}
