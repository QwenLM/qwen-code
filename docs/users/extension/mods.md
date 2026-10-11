# Experimental Mod commands

Qwen Code can run a small subset of the Claude Code Mod API in headless sessions.
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
are supported. A stream-json process retains module variables between turns.

## Supported subset

| Surface    | Behavior                                                                                                                                                                   |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Packaging  | One `.js`, `.mjs`, `.cjs`, `.ts`, `.mts` or `.cts` ESM entry; relative static imports and re-exports inside the installed plugin                                           |
| Entry      | `register(on, options)`; async registration is awaited; typed non-secret options are copied and deeply frozen                                                              |
| Lifecycle  | `session.start` before the first prompt; `session.end` on exit and conversation replacement; clear/resume do not reload the module                                         |
| Commands   | Register during `session.start` using name, description and optional argumentHint; exact `command.run` matcher for the plugin's own command; return `{text}` or `{}`       |
| Middleware | Explicit `next(e)` and repeated calls; event input is frozen; host identity fields cannot change                                                                           |
| Logging    | Synchronous `$.ui.log`; transcript logs use stderr in text mode or `system/ui_log` in JSON modes; debug-only logs stay in the debug logger; logs do not become model input |
| Isolation  | Separate QuickJS environment per plugin; no Node, filesystem or network APIs; memory, stack, source/output and execution limits; cancellable worker                        |

This is a supported subset, not full compatibility with existing Claude Mods.
JSX/TSX, runtime package imports, wildcard/nested matchers,
registration modifiers, advanced `next` metadata, cross-plugin interception,
tools, context, state/store, rendering and hot reload are not implemented.
Unsupported hooks or calls fail explicitly. Commands cannot return `context`,
`exitCode` or engine references yet. Unlike Claude's per-hook recovery behavior,
a failed dispatch disables that plugin runtime for the rest of the process.

Qwen's existing command conflict policy applies: a conflicting extension command
is renamed to `extensionName.commandName`; this differs from Claude's conflict
rejection. Disabled slash command names are matched against the resulting name.

Mods do not run in TUI, ACP, managed/SSH, sandbox or session-agent entry points in
this version. Safe mode, bare mode and `disableAllHooks` also prevent loading.
Restart after changing plugin code, options or extension activation. An already loaded
command checks activation again before execution and refuses a disabled plugin.
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
between Mods; ordinary providers are not registration nodes. Each still has a separate
realm and its own command handlers; ordering does not yet provide cross-plugin
event wrapping or shared capabilities.

Missing, ambiguous, incompatible or cyclic dependencies reject startup before
any Mod worker starts. Invalid Mod options also reject startup. This differs
from Claude's selective dependency demotion and cycle-order fallback; Qwen
retains the experimental subset's whole-session startup failure policy.

## Resource limits

The reader accepts regular files up to 256 KiB inside the installed extension and
rejects symbolic links within that root. Graphs are limited to 64 files, 1 MiB
of input and 1 MiB of compiled code. These bounds and symlink rejection are
stricter than Claude's. Each guest has a 64 MiB memory limit,
1 MiB stack limit and a 10-second dispatch budget. Startup allows 30 seconds for
worker initialization and compilation; the guest memory limit does not cover
the compiler's host memory. All session-end hooks share a 1.5-second shutdown budget.

The author API is based on Claude Code 2.1.296 declarations and the
[official Mod documentation](https://code.claude.com/docs/en/plugins/mods/create).
