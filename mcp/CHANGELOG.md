# Changelog

All notable changes to `@markasso/mcp` are documented here. The MCP server is versioned independently from the Markasso app; releases are tagged `mcp-v<version>`.

---

## [0.9.1] - 2026-11-27

### Changed
- **Elbow connections avoid the nodes they used to cross.** In exported diagrams and layout warnings, an elbow connection that ran through another node switches to the other pair of sides when that clears it, as long as it does not cross or overlap other connections instead: a top-to-bottom fan-out now leaves its hub from the bottom and reaches each child from above. Layout warnings measure crossings exactly as the router does: rotated nodes count by their rotated outline, polygons count as nodes, and a box with only a caption inside is no longer treated as a frame.

---

## [0.9.0] - 2026-11-27

### Added
- **Nine more ISO 5807 flowchart symbols.** Node kinds `manualOperation` (a manual step), `display`, `offPageConnector` (the flow continues on another page), `storedData`, `internalStorage`, `multiDocument`, `merge`, `loopStart` and `loopEnd` (loop limits) join the eight existing ones, with the same connector snapping and spread ports. The off-page connector starts at 80 x 80 and the merge triangle at 100 x 80.

### Fixed
- **Flowchart symbol sizing.** A symbol whose text area is not proportional to it (a merge triangle) no longer grows much wider than its label needs, and changing a symbol's label keeps its own default size.

---

## [0.8.2] - 2026-11-27

### Changed
- **Boards from newer versions keep their symbols.** Opening a board (file, share link or live room) that uses a flowchart symbol this version does not know now keeps it, drawn as a rectangle, instead of dropping it, so saving or editing the board never deletes it. `diagram_read` shows its kind as written. New flowchart symbols are coming in a later release.

---

## [0.8.1] - 2026-11-27

### Changed
- **Cleaner connectors on flowchart symbols.** In exported diagrams, several elbow connectors on one side of a flowchart symbol (a request and its response on a terminator, reads and writes on a database cylinder) now get their own line instead of piling up on its middle point, and a connector between a symbol and a box that face each other runs straight. Ends sit exactly on the outline, slanted and curved sides included. Decisions (rhombus) keep their connectors on the vertices.

### Fixed
- **Labels of elbows that used to be curves.** A connection switched from curved to elbow no longer has its label, or the layout warnings, follow the old curve when its route becomes a straight line.

---

## [0.8.0] - 2026-11-27

### Added
- **Your own icon packs.** Agents can now draw with the icon sets you download, such as the official AWS, Azure or Google Cloud icon ZIPs: load one with the new `icons_import` tool, or list ZIPs and folders in `MARKASSO_ICON_PACKS` so every session has them. Icons are named like `aws/amazon-ec2`, `icons_search` finds them by name or category, and a bare name such as `"lambda"` works when it matches one icon. Each node embeds its icon's SVG, as the app's icon import does, so the diagram renders the same everywhere: in the app, share links, live rooms and exports. Packs are read like the app's import, and SVGs with scripts, event attributes or external references are skipped. Nothing vendor-made ships with Markasso.

---

## [0.7.9] - 2026-11-27

### Changed
- **Cleaner `diagram_layout`.** A connection that skips layers (a shortcut, a retry loop) now gets a lane of its own: its two ends line up on it and the nodes in between step aside, so it no longer runs through them. Nodes line up with their neighbors (a single child right under its parent, chains straight), and the gap between two layers grows to fit the connection labels crossing it, so long labels in left-to-right diagrams no longer sit on the nodes. In the reference flow gallery, layout warnings drop from 12 diagrams to 2 (the remaining fan-out crossings come from routing, not layout).

---

## [0.7.8] - 2026-11-27

### Changed
- **Elbow connections by default ([#202](https://github.com/AlbertoBarrago/markasso/pull/202)).** `diagram_connect` draws orthogonal routes with rounded turns when no `routing` is given, which suits the flowcharts and architecture diagrams agents draw; pass `routing: "straight"` for radial or dense diagrams. Existing connections keep their routing. `diagram_read` now names only straight connections, and the crossing-connections hint suggests elbow routing only when one of the crossing connections is straight.

---

## [0.7.7] - 2026-11-26

### Changed
- **Smoother elbow connectors in exported diagrams ([#194](https://github.com/AlbertoBarrago/markasso/pull/194)).** `diagram_export_png` and `diagram_export_svg` draw elbow connectors with rounded turns, and connectors leaving the same side of a node get their own line and label instead of piling up on its middle point (a request and its response, a read and a write). Connectors that ran straight stay straight, and spread connectors never cross. Routes still depend only on the diagram, so a live session and the app draw the same thing.

---

## [0.7.6] - 2026-11-20

### Changed
- **Clearer tool schemas ([#182](https://github.com/AlbertoBarrago/markasso/pull/182)).** Every tool parameter now has a description, and the main tools end their description with a one-line usage example, so agents fill in arguments right the first time. `diagram_share` declares that it is not destructive: it only publishes a new link.

---

## [0.7.5] - 2026-11-16

### Added
- **Listed in the official MCP Registry ([#154](https://github.com/AlbertoBarrago/markasso/pull/154)).** The server is published there as `io.github.AlbertoBarrago/markasso`, so MCP clients and directories that read the registry can find it. Claude Code users can also install it as a plugin, with a skill that knows when to draw: `claude plugin marketplace add AlbertoBarrago/markasso-plugin`, then `claude plugin install markasso@markasso`.

---

## [0.7.4] - 2026-11-15

### Fixed
- **Refused edits are reported ([#150](https://github.com/AlbertoBarrago/markasso/pull/150)).** When the live room refuses some of the agent's edits (too large, too many at once, board full, not applicable), the tool answer says so, so the agent knows the others do not see them. An answer that made edits waits for the ones the room's limit held back to go out first.
- **Long gestures ([#148](https://github.com/AlbertoBarrago/markasso/pull/148)).** Edits waiting for the room's limit are merged per element, so a burst reaches the room sooner.

---

## [0.7.3] - 2026-11-15

### Fixed
- **No ghost peer after the client quits ([#146](https://github.com/AlbertoBarrago/markasso/pull/146)).** When the client closes the connection (stdin) or the process gets SIGINT or SIGTERM, the server lets running tool calls finish, sends the edits the room's limit held back, leaves the live room and exits. It used to keep running, still present in the room.

### Changed
- `@modelcontextprotocol/sdk` 1.32.2.

---

## [0.7.2] - 2026-11-15

Publishes the fixes of 0.7.1, whose release did not reach npm. No other change.

---

## [0.7.1] - 2026-11-15

### Fixed
- **The licence key goes only to the configured instance ([#124](https://github.com/AlbertoBarrago/markasso/pull/124)).** `live_join` no longer sends `MARKASSO_LICENSE` to whatever host a link points to.
- **Live sessions ([#127](https://github.com/AlbertoBarrago/markasso/pull/127), [#132](https://github.com/AlbertoBarrago/markasso/pull/132)).** Commands from the room are validated before they are applied, and one that fails no longer ends the server. Edits are paced to the room's limit, a board drawn before joining is published in pieces, and `live_leave` sends the last edits before closing.

---

## [0.7.0] - 2026-11-09

### Added
- **Requests from people in a live room.** People with a Markasso Cloud licence can ask the agent something from the participant list. Requests arrive at the end of any tool result, or through the new `live_wait_request`, which waits for the next one; the new `live_reply` answers under the agent's name. Requests are marked as untrusted input scoped to the board.

---

## [0.6.1] - 2026-11-06

### Fixed
- **Titles no longer push the diagram off-center.** `diagram_layout` placed a text node that no connection touches (a title, a caption) beside the diagram as a group of its own, so the exported picture had a wide empty band on one side. Such text nodes now sit centered above the laid-out diagram, stacked in the order they were added. Connected text nodes are laid out as before.

---

## [0.6.0] - 2026-11-06

### Added
- **Layout warnings.** `diagram_layout`, `diagram_read` and `diagram_export_png` now report, by node key and connection id, connections drawn through a node, labels on top of a node or another label, crossing connections (with the count) and overlapping nodes, each with a hint on what to try. An agent that can't see the picture still knows when it is unclear. Nothing is added when the diagram is clear.
- **PNG export without the image.** `diagram_export_png` takes `returnImage` (default `true`). With a `path` and `returnImage: false` it writes the file and answers in text only, so an agent refreshing a live preview doesn't spend context on an image it won't look at.

### Changed
- **`diagram_export_png` writes its file atomically.** The PNG goes to a temporary file in the same folder and is then renamed over the target, so a viewer polling the file never reads a partial image.

### Fixed
- **Arrows no longer cross a node after a layout.** `diagram_layout` and `diagram_update` could leave a connector anchored to the wrong side of a moved node (its old center landing on the new border), so the arrow was drawn through it. Connector ends now face the other node again after every move or resize, and each `diagram_layout` or `diagram_update` call is a single undo step.

---

## [0.5.1] - 2026-11-04

### Fixed
- **Node keys as the model wrote them.** A node added as "Client" can be connected, updated, removed or laid out as "Client" as well as "client": tools first match the exact key, then the key as `diagram_add_nodes` normalizes it.

---

## [0.5.0] - 2026-11-04

### Added
- **Licence for live drawing.** `live_join` sends the key in `MARKASSO_LICENSE` (if set) as its first message, and explains how to get a Markasso Cloud licence when a live room refuses agents without one. Everything else stays free.

---

## [0.4.2] - 2026-10-28

### Fixed
- **Saved boards keep connectors where they are drawn.** After `diagram_layout` or `diagram_update`, `diagram_save` and `diagram_share` used to write connectors with the ends they had when connected; they now store the ends the app draws, so the file matches the board.

---

## [0.4.1] - 2026-10-28

### Fixed
- **`live_join` points to the right place in the app.** The `link` parameter now says the live link comes from **⋯ More tools → Start live session** (or the prompt copied by **Invite AI agent**), not from a Share menu that no longer exists.

---

## [0.4.0] - 2026-10-27

### Added
- **Font size.** `diagram_add_nodes` and `diagram_update` take `fontSize` (6 to 400 px) for text nodes and for shape and icon labels; `diagram_connect` and `diagram_update_edge` take it for connector labels. Auto-sized nodes grow to fit a larger font, so a heading stays on one line. `diagram_read` shows sizes that differ from the default.

### Changed
- **Node sizing shares the app's label rules:** the same wrap width and label font defaults as the canvas, and overlong words break inside the node as they do in the app.

---

## [0.3.0] - 2026-10-23

### Added
- **`diagram_export_png`.** Renders the diagram (same geometry as the app) and returns the image, so an agent can check its work; it can also save the file.
- **`diagram_disconnect` and `diagram_update_edge`.** Remove or change a single connection by id or by its node keys, without recreating the nodes. `diagram_read` now shows connection ids.
- **`diagram_share` tells when the link expires.**

### Changed
- **Nodes fit their text.** Nodes added without width/height are sized from their label, text nodes from their content, and they resize when the label changes.
- **Layout leaves room for icon labels**, and connectors attach and route around them.

### Fixed
- **Connectors follow nodes moved by `diagram_layout` or `diagram_update` in exported SVGs.** Straight connectors were drawn from where the nodes were when they were connected.
- **The SVG export matches the app:** straight connector labels and rhombus text are no longer missing, straight connectors stop at the node border, and labels wrap like on the canvas.
- **Connector labels no longer sit on other connectors**, and have a solid background.
- **Elbow connectors between nearly aligned nodes run straight** instead of making a small step.

---

## [0.2.0] - 2026-10-23

### Added
- **Published on npm as `@markasso/mcp`.** Run it with `npx -y @markasso/mcp@latest`: no clone or build needed, and agents pick up new versions on restart.

### Changed
- **Undo in live sessions is per-user.** The agent's undo reverts only its own changes and reaches the room as a patch, so edits people made in the meantime are kept. Bare `UNDO`/`REDO` from outdated clients are ignored. Requires Markasso 1.13.2 or later on the board.
- **The server reports its real version** to MCP clients (it was hardcoded to 0.1.0).

---

## [0.1.0] - 2026-10-21

### Added
- **First release** (shipped with Markasso 1.13.0, built from the repository). Document mode (create, read and edit diagrams, save `.markasso`, export SVG, publish share links) and live mode (join a live session and draw on the shared board).
