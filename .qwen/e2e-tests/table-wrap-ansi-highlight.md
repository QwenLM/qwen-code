# Table Inline-Code Wrap ANSI Highlight E2E

## Problem

Markdown tables render inline code as ANSI-colored strings before wrapping cell
content. In narrow terminals, `wrap-ansi` can split a truecolor inline-code span
without re-opening its foreground color on the continuation line, so long table
names lose their code highlight after wrapping.

## Scenario

- Script:
  `integration-tests/terminal-capture/table-inline-code-wrap-regression.ts`
- Trigger: a fake OpenAI server returns a fixed markdown table containing a long
  inline-code table name.
- Terminal: `100x32`, real `node dist/cli.js`, OpenAI-compatible auth pointed at
  the local fake server.
- Metric: every raw ANSI occurrence of the wrapped table-name suffix
  `244650615` must have an active `38;2` foreground color, and the final screen
  must contain the suffix without containing the full table name on one line.

## Commands

```bash
cd /Users/gawain/Documents/codebase/opensource/qwen-code-table-wrap-ansi-highlight

cd packages/cli && npx vitest run src/ui/utils/TableRenderer.test.tsx

cd /Users/gawain/Documents/codebase/opensource/qwen-code-table-wrap-ansi-highlight
npm run build && npm run typecheck && npm run bundle

QWEN_TUI_E2E_OUT=/tmp/qwen-table-wrap-ansi/fixed \
  npx tsx integration-tests/terminal-capture/table-inline-code-wrap-regression.ts

QWEN_TUI_E2E_REPO=/Users/gawain/Documents/codebase/opensource/qwen-code-table-wrap-ansi-highlight-base \
QWEN_TUI_E2E_OUT=/tmp/qwen-table-wrap-ansi/base \
QWEN_TUI_E2E_EXPECT_PASS=false \
  npx tsx integration-tests/terminal-capture/table-inline-code-wrap-regression.ts
```

## Results

| Branch | Expected | wrapped | continuationOccurrences | colored | uncolored | Result |
| --- | --- | --- | ---: | ---: | ---: | --- |
| `origin/main` base worktree | failure-first reproduction | true | 1 | 0 | 1 | reproduced |
| `fix/table-wrap-ansi-highlight` | strict pass | true | 1 | 1 | 0 | passed |

## Artifacts

- Base summary: `/tmp/qwen-table-wrap-ansi/base/summary.json`
- Base raw ANSI: `/tmp/qwen-table-wrap-ansi/base/raw.ansi.log`
- Base screenshot: `/tmp/qwen-table-wrap-ansi/base/table-inline-code-wrap.png`
- Fixed summary: `/tmp/qwen-table-wrap-ansi/fixed/summary.json`
- Fixed raw ANSI: `/tmp/qwen-table-wrap-ansi/fixed/raw.ansi.log`
- Fixed screenshot: `/tmp/qwen-table-wrap-ansi/fixed/table-inline-code-wrap.png`

What this proves:

- The unfixed table renderer emits the wrapped table-name continuation without a
  code foreground color.
- The fixed table renderer emits the same continuation with active truecolor
  foreground while preserving the final rendered table.

What this does not prove:

- It does not validate non-table inline code or fenced code blocks; those use
  Ink React `<Text color=...>` rendering instead of the table ANSI-string path.
