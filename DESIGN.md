# Teleprompter DESIGN.md

Visual system for the on-screen coding teleprompter (overlay panel, subtitle
band, start hub, web admin). Dark pastel calm on deep slate. Color is
functional only; decoration is refused (see craft notes at the bottom).

## Tokens

| token | value | use | contrast on bg |
|---|---|---|---|
| `--panel` / `--panel2` | rgba(11,15,27,.93) / rgba(16,22,36,.94) | shells | — |
| `--text` | `#e9ebf3` | primary ink | 16.1 ✓ |
| `--text-dim` | `#bcc8de` | goal, secondary | 11.7 ✓ |
| `--muted` | `#9aa3b8` | labels, meta | 7.6 ✓ |
| `--faint` | `#7e8ca6` | microcopy, placeholders | 5.6 ✓ |
| `--accent` (lilac, the ONE brand) | `#a9c6f5` | interactive, current, focus | 6.8 ✓ |
| `--accent-soft` | `#c3b3ee` | large-area accents | 9.7 ✓ |
| `--ink-on-accent` | `#0b0b0f` | ink on lilac fills | 7.2 ✓ |
| `--green` (mint, success) | `#a9dcc0` | done, success | 12.1 ✓ |
| `--amber` (peach, pending) | `#f0d3a0` | waiting, pending | 12.8 ✓ |
| `--red` (rose, error) | `#f0b3c0` | errors | 10.5 ✓ |
| primary button | `#b9d2f6` fill + `#1a2740` ink | the one CTA | 9.7 ✓ |

Code lines: dim `#8b96ad` (6.2), current `#ffffff`, numbers `#7588ab` (5.5).

## Type

- UI: system stack (`SF Pro Text`, `Segoe UI`, system-ui, `Vazirmatn` for Persian).
- Code: `JetBrains Mono` → ui-monospace → Menlo → Consolas (graceful fallback).
- Tabular numerals everywhere numbers move (stats, meta, pills, ranges).
- Persian: `letter-spacing: normal` guard (connected script must not spread).

## Shape & motion

- Radii 8/12/18/pill. Elevation = offset neutral shadows + 1px hairline +
  top inner highlight. No colored outer glow. No gradient text. No pulse
  decoration (the server pill is flat; it means live data by color+label).
- Motion budget: caret blink (typing cue) + toast entrance only.
  `prefers-reduced-motion` kills all of it.

## Surfaces

- **Panel** (`#app`): full glass window, header + badges, goal strip, guide rows
  (divider-separated, never nested boxes), code list (state in the line NUMBER:
  peach = current, mint ✓ = file-done, powder = practice-done), practice box,
  stats with hairline dividers.
- **Subtitle band** (`#sub`, top by default, draggable, resizable 320×120…area):
  title → why → current code (wraps to 3 lines, never `…`) → next (dim preview)
  → `file:line` → result → `n/N · pct% · wpm`.
- **Hub** (`#empty`): hero (solid title, single glow), connections, quickstart
  steps (sequence carries meaning, numbers stay), settings, sample drill.
- **Admin** (`/admin`, separate `admin.css`): same tokens, tables over cards.

## Themes

- **Dark** (default surfaces above): the working theme, dark-first for long
  editor sessions.
- **Light pastel** (`html[data-theme="light"]`, panel + hub only): cream
  `#f5f3fa` canvas, white cards, ink `#2e2a38` (13+), muted `#6f6880` (4.8),
  brand lilac fills `#a78bfa` + ink (6.2), brand text `#6d4fc2` (5.9),
  success `#177a5b` (5.3), error `#b3374f` (5.9), pending `#8a5f16` (5.6).
  The subtitle band and toasts stay dark ALWAYS (they float over code).
  Toggle: `روشن/تیره` seg in hub settings (`tpTheme`), applied by a tiny
  inline script before `app.js` (no flash, no dependency).

## Craft notes (from impeccable passes)

- Fixed with evidence: gradient title → solid; primary 2.77 → 5.9+;
  micro-labels to the 11px floor; decorative glows removed; guide unboxed.
- Kept deliberately: 11px HUD microcopy (dense overlay, VS Code parity),
  server-pill pulse-free flat dot (live data, color+label carry it),
  wide diffuse shadows (a transparent overlay needs separation from wallpaper),
  focus rings (accessibility, not decoration).
- Deferred (needs `app.js`, blocked mid-tour): progress-bar `scaleX`
  (compositor-friendly), microcopy 11→12px with render check.
- Unverified: rendered pixels in EN+FA (hub/panel/band) — blocked while a
  drill is being typed into `app.js`; run the screenshot round right after.
