# Upcoming Enhancements

## 1. Cached Summaries & Explain Selection ✅ Completed
- **Summary caching toggle**: Add a `jsonAtlas.enableSummaryCaching` setting so users can opt in/out of caching AI summaries per document.
- **Cache layer**: Store a hash of the document contents + model id and reuse the summary when nothing changed.
- **Explain Selection command**: New command (and context menu entry) that sends only the current selection/JSON path to the AI and displays the explanation in the summary panel.

## 2. Schema-Aware Navigation ⏳ Incomplete
- Surface schema pointers for nodes in the visualizer (e.g., “Go to schema definition” action).
- Leverage the existing `SchemaValidator` cache so a single schema load/prefix tree powers diagnostics, hover tooltips, and quick navigation.

## 3. Graph Layout Presets ⏳ Incomplete
- Introduce presets such as `compact`, `balanced`, and `relaxed` that adjust node spacing/line length.
- Persist the chosen preset per document (similar to node positions) and expose it through settings and the control dock.
