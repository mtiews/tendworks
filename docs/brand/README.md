# Brand

The Tendworks mark is a sprout whose stem and two leaves form a T: tend means caring for something that grows.

## Colors

| Use | Light | Dark |
| --- | --- | --- |
| Stem, background of app icons | `#2f6f4f` | `#5fb38a` |
| Leaves | `#5fb38a` | `#a8dcbf` |
| Leaves on the green background | `#a8dcbf` | |

The web UI's design tokens (`apps/web/src/styles.css`) are built on them: the UI uses the dark column only (mission control, on a blue-grey background `#0b0e12`). The mark is an inline SVG component (`apps/web/src/brand-mark.tsx`) colored by the tokens `--color-brand-stem` and `--color-brand-leaf`.

## Files

| File | Use |
| --- | --- |
| `mark.svg`, `mark-dark.svg` | the mark alone, on light or dark backgrounds |
| `mark-mono.svg` | single color in `currentColor`, colored by CSS |
| `logo-horizontal.svg`, `logo-horizontal-dark.svg` | mark with the wordmark on a transparent background, for light or dark pages (the repository README) |
| `favicon.svg` | browser tab, 32 px and up |
| `favicon-16.svg` | browser tab at 16 px, with less padding |
| `app-icon.svg` | app icon with rounded corners (PWA 192/512) |
| `app-icon-maskable.svg` | full bleed, mark inside the 80 % safe zone: iOS `apple-touch-icon` (180) and PWA `maskable` |
| `notification-icon-192.svg` | icon of a notification, e.g. the Pushover application icon |
| `notification-badge-96.svg` | Android status bar badge: white on transparent only |
| `social-1200x630.svg` | Open Graph image for shared links |

## Wordmark

The wordmark is set in [Nunito](https://fonts.google.com/specimen/Nunito) (SIL Open Font License): "tend" in bold (700), "works" in medium (500), letter spacing −2 %. The tagline uses regular (400). All text in these files is converted to paths, so they render the same everywhere without the font installed.

## Web UI

`apps/web/public/` holds `favicon.svg` and PNGs rendered from these SVGs: `apple-touch-icon.png` (180 px, from `app-icon-maskable.svg`), `icon-192.png` and `icon-512.png` (from `app-icon.svg`), `icon-maskable-512.png` (from `app-icon-maskable.svg`). Render them again when the mark changes. The PWA manifest (`manifest.webmanifest`) uses the UI's background `#0b0e12` for `background_color` and `theme_color`, as does `theme-color` in `index.html`.
