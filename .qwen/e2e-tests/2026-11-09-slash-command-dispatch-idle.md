# E2E test plan: idle-only slash commands typed from an idle session (#16700, #12224)

Build: `npm run build && npm run bundle` on this branch. Baseline: the published 0.27.0 CLI, and 0.23.4 as the last release before the regression.
Harness: the Ink interactive CLI in tmux with an isolated `HOME`, `--auth-type openai` against a mock SSE server that answers every request with a short text reply (and holds the reply for 8 s when the last message contains `slowreply`). Send `hi`, wait for the reply, then type each command and capture the pane. Press Esc before Enter so path completion does not take the Enter.

## Cases

| # | Scenario | Expected (0.24.0 – 0.27.0) | Expected (branch) | Result |
| - | -------- | -------------------------- | ----------------- | ------ |
| 1 | `/branch` after one finished turn | `Cannot branch while a response or tool call is in progress…` | Branches; `/resume <id>` hint for the original | 0.27.0 refused, branch branched ✅ |
| 2 | `/cd <existing dir>` after one finished turn | `Cannot change directory while a response or tool call is in progress.` | `Moved to <dir>.` | 0.27.0 refused, branch moved ✅ |
| 3 | `/fork say hi` after one finished turn | `Cannot fork while a response or tool call is in progress…` | Background fork agent starts and reports back | 0.27.0 refused, branch forked ✅ |
| 4 | `/recap` after one finished turn | `Cannot run /recap while another operation is in progress.` | Recap runs (`Not enough conversation context…` on a one-turn session) | 0.27.0 refused, branch ran ✅ |
| 5 | `/branch` typed while a response is still streaming | Queued, then refused once the turn ends | Queued, then branches once the turn ends | 0.27.0 refused after the turn, branch branched after the turn ✅ |
| 6 | `/branch` while a tool call waits for approval | Composer is held by the approval prompt | Unchanged | not run (no input path while the approval prompt owns the composer) |

## Notes

- 0.23.4 runs case 1 successfully; 0.24.0 is the first release that refuses it, because a typed slash command's own submission marks the session busy before the command's action reads the idle ref.
- OpenTUI already gives commands the idle state from before their dispatch (`createOpenTuiCommandContext`), so it is not affected.
- Cases 1–5 were run on Linux, Node 24.
