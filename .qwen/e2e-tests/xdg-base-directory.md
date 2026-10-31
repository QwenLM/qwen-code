# XDG Base Directory global directory verification

Design: [docs/design/2026-10-24-xdg-base-directory.md](../../docs/design/2026-10-24-xdg-base-directory.md)

Start every group from a fresh throwaway home, so the operator's real configuration is never read or written and no group sees another group's files. Two groups continue in the new-install group's home on purpose, because they need the marker its run wrote: the recreated `~/.qwen` group and the `~/.qwen/.env` group.

```bash
export HOME=$(mktemp -d)
unset QWEN_HOME XDG_CONFIG_HOME QWEN_USAGE_STATISTICS_ENABLED QWEN_CODE_SIMPLE
```

On Windows, Node reads the home directory from `USERPROFILE`, not `HOME`, so also set `export USERPROFILE="$HOME"` (and `HOMEDRIVE`/`HOMEPATH` for cmd or PowerShell), or use a throwaway user account. Otherwise the run reads and writes the real profile.

`qwen -p "say hi"` without credentials is enough. The run performs first-run setup and then stops at "No auth type is selected", so no model is called.

## Test groups

### New install on Linux

Run `qwen -p "say hi"` in an empty home. Expect `~/.config/qwen` to contain `.qwen-global-dir`, `installation_id` and `output-language.md`, and no `~/.qwen`.

### New install in bare mode with usage statistics off

Run `QWEN_USAGE_STATISTICS_ENABLED=false qwen --bare -p "say hi"` in an empty home. Expect `~/.config/qwen/.qwen-global-dir` even though neither `installation_id` nor `output-language.md` is written. Then `mkdir ~/.qwen` and run `qwen -p "say hi"`: expect `~/.config/qwen` to stay in use.

### Existing install on Linux

Create `~/.qwen`, then run the same command. Expect the first-run files under `~/.qwen`, and no `~/.config/qwen/.qwen-global-dir`.

### Unrelated ~/.config/qwen

Create `~/.qwen` and `~/.config/qwen/settings.json` containing `{}`, then run the command. Expect `~/.qwen` to stay in use and `~/.config/qwen` to be left untouched.

### ~/.qwen recreated after an XDG install

In the new-install group's home, `mkdir ~/.qwen` and run the command again. Expect `~/.config/qwen` to stay in use.

### Other entry points on a new install

Each in its own fresh home: run `qwen mcp list`, and start `qwen serve --port 0` and stop it once it prints its listening line. Expect `~/.config/qwen/.qwen-global-dir` after each. `qwen --version` and `qwen --help` still create nothing under `HOME`.

### A ~/.qwen/.env left behind on an XDG install

In the new-install group's home, run `printf 'QWEN_HOME=%s/legacy\nDEMO_VAR=1\n' "$HOME" > ~/.qwen/.env` after `mkdir ~/.qwen`, so the file holds an absolute path (`.env` values are not shell-expanded), then run the command. Expect `~/.config/qwen` to stay in use, no `$HOME/legacy`, and a warning that names `~/.qwen/.env` and `QWEN_HOME`.

### Custom XDG_CONFIG_HOME with a recreated ~/.qwen

In a fresh home, run the command with `XDG_CONFIG_HOME=$HOME/xdg`. Expect `$HOME/xdg/qwen/.qwen-global-dir`. Then `mkdir ~/.qwen` and run it again with the same `XDG_CONFIG_HOME`: expect `$HOME/xdg/qwen` to stay in use.

### Moving an existing install

Create `~/.qwen` with a `settings.json`, then run the migration command from the design note. Expect `~/.config/qwen/settings.json` and `~/.config/qwen/.qwen-global-dir`, and no `~/.qwen`. With `XDG_CONFIG_HOME=relative`, with `QWEN_HOME` set, on macOS, or when run a second time, it must print why and leave everything in place.

### QWEN_HOME pointed at the XDG directory

Create `~/.qwen`, run `QWEN_HOME=$HOME/.config/qwen qwen -p "say hi"`, then run `qwen -p "say hi"` without it. Expect the second run to use `~/.qwen`, and no `~/.config/qwen/.qwen-global-dir`.

### Overrides

Each in its own fresh home, with no `~/.qwen`:

- `XDG_CONFIG_HOME=$HOME/xdg`: files appear under `$HOME/xdg/qwen`.
- `XDG_CONFIG_HOME=relative`: the value is ignored and `~/.config/qwen` is used.
- `XDG_CONFIG_HOME=$HOME/xdg` written to `~/.env` instead of the environment: the value is ignored and `~/.config/qwen` is used.
- `QWEN_HOME=$HOME/custom`: files appear under `$HOME/custom`, whatever else exists.

### macOS and Windows

Run the new-install step. Expect `~/.qwen`, even if `~/.config/qwen` exists.

## Baseline dry-run

No global `qwen` is installed on the verification machine, so the repository's launcher (`node scripts/cli-entry.js`, 0.26.0) was used on macOS. It ran under `env -i` with a throwaway `HOME`, a throwaway `TMPDIR` and no credentials in the environment:

- `--version` printed `0.26.0` and created nothing under `HOME`.
- `-p "say hi"` stopped at "No auth type is selected". It created `~/.qwen` with `installation_id`, `output-language.md`, `extension-store/`, `extensions/` and `skills/`.
- The same run with `QWEN_USAGE_STATISTICS_ENABLED=false` created everything except `installation_id`.

That is why neither file can serve as the marker: each is skipped by one of those switches, and a first run with both switches writes neither. The CLI writes `.qwen-global-dir` instead.

## Local verification

All runs used a throwaway `HOME` with `QWEN_HOME` and `XDG_CONFIG_HOME` unset.

- `cd packages/core && npx vitest run src/config/storage.test.ts src/permissions/autoMode.test.ts src/skills/bundled/stuck/SKILL.test.ts` and the other suites that read the global directory.
- `cd packages/cli && npx vitest run src/cli.test.ts src/llm.test.tsx src/config/storage-paths-lite.test.ts src/config/shared-env-keys.test.ts src/config/environment.test.ts src/config/settings.test.ts src/config/path-freshness.test.ts src/serve/fast-path.test.ts src/serve/run-qwen-serve.test.ts` and the profiler suites.
- `cd packages/vscode-ide-companion && npx vitest run src/utils/paths.test.ts src/ide-server.test.ts`.
- `cd packages/channels/base && npx vitest run src/paths.test.ts`.
- `cd packages/sdk-typescript && npx vitest run test/unit/peer/registry.test.ts`.
- `npx vitest run --config ./scripts/tests/vitest.config.ts scripts/tests/cli-entry.test.js scripts/tests/global-dir-marker.test.js scripts/tests/xdg-migration-command.test.js`.
- Linux simulation: with the macOS exemption temporarily disabled in every resolver and `dist/` rebuilt, the same suites passed under a throwaway `HOME`. The only failures were the cases that assert macOS keeps `~/.qwen`, which the simulation disables by design.

## Not run

The test groups above were not executed on Linux or Windows. No machine for either was available, and no container runtime was running. The Linux rules are covered by unit tests that stub the platform, plus the simulated run described above.
