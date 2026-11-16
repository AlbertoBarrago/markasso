# Architecture

How Markasso is built, for contributors. For what the app does, see the [User Manual](./MANUAL.md); for the repository and module map and the coding guidelines, see [AGENTS.md](../AGENTS.md).

## Data Flow

Markasso follows a **Redux-style unidirectional data flow**: no mutable state, no event spaghetti, no surprises.

```
User event
    │
    ▼
Tool (onMouseDown / onMouseMove / onMouseUp)
    │  dispatches Command
    ▼
History.dispatch(command)
    │  calls
    ▼
reducer(Scene, Command) → Scene   ← pure function, no side effects
    │  notifies
    ▼
Subscribers (toolbar, properties panel, canvas view)
    │
    ▼
render(ctx, scene, canvas)        ← called every requestAnimationFrame
```

## Key Invariants

- **All coordinates in CSS pixels.** The canvas buffer is `clientWidth × devicePixelRatio` for sharpness, but all viewport `offsetX/Y`, element positions, and mouse events live in CSS pixel space.
- **Immutable scene.** Every `Scene` object is never mutated. The reducer returns a new reference or the same reference if nothing changed (enabling cheap equality checks).
- **Ephemeral commands** (pan, zoom, set-viewport, select, tool change) are excluded from the undo stack.
- **`APPLY_STYLE`** is the single undoable command that updates both `appState` defaults and all currently selected elements in one atomic operation.

## Realtime Layer

On top of the local store, Markasso adds live collaboration via a Cloudflare Worker **Durable Object** (`SessionRoom` in `src/worker.ts`).

```
Client A ──┐
Client B ──┼── WebSocket /session/ws?room=<id> ──▶ SessionRoom DO
Client C ──┘                                           │ serializes commands
                                                       │ appends to room log (DO storage)
                                                       ▼
                                  broadcasts apply to all peers in server order
```

- The DO is the **single serialization point**: it appends each persistent command to the room's log and relays it to peers in arrival order, so replaying the deterministic `reducer` in the same order converges every client.
- **Ephemeral** view commands (pan/zoom/select/tool) and **cursors** are relayed live but never logged.
- **Seeding** publishes the creator's elements as `CREATE` commands into a fresh room (echo-suppressed by the server).
- Undo/redo are shared (model B); `History.applyRemote` applies network commands without touching the local undo stack or echoing them back.
- `realtime.ts` wires `History.onCommand` → WebSocket; `presence.ts` + `canvas_view.ts` render remote cursors. Limits: 20 peers/room, per-peer command rate limit, max message size.

## Backend (Cloudflare Worker)

One Worker (`src/worker.ts`, helpers in `src/worker/`) serves the static assets and a few routes. With `run_worker_first`, only `/api/*`, `/session/*` and `/download/*` reach it; everything else is a static file or the single-page fallback.

| Route | What it does | Storage |
|---|---|---|
| `POST /api/share`, `GET /api/share/:id` | Share links: a snapshot of the elements, valid 90 days | KV `SHARE_LINKS` |
| `/session/ws` | Live rooms (WebSocket to the `SessionRoom` Durable Object, above) | Durable Object storage |
| `/api/board`, `/api/board/:id` | Cloud boards: create, read, write (version check, conflict on mismatch), delete | D1 `BOARDS_DB` (index), R2 `BOARDS_BUCKET` (scenes) |
| `POST /api/licence/check` | Markasso Cloud licence check against Polar, cached 6 hours | KV `SHARE_LINKS` |
| `POST /api/report` | Report a problem: opens a GitHub issue | GitHub API |
| `/download/mac`, `/download/mac.json` | Latest Mac app build, read from the Sparkle appcast | none |

Rate limiters guard share links, live sessions, boards and reports. A daily cron (`0 12 * * *`) reclaims live rooms idle for 7 days and cloud boards not written for a year. `CLOUD_ENABLED`, `CLOUD_REQUIRES_LICENSE` and `LIVE_AGENT_REQUIRES_LICENSE` gate the paid features.

Commands from the network are validated with the same code the app uses (`src/io/command_validation.ts`, `element_validation.ts`), so a room never stores a command the reducer would reject.

## MCP Server

`mcp/` is a separate package (`@markasso/mcp`, stdio). It imports the app's own `reducer`, element types, layout and text metrics, so a diagram built by an agent is exactly what the app would produce, and undo works on it. Document mode keeps the diagram in memory and saves, exports or shares it; live mode joins a room over the same WebSocket protocol as the browser, appearing as a participant. PNG export renders in Node without a browser.

## Static Pages

`agents/`, `cloud/` and `mac/` are extra Vite entries (`vite.config.ts`), each a static HTML page with its English copy in the markup, translated at load from `data-i18n` keys (`src/*_page.ts`). `public/` holds files served as is, including `robots.txt`, `sitemap.xml` and `llms.txt`.

## Technology Stack

| Concern | Choice | Rationale |
|---|---|---|
| Language | TypeScript 5 | Exhaustive `switch` on discriminated unions catches unhandled commands at compile time |
| Build | Vite (with the Cloudflare plugin) | Instant HMR; one build for the app, the static pages and the worker |
| Rendering | Canvas 2D API | Direct pixel control without virtual DOM overhead |
| Testing | Vitest | Runs in Node, no browser needed for reducer/viewport math |
| Backend | Cloudflare Workers, Durable Objects, KV, D1, R2 | One DO per live room serializes commands; share links, cloud boards and licences need no server to run |
| Dependencies | Core: none; Mermaid import: `@excalidraw/mermaid-to-excalidraw` | Core relies on native `crypto.randomUUID()`, `requestAnimationFrame`, `ResizeObserver`; Mermaid is a lazy-loaded chunk, so it costs nothing until used. Icon pack import uses the native `DecompressionStream`, no ZIP library |
