# Loop protection setting E2E plan

Issue #14828, PR 2: `model.loopProtection` (`stop` / `warn` / `off`) and the
reminder before a governed stop.

## Setup

- A mock OpenAI-compatible server returns scripted tool calls for each request
  that declares tools and logs the loop-protection reminders each request
  carries. Scenarios: `identical` (the same `read_file` call), `stuck` (10
  calls per round, one identical `glob` among distinct reads from round 10),
  `shell` (rotating `git status` variants), `invalid` (`read_file` without
  `file_path`) and `distinct`. `MAX_ROUNDS` ends the turn with plain text.
- Headless runs: `qwen -p` with `--auth-type openai`, `--openai-base-url <mock>`
  and `--approval-mode yolo`, in a scratch project with an isolated `HOME`; the
  project `.qwen/settings.json` sets `model`.
- Daemon: `qwen serve` against the same mock, one prompt through the Web Shell UI (Playwright).

## Scenarios

| Group | Setting | Scenario | Expected |
| --- | --- | --- | --- |
| H0 | default (`warn`), 8 rounds | identical | One reminder after the 3rd call, without the stop sentence; no stop, exit 0 |
| H1 | `stop` | identical | Reminder in the request after the 3rd call; stops at the 5th, exit 1 |
| H2 | `warn`, 8 rounds | identical | Same as H0 |
| H3 | `off`, 8 rounds | identical | No reminder; exit 0 |
| H4 | `stop` | stuck | Cap reminder at 4 `glob` repeats; stops at 6 (`stuck_repetition`) |
| H5 | `warn`, 20 rounds | stuck | One cap reminder; runs all 20 rounds, exit 0 |
| H6 | `stop` | shell | Reminder after the 6th inspection; stops at the 8th |
| H7 | `warn`, 12 rounds | shell | One reminder; runs all 12 rounds |
| H8 | `off`, `maxToolCallsPerTurn: 3` | distinct | Still stops at the 4th call (budget), hint names `model.maxToolCallsPerTurn` |
| H9 | `warn`, telemetry to a file | identical | `loop_protection` with `decision: reminded`; no `loop_detected` |
| H10 | `stop`, telemetry to a file | identical | `loop_protection` `reminded` and `stopped`; one `loop_detected` |
| D0 | daemon, default (`warn`), 6 rounds | invalid | One reminder after the 2nd invalid call; the prompt ends normally |
| D1 | daemon, `stop` | invalid | Reminder in the request after the 2nd invalid call; turn error `loop_detected` at the 3rd |
| D2 | daemon, `warn`, 6 rounds | invalid | Same as D0 |

Baseline (released CLI before this change): H0–H3, H9 and H10 all stop at the
5th identical call with no reminder, whatever the setting; H4 and H5 stop at
round 16; H6 and H7 stop at the 8th inspection; H8 stops at the 4th call.

## Automated coverage

Unit tests cover every governed detector in each mode, the reminder points,
one reminder per streak, reminders sent together, retry handling, side queries, the stateful-read
exemption, budgets in every mode, the decision event, reminder delivery in the
core client, subagents and the daemon, and the setting plumbing.
