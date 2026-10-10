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
| Packaging  | One self-contained `.js` or `.mjs` ESM module; canonical or custom hooks file inside the installed plugin                                                                  |
| Entry      | `register(on, options)`; async registration is awaited; options is empty                                                                                                   |
| Lifecycle  | `session.start` before the first prompt; `session.end` on exit and conversation replacement; clear/resume do not reload the module                                         |
| Commands   | Register during `session.start` using name, description and optional argumentHint; exact `command.run` matcher for the plugin's own command; return `{text}` or `{}`       |
| Middleware | Explicit `next(e)` and repeated calls; event input is frozen; host identity fields cannot change                                                                           |
| Logging    | Synchronous `$.ui.log`; transcript logs use stderr in text mode or `system/ui_log` in JSON modes; debug-only logs stay in the debug logger; logs do not become model input |
| Isolation  | Separate QuickJS environment per plugin; no Node, filesystem or network APIs; memory, stack, source/output and execution limits; cancellable worker                        |

This is a supported subset, not full compatibility with existing Claude Mods.
Imports, TypeScript, userConfig, dependencies, wildcard/nested matchers,
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
Restart after changing plugin code or extension activation. An already loaded
command checks activation again before execution and refuses a disabled plugin.
Native Qwen extensions with an absolute or external hooks manifest path continue
to use only the classic hook loader; Mod manifests must be relative paths inside
the extension.

The reader accepts regular files up to 256 KiB inside the installed extension and
rejects symbolic links within that root. Each guest has a 64 MiB memory limit,
1 MiB stack limit and a 10-second dispatch budget. Startup allows 30 seconds for
worker initialization. All session-end hooks share a 1.5-second shutdown budget.

The author API is based on Claude Code 2.1.296 declarations and the
[official Mod documentation](https://code.claude.com/docs/en/plugins/mods/create).
