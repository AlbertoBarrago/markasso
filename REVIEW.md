# Review guide: Markasso

Check only the rules whose trigger matches a path in the diff. For each finding, name the rule (R1, R2, ...) or say "outside REVIEW.md" when it is a bug no rule covers. Report real defects with a concrete failure scenario; skip anything listed under "Do not flag".

This file is read from the base branch. Change it in its own commit, never together with the code it judges. Every rule comes from bugs that shipped: the commits are listed so a rule can be judged, sharpened or deleted.

## Rules

### R1: Remote commands leave per-user state alone
Trigger: `src/engine/reducer.ts`, `src/engine/history.ts`, `src/commands/commands.ts`
Check: every reducer case that writes `appState` or `selectedIds` (selection, last created id, default font, size, style) branches on `isRemote` and keeps the receiver's value. A new command states which of its fields are per user.
Why: a peer's or an agent's command changed the local selection, defaults or restyle target (fixes: 23aa970, d58e4df, 74f2d4a, fb561b6, 7862d43, 766fc1f).

### R2: One user action is one undo step, never an empty one
Trigger: `src/engine/history.ts`, `src/tools/**`, `src/ui/style_actions.ts`, any new `history.dispatch` call
Check: ephemeral changes (defaults, tool, view, selection) create no step; a text edit or a gesture yields exactly one step; undo or redo during an open gesture cancels it first; restoring `appState` touches only the fields the step changed.
Why: Ctrl+Z looked dead, undid a non-edit or wiped the redo stack (fixes: 23947ff, f01d74f, 3fd33a7, b7a8b57, 7862d43).

### R3: Live rooms: capacity, reconnection and quotas
Trigger: `src/worker.ts` (SessionRoom), `src/worker/room_log.ts`, `src/io/live_outbox.ts`, `src/io/realtime.ts`, `mcp/src/live.ts`
Check: limit checks do not count the reconnecting client's own sockets; compaction or recompute runs only when there is new work; the outbox paces to the room quota and collapses grouped gestures; reconnection has a stop condition, and "full" or "refused" reaches the user instead of a retry loop.
Why: reconnect loops, peers locked out of their own room, CPU burned on full rooms, edits silently lost (fixes: c6f0316, ef0812d, 404099d, 8c69469, 692f95d, 972f1b1, fd84318, 373a403).

### R4: Network input goes through the shared validators
Trigger: `src/io/command_validation.ts`, `src/io/element_validation.ts`, new `Command` variants, worker or MCP code that relays or loads scenes
Check: a new or changed command field gets a validator case shared by app and worker; loading drops only the bad element, never the whole scene.
Why: a room stored a command the reducer rejects, and one malformed element wiped a session (fixes: 6d35c2c, 766fc1f, 1debd64).

### R5: Selection operations act on the whole set, whatever its order
Trigger: `src/ui/style_actions.ts`, `src/tools/select_tool.ts`, `src/rendering/draw_selection.ts`, gesture and selection commands
Check: no logic keyed on `[...selectedIds][0]` or "the first element"; reorder, drag and resize treat the selection as one block; rotated elements resize in their own frame.
Why: a multi-selection collapsed to one element or reordered differently depending on click order (fixes: 22ade11, 7c2b983, d7adec6, 8262346, 684be15).

### R6: Global key and clipboard handlers respect fields and dialogs
Trigger: `src/ui/shortcuts.ts`, `src/ui/canvas_view.ts` (keydown), `src/ui/clipboard_actions.ts`, `src/ui/keyboard_utils.ts`, `src/main.ts`
Check: new handlers call `isEditableTarget`, `keyBelongsToDialog` or `isModalDialogOpen` (native `dialog[open]` and contenteditable included); Cmd/Ctrl combinations the browser owns call `preventDefault`.
Why: shortcuts fired while typing or behind a modal (fixes: 32de7cd, e0ca690, 81b459a, 295e2fa, 54dd9db).

### R7: The text editor overlay commits and follows the view
Trigger: `src/tools/text_tool.ts`, `src/ui/canvas_view.ts`, label and code editors
Check: an open editor commits (never discards) on another tool's press, Esc and blur; it tracks pan and zoom and scales padding, line height and size with the zoom to match the rendered element.
Why: lost text, editors drifting off their element, editor and render out of step (fixes: b01c7ab, c65dbf1, c76f535, 4583c3c, d9cd398, f3efaf3, ffa5dea).

### R8: SVG and PNG export match the canvas renderer
Trigger: `src/rendering/draw_element.ts`, connector and label rendering, `src/rendering/export.ts`
Check: a visual change to canvas drawing has the matching change in `export.ts` and a case in `tests/export_parity.test.ts` or `tests/svg_parity.test.ts`.
Why: exported files differed from the canvas: theme, labels, strokes, polygon bounds (fixes: a4897c8, 6500fef, 85b5e8a, 7495034).

### R9: Bound connectors are resolved from their shapes
Trigger: `mcp/src/diagram.ts`, `mcp/src/server.ts`, `src/ui/minimap.ts`, layout and connector code
Check: anything that reads connector geometry outside the renderer (save, share, layout, minimap) uses `resolveConnectorRoute` or `resolveArrowEndpoints`; layout updates connector ends after moving nodes.
Why: connectors pointed at stale positions in files, links, the minimap and after a layout (fixes: 18bd1e6, cd690a9, 7f3833c, 7cf72fe).

### R10: Cloud save keeps tokens and work safe on failure
Trigger: `src/io/cloud.ts`, `src/ui/cloud_boards.ts`, `src/io/session.ts`
Check: a token is replaced only after the new one is proven; `Retry-After` is honoured; a lost reply is not a conflict; missing-board and failed-first-save paths are handled; an injected `fetch` is called unbound.
Why: lost edit rights, spurious conflicts, the local drawing overwritten by a link or a cloud board, valid licence keys never confirmed (fixes: 8b7e359, 1c2cccc, 0464479, 85e165f, 4be1528).

### R11: Storage goes through safe_storage
Trigger: any new `localStorage` or `sessionStorage` use in `src/`
Check: use the `src/io/safe_storage.ts` helpers (`readStorage`, `writeStorage`), never raw access at module load.
Why: the app failed to start when the browser blocks storage (fixes: b4d23b9, 1debd64, 4be1528).

### R12: Colours follow the theme
Trigger: `src/styles/**`, `src/rendering/**`, `src/ui/minimap.ts`, the colour picker
Check: no hard-coded light or dark colours, use theme tokens or `theme_cache`; cached canvases repaint on a theme or background change.
Why: unreadable chrome or ink in one theme, stale minimap (fixes: 7da3ebc, c765a9d, 74686d5).

### R13: New strings are really translated
Trigger: `src/i18n/locales/*.json`
Check: non-English values are translations, not English copies (tests only check key parity and non-empty values).
Why: English text shipped in six locales (fixes: 9f94325, 515608f, 57a77d3).

## Do not flag

- Formatting, quote style, import order: Biome enforces them (`biome ci` in the release workflows).
- Non-null assertions (`!`): allowed on purpose (`noNonNullAssertion: off` in `biome.json`, AGENTS.md).
- Missing or empty locale keys, static page `data-i18n`: covered by `tests/i18n_locales.test.ts` and `tests/static_pages_i18n.test.ts`.
- Type errors in app, worker or MCP: `pnpm typecheck` runs on all three projects and is part of `build`.
- Missing tests for DOM or rendering modules: excluded from coverage by design (`vitest.config.ts`, AGENTS.md). Do flag missing tests for a new command, element type or tool behaviour.
- A new runtime dependency loaded with dynamic `import()` outside the core, when the reason is stated (AGENTS.md).
