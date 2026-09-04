# File History Snapshot Persistence E2E Plan

## Goal

Verify that `/rewind` file-history state survives session resume when tool edits
occur after the turn-boundary `makeSnapshot()` and before process exit.

## Scenario

- Enable file checkpointing and chat recording.
- Start an interactive session in a temporary project.
- Ask the model to edit or write a file through the normal edit/write tool
  path.
- Exit immediately after the edit completes, before sending another prompt.
- Resume the same session.
- Run `/rewind` to the prompt that scheduled the edit.

## Expected Results

- The resumed session includes the updated `file_history_snapshot` record for
  the edited turn.
- `/rewind` can restore the edited file to its pre-edit state.
- The JSONL record shape remains a system record with subtype
  `file_history_snapshot` and a `systemPayload.snapshots` array.
- No `schemaVersion` or `isSnapshotUpdate` field is required.

## Commands

Build the local CLI first:

```bash
npm run build && npm run bundle
```

Run the scenario in a throwaway project and inspect the generated chat JSONL.
Use a clean user config, or confirm local settings have not disabled
checkpointing.

```bash
REPO_ROOT="/Users/jinye.djy/.codex/worktrees/6393/qwen-code"
TMP_PROJECT="$(mktemp -d)"
cd "$TMP_PROJECT"
printf 'before\n' > a.txt

node "$REPO_ROOT/dist/cli.js" --chat-recording
```

Inside the TUI, ask Qwen Code to replace `before` with `after` in `a.txt`, then
exit immediately after the edit tool completes. Resume the session with the same
CLI build and run `/rewind`.

## Status

Not executed as part of this implementation pass. The regression is covered by
focused unit tests for snapshot recording, JSONL persistence, resume
reconstruction, client prompt flow, and ACP prompt flow.
