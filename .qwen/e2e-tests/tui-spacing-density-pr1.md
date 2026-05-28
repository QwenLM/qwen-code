# TUI Spacing And Density PR1 Evidence

## Goal

Provide before/after evidence that PR1 reduces visible row usage without
removing content or changing rendering scope.

## Fixed Conditions

- Terminal width: 100 columns.
- Compare the same prompt/output fixture before and after this PR.
- Strip ANSI control sequences before counting visible rows.
- Count rendered rows from the first non-empty fixture row through the last
  non-empty fixture row. This keeps internal blank spacer rows in the metric
  because those are the rows this PR removes.
- The fixture renders the real Ink TUI components directly, so it does not
  require a model call or network access.

## Scenarios

- Simple Q&A.
- File list output.
- Long shell output.
- File-read error output.
- Multi-block project inspection output.
- Diff output.
- Long streaming output.

## Commands

Terminal capture:

```bash
git checkout origin/main
/tmp/qwen-pr1-spacing-evidence/run-tmux-capture.sh /Users/gawain/.codex/worktrees/tui-display-optimization-issue/qwen-code 'base origin/main 34b7d472e' base
git switch codex/tui-spacing-density-pr1
/tmp/qwen-pr1-spacing-evidence/run-tmux-capture.sh /Users/gawain/.codex/worktrees/tui-display-optimization-issue/qwen-code 'PR1 fixed 848d6a166' fixed
```

VHS visual capture:

```bash
git checkout origin/main
PATH=/Users/gawain/.nvm/versions/node/v24.15.0/bin:$PATH vhs /tmp/qwen-pr1-spacing-evidence/base.tape
git switch codex/tui-spacing-density-pr1
PATH=/Users/gawain/.nvm/versions/node/v24.15.0/bin:$PATH vhs /tmp/qwen-pr1-spacing-evidence/fixed.tape
ffmpeg -y -i /tmp/qwen-pr1-spacing-evidence/base.gif -i /tmp/qwen-pr1-spacing-evidence/fixed.gif -filter_complex "[0:v]fps=5,scale=780:-1:flags=lanczos[left];[1:v]fps=5,scale=780:-1:flags=lanczos[right];[left][right]hstack=inputs=2,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" /tmp/qwen-pr1-spacing-evidence/base-vs-fixed-optimized.gif
```

## Evidence Artifacts

- Release: <https://github.com/chiga0/qwen-code/releases/tag/pr-4594-tui-spacing-evidence>
- Side-by-side GIF: <https://github.com/chiga0/qwen-code/releases/download/pr-4594-tui-spacing-evidence/base-vs-fixed-optimized.gif>
- Final screenshot: <https://github.com/chiga0/qwen-code/releases/download/pr-4594-tui-spacing-evidence/base-vs-fixed-final.png>
- Base tmux capture: <https://github.com/chiga0/qwen-code/releases/download/pr-4594-tui-spacing-evidence/base.tmux.txt>
- Fixed tmux capture: <https://github.com/chiga0/qwen-code/releases/download/pr-4594-tui-spacing-evidence/fixed.tmux.txt>
- Base summary JSON: <https://github.com/chiga0/qwen-code/releases/download/pr-4594-tui-spacing-evidence/base.summary.json>
- Fixed summary JSON: <https://github.com/chiga0/qwen-code/releases/download/pr-4594-tui-spacing-evidence/fixed.summary.json>

## Expected Results

- Simple Q&A: at least 1 fewer visible row.
- Expanded tool output: at least 1 fewer visible row per rendered tool result
  that previously had a blank header/result spacer.
- Multi-tool expanded groups: 1 fewer visible row between each adjacent tool
  entry.
- No scenario should lose user-visible content.

## Results

| Scenario | Width | Baseline rows | PR1 rows | Delta | Notes |
| --- | ---: | ---: | ---: | ---: | --- |
| Simple Q&A | 100 | 2 | 1 | -1 | Assistant history item no longer starts with a spacer row |
| File list or shell output | 100 | 3 | 2 | -1 | Tool header and first result row are adjacent |
| File-read error | 100 | 3 | 2 | -1 | Error result uses the same tool header/result spacing |
| Project inspection | 100 | 16 | 11 | -5 | Three expanded tools no longer have header/result spacer rows or blank inter-tool rows |
| Diff output | 100 | 3 | 2 | -1 | Diff renderer remains unchanged; only tool header/result spacing changes |
| Long streaming output | 100 | N + 2 | N + 1 | -1 | Content rows are unchanged; the extra header/result spacer is removed |
| Full representative fixture | 100 | 26 | 19 | -7 | Same content rendered through real Ink components and captured in tmux |

## What This Proves

- The base branch reproduces the extra spacer rows in a real terminal capture.
- PR1 removes the targeted spacer rows while preserving the same fixture content.
- The row-count improvement is measurable under fixed 100-column conditions.

## What This Does Not Prove

- It does not cover later PR scopes such as thinking trace visibility, tool
  border removal, SubAgent layout, branding, or theme colors.
- It does not replace manual review for extremely narrow terminal wrapping.
