/** The Tendworks mark (`docs/brand/mark.svg`): a sprout whose stem and two leaves form a T. Inline, so the CSP needs no image source; colored by the brand tokens. */
export function BrandMark({ size = 32 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <path className="brand-stem" d="M44 46 H56 V84 A6 6 0 0 1 44 84 Z" />
      <path className="brand-leaf" d="M50 46 Q46 13 14 20 Q18 53 50 46 Z" />
      <path className="brand-leaf" d="M50 46 Q54 13 86 20 Q82 53 50 46 Z" />
    </svg>
  );
}
