# XDG Base Directory for the global directory on Linux

[English](2026-10-24-xdg-base-directory.md) | [简体中文](2026-10-24-xdg-base-directory.zh-CN.md)

## Problem and scope

Qwen Code keeps settings, credentials and other global state in `~/.qwen` on every platform. On Linux, the XDG Base Directory specification expects configuration under `$XDG_CONFIG_HOME` (default `~/.config`), and issue #1210 asks Qwen Code to follow it. Existing installs must keep working without a migration step, and macOS and Windows must not change.

This change moves only the default location of the global directory. `QWEN_HOME`, `QWEN_RUNTIME_DIR` and project-level `.qwen/` directories keep their meaning.

## Resolution order

1. `QWEN_HOME`, when set.
2. On macOS and Windows, `~/.qwen`.
3. On Linux and other XDG platforms, the XDG directory is `$XDG_CONFIG_HOME/qwen` when `XDG_CONFIG_HOME` is an absolute path, and `~/.config/qwen` otherwise. The specification says a relative value is invalid and must be ignored.
   - If `~/.qwen` does not exist, use the XDG directory (a new install).
   - If `~/.qwen` exists and the XDG directory contains `installation_id` or `output-language.md`, use the XDG directory.
   - Otherwise use `~/.qwen`.

## Decisions

- When both locations exist, Qwen Code-specific marker files decide between them, not whether a directory exists. `installation_id` is written on first run unless usage statistics are off, and `output-language.md` is written on every CLI start except in bare mode. Both names are specific enough that an unrelated program's `~/.config/qwen` will not contain them.
- Every component that resolves the default on its own applies the same rule, just as they already share the `QWEN_HOME` rule:
  - core `Storage`;
  - the CLI's lightweight settings resolver and the serve runtime-directory fallback;
  - the launcher (managed-update root and `.env` pre-read);
  - the VS Code companion (IDE lock files);
  - channels base;
  - the SDK peer registry.
- Code that derived the home directory as the parent of the global directory now uses the home directory directly, so `~/.env` remains the home-level `.env`.
- When `QWEN_HOME` is unset, auto mode's self-modification guard now protects the resolved global directory. Its path patterns only match `.qwen/...`, and `~/.config/qwen` does not match them.

## Alternatives considered

- Keep `~/.qwen` whenever it exists, otherwise use XDG (the rule proposed in the issue). Several things recreate `~/.qwen`: the Live discovery rendezvous, an older CLI bundled with the VS Code companion, and the opt-in profilers. Any of them would move a new XDG install back to a nearly empty `~/.qwen`, which looks like lost settings and credentials.
- Prefer the XDG directory whenever it exists. An unrelated `~/.config/qwen` would then silently take over an existing `~/.qwen`.
- Write a dedicated marker file. That adds a new write path when existing first-run files already serve the purpose.
- Split configuration, data and state across `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `XDG_STATE_HOME`. That touches every runtime path and is left for a follow-up; `QWEN_RUNTIME_DIR` already separates runtime output.
- Use XDG on macOS as well. Nobody asked for it, so macOS keeps `~/.qwen`.

## Compatibility and migration

- Existing installs keep using `~/.qwen`, with nothing to migrate.
- New Linux installs use `~/.config/qwen`.
- To move an existing install, run `mv ~/.qwen "${XDG_CONFIG_HOME:-$HOME/.config}/qwen"`. The moved directory already contains its marker files.
- To keep `~/.qwen` on a new machine, set `QWEN_HOME=~/.qwen` or create `~/.qwen` before the first run.
- On Linux, resolving the default costs one to three `existsSync` calls when `QWEN_HOME` is unset.
- Tests that faked the home directory, or mocked `node:fs` without `existsSync`, now pin `QWEN_HOME`, because Linux CI runs with an empty `HOME`.

## Out of scope

- Automatic migration of `~/.qwen`.
- Prompt texts and documentation that still say `~/.qwen` literally, as they already do under `QWEN_HOME`.
- Opt-in diagnostics (CPU and startup profiles, memory snapshots), the Live discovery rendezvous, and the repository's telemetry and sandbox helper scripts, which still use `~/.qwen`.
- Pre-resolving `XDG_CONFIG_HOME` from a user-level `.env` file, as is done for `QWEN_HOME`. `XDG_CONFIG_HOME` is read from the environment Qwen Code starts with.

## Acceptance criteria

- On Linux with an empty home, the first run creates `~/.config/qwen` and no `~/.qwen`.
- With only `~/.qwen`, it keeps being used.
- With `~/.qwen` and a `~/.config/qwen` that has no marker files, `~/.qwen` is used.
- With `~/.qwen` and a `~/.config/qwen` that contains `installation_id` or `output-language.md`, the XDG directory is used. This includes a `~/.qwen` recreated after a first run in the XDG directory.
- An absolute `XDG_CONFIG_HOME` is honored, a relative one is ignored, and `QWEN_HOME` overrides everything.
- macOS and Windows use `~/.qwen` even when `~/.config/qwen` exists.
- All independent resolvers agree, and auto mode protects the global directory's settings, hooks and skills in either location.
