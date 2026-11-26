# Mods in ACP sessions

[English](2026-11-18-mods-in-acp-sessions.md) | [简体中文](2026-11-18-mods-in-acp-sessions.zh-CN.md)

Status: implemented. This runs Mods in ACP sessions (`qwen --acp`: the Web Shell daemon, Zed and the VS Code companion), tracked in #13749. It is the step before the Web Shell draws Mod rewrites of message rows.

## Problem and current behavior

Mods run in the terminal and in headless runs. An ACP session never loads them: the Mod session refuses to start when the Config is in ACP mode, a guard that dates from the first headless Mod commands, when no ACP host existed. A Mod that translates the model's replies, keeps notes at the end of each turn, or calls `$.model.complete` does nothing in the Web Shell.

ACP already has a stopgap for one of these uses, `MessageRewriteMiddleware` (`messageRewrite` setting). It rewrites a turn's text with a model call at the end of the turn and appends the result as an extra message. Its README asks for a hook-based replacement, and the Web Shell does not draw its output.

## Goals and non-goals

Goals:

- An ACP session with `experimental.mods` on loads the workspace's Mods, as the terminal and headless runs do, under the same permission checks.
- The Mods hear `session.start` and `session.end`, `turn.start` and `turn.complete`, and can call `$.model.complete`, `$.store`, the `$.session` reads, `$.clock` and `$.turn.abort`.
- What a Mod logs, and the diagnostics the host writes about it, reach the ACP client as a notification, and the daemon forwards them to its session's event stream.
- Each session's Mods are isolated: one session's model responses, turns and logs never reach another session's Mods.

Non-goals:

- Render sites (`ui.render`). Nothing in an ACP client draws a Mod rewrite yet. The Web Shell projection, with its client capability check, is the next step.
- Tool and command middleware (`tool.call`, `tool.check`, Mod commands) and prompts (`prompt.submit`, `$.prompt.submit`). They are a later ACP step.
- Showing Mod logs in the Web Shell, which comes with the projection.
- Removing `MessageRewriteMiddleware`. It went once the Web Shell drew Mod rewrites: [Removing MessageRewriteMiddleware](2026-11-23-remove-message-rewrite-middleware.md).

## Contract

An ACP session is a host with no surface of its own: `$.session.surface()` returns `null` and `$.session.surfaces()` returns `[]`, as in a headless run. `session.start` reports `isInteractive: false`. A Mod therefore runs the same way under the Web Shell, Zed and the VS Code companion. A surface is reported once a client draws Mod output.

The ACP host raises:

- `session.start` once the session's Mods load. `session.end` when the session closes, its process shuts down, or `/clear` replaces it, with the reasons the terminal uses.
- `turn.start` and `turn.complete` for each prompt that runs `UserPromptSubmit`: a new prompt or a retry, on either agent loop. A continue, a restored question and a Goal continuation are not new turns, and neither are slash commands that never call the model. Cron and background notification turns are not prompts and raise nothing, as in the terminal. `turn.complete` reports `aborted` for a cancelled turn and `error` for a failed one.
- `$.model.complete` and `$.store` as in the terminal. `$.turn.abort` cancels the running ACP turn.

The ACP host does not raise `ui.render`, `prompt.submit`, `tool.call` or `tool.check`. At load, a Mod that hooks one of them gets the existing diagnostic, "Hooks for unsupported events will not run: …", and `$.session.version()` leaves the events out. `$.prompt.submit` drops the prompt with "this host does not run prompts a Mod submits", as today in hosts that run no Mod prompts. A Mod that installs a tool guard is therefore told that it is not guarding, and is not silently ignored.

### Logs

Each `ui.log` line meant for the transcript, each note `turn.complete` returns, and each host diagnostic is sent to the client as an ACP extension notification:

```json
{
  "method": "qwen/notify/session/mod-log",
  "params": {
    "sessionId": "…",
    "plugin": "zh-display",
    "text": "translated 3 blocks"
  }
}
```

The text has ANSI and control characters removed and is capped as in headless runs (2,000 characters for a log line, 4,096 for a turn note). A line meant only for the debug log goes there and not to the client. Clients that do not know the method ignore it, as ACP requires. The daemon forwards it to the session's event stream as a `mod_log` frame (`{ sessionId, plugin, text }`). Lines for a session the daemon does not own are dropped, as with its other notifications.

## Qwen design decisions

### One Mod session per ACP session

One ACP process hosts many sessions, each with its own Config. Each ACP session owns one Mod session, created with the session and closed before its Config shuts down. A live session that a client loads or resumes again keeps its Mod session, so `session.start` is not raised twice. A session loaded from disk gets a new one.

Loading the Mods does not hold up `newSession` or `loadSession`; a prompt waits for the load before its turn starts. If the Mods fail to load, the session refuses each prompt with an error that names the failure, as the terminal and headless runs fail closed rather than run without the Mods the person installed.

### Host shape

The Mod session gains a third kind of host next to the terminal host and the headless output: an ACP host that reports each log line through a callback, names no surface, raises no prompts and no tool middleware, and keeps the process's stdout untouched (it carries the JSON-RPC stream). The headless paths that print to stdout or stderr do not run for it. The guard that refuses ACP mode now refuses it only for the other hosts.

The load request gains a flag for whether the host raises the tool events: on for the terminal and headless hosts, off for ACP. Without it, `tool.call` and `tool.check` join the events a host may not raise, and the existing skip-with-diagnostic rule applies.

### Isolation

The figures a Mod reads through `$.session.usage()` come from the session's own chat, not from the process-wide telemetry service, whose last prompt token count belongs to whichever session answered last. The turn's model is taken only from responses that carry the turn's prompt id, the filter the Mod session already applies. Each Mod session also raises the telemetry service's listener limit by one, so a daemon with many open sessions does not warn of a leak. Logs are sent with the session's ACP id, which `/clear` does not change while it gives the Config a new session id, and the daemon publishes them on that session's stream.

### Both agent loops

ACP runs a prompt on its own legacy loop or on the shared agent loop. The shared loop hands the turn the same model events as headless runs. The legacy loop reads raw model responses, so the host turns each response's non-thought text into the turn's content, a retry or model fallback into the matching event, and the end of a stream into its finish with its usage. The turn's answer is the text of the last model response, as in the other hosts.

## Validation and acceptance

Unit tests:

- Core runtime, with the real QuickJS worker: a host that raises no tool events skips `tool.call` hooks with the diagnostic and leaves the tool events out of `$.session.version()`.
- The Mod session: with an ACP host it loads in ACP mode, raises no prompts and no tool events, names no surface, and sends its logs through the host's callback without writing to stderr; outside ACP mode the ACP host loads nothing. Its context figures come from the session's own chat while the process-wide count says otherwise.
- The ACP Mod session: off unless the setting is on; log lines go out under the session's ACP id, also after `/clear` rotated the Config's id; a failed load refuses every prompt; a legacy stream reads as content, retries and a finish with usage; a turn ends as completed, failed or aborted.
- The daemon forwards `mod-log` as a `mod_log` frame and drops malformed or foreign ones.

An integration test runs the built CLI over ACP with the fake model server, on the legacy and the shared loop. A Mod hooks `tool.call`, logs at `session.start`, `turn.start` and `session.end`, and in `turn.complete` calls `$.model.complete`, writes and reads `$.store`, and counts turns in a module variable. The first session's second prompt reads a file before it answers, so its turn spans two model responses. Two sessions in one process each receive, in order, the diagnostic, their own `session.start`, their turns and their own count; `/clear` ends the first one's Mods session.

Acceptance: in an ACP session with Mods enabled, a Mod's session and turn hooks run, its model calls and store work, and its log lines reach the client and the daemon's event stream. Hooks the host does not raise are reported at load.

## Risks and open questions

- Each ACP session with Mods runs its own Mod worker thread, whose guest memory is capped at 64 MiB, so a daemon pays a worker for each open session that loads Mods.
- The legacy-loop mapping is a second reading of the model stream. It goes away with the legacy loop once ACP runs the shared loop by default.
- `session.end` on daemon shutdown has the same end budget as the terminal. A shutdown that kills the process sooner cuts it short. Closing a session was checked by hand against a real `qwen serve` daemon (its `session.end` hook wrote to `$.store` before the close returned); the integration test covers neither closing nor shutdown.
- A chatty Mod's `mod_log` frames take slots in the session's event ring. (The SDK event, its Web Shell display and the setting on the Web Shell settings page followed in [Mod reply rows in the Web Shell](2026-11-18-mod-rows-in-web-shell.md).)
- The two sessions in the integration test run one after the other. Turn isolation under concurrent prompts rests on the prompt-id filter and each session's own Config, not on a concurrency test.
