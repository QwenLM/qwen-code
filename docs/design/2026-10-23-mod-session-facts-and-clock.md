# Mod session facts and clock

[English](2026-10-23-mod-session-facts-and-clock.md) | [简体中文](2026-10-23-mod-session-facts-and-clock.zh-CN.md)

Status: proposed. This is the first host API stage after the compatibility baseline in #15270, tracked in #13749. It follows the Claude Code 2.1.309 plugin API declarations, whose session and clock methods are unchanged since 2.1.308.

## Problem and current behavior

A Mod's `$` offers `command.register`, `session.version` and `ui.log`. Any other method throws `Mod API not supported`. Mods written for Claude Code read facts about the session and the time:

- Token Weather, the sample that marks the first milestone, calls `$.session.usage()` at `session.start` and after each turn to chart how full the context window is.
- Claude Code's built-in telemetry Mod reads `$.session.id()`, `cwd()`, `model()` and `surfaces()`, and waits with `$.clock.sleep()`.
- Mods label their own output with `$.plugin.name`.

These calls fail in Qwen Code today, so such a Mod's hook fails and is skipped.

## Goals and non-goals

Goals:

- Answer the read-only session facts and the clock with Claude Code's shapes, from the figures Qwen Code already shows.
- Keep each method an API event that other plugins can observe, answer or deny, as `session.version` is.

Non-goals:

- `$.session.messages`, `repo`, `compact`, `send`, `append`, `authorize` and `identity`.
- `$.clock.after` and `every`, which need work that outlives a dispatch.
- The `breakdown` of `$.session.usage`.
- Turn events. They are the next stage; this one supplies the reading that a `turn.complete` hook takes.

## Proposed changes

### 1. `$.plugin`

`$.plugin.name` is the plugin's name from its manifest. `$.plugin.root` is the plugin's absolute directory, the one that holds `qwen-extension.json` or `.claude-plugin/plugin.json`. They are plain properties, as in Claude Code, and do not pass through the chain.

### 2. Session facts

Each method is an API event with no arguments, except `session.usage`:

| Method                 | Answer                                               | Source in Qwen Code                                                                        |
| ---------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `session.id()`         | the session's id                                     | the current session; it changes on `/clear` and `/resume`                                  |
| `session.cwd()`        | the directory the session runs in                    | the session's target directory                                                             |
| `session.root()`       | the session's project root                           | the same target directory; a worktree move changes both, a shell `cd` neither              |
| `session.model()`      | the main model's id                                  | the configured model, as `/model` sets it                                                  |
| `session.turns()`      | user turns in the transcript                         | the transcript's turn boundaries, which `/resume`, `/rewind` and `/clear` already maintain |
| `session.surfaces()`   | `["terminal"]` in a terminal, `[]` in a headless run | the entry point                                                                            |
| `session.surface()`    | the first surface, or `null`                         | the entry point; deprecated in Claude Code but still declared                              |
| `session.usage(args?)` | `{ startedAt, context, rateLimits }`                 | see below                                                                                  |

`session.usage` returns:

- `startedAt`: when the session began, in `$.clock.now()` milliseconds. For a resumed session it is the session's first record; `/clear` starts it over. A branch made with `/branch` copies its parent's records, so it keeps the parent's start, just as its `turns` include the parent's turns.
- `context`: the main conversation's `tokens`, the model's context `window`, and `percent`, a whole number from 0 to 100. These are the figures the status line shows: the input tokens of the last response, including cached ones. Before the first response `tokens` and `percent` are 0. When the window size is unknown, `window` is 0 and `percent` is absent.
- `rateLimits`: always empty. Qwen Code reads no rate-limit windows.
- `cost` is absent, because Qwen Code keeps no cost ledger. `args.breakdown` and `args.columns` are validated but no breakdown is computed.

The facts are read when each dispatch starts, on the main thread, and travel with the request to the worker. A hook that calls `$.session.usage()` while a tool runs reads the figures from the start of that tool call. They do not change during a tool call: the main conversation waits for its tools before it sends the next request, and subagents do not update the main conversation's figures.

### 3. Clock

`$.clock.now()` resolves the worker's current time in epoch milliseconds.

`$.clock.sleep(ms, options?)` resolves after `ms` milliseconds:

- `ms` must be a finite, non-negative number.
- Unlike every other `$` call, the wait is charged to the calling hook's budget, as in Claude Code. A sleep that outlasts the remaining budget times the hook out.
- `options.signal` rejects the sleep at once when it aborts. In Qwen Code the only signal a Mod has is `next.signal`, because the QuickJS environment provides no `AbortController`. As in Claude Code, the signal does not cross to the host.
- A sleep ends with the hook that started it. Work that outlives a dispatch is not supported yet, so a sleep the hook does not await cannot hold up the dispatch.

## Design decisions

- **Snapshot instead of a query.** Facts are read once per dispatch and sent with it, rather than requested from the worker on each call. This needs no new message type and no main-thread callback in the middle of a dispatch. Every value is a few field reads. A hook runs only inside a dispatch: a tool call, a command, `session.start` or `session.end`. Timers that run between dispatches will need a query path; that belongs to the stage that adds them.
- **Turns from the transcript.** Claude Code counts the user turns in the transcript. The chat recording already keeps one boundary per user prompt and excludes cron, notification, mid-turn and agent messages. It rebuilds the boundaries on resume, trims them on rewind and starts over on a new session. Counting model requests instead would include tool continuations and retries. With chat recording turned off there is no transcript and the answer is 0.
- **The status line's figures.** `session.usage` reuses the numbers the status line already shows, so a Mod's band and the status line agree. `percent` is rounded to a whole number, as Claude Code declares it, while the status line keeps one decimal.
- **Interception.** Like `session.version`, every new method starts at the head of the chain with the calling plugin as origin. A plugin can answer any of them, for example to freeze time in a test, or deny them. An answer of the wrong shape fails that hook, as any invalid answer does.

## Differences from Claude Code

These go into the user guide:

- `session.root()` equals `session.cwd()`.
- `session.surfaces()` never lists a remote surface.
- `session.usage()` has no `cost`, an empty `rateLimits` and no `breakdown`.
- `session.turns()` is 0 when chat recording is off.
- `$.clock.sleep` accepts only `next.signal` as its signal.

## Validation and acceptance

- Real QuickJS worker tests:
  - `$.plugin` values;
  - each session fact from a supplied snapshot, in both headless and terminal runtimes;
  - another plugin answering and denying each kind of call;
  - wrong-shaped answers being refused;
  - `$.clock.now()`;
  - `$.clock.sleep()` charging the budget, timing a hook out, rejecting on `next.signal` and ending with its hook.
- Validation tests for each method's input and answer.
- CLI tests for the snapshot: the session id after `/clear`, the resumed start time, the turn count with and without recording, and the context figures.
- The built CLI checks, in headless JSON and the Ink and OpenTUI terminals:
  - a Mod command prints every fact;
  - after two prompts `turns` is 2 and `tokens` matches the model's reported input tokens;
  - after `/resume`, `turns` and `startedAt` come from the resumed session.

## Risks and open questions

- The answer to `turns()` depends on chat recording. A Mod that counts turns while recording is off sees 0.
- The figures are a snapshot. If a later stage lets hooks run during a model request, `usage` must be read at the call instead.
