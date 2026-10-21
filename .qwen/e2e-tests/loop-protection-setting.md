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
- Headless runs: `qwen --auth-type openai --openai-base-url <mock> -p ...
--approval-mode yolo` in a scratch project with an isolated `HOME`; the
  project `.qwen/settings.json` sets `model`.
- Daemon: `qwen serve` against the same mock, one prompt through the HTTP API.

## Scenarios

| Group | Setting                                   | Scenario                | Expected                                                                                   |
| ----- | ----------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------ |
| H1    | default                                   | identical               | Reminder in the request after the 3rd call; stops at the 5th, exit 1                       |
| H2    | `warn`, 8 rounds                          | identical               | One reminder without the stop sentence; exit 0                                             |
| H3    | `off`, 8 rounds                           | identical               | No reminder; exit 0                                                                        |
| H4    | default                                   | stuck                   | Cap reminder at 4 `glob` repeats; stops at 6 (`stuck_repetition`)                          |
| H5    | `warn`, 20 rounds                         | stuck                   | One cap reminder; runs all 20 rounds, exit 0                                               |
| H6    | default                                   | shell                   | Reminder after the 6th inspection; stops at the 8th                                        |
| H7    | `warn`, 12 rounds                         | shell                   | One reminder; runs all 12 rounds                                                           |
| H8    | `off`, `maxToolCallsPerTurn: 3`           | distinct                | Still stops at the 4th call (budget), hint names `model.maxToolCallsPerTurn`               |
| H9    | `warn`, telemetry to a file               | identical               | `loop_protection` with `decision: reminded`; no `loop_detected`                            |
| H10   | default, telemetry to a file              | identical               | `loop_protection` `reminded` and `stopped`; one `loop_detected`                            |
| D1    | daemon, default                           | invalid                 | Reminder in the request after the 2nd invalid call; turn error `loop_detected` at the 3rd |
| D2    | daemon, `warn`                            | invalid, 6 rounds       | One reminder; the prompt ends normally                                                     |

Baseline (released CLI before this change): H1–H3, H9 and H10 all stop at the
5th identical call with no reminder, whatever the setting; H4 and H5 stop at
round 16; H6 and H7 stop at the 8th inspection; H8 stops at the 4th call.

## Automated coverage

Unit tests cover every governed detector in each mode, the reminder points,
one reminder per streak, a waiting reminder, retry handling, the stateful-read
exemption, budgets in every mode, the decision event, reminder delivery in the
core client, subagents and the daemon, and the setting plumbing.
