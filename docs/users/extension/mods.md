# Experimental Mods

Qwen Code can run a small subset of the Claude Code Mod API in headless and interactive terminal sessions.
This feature is opt-in and requires a trusted workspace and an enabled Claude or
native Qwen extension. Agent Plugins v1 packages continue to ignore hooks.

Add this setting to your Qwen settings:

```json
{
  "experimental": { "mods": true }
}
```

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

Interactive support currently covers commands, lifecycle and logs. Explicit
`tool.call`, `tool.check` and `tool.*` registrations reject initialization before
a model request. Broad wildcard or negated patterns that also match tool events
receive a visible diagnostic and apply only to supported events. Tool
interception below is available only in headless sessions.

If Mod initialization fails in an interactive terminal, the error remains visible
and the input stays available for the built-in `/help` and `/quit` commands.
Other commands and model requests remain blocked; fix the Mod configuration and
restart the session. File or plugin commands named `help` or `quit` do not gain
this recovery exception.

## Supported subset

| Surface    | Behavior                                                                                                                                                                                |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Packaging  | One `.js`, `.mjs`, `.cjs`, `.ts`, `.mts` or `.cts` ESM entry; relative static imports and re-exports inside the installed plugin                                                        |
| Entry      | `register(on, options)`; async registration is awaited; typed non-secret options are copied and deeply frozen                                                                           |
| Lifecycle  | All modules register before the initial `session.start` chain; `session.end` on exit and conversation replacement; clear/resume do not reload modules                                   |
| Commands   | Register during `session.start` using name, description and optional argumentHint; intercept registered Mod commands across plugins; return `{text}` or `{}`                            |
| Tools      | In headless sessions only, intercept existing main-session tools with `tool.call`; inspect and restrict native permission decisions with `tool.check`                                   |
| Middleware | Patterns and recursive matchers; explicit, repeatable `next(e)`; `.catch` and per-plugin failure recovery; frozen input and host identity                                               |
| API events | `command.register` and `ui.log` calls pass through the middleware chain with host-supplied origin                                                                                       |
| Logging    | `$.ui.log` returns void and queues delivery; transcript logs use stderr in text mode or `system/ui_log` in JSON modes; debug logs stay in the debug logger; neither becomes model input |
| Isolation  | Separate QuickJS environment per plugin inside a session worker; no Node, filesystem or network APIs; memory, stack, source/output and execution limits                                 |

This is a supported subset, not full compatibility with existing Claude Mods.
JSX/TSX, runtime package imports, built-in command interception, tool registration and active `$.tool` APIs, context,
state/store, rendering, streaming events and hot reload are not implemented.
Commands cannot return `context`, `exitCode` or engine references yet.

Two Mods cannot register the same command name: the later registration rejects.
A conflict with a Qwen built-in command still uses Qwen's command conflict policy:
the extension command is renamed to `extensionName.commandName`. Disabled slash
command names are matched against the resulting name.

## Middleware and recovery

Patterns select among `session.start`, `session.end`, `command.run`,
`command.register`, `ui.log`, `tool.call` and `tool.check`. Use an exact name, a prefix such as `command.*`,
`*`, or a single negation such as `!session.*`. Other concrete events and the
patterns `!*` and `!!...` are rejected.

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
Additional attempts count against `--max-tool-calls`; catch replay adds no
attempt. Sessions with tool middleware serialize tool calls, including parallel
next calls, because rewritten arguments may introduce side effects. One root
call permits at most 64 native attempts and 32 outstanding host operations.
The 60-second root limit includes native execution and time spent waiting for
approval. Returning before an outstanding next completes cancels that work and
waits for it to settle.

`tool.check` receives `{tool, input, tool_use_id}` after native validation and
classic input rewrites. All fields are pinned. Its next returns a declarative
`{decision: 'allow' | 'ask' | 'deny', reason?}` without executing the tool.
Qwen merges the answer restrictively: a Mod cannot upgrade a native deny or
ask to allow. A Mod ask follows the current approval mode's existing decision
flow; required human interaction and classic forced asks remain authoritative.
This is deliberately stricter than Claude's consumer permission overrides.
If a native PermissionRequest hook rebuilds the arguments, they are checked
again. A Mod-authored `rule`, `hook` or `ceiling` cannot create host permissions.

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
and `error.kind` (`throw`, `timeout` or `re-entry`). Engine events use origin
`{ plugin: 'engine', tier: 'core' }`; Mod API events identify the calling plugin
with tier `user`. Managed-tier `next.to`, tracing and custom namespace `lent`
recovery are not available.

API events begin at the chain head. Their input is the command specification or
`{text, to}` log payload. Return `next(e)`, `{value}` to answer, or `{deny: reason}`
to reject the API call. Immediate self-reentry skips that registration; active
ancestor registrations can use their catch. Re-entry catch cannot call `$` APIs,
and its `next` reuses the original event once. `ui.log` remains a void notification:
`await $.ui.log(...)` does not wait for interceptors. The headless boundary drains
queued notifications before returning output.

A normal plugin layer has 10 seconds of its own time, excluding time waiting for
cross-plugin `next` or API calls. Pending void `ui.log` notifications do not pause
the caller's budget. Catch and re-entry recovery use a one-second budget.
Re-entry dispatch shares this shorter budget with other registrations in
that plugin. Qwen additionally caps each root dispatch at 60 seconds and each
uninterrupted guest execution slice at 10 seconds. All `session.end` work shares
1.5 seconds. An outer handler that finishes early abandons pending downstream
work; cancellation never starts a fallback operation. Retained next/API functions
cannot perform work after their invocation ends. A worker that cannot acknowledge
cancellation within 250 milliseconds is terminated; restart the CLI to reload Mods.

There are at most 32 Mod environments, 64 registered commands, 128 registrations
per plugin, and 4,096 root/API event chains per root call. Passing through another
plugin does not consume an extra event. Each environment has a 64 MiB
memory limit. Logs and message payloads are also bounded. Registration, compilation
and configuration failures still reject initialization; ordinary hook failure
can recover without resetting module state. Guest promise jobs run only while a
host request is active, including its queued notification drain.

Mods do not run in ACP, managed/SSH, sandbox or session-agent entry points in
this version. Safe mode, bare mode and `disableAllHooks` also prevent loading.
Restart after changing plugin code, options or extension activation. An already loaded
command rechecks every participating plugin before execution and refuses a changed
or disabled middleware chain. External settings edits take effect after restart.
Native Qwen extensions with an absolute or external hooks manifest path continue
to use only the classic hook loader. Claude hooks paths that conversion already
ignores because they are absolute or outside the extension are also skipped by
Mod discovery. Mod manifests must be relative paths inside the extension.

## TypeScript and relative imports

Change the hooks entry to `./register.ts` to use TypeScript. Imports and
re-exports may use relative paths, extensionless paths, directory `index` files,
or JavaScript spellings of TypeScript files (`./helper.js` can resolve to
`helper.ts`). Exact files win. Next come `.js` → `.ts`, `.mjs` → `.mts`, and
`.cjs` → `.cts` substitutions, followed by `.ts`, `.js`, `.mjs`, `.cjs`, `.mts`,
`.cts` candidates, trying each file and then its directory index. All six
suffixes use ESM, including `.cjs` and `.cts`. Module cycles and shared imported
state within one plugin are supported.

Compilation uses fixed options inside the cancellable worker; it does not
type-check or load `tsconfig.json`, package resolvers or build plugins. Type-only
imports, including types from `claude-code`, are erased. Runtime value imports
from `claude-code` require APIs outside this subset and are rejected, as are
package/Node/URL imports, dynamic imports, `require`, JSX and imported top-level
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

The author API is based on Claude Code 2.1.296 declarations and the
[official Mod documentation](https://code.claude.com/docs/en/plugins/mods/create).
