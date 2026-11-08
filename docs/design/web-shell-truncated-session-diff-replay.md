# Truncated session diff replay

## Problem

Saved edit results truncate large old/new file bodies. The unified `fileDiff`
often remains complete, but replay drops the whole result, so Web Shell can
list the edited file without showing its diff.

## Design

When the saved unified patch was not truncated, replay only its bounded
`fileName` and `fileDiff` metadata. Do not replay the truncated old/new bodies
as complete documents. Web Shell keeps that patch as a file-diff-only change
and renders it with the existing unified diff view. Summary line counts come
from the same displayed patches.

If the patch itself was truncated, preserve the current unavailable state.
Do not fall back to the current Git worktree because it may no longer match the
historical turn.

## Verification

- Replay keeps an intact patch while excluding truncated file bodies.
- File-change selection retains the patch without treating it as full content.
- Summary and file rows show patch line counts.
- The review panel renders the patch instead of `No diff available.`
