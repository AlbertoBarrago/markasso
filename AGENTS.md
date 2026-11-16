# Working on Markasso

Guide for contributors and coding agents. Markasso is a browser-based whiteboard with a zero-dependency core (TypeScript, Canvas 2D), a Cloudflare Worker backend and an MCP server for AI agents. What the app does: [docs/MANUAL.md](docs/MANUAL.md). How it is built: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Setup

```bash
pnpm install
pnpm dev          # Vite dev server at http://localhost:5173
```

Local development needs no `.env` file or API key. Cloud boards and licensing stay off unless `VITE_CLOUD_ENABLED=true` (set in `.env.production` for release builds).

## Commands

```bash
pnpm dev          # Dev server (web app and static pages)
pnpm build        # Type-check, then production build into dist/
pnpm preview      # Build, then serve app and worker with wrangler dev
pnpm typecheck    # App, worker and MCP TypeScript projects
pnpm lint         # Biome check with fixes (pnpm lint:ci: check only, as in CI)
pnpm test         # Vitest, once (pnpm test:watch: watch mode)
pnpm coverage     # Tests with coverage, then refresh the README badge
pnpm mcp:build    # Build the MCP server into mcp/dist/
```

The pre-commit hook (`.husky/pre-commit`) runs `pnpm lint`, stages the fixes of tracked files (`git add -u`), then runs `pnpm typecheck`, `pnpm test` and `pnpm coverage`.

## Repository layout

| Path | What lives there |
|------|------------------|
| `index.html`, `src/main.ts` | The web app entry |
| `agents/`, `cloud/`, `mac/` | Static pages served at `/agents/`, `/cloud/`, `/mac/` (entries `src/*_page.ts`, shared motion in `src/site_fx.ts`) |
| `src/` | App code (module map below), plus the worker in `src/worker.ts` and `src/worker/` |
| `mcp/` | The `@markasso/mcp` package: MCP server for AI agents, released on its own (`mcp/README.md`, `mcp/CHANGELOG.md`) |
| `public/` | Static files served as is: icons, `robots.txt`, `sitemap.xml`, `llms.txt`, page media |
| `tests/` | Vitest suites (Node environment) |
| `scripts/` | Generators (font metrics, icon sets, fixtures for the Mac app) and the coverage badge |
| `migrations/` | D1 schema for cloud boards |
| `docs/` | User manual (EN, IT), architecture, design reference, contributing guide, README media |

## Architecture

Redux-style unidirectional data flow:

```
User event → Tool → Command → History.dispatch → reducer(Scene, Command) → Scene → render
```

### Key invariants

- All coordinates are in CSS pixels; the canvas buffer is scaled by `devicePixelRatio`
- `Scene` objects are immutable: a new reference on change, the same reference if unchanged
- Ephemeral operations (pan, zoom, select, tool changes) stay out of the undo stack
- TypeScript strict mode with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`
- Exhaustive `switch` on discriminated unions: every case must be handled

### Module layers (`src/`)

| Module | Responsibility |
|--------|----------------|
| `core/` | `Scene`, `AppState` (active tool, colors, grid), `Viewport` (pan/zoom math), layered auto layout, canvas-free text metrics (`text_metrics.ts`, tables from `scripts/build-font-metrics.mjs`) shared by renderer, export and MCP |
| `elements/` | Discriminated union of all drawable element types (rectangle, ellipse, rhombus, flowchart `shape`, `stencil` icon, line, arrow, curve, polygon, freehand, text, image); flowchart outlines (`shapes.ts`) and icon sets/registry (`stencils/`) |
| `commands/` | Discriminated union of all state-mutating commands |
| `engine/` | Pure `reducer(scene, command) → scene` and `History` (undo/redo, pub/sub, remote commands) |
| `io/` | `.markasso` format, auto-save, share links, realtime client and live outbox, presence, cloud boards, command and element validation (shared with the worker), Mermaid import, vendor icon pack import (ZIP reader, IndexedDB store) |
| `libraries/` | Bundled icon packs loaded as lazy chunks (generated, e.g. `kubernetes/` via `scripts/build-k8s-icons.mjs`) |
| `rendering/` | Canvas 2D renderer, per-element draw dispatch, grid, selection handles, connector geometry (ports, elbow routing, arrowheads), connector labels, PNG/SVG export (kept in parity with the canvas, see `tests/export_parity.test.ts`) |
| `tools/` | Select, hand, eraser, rectangle, rhombus, ellipse, flowchart shape, line (arrowheads are a line style), pen, text, sticky note |
| `ui/` | DOM init, canvas event hub, toolbar, menu, context panel, library sidebar, command palette, dialogs, live controls, keyboard shortcuts |
| `i18n/` | UI strings in 8 locales (`locales/*.json`, every locale has exactly the English keys) |
| `config/` | Build flags (`features.ts`) and Polar checkout links |
| `worker.ts`, `worker/` | Cloudflare Worker: share links, live rooms (`SessionRoom` Durable Object), cloud boards, licence checks, issue reports, Mac downloads |

### Data flow detail

1. `canvas_view.ts` captures pointer events, converts them to world coordinates and hands them to the active tool
2. Tool handlers call `history.dispatch(command)`
3. `History` applies the command through `reducer`, manages the undo stack and notifies subscribers
4. The renderer redraws on the next `requestAnimationFrame`

## Tests

Tests live in `tests/` and run in Node. They cover pure logic (reducer, undo/redo, viewport math, hit detection, geometry, export parity, i18n dictionaries, MCP tools, worker helpers). UI and rendering modules that need a real browser are excluded from coverage by design (`vitest.config.ts`).

When adding an element type, a command or a tool behaviour, add tests for it. Never edit a test only to make it pass.

## Guidelines

- Keep the core (`core/`, `elements/`, `commands/`, `engine/`, `rendering/`, `tools/`) free of runtime npm packages
- A runtime dependency is acceptable only for an isolated feature that would otherwise mean re-implementing a mature project (e.g. Mermaid import via `@excalidraw/mermaid-to-excalidraw`). Load it with a dynamic `import()` so it never lands in the entry chunk, and state why it is needed
- New element types go in `elements/`, new commands in `commands/`: update the discriminated unions and the reducer's `switch`
- Do not touch the undo stack for ephemeral operations
- Coordinate math must hold for any `devicePixelRatio`
- New UI strings go in all 8 locale files; static pages carry their English copy in the HTML (`data-i18n` keys, checked by `tests/static_pages_i18n.test.ts`)
- No em or en dashes in user-facing text and docs: use a comma, colon, parentheses or a period

## Branches, releases and deploys

- One task, one branch from `main` (`feat/`, `fix/`, `docs/`, `test/`, `chore/`), merged through a PR with a merge commit; GitHub deletes the branch on merge
- A push to `main` deploys production (Cloudflare Workers Builds)
- An app release bumps `package.json` and `CHANGELOG.md` on a `release/vX.Y.Z` branch; after its PR is merged, the `vX.Y.Z` tag runs `.github/workflows/release.yml` (lint, tests, build, GitHub release from the changelog section, deploy)
- An MCP release bumps `mcp/package.json`, both versions in `mcp/server.json` and `mcp/CHANGELOG.md`; the `mcp-vX.Y.Z` tag publishes to npm and the MCP Registry (`.github/workflows/mcp-release.yml`)
