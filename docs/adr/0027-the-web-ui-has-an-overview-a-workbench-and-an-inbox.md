# The web UI has an overview, a workbench and an inbox, and a reduced phone layout

The web UI (ADR 0018) is organized around what the operator does, not around the platform's tables. It has two places to be and a few pages around them:

- **Overview**, the platform view: what works right now, what waits for the operator, what needs attention, when trigger bindings check next.
- **Workbench**, the working area: a list of runs or chats next to the selected one's detail. Runs are named by the item that started them and grouped by what they need from the operator.
- **Inbox**: notifications, subscriptions and decided approval requests.
- **Pages** for triggers, agents and workspaces.

The pieces arrive ticket by ticket (spec #101); until a page exists, its navigation entry leads to today's page.

## Shell

- **Desktop:** an icon rail with the brand mark, the sections Overview, Runs, Chats, Inbox, Triggers, Agents, Workspaces and More, and sign-out. Every entry has an accessible name and `aria-current` marks the current section.
- **Phone (below 760 px):** a top bar with the brand mark and the access scope (a back button on a detail view) and bottom tabs: Overview, Runs, Chats, Inbox, More. "More" holds the remaining sections, the start page choice, the access scope and sign-out. The layout is chosen in script from the viewport, so one navigation is in the page at a time.
- **Badges** on the navigation: the pending approval requests (Runs) and the notifications with a failed delivery (Inbox). They are numbers with an accessible description, not colors alone.
- **Access scope** (full or read-only) stays visible in the shell on both layouts.
- **No sideways page scrolling and touch targets of at least 44 px** at every width; tables scroll inside themselves until the views replace them with lists and cards.

## Start page

`/` opens the overview or the runs. The choice is per browser (it is a habit of the device, not of the operator), kept in `localStorage`, defaults to the overview, and where storage is unavailable holds for the life of the page.

## Theme

"Mission control": dark, dense, monospace transcripts. Design tokens (CSS custom properties) hold dark as designed and light derived from the brand's light colors (`docs/brand/README.md`); the scheme follows the system. Views use tokens only. The Content Security Policy of ADR 0018 holds: no inline styles, no `data:` assets; the brand mark is an inline SVG component. The PWA manifest and the first theme color use the dark colors, since a manifest cannot follow the scheme.

## Considered Options

- **Keep the top navigation and wrap it on small screens:** a grid of entries over tables that scroll sideways; the operator works from a phone a lot.
- **Render the rail and the tabs both and hide one with CSS:** duplicate links in the accessibility tree and in tests; choosing the layout in script keeps one navigation.
- **Store the start page on the platform:** needs an endpoint only the UI uses (ADR "UI and CLI are just clients"); the choice is about the device.

## Consequences

- This refines the views of spec #38; ADR 0018 (same-origin SPA, API token, CSP) stays.
- The status page becomes the overview step by step; agents and trigger bindings get their own pages.
- Browser tests run the shell at desktop and phone width.
