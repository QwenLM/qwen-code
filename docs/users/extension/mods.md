# Experimental Mods

Qwen Code can run a small subset of the Claude Code Mod API in headless and interactive terminal sessions.
This feature is opt-in and requires a trusted workspace and an enabled Claude or
native Qwen extension. Agent Plugins v1 packages continue to ignore hooks.

In the Ink or OpenTUI terminal, open `/settings`, search for **Mods**, and turn on
**Mods (Experimental)**. The setting is disabled by default. Changes take effect
after restarting Qwen Code; the current session keeps its startup state.

You can also configure the same setting directly, including for headless use:

```json
{
  "experimental": { "mods": true }
}
```

Set `experimental.mods` to `false` and restart to disable Mod loading. The switch
does not install or enable extensions. With no Mod extensions installed, enabling
it leaves the session running normally. Existing workspace trust and host
restrictions still apply.

Create a plugin directory with these files:

```text
hello-mod/
  .claude-plugin/plugin.json
  hooks/hooks.json
  hooks/register.js
```

`.claude-plugin/plugin.json`:

```json
{ "name": "hello-mod", "version": "1.0.0" }
```

`hooks/hooks.json` (module paths are relative to this file):

```json
{ "modules": ["./register.js"] }
```

`hooks/register.js`:

```javascript
let calls = 0;

export function register(on) {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'hello',
      description: 'Say hello without a model request',
    });
    return next(e);
  });

  on('command.run', { command: 'hello' }, ($, e) => ({
    text: `Hello ${e.args || 'world'}! Call ${++calls}.`,
  }));

  on('session.end', ($, e, next) => {
    $.ui.log(`Finished ${e.sessionId}`, { to: 'debug' });
    return next(e);
  });
}
```

Install the plugin and run its command:

```bash
qwen extensions install ./hello-mod --consent
qwen -p '/hello Qwen' --output-format json
```

Normal CLI authentication configuration is still required at startup. The Mod
command itself makes no model request. Text, JSON and stream-json headless output
are supported. A stream-json or interactive process retains module variables between turns.

To use the same `/hello Qwen` command in the terminal UI, start `qwen` without
`-p`. Both Ink and OpenTUI load Mod commands with the same opt-in setting.
Interactive `session.start` receives `surface: 'terminal'` and
`isInteractive: true`; `command.run` receives `origin: { kind: 'composer' }`
and `presentation: { isFullscreen, columns }` from the active renderer. These
host fields stay pinned. Headless sessions retain `surface: null`,
`isInteractive: false`, and `origin: { kind: 'sdk' }`.

Interactive transcript logs appear as informational messages and never enter
model context. Debug-only logs stay in the debug logger. Terminal text is
control-character sanitized, preserving ordinary newlines and tabs, and each transcript log is limited to 2,000
characters. These UI logs need not survive a restart or resume. Esc cancels
the current Mod command; the next command waits for worker cancellation to
settle. Clear, resume and branch retain the loaded modules and their variables,
send `session.end` for the replaced session, and do not repeat `session.start`.

Interactive tool middleware runs for model-initiated tools in the local Ink and
OpenTUI main session. Explicit tool subscriptions and matching wildcard patterns
use the same tool protocol as headless sessions. Client-initiated slash-command
tools keep their native path and do not trigger a model continuation.

A synthetic result or denial completes the logical call without inventing a
native invocation. Every real attempt retains its execution facts and write
observations, even when a Mod selects an earlier result or withholds a later
result. The model and recording receive one final result after Mod unwind.
Native permission denials and required approvals remain authoritative.

The 60-second root wall-clock limit still includes native execution and human
approval waiting. Expiry cancels outstanding work and drains it before releasing
the queue; old approvals cannot start a new execution. Esc and accepted session
switches also revoke the old session's queued tools and approval callbacks.

Tool middleware uses one native scheduler batch per attempt, so classic
PostToolBatch hooks run for each real attempt, never for synthetic results or
logical aggregation. Each attempt validates independently; the native scheduler's
three-identical-validation-failures diagnostic does not accumulate across Mod
attempts. Invalid inputs remain rejected and the 64-attempt limit remains.
Sessions without tool middleware retain their existing scheduler, parallelism
and validation diagnostic behavior.

If Mod initialization fails in an interactive terminal, the error remains visible
and the input stays available for the built-in `/help` and `/quit` commands.
Other commands and model requests remain blocked; fix the Mod configuration and
restart the session. File or plugin commands named `help` or `quit` do not gain
this recovery exception.

## Supported subset

| Surface    | Behavior                                                                                                                                                                                |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Packaging  | One `.ts`, `.tsx`, `.jsx`, `.js`, `.mjs`, `.cjs`, `.mts` or `.cts` ESM entry; relative static imports and re-exports inside the installed plugin; JSX in `.tsx` and `.jsx` files        |
| Entry      | `register(on, options)`; async registration is awaited; typed non-secret options are copied and deeply frozen                                                                           |
| Lifecycle  | All modules register before the initial `session.start` chain; `session.end` on exit and conversation replacement; clear/resume do not reload modules                                   |
| Commands   | Register during `session.start` using name, description and optional argumentHint; intercept registered Mod commands across plugins; return `{text}` or `{}`                            |
| Tools      | In headless and local terminal model turns, intercept existing main-session tools with `tool.call`; inspect and restrict native permission decisions with `tool.check`                  |
| Middleware | Patterns and recursive matchers; explicit, repeatable `next(e)`; `.catch` and per-plugin failure recovery; frozen input and host identity                                               |
| API events | `command.register`, `ui.log`, `ui.invalidate` and the session and clock methods pass through the middleware chain with host-supplied origin                                             |
| Session    | `$.plugin`, read-only `$.session` facts, `$.clock.now` and `$.clock.sleep`, described in [Session facts and clock](#session-facts-and-clock)                                            |
| Turns      | `turn.start`, `turn.complete` and `$.turn.abort` for the prompts a person submits, described in [Turn events](#turn-events)                                                             |
| Logging    | `$.ui.log` returns void and queues delivery; transcript logs use stderr in text mode or `system/ui_log` in JSON modes; debug logs stay in the debug logger; neither becomes model input |
| Elements   | `$.ui.resolve`, `$.ui.invalidate` and the `h` and `Fragment` globals, described in [Elements](#elements)                                                                                |
| Drawing    | `ui.render` for the band above the prompt in the Ink and OpenTUI terminals, described in [The band above the prompt](#the-band-above-the-prompt)                                        |
| Isolation  | Separate QuickJS environment per plugin inside a session worker; no Node, filesystem or network APIs; memory, stack, source/output and execution limits                                 |

This is a supported subset, not full compatibility with existing Claude Mods.
Runtime package imports, built-in command interception, tool registration and active `$.tool` APIs, context,
`$.session.messages` and `repo`, state/store, `$.clock.after` and `every`, `ui.render` sites other than the band above the prompt, streaming events and hot reload are not implemented.
Commands cannot return `context`, `exitCode` or engine references yet. Hooks for
other Claude Code events load without running, as described in
[Middleware and recovery](#middleware-and-recovery).

Two Mods cannot register the same command name: the later registration rejects.
A conflict with a Qwen built-in command still uses Qwen's command conflict policy:
the extension command is renamed to `extensionName.commandName`. Disabled slash
command names are matched against the resulting name.

## Middleware and recovery

Patterns select among the engine events `session.start`, `session.end`,
`command.run`, `tool.call`, `tool.check`, `turn.start`, `turn.complete` and, in the Ink and OpenTUI terminals, `ui.render`, and the API event of each supported
`$` method, which `$.session.version()` lists. Use an exact name, a prefix such as `command.*`,
`*`, or a single negation such as `!session.*`. The patterns `!*` and `!!...` are
rejected.

Claude Code 2.1.310 also defines events that Qwen Code does not run yet, such as
`prompt.submit` or `classic.Stop`, and `ui.render` runs only where a host draws
it. A registration for one of them,
or for a prefix such as `prompt.*` that matches none of the events above, loads
but never runs, so the rest of the Mod keeps working. At startup each plugin
reports its skipped patterns once, where transcript logs appear:
`Hooks for unsupported events will not run: prompt.submit, ui.render`. A skipped
hook never runs, including a guard and its `.catch`. Names that Claude Code does
not define, such as `tool.calls`, still reject initialization.

To refuse such a plugin instead, set its `unsupportedEvents` to `"reject"` in user
or system settings. Initialization then fails if the plugin registers any skipped
pattern:

```json
{
  "pluginConfigs": {
    "my-guard": { "unsupportedEvents": "reject" }
  }
}
```

The plugin identity and settings precedence are the same as for
[`toolDialect`](#opt-into-claude-tool-inputs); the default is `"skip"`.

Matchers are partial objects. All specified fields must match; arrays are
alternatives, nested objects match their own fields, and regular expressions
test the field's string representation. Matchers are copied during registration.
They allow at most eight levels and 256 nodes. Stateful `g`/`y` regexes and nested
quantifiers are rejected; regex inputs longer than 65,536 characters match
conservatively, leaving the decision to the hook. Nested objects are data, not
operators such as `startsWith`.

An exact event can have one registration without a matcher and multiple
registrations with matchers, including equal matchers. Each wildcard or negated
pattern can be registered once. Within a plugin, registration order determines
the chain; consumers run before their declared dependency providers. A handler
can answer early, including at `session.start`, preventing later handlers from
running. Only command `args` can be rewritten on `command.run`; lifecycle and
command identity fields stay pinned.

## Tool interception

`tool.call` receives the Qwen tool's arguments as flat fields alongside `tool`
and `tool_use_id`. By default, names, argument schemas and output records use
Qwen's native contracts, including for plugins installed in Claude format.
There is no separate `tool.result` event; inspect or change the value returned
by `await next(e)`:

```javascript
export function register(on) {
  on('tool.call', { tool: 'write_file' }, async ($, e, next) => {
    if (!e.file_path.endsWith('.txt'))
      return { deny: 'Only text files are allowed' };
    return next({ ...e, content: e.content.trim() });
  });

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e);
    if (e.tool === 'run_shell_command') {
      return { decision: 'deny', reason: 'Shell is disabled by this Mod' };
    }
    return verdict;
  });
}
```

Every ordinary `tool.call` next starts a fresh native tool attempt: validation,
classic hooks, permissions, approvals and invocation guards all still apply.
In headless runs, additional attempts count against `--max-tool-calls`; catch replay adds no
attempt. Interactive terminals retain their existing usage counters and do not add a run-budget setting. Sessions with tool middleware serialize tool calls, including parallel
next calls, because rewritten arguments may introduce side effects. One root
call permits at most 64 native attempts and 32 outstanding host operations.
The tool root has a cumulative 60-second Mod budget. Native execution and
approval waiting do not consume it while the host owns the active attempt and
no guest work is running or awaiting without lending its budget. Guest checks,
callbacks, continuations and log observers still consume the root budget, even
while another native attempt is active. Starting another attempt never resets
the remaining budget. Returning before an outstanding next completes cancels
that work and waits for it to settle.

`tool.check` receives `{tool, input, tool_use_id}` after native validation and
classic input rewrites, with two facts the host sets:

- `isReadOnly: true` when the tool reports the call as read-only: read, search
  and fetch tools, MCP tools whose server marks them read-only, and shell
  commands that pass the read-only check. Read its absence as a possible write.
- `approver`: `person` where a dialog can ask the user, `host` in a stream-json
  session whose host answers permission requests, and absent where nobody can
  answer.

All fields are pinned; a matcher can select `isReadOnly: true`. Its next returns
a declarative `{decision: 'allow' | 'ask' | 'deny', reason?}` without executing
the tool. Qwen merges the answer restrictively: a Mod cannot upgrade a native
deny or ask to allow. This is deliberately stricter than Claude's consumer
permission overrides.

An ask that a Mod makes or rewords, rather than Qwen's own ask passed up
unchanged, carries the Mod's name as `plugin` and is the user's to answer, as a
classic PreToolUse ask is. YOLO, AUTO_EDIT and the AUTO classifier do not approve
it; the dialog shows the Mod's reason and hides "always allow"; approving another
call does not approve it; and a headless run without a permission host denies
it, giving the model the Mod's reason. A PermissionRequest hook can deny it but
cannot answer for the user. Qwen's own ask passed up unchanged keeps the current
approval mode's decision flow. If a native PermissionRequest hook rebuilds the
arguments, they are checked again. A Mod-authored `rule`, `hook`, `setting`,
`ceiling` or `plugin` cannot create host permissions. The host sets `plugin`.
It drops a `setting` a hook writes: in Claude Code that field names a Claude
Code option's own check, and Qwen Code reports none.

Return `{deny: reason}` to block, or `{result: value}` to supply a JSON result
without executing. Native next returns `{ref, result, text, isError?}`.
`result` is the native function response record, commonly `{output: ...}` or
`{error: ...}`. A returned ref with an unchanged result retains the original
output, including images and output metadata; changing text or error flags
beside that reference does not alter it. Host execution facts are retained
across all attempts even when an earlier result is selected. To change output,
return a new result:
`{result: {output: 'Replacement text'}}`. Records containing only string
`output`/`error` fields retain that shape; other JSON is serialized in full into
an `output` string so native output budgets still apply. The host owns the
function response: JSON is never interpreted as IDs, media parts or execution facts.
Unknown refs and `isReadOnly` claims do not grant provenance. Results too large
for the Mod payload contain an omission notice and a ref; returning that pair
unchanged preserves the complete native response.

Native errors, approval requirements and cancellation cannot be turned into
successful execution by changing the Mod result. A denial after next cannot
undo a tool's effects: Qwen reports that the tool already ran. The same applies
when an earlier attempt ran and a later attempt was refused. Context injection
and request metadata are not supported.

Tool identity, invocation IDs, consent and host metadata are pinned. Native
argument names that collide with `tool`, `tool_use_id`, `agentId`, `consent`,
`requestMeta` or `$shadowed` are preserved in a host-created, pinned `$shadowed`
record and restored for execution. Valid deferred `tool_call` requests expose
the resolved target's name and arguments while retaining the wrapper's native
permission gates. Invalid wrappers, unknown tools, fixed-policy calls and the
synthetic `structured_output` terminal tool stay on their original paths.
`tool_search` and `search_memory` also stay native so guest-authored results cannot
inherit their native output-budget exemptions.
Goal tool calls also keep the native path: this stage does not allow Mod-authored
results to enter a Goal's catalog as external evidence.
Child agents and nested code-mode schedulers do not inherit this middleware.

### Opt into Claude tool inputs

To run a Mod that consumes the supported Claude input fields or passes through
native results, select its tool dialect in user or system settings and restart:

```json
{
  "experimental": { "mods": true },
  "pluginConfigs": {
    "my-mod": { "toolDialect": "claude" }
  }
}
```

Use `name@marketplace` for marketplace installations; local installations accept
`name` or `name@inline`. The setting follows the same operator precedence as
Mod options. Workspace settings cannot select a dialect. `"native"` is the
default and explicitly restores the original view. This setting is separate
from `options` passed to `register` and does not require a `userConfig` declaration.
Unsupported dialect values fail initialization before any Mod starts.

| Native tool         | Claude name | Fields available to the Mod                            |
| ------------------- | ----------- | ------------------------------------------------------ |
| `run_shell_command` | `Bash`      | `command`                                              |
| `edit`              | `Edit`      | `file_path`, `old_string`, `new_string`, `replace_all` |
| `write_file`        | `Write`     | `file_path`, `content`                                 |

Both `tool.call` matchers/flat arguments and `tool.check` matchers/`input` use
this view. Invocation IDs and host identity remain pinned. Inputs are converted
back to Qwen arguments before the next plugin; native and Claude plugins may
coexist in either order. The scheduler, native permission rules and recording
continue to use Qwen names. `tool.check` input is still immutable and cannot
relax native permissions.

Other tools bypass that plugin's Claude tool hooks, including Read, MultiEdit
and custom/MCP tools, even if a custom tool is named `Bash`, `Edit` or `Write`.
Lifecycle, commands and logging are unaffected. This is a selected input
contract, not compatibility with every Claude tool or Mod.

Native-only parameters such as shell `directory`, `timeout`, `is_background`
and write `record_as_artifact` are preserved by the host and hidden from this
view. They cannot be added or changed through a Claude continuation. Unsupported
fields raise a hook error; existing `.catch` and fallback behavior applies, so
an uncaught error can still execute the original native request. Return `{deny}`
to block a call. Omitting a supported field really removes it from the native
arguments, including required fields; native validation still applies.

Results remain Qwen-native, including refs, errors, images and execution facts.
In particular, Bash results do not provide Claude's separate `stdout`/`stderr`
schema. Foreground timeout and background behavior retain Qwen semantics; the
60-second Mod root limit still applies. This stage supports input guards,
observers and rewrites using the fields above, not full UI-based Mods such as
Blast Radius or Replay Theater.

## Command recovery

```javascript
export function register(on) {
  on('command.run', { command: /^hello/ }, async ($, e, next) => {
    const result = await next({ ...e, args: e.args.trim() });
    return { text: `[wrapped] ${result.text || ''}` };
  }).catch(($, e, next) => next(e));
}
```

Ordinary `next` executes downstream on every call. A plugin's registrations form
one layer, sharing a failure record and time budget. On a throw, timeout or
invalid result, its catches are tried in registration order until one returns a
non-undefined answer or calls `next`. A catch that returns undefined or throws
without calling `next` allows the next matching catch to run. As in Claude Code
2.1.296, an invalid answer or a failure after `next` ends catch selection and uses
the shared fallback record; it does not try later catches. `next.called` in catch
means the plugin crossed into the next plugin before recovery began, not merely
into another registration of its own.

If the plugin already called downstream, recovery waits for and replays the last
started call, including its rejection, ignoring replay arguments. If it had not,
catch's first `next` runs downstream once and subsequent calls replay it. A
failed catch uses the same record. Without a successful catch, the plugin is
skipped or its recorded result retained. A registered command that nobody answers
fails explicitly; it is not sent to the model.

`next` exposes `event`, `is(pattern)`, frozen `origin`, `signal`, and a fresh frozen
`budget` snapshot with `ms` and `remainingMs`. Catch additionally receives `called`
and `error.kind` (`throw` or `timeout`). Engine events use origin
`{ plugin: 'engine', tier: 'core' }`; Mod API events identify the calling plugin
with tier `user`. Managed-tier `next.to`, tracing and custom namespace `lent`
recovery are not available.

API events begin at the chain head. Their input is the command specification,
the `{text, to}` log payload, `{ms}` for `clock.sleep`, the `{breakdown, columns}`
arguments of `session.usage`, `{turnId}` for `turn.abort`, `{event}` for `ui.invalidate`, or `{}` for the other session and clock methods. Return `next(e)`,
`{value}` to answer, or `{deny: reason}` to reject the API call. Registrations
already in the event's call chain are skipped, including their catches. Other
registrations in the same plugin remain eligible. This re-entry behavior follows
Claude Code 2.1.301.
`ui.log` remains a void notification:
`await $.ui.log(...)` does not wait for interceptors. The headless boundary drains
queued notifications before returning output.

`$.session.version()` resolves to the Qwen Code version and what this runtime
supports:

```json
{
  "version": "0.26.0",
  "qwen": {
    "claudeCode": "2.1.310",
    "events": [
      "clock.now",
      "clock.sleep",
      "command.register",
      "command.run",
      "session.cwd",
      "session.end",
      "session.id",
      "session.model",
      "session.root",
      "session.start",
      "session.surface",
      "session.surfaces",
      "session.turns",
      "session.usage",
      "session.version",
      "tool.call",
      "tool.check",
      "turn.abort",
      "turn.complete",
      "turn.start",
      "ui.invalidate",
      "ui.log"
    ],
    "methods": [
      "clock.now",
      "clock.sleep",
      "command.register",
      "session.cwd",
      "session.id",
      "session.model",
      "session.root",
      "session.surface",
      "session.surfaces",
      "session.turns",
      "session.usage",
      "session.version",
      "turn.abort",
      "ui.invalidate",
      "ui.log",
      "ui.resolve"
    ]
  }
}
```

This is a headless run. In the Ink and OpenTUI terminals, `events` also lists `ui.render`.
`claudeCode` is the Claude Code release whose event names are recognized,
`events` lists the events hooks can receive and `methods` the `$` methods a Mod can
call. A Mod can use it to choose a fallback, such as a command reply where a
drawing hook would not run.

A normal plugin layer has 10 seconds of its own time, excluding time waiting for
cross-plugin `next` or API calls other than `$.clock.sleep`. Pending void `ui.log` notifications do not pause
the caller's budget. Catch recovery uses a one-second budget.
Qwen additionally caps each root dispatch at 60 seconds of charged time and each
uninterrupted guest execution slice at 10 seconds. Only tool roots exclude the
trusted native waits described above; load and command roots retain continuous
60-second limits. All `session.end` work shares 1.5 seconds. Native tool timeouts
and permission decisions still apply. The scheduler's optional execution timeout
defaults to disabled and does not impose an approval deadline; individual tools
retain their own timeout policies.

An outer handler that finishes early abandons pending downstream work;
cancellation never starts a fallback operation. Retained next/API functions cannot
perform work after their invocation ends. Cancellation immediately revokes the
current root, including during an excluded native wait. A worker that cannot
acknowledge cancellation within 250 milliseconds is terminated; this watchdog
continues independently of the Mod budget. Native process cleanup and task drain
can take longer. Restart the CLI to reload a terminated Mod worker.

There are at most 32 Mod environments, 64 registered commands, 128 registrations
per plugin, and 4,096 root/API event chains per root call. Passing through another
plugin does not consume an extra event. Each environment has a 64 MiB
memory limit. Logs and message payloads are also bounded. Registration, compilation
and configuration failures still reject initialization, apart from the skipped
hooks described above; ordinary hook failure can recover without resetting module
state. Guest promise jobs run only while a host request is active, including its
queued notification drain.

Mods do not run in ACP, managed/SSH, sandbox or session-agent entry points in
this version. Safe mode, bare mode and `disableAllHooks` also prevent loading.
Restart after changing plugin code, options or extension activation. An already loaded
command rechecks every participating plugin before execution and refuses a changed
or disabled middleware chain. External settings edits take effect after restart.
Native Qwen extensions with an absolute or external hooks manifest path continue
to use only the classic hook loader. Claude hooks paths that conversion already
ignores because they are absolute or outside the extension are also skipped by
Mod discovery. Mod manifests must be relative paths inside the extension.

## Session facts and clock

`$.plugin.name` is the plugin's manifest name and `$.plugin.root` its absolute
directory, the one that holds `qwen-extension.json` or
`.claude-plugin/plugin.json`. They are plain properties.

The other methods are API events that resolve to the shapes Claude Code 2.1.310
declares:

| Method                                | Resolves to                                                                             |
| ------------------------------------- | --------------------------------------------------------------------------------------- |
| `$.session.id()`                      | the session's id; it changes after `/clear` and `/resume`                               |
| `$.session.cwd()`, `$.session.root()` | the session's working directory; the two are the same in Qwen Code                      |
| `$.session.model()`                   | the main model's id                                                                     |
| `$.session.turns()`                   | the user turns in the session's transcript, counting resumed turns and not rewound ones |
| `$.session.surfaces()`                | `["terminal"]` in a terminal, `[]` in a headless run                                    |
| `$.session.surface()`                 | the first surface, or `null`                                                            |
| `$.session.usage()`                   | `{startedAt, context: {tokens, window, percent}, rateLimits}`                           |
| `$.clock.now()`                       | the current time in epoch milliseconds                                                  |
| `$.clock.sleep(ms, {signal})`         | `undefined`, after `ms` milliseconds                                                    |

`$.session.usage()` reports the figures the status line shows. `tokens` is the
input of the main conversation's last response, including cached tokens, and
`window` is the model's context window. `percent` is a whole number. When the
window size is unknown, `window` is 0 and `percent` is absent. `startedAt` is when the session began;
for a resumed session it is the session's first record. A branch made with
`/branch` copies its parent's records, so it keeps the parent's `startedAt` and
its `turns` include the parent's turns. Qwen Code keeps no cost
ledger, so `cost` is absent, and `rateLimits` is always empty. `breakdown` and
`columns` are accepted, but no breakdown is computed. With chat recording turned
off, `turns` is 0.

The facts are read when a dispatch starts. At a `session.end` caused by `/clear`
or `/resume`, the id, turns, start time and context figures still describe the
session that is ending.

Unlike other `$` calls, `$.clock.sleep` charges its wait to the calling hook's
budget, so a sleep longer than the remaining budget times the hook out. Its
`signal` option rejects the wait at once when it aborts; pass `next.signal`,
because the Mod environment has no `AbortController`. A sleep ends with the hook
that started it, so a sleep the hook does not await cannot hold up the dispatch.

## Turn events

`turn.start` and `turn.complete` follow the main loop's turns: each prompt a
person submits, from its first model request through its tool calls to the
answer. A retry with Ctrl+Y and the headless continuation of an interrupted turn
are turns too. Subagent and teammate turns, scheduled prompts, background
notifications and goal continuations fire no turn events.

```javascript
export function register(on) {
  on('turn.start', ($, e, next) => {
    $.ui.log(`turn ${e.turnId}: ${e.text}`, { to: 'debug' });
    return next(e);
  });
  on('turn.complete', async ($, e, next) => {
    const answer = await next(e);
    if (e.reason !== 'answer') return answer;
    const { context } = await $.session.usage();
    return { text: `${context.percent ?? 0}% of the context window used` };
  });
}
```

`turn.start` fires once the prompt is admitted, after UserPromptSubmit hooks let
it through and before the first model request. A prompt they block has no turn.
`e.text` is the prompt as submitted, with pasted text expanded, or `""` for a
retry or a continuation. `e.turnId` is new for each turn. The model request does
not wait for the hooks, but the turn's tool middleware and its `turn.complete`
run after them. Cancelling the turn ends the `turn.start` hooks still running,
including one that calls `$.turn.abort` itself: its code after that call does
not run.

A prompt longer than 128 KiB as JSON reaches the hooks with its beginning and
end around the line `[... truncated for Mods ...]`, and `e.isTextTruncated` is
`true`. A long answer is cut the same way, with `e.isAnswerTruncated`. Claude
Code passes both whole.

`turn.complete` fires once the turn has ended. A turn still running when the
session closes ends as `aborted` before `session.end`; a `turn.complete` that is
already running or queued then still runs, within the same budget. The hook
receives:

| Field               | Value                                                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `answer`            | the visible text of the turn's last model response, or `""`                                                                            |
| `durationMs`        | how long the turn took                                                                                                                 |
| `reason`            | `answer`; `aborted` when a person or a Mod cancelled the turn; `error` when an API error, a loop detection or a session limit ended it |
| `isAborted`         | `true` when `reason` is `aborted`                                                                                                      |
| `turnId`            | the id `turn.start` carried                                                                                                            |
| `usage`             | `{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, model}` summed over the turn's model responses    |
| `isAnswerTruncated` | `true` when `answer` was cut to fit; absent otherwise                                                                                  |

The fields of both events are pinned. `next(e)` resolves to `{text: e.answer}`,
with `usage` when the turn has it. Return a different, non-blank `text` to show
it beneath the answer, up to 4,096 characters:

- in a terminal, as the transcript line `[Mod <plugins>] <text>`;
- in headless text mode, as the same line on stderr after the answer;
- in JSON modes, as a `system` `ui_log` message before the result.

The conversation record keeps the answer. In a terminal the hooks run after the
answer, and the next prompt can already start. A headless run waits for them
before it writes its result.

`usage` counts only the turn's own model requests; requests made by subagents,
side queries and compaction are left out. It is absent when no response
finished. `cache_creation_input_tokens` is 0 unless the provider reports cache
writes separately, as Anthropic's does. `reason` is never `refusal`.

`$.turn.abort({ turnId })` ends the running turn and its running tools as Esc
does, but leaves no "Request cancelled." notice and does not put the prompt
back in the composer. Queued prompts then run. The call rejects when no turn is
running, when `turnId` is not the running turn's id, or when the turn is already
ending. In a headless run the turn ends with the error result
`A Mod ended the turn.` and exit code 130, and a stream-json session goes on to
its next message. Qwen Code has no `$.prompt.submit` yet, so a Mod cannot send a
prompt after it ends a turn.

## Elements

`$.ui.resolve(e)` returns the element table of the terminal: a frozen object
with no prototype that holds Claude Code's eleven terminal constructors,
`Box`, `Text`, `Button`, `Input`, `Select`, `Link`, `Code`, `Markdown`,
`Client`, `Raster` and `Image`. It reads the table without a dispatch. `e` is a
`ui.render` event; any argument whose `surface` is not `"terminal"` throws.

A constructor takes the props, `children` among them, and returns a frozen
plain-data element `{ type, props?, hover?, children? }`. Children are
flattened: `null`, `undefined` and booleans are dropped, arrays are spread and
numbers become strings. `key` is kept only on a `Box`. The `h(tag, props,
...children)` and `Fragment` globals build the same elements, as Claude Code's
JSX factory does; `Fragment` is a column `Box`. `h` calls a function tag with
its props and its children flattened into an array, and throws for a string tag other than `Box` or `Text`.
JSX in a `.tsx` or `.jsx` file compiles to these calls, as described in
[TypeScript, JSX and relative imports](#typescript-jsx-and-relative-imports).

A tree a hook returns is judged with Claude Code 2.1.310's rules for `Box` and
`Text`, and any other element refuses it with
`<Element> is not drawn by Qwen Code yet`.

`$.ui.invalidate("ui.render")` returns at once and asks for a redraw of the
sites the plugin's `ui.render` hooks may draw. The cached-answer events
Claude Code also accepts, such as `prompt.section`, do nothing in Qwen Code.
Any other name throws. Both methods work in every host, so a `turn.complete`
hook that asks for a redraw does not fail where nothing is drawn.

## The band above the prompt

The Ink and OpenTUI terminals raise `ui.render` for Claude Code's `AbovePrompt`
site, a band between the session survey and the prompt input. Headless runs
draw no site: there a `ui.render` hook is skipped and listed at startup, and
`$.session.version()` leaves it out.

A hook receives Claude Code's input:

```js
{
  surface: 'terminal',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  viewport: { columns: 120, rows: 40, isFullscreen: true },
  props: {
    hasSurvey: false, // the session survey shows above the band
    isWorking: false, // a model turn runs
    maxRows: 13, // a third of the terminal's rows, at least 1
    bodyColumns: 115, // the terminal's width less 5 columns
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
}
```

`isFullscreen` is true when Qwen Code draws on the alternate screen. A hook may
rewrite the props but keep their kinds; changing `surface`, `component`,
`requestId`, `viewport` or `props.view` fails the hook. `next(e)` resolves to
the engine's own node, `{ type: 'engine', ref: 0 }`, which draws nothing here.
With no hook, or with every hook passing `next(e)` on, the band takes no rows.

The band renders after `session.start`, after `/clear`, `/resume` and
`/branch`, when a plugin calls `$.ui.invalidate("ui.render")`, and when its
input changes. A change of height alone renders nothing unless it changes
`maxRows`. A change of width or of `maxRows` renders once it has settled for
150 milliseconds. Requests fold into one render, and renders run at most every
34 milliseconds, or every 100 milliseconds for a second after one took longer
than that. A render waits in the session's queue behind commands, tool calls and
turn events, and a render that is running is never cancelled for a newer one.
The band keeps its last tree until a new answer lands, and the prompt never
waits for it.

The band is drawn with these conversions:

- A string inside a `Box` is drawn as a `Text`.
- Text wrap values `end` and `middle` become `truncate-end` and
  `truncate-middle`.
- Spacing steps become cells: `xs` and `sm` are 1 across and 0 down, `md` 2 and
  1, `lg` 3 and 1, `xl` 4 and 2.
- `weight: "semibold"` or `"bold"` draws bold. `size`, `mono`, `tabular` and
  `dir` are dropped, as Claude Code's terminal drops them. `hover` is checked
  but not drawn.
- The theme keys `text`, `subtle`, `inactive`, `success`, `error`, `warning`,
  `claude` and `suggestion` follow the active Qwen Code theme. Claude Code's
  other theme keys, such as `permission` or `diffAdded`, draw in the default
  color. Other colors draw when they are an ANSI color name such as `cyan` or
  `redBright`, a hex value, `rgb(r, g, b)` or `ansi256(n)`.
- Text is sanitized for the terminal, as Mod transcript lines are. Tabs
  become spaces to the next 8-column stop, as in Claude Code.

The band clips horizontal overflow to the composer's width.

A tree that throws while drawn shows nothing, and the next answer is drawn
afresh. The debug log records each refused tree and adjustment, such as
`<plugin>: ui.render (AbovePrompt) refused: <reason>; nothing was drawn`.

These differ from Claude Code:

- The band has no collapse mark, focus, scrolling or `n more` row. A tree
  taller than `maxRows` is clipped. `maxRows` is a third of the terminal's rows,
  where Claude Code gives the bottom slot's remaining rows on the alternate
  screen and the terminal's height otherwise.
- The band shows only under the main conversation, never in an agent tab, and
  hides while a dialog takes the composer's place.
- `$.ui.invalidate` takes effect after the dispatch that called it, since Qwen
  Code Mods have no timers.
- A render can wait behind a tool call and its approval, and the band keeps its
  last tree meanwhile. A tool call, command or turn event queued behind a
  running render waits for it, up to 10 seconds for each `ui.render` hook in
  the chain.
- Refusal lines go only to the debug log, since Qwen Code has no hot reload.
- OpenTUI has no session survey, so `hasSurvey` is always `false` there, and
  `isWorking` stays `false` while a `!` shell command runs. OpenTUI takes
  colors as hex values, so ANSI color names and `ansi256()` colors draw as
  fixed values instead of the terminal's palette, and a `borderColor` border
  draws undimmed under `borderDimColor`. Its text truncates only in the
  middle, with `...` where Ink draws `…`: `wrap: "middle"` and
  `"truncate-middle"` draw that way, and the other truncations cut the text
  off at the right edge without a mark. Its borders have one stroke per axis,
  so the `arrow` border draws its top arrow on the bottom edge and its left
  arrow on the right edge.

## TypeScript, JSX and relative imports

Change the hooks entry to `./register.ts` to use TypeScript, or to
`./register.tsx` or `./register.jsx` to write JSX. Imports and re-exports may
use relative paths, extensionless paths, directory `index` files, or JavaScript
spellings of TypeScript files (`./helper.js` can resolve to `helper.ts`). Exact
files win. Next come `.js` → `.ts` or `.tsx`, `.jsx` → `.tsx`, `.mjs` → `.mts`
and `.cjs` → `.cts` substitutions, followed by `.ts`, `.tsx`, `.jsx`, `.js`,
`.mjs`, `.cjs`, `.mts`, `.cts` candidates, trying each file and then its
directory index. This is Claude Code's order. All eight suffixes use ESM,
including `.cjs` and `.cts`. Module cycles and shared imported state within one
plugin are supported.

JSX compiles with the classic runtime to calls of the `h` and `Fragment`
globals, as Claude Code compiles it, so `<>...</>` is a column `Box`. A tag is
one of the constructors `$.ui.resolve(e)` returns, or a function component:

```tsx
on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
  const { Box, Text } = $.ui.resolve(e);
  return (
    <Box flexDirection="row" paddingX={1}>
      <Text bold>☀ Clear</Text>
      <Text dimColor> {e.props.bodyColumns} columns</Text>
    </Box>
  );
});
```

Only `.tsx` and `.jsx` files take JSX. As in Claude Code, a module that declares
its own `h` or `Fragment`, or carries a `@jsx` pragma, points its JSX away from
the globals. A file that fails to compile reports the first error with its line
and column, such as
`Invalid Mod JSX: view.jsx: JSX element 'Text' has no corresponding closing tag. (line 4, column 12).`

Compilation uses fixed options inside the cancellable worker; it does not
type-check or load `tsconfig.json`, package resolvers or build plugins. Type-only
imports, including types from `claude-code`, are erased. Runtime value imports
from `claude-code` require APIs outside this subset and are rejected, as are
package/Node/URL imports, dynamic imports, `require` and imported top-level
`await`. Guest code continues to execute only in QuickJS.

## Plugin options

Declare `userConfig` in the plugin manifest:

```json
{
  "name": "hello-mod",
  "version": "1.0.0",
  "userConfig": {
    "greeting": {
      "type": "string",
      "title": "Greeting",
      "description": "Greeting used by /hello",
      "default": "Hello"
    }
  }
}
```

Set options in user or system settings, then read `options.greeting` from the
second argument to `register`:

```json
{
  "experimental": { "mods": true },
  "pluginConfigs": {
    "hello-mod": { "options": { "greeting": "Welcome" } }
  }
}
```

Fields require `type`, `title` and `description`. Supported types are `string`,
`number`, `boolean`, `directory` and `file`. Optional constraints include
`required`, `default`, numeric `min`/`max`, string `multiple`, and string
`options` choices. File and directory values are strings, with no existence
check or added filesystem access. `sensitive: true` is explicitly unsupported,
including when a default is provided; there is no secret storage or config UI.

Qwen uses SystemDefaults → User → System precedence, merging individual option
keys. Workspace settings are ignored even in trusted workspaces. Qwen maps
extensions without marketplace provenance to the inline identity. They accept
`name` and `name@inline`; the latter wins within each settings source.
Marketplace plugins use their actual `name@marketplace` identity. A higher
priority source wins over either local alias from a lower priority source.

As in the inspected Claude implementation, missing optional values become `''`
unless they have defaults; optional `''` also bypasses type checks. Required
values reject missing or `''`, while `false` and `0` remain valid. Invalid stored
string choices fall back to defaults. With a nonempty schema, unknown option
keys pass through too, limited to strings, numbers, booleans or string arrays.
An absent or empty schema receives `{}`. Options stay frozen until restart.

## Installed dependencies

Manifest `dependencies` accepts plugin names, `name@marketplace`, or objects
such as `{ "name": "base", "marketplace": "team", "version": "^1.0.0" }`.
Bare names refer to the consumer's marketplace. An installed inline plugin with
the same name can override a marketplace dependency, without a version check.
Otherwise, version ranges are checked against the installed extension's
manifest version. Ordinary extensions without Mods can satisfy dependencies.
Their transitive dependencies are checked when reachable from a selected Mod;
unrelated ordinary extensions' dependency declarations do not participate.

Dependencies must already be installed, enabled and selected for this invocation.
Qwen does not fetch, install or enable them automatically. Selected Mods are
registered in stable consumer-before-dependency order for direct dependencies
between Mods; ordinary providers are not registration nodes. Each Mod has a
separate realm; events pass through their handlers in this order, allowing
cross-plugin interception without sharing module variables.

Missing, ambiguous, incompatible or cyclic dependencies reject startup before
any Mod worker starts. Invalid Mod options also reject startup. This differs
from Claude's selective dependency demotion and cycle-order fallback; Qwen
retains the experimental subset's whole-session startup failure policy.

## Resource limits

The reader accepts regular files up to 256 KiB inside the installed extension and
rejects symbolic links within that root. Graphs are limited to 64 files, 1 MiB
of input and 1 MiB of compiled code. These bounds and symlink rejection are
stricter than Claude's. Each guest has a 64 MiB memory limit and 1 MiB stack limit.
The execution budgets described above include a 60-second startup limit for all
worker initialization, compilation and startup hooks together. The guest memory
limit does not cover the compiler's host memory.

Values that cross between a Mod and Qwen Code nest at most 512 levels, so walking
them never exhausts a native stack:

- A hook answer, or a value a hook passes to `next` or a `$` method, that nests
  deeper fails like a thrown error. The hook is skipped or its `.catch` runs, and
  the Mod keeps working.
- A tool input that nests deeper cannot be handed to the Mod's hooks, so the call
  is refused.
- A native result that nests deeper than 256 levels reaches the Mod as the
  omission notice and reference described in
  [Tool interception](#tool-interception). Returning them unchanged keeps the
  complete result.

Own `__proto__` keys in tool inputs and results are ordinary data on both sides.
A hook answer whose getter throws while Qwen Code reads it fails as a whole;
Claude Code 2.1.299 drops only that key.

The author API follows the Claude Code 2.1.310 declarations, event names
included, and the
[official Mod documentation](https://code.claude.com/docs/en/plugins/mods/create).
