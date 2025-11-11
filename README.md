# JSON Atlas

JSON Atlas keeps your JSON documents healthy by surfacing syntax errors in-line, visualizing the structure in multiple modes, and layering on AI summaries plus chat assistance.

## Features

- **Real-time linting** for `json` and `jsonc` documents using the `jsonc-parser`, with inline diagnostics that point directly to the faulty token.
- **Optional schema validation** powered by [Ajv](https://ajv.js.org/). Point the extension at a JSON Schema file to receive rich, property-level diagnostics.
- **Schema-aware navigation** whenever validation is enabled: every node in the visualizer surfaces a `Schema` action that jumps straight to the matching definition inside your JSON Schema, complete with the title/description tooltip. Hover inside the JSON editor (or use the inline CodeLens) to see the schema title/description and jump via `JSON Atlas: Go to Schema Definition`.
- **Schema Insights view** (next to the Summary panel) lists missing required props, type mismatches, and other validation issues, with one-click focus in the visualizer or jump-to-editor actions.
- **Visualizer view** that turns a valid JSON tree into a tidy, zoom-independent overview so you can reason about large payloads at a glance and now auto-refreshes as you type. Every depth level becomes its own collapsible box with a key-to-value link, so you can fold away branches while keeping the surrounding context visible.
- **Graph & Tree modes** selectable via the view dropdown: the Graph view offers pan/zoom with smooth connectors, while the Tree view keeps a classic outline for folks who prefer a stacked hierarchy. Both modes keep URL values clickable.
- **Focus modes & schema badges** so you can filter to required nodes, schema warnings, or dense arrays while deprecated/read-only values get inline badges for instant triage.
- **Graph layout presets** (compact, balanced, relaxed) that you can switch from the control dock or via `jsonAtlas.graphLayoutPreset`, adjusting spacing/line lengths without rebuilding the document.
- **Inline rename**: click any key label in either view to rename the underlying property and apply the edit directly to the JSON document.
- **Draggable layout** in Graph mode so you can rearrange nodes to highlight the relationships you care about; per-document positions persist between renders.
- **Instant search & pan**: use the visualizer “Find” box to jump to any key/value (including array items) and automatically center the corresponding node.
- **Built-in AI assistant**: chat with your JSON, stream responses, and apply suggested edits directly from the webview once you provide an API key.
- **AI schema proposals**: run `JSON Atlas: Generate AI Schema Updates` to have the AI inspect the active document plus its schema, propose changes (new enums/constraints), review diffs, and apply updates safely.
- **Command palette & editor title entry** to trigger the visualization beside the active editor.

## Usage

1. Open any JSON/JSONC document. Diagnostics update automatically while you edit.
2. Once the document is valid, run `JSON Atlas: Show Visualizer` (command palette) or use the editor title button.
3. A webview opens beside the editor showing the hierarchical structure with metadata such as object property counts and array lengths. Keep editing—the view refreshes automatically whenever the JSON stays valid.
4. Use the view dropdown to switch between *Graph* and *Tree* modes. In Graph, drag the canvas (or scroll to zoom), reposition individual nodes to create your own layout, and click URL values; in Tree, collapse/expand inline branches while keeping the surrounding context visible.
5. Type into the **Find** box to locate any key or value; the graph view centers the matching node immediately (arrays are searched by parent label and value).
6. Open **AI Chat** in the toolbar, set your API key via `JSON Atlas: Set AI API Key`, and hold multi-turn conversations. Streamed answers can include ready-to-apply JSON snippets.
7. Click a key label to rename that property. A VS Code input box appears so you can confirm the new name, and the JSON text updates immediately afterward. Enable `jsonAtlas.autoSaveOnEdit` if you want the extension to save the document automatically after the rename.

### Schema validation

Set the following settings (Workspace recommended):

- `jsonAtlas.enableSchemaValidation`: `true`
- `jsonAtlas.schemaPath`: absolute path or workspace-relative path (e.g. `schemas/payload.schema.json`)
- `jsonAtlas.autoSaveOnEdit`: set to `true` if you want JSON Atlas to save the JSON document automatically whenever you rename a key from the visualizer.
- `jsonAtlas.graphAutoScale`: enable to let JSON Atlas pick an initial graph zoom level based on how large the document is.
- `jsonAtlas.graphInitialScale`: when auto scaling is disabled, this numeric zoom (0.4–1.2) becomes the starting scale for the graph view.
- Run `JSON Atlas: Set AI API Key` (stored securely) to unlock AI chat and the `JSON Atlas: Summarize JSON` command.
- For local testing, open `samples/sample.json` and set `jsonAtlas.schemaPath` to `samples/sample.schema.json` (workspace-relative) to try schema validation + navigation immediately.
- `jsonAtlas.visualizerExcludeGlobs`: glob array that skips auto-opening the visualizer for matching files (defaults to `["**/*.schema.json", "**/schemas/**"]` so schema documents remain manual).
- `jsonAtlas.insightExcludeGlobs`: glob array (defaults to `["**/.vscode/**", "**/*.schema.json"]`) that suppresses Schema Insight updates for matching files while still showing editor diagnostics.

When enabled, the extension loads/compiles the schema with Ajv and surfaces additional diagnostics alongside the syntax errors.

## Development

```bash
npm install
npm run watch
```

For a one-off build run `npm run compile`. Launch the extension via the VS Code debugger using the `Run Extension` configuration. Packaging is available through `npm run package` (requires `vsce`).
