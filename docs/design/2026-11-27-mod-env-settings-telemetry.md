# Mod reads of the environment and settings, and telemetry

[English](2026-11-27-mod-env-settings-telemetry.md) | [简体中文](2026-11-27-mod-env-settings-telemetry.zh-CN.md)

Status: proposed. Tracked in #13749. This follows the Claude Code 2.1.332 plugin API declarations, and continues [Mods written for Claude Code 2.1.332](2026-11-26-mod-claude-code-2-1-332-shapes.md).

## Problem and current behavior

Many Mods begin by reading where they run. They check the terminal or the CI through `$.env.get`, read a setting through `$.settings.read`, and mark how a feature went through `$.telemetry.log` and `$.telemetry.mark`. Qwen Code has none of these methods. Each call throws `Mod API not supported`, so the hook that makes it fails, and with it whatever the Mod draws or answers. [Baseline](#baseline) records what was observed.

A command's `presentation` also lacks `isColorless`, which tells a Mod to leave escape codes out of its answer.

## Goals and non-goals

Goals:

- `$.env.get`, `$.settings.read`, `$.telemetry.log` and `$.telemetry.mark` answer in their contract shapes, in every host that runs Mods, and pass through other plugins' hooks as API events.
- A Mod cannot read the session's credentials through them.
- `presentation.isColorless` is present where the terminal shows no color.

Non-goals:

- `$.env.set`. It changes what every later child process inherits, which goes with the file and process slice.
- Sending telemetry anywhere.
- Letting a hook change the settings the session runs under.

## Compatibility contract

These follow the 2.1.332 declarations.

1. **`$.env.get(name)`** resolves to the variable's value, or `undefined` when it is unset. Its event `env.get` carries `{ name }`, which is pinned. Its answer is `{ value }`, a string or `undefined`, or `{ deny }`.
2. **`$.settings.read(args?)`**:
   - With no arguments, it resolves to the settings merged over every source.
   - With `{ source }`, it resolves to that one source's settings as loaded. A source with no settings answers `{}`.
   - With `{ key }`, and optionally `source`, it resolves to that top-level key of the object, or `undefined`. It is the object's read, projected, and raises no event of its own.
   - The sources are `user`, `project`, `local`, `flag` and `policy`, lowest precedence first.
   - Its event `settings.read` carries `{ source?, layers }`. `layers` lists `{ source, settings }` for each source that holds settings, lowest precedence first; for a source read it holds that source's layer alone.
   - `source` and `layers` belong to the host: a `layers` a caller passes is replaced, and a hook that changes either is skipped.
   - The answer is `{ value }`, a settings object, or `{ deny }`.
3. **`$.telemetry.log(entry)`**:
   - The entry is a first-party row `{ to?: 'anthropic', event, props? }`, or a collector record `{ to: 'collector', event, attributes, loggedAt, span? }`.
   - A row that leaves `to` out reads as `anthropic` before any hook sees it.
   - A property is a number, a boolean, or `{ value, of }` with `value` one of `of`.
   - An attribute is a string, a number, a boolean or a list of strings.
   - `to` is pinned. The answer is `{ value: undefined }` or `{ deny }`.
4. **`$.telemetry.mark(entry)`** takes `{ feature, kind, reason?, props? }`, with `kind` one of `ok`, `sad` and `bad`. The answer is the same as `telemetry.log`'s.
5. **Both telemetry calls** resolve to `undefined` once the hooks have answered, and reject when one denies.
6. **`CommandPresentation.isColorless`** is `true` where the terminal shows no color, and absent elsewhere and in headless runs.
7. **`$.session.version().qwen.methods`** lists `env.get` and `settings.read` only where the host answers them, as it lists the store's methods only where the host keeps a store.

## Qwen design decisions

- **Credentials are kept from Mods.** Claude Code passes the environment and the settings through unfiltered. In Qwen Code both hold the model provider's keys, the settings' `apiKey` and MCP servers' tokens. A Mod can send what it reads to the model, into a prompt or into its store, so a Mod that never asks for a credential should not be able to read one. The Mods examined read terminal and CI variables such as `HOME`, `TERM`, `CI` and `TMUX`, and settings such as `enabledPlugins` and the policy source; none reads a credential. Hiding credentials therefore breaks none of them. The rules:
  - A variable or settings key is a credential by its name. Its words, split at `_`, `-` and camelCase, include `TOKEN`, `SECRET`, `API_KEY`, `ACCESS_KEY`, `PRIVATE_KEY`, `CREDENTIAL`, `PASSWORD`, `PASSPHRASE`, `AUTHORIZATION`, `DSN` or `CONNECTION_STRING` (the full list is the rule the daemon already uses to redact worker diagnostics, now shared).
  - A variable counts as a credential if any settings source names it in `envKey`, `credentialEnv` or `apiKeyEnv`, or references it in a credential field such as `security.auth.apiKey`.
  - A variable referenced by an MCP server's HTTP header also counts as a credential, regardless of the header name.
  - `$.env.get` answers `undefined` for a credential or for a variable whose value contains a recognized credential of at least four characters, including values copied through settings aliases. A variable that is unset gives the same answer.
  - An installed credential alias stays hidden until its environment value changes, including across settings-only reloads, CLI relaunches, and when the daemon passes its workspace environment to an ACP child.
  - `$.settings.read` leaves out every string under a credential's key at any depth, including those variables in the top-level `env`. It also leaves out each MCP server's `env` and `headers` whole, because their names follow no rule.
  - Settings resolve `$VAR` and `${VAR}` as they load, so a credential's value can sit under an ordinary key, such as a command or an MCP server's `args`. `$.settings.read` therefore also leaves out every string, at any depth, that contains the value of a hidden variable (four characters or longer). The host checks both the current environment and the values used during expansion, which can differ after loading a workspace environment or reloading a scope.
  - Only strings are left out. A number or a flag under such a name, such as `model.sessionTokenLimit`, is a limit and not a secret.
- **Sources map onto Qwen Code's scopes.**
  - `user` is `~/.qwen/settings.json`.
  - `project` is the workspace's `.qwen/settings.json`, left out where the folder is not trusted, since those settings do not apply there.
  - `policy` is the system settings file, which overrides every other scope as managed policy does.
  - `local` and `flag` have no counterpart and answer `{}`.
  - The system defaults file is the lowest scope but names no source a Mod knows. It counts in the merge and is not a layer.
  - The merge is the one the session runs under, not a fold a Mod could recompute from the layers: Qwen Code's merge strips a workspace's restricted settings and merges some keys by their own rules.
- **A hook's answer reaches the caller only.** Claude Code also raises `settings.read` for its own merge, so a hook can rewrite the settings the engine runs under. Qwen Code raises it only for a Mod's call. Letting a sandboxed plugin change permissions, providers or MCP servers is a larger decision than reading them, and no Mod examined needs it.
- **Telemetry is logged, not sent.** Qwen Code has no first-party row for a plugin, and an operator's collector receives only what Qwen Code itself records. Both calls validate the entry, run the hooks, then write the entry to the debug log as `telemetry.log (not sent): …` or `telemetry.mark (not sent): …`. A Mod author sees what their Mod would report. The 100,000-character budget is shared with `$.ui.log`. Telemetry calls are still accepted when their entry exceeds the remaining budget. Only entries written to the debug log consume it.
- **No literal-name check for `env.get`.** Claude Code requires the name to be a string literal so its validator can list what a module reads. Qwen Code has no such validator. Credentials are kept back by the rules above, which do not depend on reading the module's source.
- **`isColorless` follows `NO_COLOR`.** Both terminal UIs drop color when `NO_COLOR` is set, and Qwen Code has no `--no-color` flag. The terminal reads the variable as each command runs, so the field follows the environment the command sees.
- **A completion at a usage limit fails at once, as it already does.** A Mod waiting on a retry it cannot cancel would hold its hook for nothing. Qwen Code already sends a Mod's completion once, without retrying, and answers a quota error with `{ isAnswered: false, reason: 'api-error', error: 'billing_error' }`, as the declarations describe. An existing unit test covers the quota case.

## Host interface

The worker asks the host for each read and never sees the environment or the settings files itself. That keeps the credential rules on the host side and makes the reads replaceable by any host.

- `ModRuntime.createGroup` takes a `reads` host:
  - `env(name)` returns a string or `undefined`;
  - `settings()` returns `{ layers, merged }`, with each layer `{ source, settings }`.
- Without a `reads` host, `env.get` and `settings.read` reject with `This host gives Mods no environment or settings.`, are missing from `$.session.version()`, and their hooks are skipped.
- The worker posts `{ type: 'read', id, read }` and the runtime answers `{ type: 'read-result', id, value?, error? }`. A value too large for a host message fails the call, not the session.
- A settings read can include a validated source. The runtime sends only that layer for a scoped read, including an empty layer list for a source with no settings.
- The CLI's host applies the credential rules to `process.env` and to the session's loaded settings. A future Harness host provides the same two functions from its own environment and settings.
- Telemetry and `isColorless` need nothing new from the host: telemetry writes through the existing log channel, and `isColorless` rides on the `presentation` the terminal already passes.

## Baseline

Observed with Qwen Code 0.27.4, the global CLI, with an isolated `HOME` and a Mod command that calls each method:

| Call                                                                         | Observed                                                     |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `$.env.get('HOME')`, `$.env.get('OPENAI_API_KEY')`                           | Throws `Mod API not supported: $.env.get`.                   |
| `$.settings.read({ key: 'general' })`, `$.settings.read({ source: 'user' })` | Throws `Mod API not supported: $.settings.read`.             |
| `$.telemetry.log({ event, props })`, `$.telemetry.mark({ feature, kind })`   | Throws `Mod API not supported: $.telemetry.log` and `.mark`. |

## Validation and acceptance

- Unit tests:
  - each method's answer and its pass through another plugin's hooks;
  - a hook that changes `name` or `layers` is skipped;
  - an unknown source, a key that is not a string, and a telemetry entry with free text are refused;
  - telemetry reaches the debug log only, and a deny rejects the call;
  - a host with no reads refuses both calls and does not list them;
  - the CLI host's credential rules for variables and aliases, settings keys, `env`, provider-named variables, MCP `env` and `headers`, a string holding a resolved credential even after the environment changes, and an untrusted folder;
  - `isColorless` under `NO_COLOR`.
- An integration test (`integration-tests/cli/mods-env-settings-telemetry.test.ts`) installs a Mod fixture on the built CLI. Its command reads `HOME`, a credential variable, the settings and one source, and logs telemetry. The test checks the answers, that no credential appears in the output, and that the run sends no model request.

## Risks and open questions

- The rules can hide what is not a credential: `SESSION_TOKEN_LIMIT` read as a string, or a setting that happens to contain a hidden variable's value. A Mod that needs a hidden variable has no way around them yet.
- The rules miss a credential written literally under an ordinary key, with no variable behind it: a token typed into an MCP server's `args` or `url`, or a proxy URL with a password in it. They also miss one in a variable whose name follows no rule, such as `GITHUB_PAT` used outside MCP settings. Naming that variable in a settings `envKey` closes the second case; the first is the settings file's own content and stays readable.
- `local` and `flag` reading as `{}` may surprise a Mod that expects a source it knows from Claude Code. Qwen Code has no such files.
