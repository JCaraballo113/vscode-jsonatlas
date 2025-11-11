# Future Enhancements

## 1. Schema Drift Alerts
- Allow teams to pin a “golden” schema reference (local file, remote URL, or package version).
- Diff the pinned schema against active associations to surface drift, highlight breaking changes, and warn during workspace scans.

## 2. Visualizer Timeline & Replay
- Capture lightweight snapshots of JSON documents (hash + summary + schema highlights) whenever validation runs.
- Provide a history scrubber inside the visualizer so users can replay changes, compare revisions, and copy prior payload states.

## 3. AI Patch Composer
- Extend AI edit proposals into an approval queue that produces staged patches with rationale.
- Let users cherry-pick approved changes straight into the editor or export them as ready-to-commit diffs for PR reviews.

## 4. CI Hook Generator
- Take the workspace scan configuration and emit turnkey CI recipes (GitHub Actions, npm scripts, Azure DevOps tasks).
- Include optional report upload + badge generation so schema health is visible in dashboards outside VS Code.

## 5. Schema Coverage Heatmap
- Track which schema nodes are exercised by workspace JSON files during scans.
- Overlay coverage intensity and “never used” indicators inside the visualizer to reveal dead branches or under-tested oneOf clauses.
