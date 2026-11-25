# Markasso: Design Reference

The visual language of the app and of the static pages. The source of truth is `src/design/tokens.ts`: names follow Tailwind CSS v4's theme namespaces (issue #184). `pnpm tokens` generates `src/styles/tokens.css` (dark on `:root`, light on `[data-theme="light"]`, loaded first by `base.css`) and the Figma Variables of each theme in `design/tokens.dark.json` and `design/tokens.light.json` (W3C DTCG). Never edit the generated files; update this file when a token changes.

The pre-#184 names (`--accent`, `--bg-island`, ...) still work as aliases of the new tokens until the migration ends; new CSS uses the new names.

## Concept

Dark first, fast and quiet: the canvas is the hero and the chrome fades into it. The palette started from Pablo Picasso's **Le Rêve** (1932): one saturated crimson accent over warm near-blacks. The accent has since moved to a crimson leaning towards magenta, which keeps its contrast in both themes.

## Color tokens

| Token | Old name | Dark | Light | Used for |
|---|---|---|---|---|
| `--color-accent` | `--accent` | `#c42059` | `#af145a` | Active tools, selection, focus rings, primary buttons, links |
| `--color-accent-subtle` | `--accent-light` | `rgb(196 32 89 / 0.2)` | `rgb(175 20 90 / 0.2)` | Active button fill, selected tab |
| `--color-danger` | `--alert` | `#fa0101` | `#cb0303` | Destructive actions |
| `--color-warning` | `--warning` | `#f59e0b` | `#8a6000` | Warnings |
| `--color-surface-island` | `--bg-island` | `rgb(21 21 21 / 0.98)` | `#f5f5f5` | Toolbar islands, panels, menus |
| `--color-border` | `--island-border`, `--border` | `rgb(255 255 255 / 0.18)` | `#767676` | Island outlines, dividers, inputs (light value meets 4.5:1 on white) |
| `--color-surface-control` | | `var(--color-overlay-1)` | `#ffffff` | Resting fill of buttons, chips and inputs on an island |
| `--color-hover` | | `var(--color-overlay-1)` | `color-mix(in oklab, var(--color-accent) 8%, transparent)` | Hover states |
| `--color-hover-legacy` | `--bg-hover` | `rgb(255 255 255 / 0.07)` | `rgb(169 1 27 / 0.08)` | Pre-#184 hover of the CSS not migrated yet; removed with the aliases |
| `--color-text` | `--text` | `#e8d4d4` | `#000000` | Primary text (warm off-white in dark) |
| `--color-text-muted` | `--text-muted` | `rgb(141 141 141)` | `#4d4d4d` | Secondary and hint text |
| `--color-text-strong` | `--false-white` | `#fffadf` | `#000000` | Dialog titles |
| `--color-text-on-accent` | | `#ffffff` | `#ffffff` | Text on a solid accent fill (primary buttons) |
| `--color-scrim` | `--scrim` | `rgb(0 0 0 / 0.5)` | `rgb(0 0 0 / 0.25)` | Behind modal dialogs |
| `--color-ink-default` | `--default-ink` | `#e2e2ef` | `#000000` | Default stroke of new elements |

**Canvas background:** `#080808` (dark) or `#ffffff` (light) by default. **Menu → Canvas background** offers swatches per theme (dark: `#141414`, `#1a1a2e`, `#0d1117`, `#1e1e1e`, `#12100e`, `#0f1923`), applied through `--color-canvas` (set inline on `<html>`, read by the renderer through `getCanvasBg()`).

## Typography

- **App UI:** `system-ui, -apple-system, sans-serif`
- **Static pages** (`/agents`, `/cloud`, `/mac`): headings in **Kode Mono** 500, terminal-style lists and counters in **Roboto Mono** 500, body in the system font
- **Board text:** the fonts chosen per element in the style panel; text metrics for export and the MCP come from `scripts/build-font-metrics.mjs`

## Geometry

| Token | Value | Usage |
|---|---|---|
| `--island-radius` | `12px` | Floating islands |
| `--radius` | `8px` | Buttons, inputs, swatches |
| Island padding | `4px` | Space around island buttons |
| Toolbar button | `36 × 36px` | Tool and island buttons (`44px` minimum on touch) |

## Motion

- Short, purposeful transitions; springs (`cubic-bezier(0.34, 1.56, 0.64, 1)`) for controls that appear, such as the live controls at the top right (`src/ui/morph_row.ts`)
- Every animation has a `prefers-reduced-motion` fallback that shows the final state at once

## Principles

- **Dark first.** The canvas is the hero; UI chrome stays low-contrast until it is needed.
- **One accent.** The crimson accent is the only highlight for focus, selection and active states.
- **Accessible contrast.** Light theme borders and text meet WCAG AA (4.5:1) against their background.
- **Follow established patterns.** Menus, panels and shortcuts behave like Excalidraw and draw.io, with no hidden affordances.
