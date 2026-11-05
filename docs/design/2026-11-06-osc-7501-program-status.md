# OSC 7501 Program Status in the Interactive CLI

[English](2026-11-06-osc-7501-program-status.md) | [简体中文](2026-11-06-osc-7501-program-status.zh-CN.md)

Status: implemented (unit-tested and run end to end in a PTY; not yet checked by hand in a supporting terminal).
Issue: [#13870](https://github.com/QwenLM/qwen-code/issues/13870).

## Problem

Terminals and agent inboxes (Rex, cmux, Orca, Prowl, iTerm2, herdr) want to
show whether each tab's agent is working, waiting on the user, or finished.
Without a protocol they guess from window titles and screen contents, which
breaks whenever the UI changes. [OSC 7501](https://www.superlogical.com/rex/docs/build/program-status)
lets the program report its state over the pty. Claude Code, Codex, opencode
and pi already emit it; Qwen Code does not.

## Current state

- `packages/cli/src/utils/osc.ts` builds OSC 9 / 99 / 777 notifications.
- `useTerminalProgress` emits OSC 9;4 tab progress from `StreamingState`.
- `StreamingState` has `Idle`, `Responding` and `WaitingForConfirmation`; the
  UI has no explicit signal for "the last turn failed".

## Goals and scope

- Report a single root record with all five states: `idle`, `working`,
  `blocked` (with `kind=permission|question|auth`), `done`, `error`.
- Interactive Ink UI only. Non-interactive (`-p`, JSON, stream-JSON) and ACP
  never mount `AppContainer`, so they never emit.
- No new setting and no dependency.

Out of scope: child records (`id=`), `progress`, feature probing, focus-based
reset of `done`, and tmux passthrough.

## Design

### Wire format

`oscProgramStatus()` in `osc.ts` writes

```text
ESC ] 7501 ; state=<state>[:kind=<kind>]:app=qwen-code[:msg=<base64>] ESC \
```

- `app=qwen-code` is sent on every report, because each report replaces the
  whole record.
- `kind` is only sent with `blocked`.
- `msg` is UTF-8 base64. Control characters and line separators become spaces
  before encoding; the text is shortened until the encoded value is at most
  2732 bytes, which keeps the whole sequence under 4096 bytes.
- `clear` is `ESC ] 7501 ; state=clear ESC \`.

### State mapping

`deriveProgramStatus()` in `ui/hooks/use-program-status.ts` evaluates in this
order:

| Condition                                      | Report                                                                     |
| ---------------------------------------------- | -------------------------------------------------------------------------- |
| `isAuthDialogOpen` or `isAuthenticating`       | `blocked`, `kind=auth`                                                     |
| A tool call is `awaiting_approval`             | `blocked`; `kind=question` for `ask_user_question`, else `kind=permission` |
| A running subagent has `pendingConfirmation`   | as above                                                                   |
| Slash-command shell confirmation               | `blocked`, `kind=permission`                                               |
| Loop-detection prompt                          | `blocked`, `kind=question`                                                 |
| Folder trust, MCP or project-hook approval     | `blocked`, `kind=permission`                                               |
| `WaitingForConfirmation` with no details found | `blocked`, `kind=permission`                                               |
| `Responding`                                   | `working`                                                                  |
| Idle after a turn                              | latched outcome: `done`, `error` or `idle`                                 |

Dialogs the user opened (theme, settings, model, ...) are not `blocked`: the
user is already at the keyboard.

### Turn outcome

`useTurnOutcome()` records the history length when streaming state leaves
`Idle`. When it returns to `Idle`:

- `idle` if `turnCancelledRef` (now returned by `useLlmStream`) is set;
- `error` if the turn added a `MessageType.ERROR` history item, or left one
  in the pending items (API errors wait there with a Ctrl+Y retry hint until
  the next submit);
- `done` otherwise.

The outcome holds until the next turn starts. If history shrinks below the
turn start (for example `/clear`), it falls back to `idle`.

### Message policy

`msg` names the tool at most (`Permission needed: Shell`), never tool
arguments, prompts or model output, because terminals show `msg` in tab UIs
and desktop notifications. `working` and `done` carry no `msg`; `error` says
`Request failed`.

### Writing and lifecycle

`utils/program-status.ts` is the single writer:

- It writes only when `process.stdout.isTTY` is true.
- It skips a report identical to the one on screen. If a write throws, it
  keeps the old value so the next report retries.
- `releaseProgramStatus()` clears the record before an external editor gets
  the terminal (`useLaunchEditor`, `text-buffer` `openInExternalEditor`);
  `restoreProgramStatus()` writes the latest record when the editor exits.
- On `SIGCONT` the hook rewrites the record, since the shell prompt shown
  during suspension makes terminals drop `working` / `blocked`.
- On `exit`, `idle` / `working` / `blocked` are cleared and `done` / `error`
  stay, as the spec intends, so the user can still see how the last turn
  ended after the CLI quits.
  The same finalization runs when the UI unmounts, because `/quit` unmounts
  Ink before calling `process.exit()`.

### tmux

Reports are never wrapped in DCS passthrough. A passed-through report reaches
the outer terminal without any pane identity, so a background pane would
overwrite the whole tab's status. tmux currently drops the sequence; once tmux
implements OSC 7501 natively (tmux#5713), it works with no change here.

## Risks

- Outcome is inferred from history: an error shown during a turn by something
  unrelated to the turn (for example a concurrent `/btw`) would mark it
  `error`.
- No terminal-side verification yet; behaviour in each terminal is up to that
  terminal.

## Validation

- `utils/osc.test.ts`: format, kind gating, base64 and sanitization, size
  limits, no tmux wrapping, clear.
- `utils/program-status.test.ts`: dedup, TTY gate, retry after a failed write,
  release/restore, SIGCONT resend, exit semantics per state.
- `ui/hooks/use-program-status.test.ts`: every row of the mapping table, the
  tool-arguments-not-leaked case, turn outcome (done, error, cancel, earlier
  errors ignored, `/clear`), and listener cleanup.
- End to end: the built CLI ran in a PTY against a mock OpenAI-compatible
  server, and the captured bytes showed idle → working → done, blocked
  `permission` (shell) and `question` (`ask_user_question`), `error` on an HTTP
  400 followed by `done` on the next turn, `idle` after an Esc cancel, `done`
  kept on `/quit`, and `clear` on `/quit` while idle. `-p` text, JSON and
  stream-JSON output contained no OSC 7501.
- Manual check still to do: run in a supporting terminal (iTerm2 3.7.5+, Rex,
  cmux, Orca, Prowl) and watch how it displays the records.

## Follow-ups

- Child records for background subagents and arena runs.
- `progress` for operations with a known size.
- Revisit tmux once its minimal implementation ships.
