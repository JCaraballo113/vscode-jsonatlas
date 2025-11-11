# Upcoming Enhancements

## 1. Schema-Aware Editor Lenses ✅ Completed
- Add CodeLens above objects/arrays showing the schema title/description plus a “Go to schema definition” action.
- Surface Quick Fixes powered by the schema (e.g., “Insert required property” or “Add enum member”).

## 2. Schema Validation Insights Panel ✅ Completed
- Introduce a panel that lists missing required props, type mismatches, and deprecated fields discovered during validation.
- Clicking an entry should focus either the visualizer node or the editor range.

## 3. Schema-Driven Snippets & Completion ✅ Completed
- Offer autocomplete items for properties/enums that include schema descriptions and defaults.
- Provide snippets that insert the full required property set for an object according to the schema.

## 4. AI-Assisted Schema Updates ⏳ Incomplete
- Have the AI analyze existing JSON payloads and propose schema changes (new enums, oneOf branches, etc.).
- Present proposals in a diff/review UI before applying them to the schema file.

## 5. Visualizer Focus Modes ⏳ Incomplete
- Add filters such as “required only”, “schema warnings”, or “array density” that temporarily hide unrelated nodes.
- Support color-coding based on schema metadata (deprecated/read-only) to highlight hot spots.

## 6. Workspace Schema Dashboard ⏳ Incomplete
- Scan all JSON files in the workspace, report which schema they use, and summarize validation status (pass/fail/error counts).
- Provide commands to open failing documents or export the report for CI usage.
