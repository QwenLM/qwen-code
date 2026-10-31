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
   - If `~/.qwen` exists and the XDG directory contains the marker file `.qwen-global-dir`, use the XDG directory.
   - Otherwise use `~/.qwen`.

## Decisions

- When both locations exist, a marker file decides between them, not whether a directory exists. The CLI writes `.qwen-global-dir` into the XDG directory whenever it uses that directory as the default global directory and the marker is missing. Every entry point does this right after reading the home `.env`: the main CLI before it parses arguments, so subcommands, bare mode, usage statistics off and the host side of a sandboxed run are covered, the `mcp` and `memory` fast paths, and `qwen serve`. It never writes the marker while `QWEN_HOME` is set, so pointing `QWEN_HOME` at `~/.config/qwen` for one run does not make that directory the default. A sandbox child always runs with `QWEN_HOME` set. The name is specific enough that an unrelated program's `~/.config/qwen` will not contain it.
- Every component that resolves the default on its own applies the same rule, just as they already share the `QWEN_HOME` rule:
  - core `Storage`;
  - the CLI's lightweight settings resolver and the serve runtime-directory fallback;
  - the launcher (managed-update root and `.env` pre-read);
  - the VS Code companion (IDE lock files);
  - channels base;
  - the SDK peer registry;
  - the bundled `/stuck` skill's shell preamble.
- `XDG_CONFIG_HOME`, `HOME` and `USERPROFILE` are read only from the environment Qwen Code starts with. `QWEN_HOME` can also come from the global directory's `.env` and `~/.env`, which are read before the global directory is resolved. No `.env` file loaded later, and no `env` section in `settings.json`, can set any of the four, including a `~/.qwen/.env` left behind on an XDG install, because a later value would split settings and credentials across two directories.
- Code that derived the home directory as the parent of the global directory now uses the home directory directly, so `~/.env` remains the home-level `.env`.
- Auto mode's self-modification guard protects the resolved global directory, so `~/.config/qwen/settings.json` and its `hooks/` and `skills/` keep the protection that `~/.qwen/...` gets from the path patterns. This also covers a `QWEN_HOME` written as `~/...`. On Linux it protects the XDG directory and its marker even while `~/.qwen` is in use, because writing the marker there makes the XDG directory the global directory on the next start.
- The opt-in diagnostics (startup and CPU profiles, heap snapshots) write under the global directory, so they no longer create `~/.qwen` on an XDG install.

## Alternatives considered

- Keep `~/.qwen` whenever it exists, otherwise use XDG (the rule proposed in the issue). Several things recreate `~/.qwen`: the Live discovery rendezvous and an older CLI bundled with the VS Code companion. Any of them would move a new XDG install back to a nearly empty `~/.qwen`, which looks like lost settings and credentials.
- Prefer the XDG directory whenever it exists. An unrelated `~/.config/qwen` would then silently take over an existing `~/.qwen`.
- Use files Qwen Code already writes on first run (`installation_id`, `output-language.md`) as the markers. Both are conditional: `installation_id` is skipped when usage statistics are off and `output-language.md` in bare mode, so such a first run leaves no marker. Both are also written under `QWEN_HOME`, so a redirected run would claim the directory it was pointed at.
- Split configuration, data and state across `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `XDG_STATE_HOME`. That touches every runtime path and is left for a follow-up; `QWEN_RUNTIME_DIR` already separates runtime output.
- Use XDG on macOS as well. Nobody asked for it, so macOS keeps `~/.qwen`.

## Compatibility and migration

- Existing installs keep using `~/.qwen`, with nothing to migrate.
- New Linux installs use `~/.config/qwen`.
- To move an existing install on Linux, run:

  ```sh
  dest="${XDG_CONFIG_HOME:-$HOME/.config}/qwen"
  if uname -s | grep -qE '^(Darwin|MINGW|MSYS|CYGWIN)'; then
    echo "macOS and Windows keep using ~/.qwen" >&2; false
  elif [ -n "${QWEN_HOME:-}" ]; then
    echo "unset QWEN_HOME first" >&2; false
  elif [ -z "${HOME:-}" ]; then
    echo "HOME is not set" >&2; false
  elif [ "${dest#/}" = "$dest" ]; then
    echo "XDG_CONFIG_HOME must be unset or absolute" >&2; false
  elif [ -e "$dest" ]; then
    echo "$dest already exists; merge it with ~/.qwen by hand" >&2; false
  elif [ ! -d "$HOME/.qwen" ]; then
    echo "there is no ~/.qwen to move" >&2; false
  else
    mkdir -p "$(dirname "$dest")" && mv "$HOME/.qwen" "$dest" &&
      touch "$dest/.qwen-global-dir"
  fi
  ```

  It writes the marker after the move, so a `~/.qwen` recreated before the next start cannot take the install back. It changes nothing and says why on macOS and Windows, with `QWEN_HOME` set or `HOME` unset, with a relative `XDG_CONFIG_HOME`, when there is no `~/.qwen`, or when the destination already exists; in that last case, merge the two directories by hand. A copy that leaves `~/.qwen` in place keeps using `~/.qwen`. While both directories exist, deleting `.qwen-global-dir` from the XDG directory makes Qwen Code use `~/.qwen` again.

- To keep `~/.qwen` on a new machine, set `QWEN_HOME=~/.qwen` or create `~/.qwen` before the first run. The standalone installer does the latter when given `--source`, because it writes `~/.qwen/source.json`.
- A custom `XDG_CONFIG_HOME` applies only where it is set. A launch context without it, such as a desktop launcher, a systemd user service or cron, resolves `~/.config/qwen` and, when there is no `~/.qwen`, uses it as a separate install. The marker rule only protects `~/.qwen`. Set it where every launch context reads it, such as a systemd `environment.d` file or `/etc/environment`, not only in a shell profile.
- A `~/.qwen` that is a dangling symlink counts as missing, as `existsSync` reports it. No marker is written while it is there, so once its target is back, such as a volume that was not mounted yet, `~/.qwen` is used again.
- On Linux, resolving the default costs one or two `existsSync` calls when `QWEN_HOME` is unset, on every call, about 3 µs for two on macOS. The result is not cached, because the home `.env` can set `QWEN_HOME` after the first resolution and the VS Code companion re-probes on purpose.
- Tests that faked the home directory, or mocked `node:fs` without `existsSync`, now pin `QWEN_HOME`, because Linux CI runs with an empty `HOME`.

## Out of scope

- Automatic migration of `~/.qwen`.
- Splitting configuration, data and state into separate XDG directories, the other half of #1210.
- Prompt texts, setting descriptions and documentation that still say `~/.qwen` literally, as they already do under `QWEN_HOME`. This includes the `settingsSchema.ts` descriptions behind the published VS Code schema and the `Saved in at ~/.qwen/settings.json` string in nine locales; fixing them means interpolating the resolved path and migrating the keys, tracked in #15628.
- The Live discovery rendezvous, which still uses `~/.qwen`.
- The repository's own development scripts (sandbox command lookup, telemetry and their home `.env` bootstrap), which still read `~/.qwen`. On a new Linux install they do not see `~/.config/qwen`: a sandbox configured only there is not picked up by the build and start scripts, and `npm run telemetry` reads its settings and output from `~/.qwen`.

## Acceptance criteria

- On Linux with an empty home, the first run creates `~/.config/qwen` with the marker and no `~/.qwen`, whether it is the interactive CLI, a subcommand, `qwen serve` or a sandboxed run, also in bare mode with usage statistics off.
- With only `~/.qwen`, it keeps being used.
- With `~/.qwen` and a `~/.config/qwen` that has no marker, `~/.qwen` is used, including after a run with `QWEN_HOME` pointing at `~/.config/qwen`.
- With `~/.qwen` and a `~/.config/qwen` that contains the marker, the XDG directory is used. This includes a `~/.qwen` recreated after a first run in the XDG directory.
- An absolute `XDG_CONFIG_HOME` is honored, a relative one is ignored, a value from a `.env` file is ignored, and `QWEN_HOME` overrides everything. A `QWEN_HOME` in a `~/.qwen/.env` left behind on an XDG install is ignored.
- macOS and Windows use `~/.qwen` even when `~/.config/qwen` exists.
- The product's independent resolvers listed under Decisions agree, and auto mode protects the global directory's settings, hooks and skills in either location, plus the XDG directory and its marker while `~/.qwen` is in use.
