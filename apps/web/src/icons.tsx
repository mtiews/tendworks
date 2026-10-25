/** Stroke icons of the navigation: decorative, the link or button carries the name. */

const PATHS = {
  overview: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  runs: "M5 4v16l14-8z",
  chats: "M4 5h16v11H9l-5 4z",
  inbox: "M4 13l2-8h12l2 8v6H4zM4 13h5l1 2h4l1-2h5",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  signOut: "M10 4H5v16h5M15 8l4 4-4 4M19 12H9",
  back: "M15 5l-7 7 7 7",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="icon" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} />
    </svg>
  );
}
