Status: DONE

Commands run:
- `sed -n '1,220p' .superpowers/sdd/task-5-brief.md`
- `sed -n '1,260p' /Users/qqqys/.codex/plugins/cache/openai-curated/superpowers/e855fa51/skills/test-driven-development/SKILL.md`
- `sed -n '1,260p' packages/channels/feishu/src/markdown.ts`
- `sed -n '1,320p' packages/channels/feishu/src/markdown.test.ts`
- `cd packages/channels/feishu && npx vitest run src/markdown.test.ts`
- `git status --short`
- `git diff -- packages/channels/feishu/src/markdown.ts packages/channels/feishu/src/markdown.test.ts`
- `git rev-parse --abbrev-ref HEAD`
- `git add packages/channels/feishu/src/markdown.ts packages/channels/feishu/src/markdown.test.ts`
- `git commit -m "feat(channels): add feishu card status labels"`

Results:
- Failing-before evidence:
  - `cd packages/channels/feishu && npx vitest run src/markdown.test.ts`
  - Result: 2 failed, 20 passed.
  - Failure 1: `uses a custom running status label` expected `text\n\n---\n*生成中...*` to contain `运行中...`.
  - Failure 2: `uses a terminal status label without enabling streaming controls` expected `text` to contain `已完成`.
- Passing-after evidence:
  - `cd packages/channels/feishu && npx vitest run src/markdown.test.ts`
  - Result: 22 passed, 0 failed.

Commits created:
- `20601b329 feat(channels): add feishu card status labels`

Changed files:
- `packages/channels/feishu/src/markdown.ts`
- `packages/channels/feishu/src/markdown.test.ts`

Self-review notes:
- Kept the change scoped to the owned Feishu markdown files.
- Added only the `statusLabel` option and reused the existing streaming fallback label from the brief.
- Confirmed terminal labels render without enabling stop-button controls.

---

Status: DONE

Commands run:
- `sed -n '1,220p' .superpowers/sdd/task-5-brief.md`
- `sed -n '1,220p' .superpowers/sdd/task-5-report.md`
- `sed -n '1,260p' packages/channels/feishu/src/markdown.ts`
- `sed -n '1,320p' packages/channels/feishu/src/markdown.test.ts`
- `cd packages/channels/feishu && npx vitest run src/markdown.test.ts`
- `git status --short`
- `tail -n 80 .superpowers/sdd/task-5-report.md`

Results:
- Failing-before evidence:
  - `cd packages/channels/feishu && npx vitest run src/markdown.test.ts`
  - Result: 1 failed, 22 passed.
  - Failure: `keeps terminal status label in long collapsible content` expected the collapsible card content to contain `已完成`.
- Passing-after evidence:
  - `cd packages/channels/feishu && npx vitest run src/markdown.test.ts`
  - Result: 23 passed, 0 failed.

Commit:
- Pending at report append time; see subsequent commit for this fix set.

Changed files:
- `packages/channels/feishu/src/markdown.ts`
- `packages/channels/feishu/src/markdown.test.ts`
- `.superpowers/sdd/task-5-report.md`

Notes:
- The fix keeps the collapsible path aligned with the existing `contentMd` rendering path by splitting from `contentMd` instead of raw `markdown`.
- The regression test is focused on the non-streaming long-content collapsible case with `statusLabel`.
