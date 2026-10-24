# XDG Base Directory global directory verification

Design: [docs/design/2026-10-24-xdg-base-directory.md](../../docs/design/2026-10-24-xdg-base-directory.md)

Run every step with a throwaway home, so the operator's real configuration is never read or written:

```bash
export HOME=$(mktemp -d)
unset QWEN_HOME XDG_CONFIG_HOME
```

`qwen -p "say hi"` without credentials is enough. The run performs first-run setup and then stops at "No auth type is selected", so no model is called.

## Test groups

### New install on Linux

Run `qwen -p "say hi"` in an empty home. Expect `~/.config/qwen` to contain `installation_id` and `output-language.md`, and no `~/.qwen`.

### Existing install on Linux

Create `~/.qwen`, then run the same command. Expect the first-run files under `~/.qwen` and no `~/.config/qwen/installation_id`.

### Unrelated ~/.config/qwen

Create `~/.qwen` and `~/.config/qwen/settings.json` containing `{}`, then run the command. Expect `~/.qwen` to stay in use and `~/.config/qwen` to be left untouched.

### ~/.qwen recreated after an XDG install

After the new-install run, `mkdir ~/.qwen` and run the command again. Expect `~/.config/qwen` to stay in use.

### Overrides

- `XDG_CONFIG_HOME=$HOME/xdg`: files appear under `$HOME/xdg/qwen`.
- `XDG_CONFIG_HOME=relative`: the value is ignored and `~/.config/qwen` is used.
- `QWEN_HOME=$HOME/custom`: files appear under `$HOME/custom`, whatever else exists.

### macOS and Windows

Run the new-install step. Expect `~/.qwen`, even if `~/.config/qwen` exists.

## Baseline dry-run

No global `qwen` is installed on the verification machine, so the repository's launcher (`node scripts/cli-entry.js`, 0.26.0) was used on macOS. It ran under `env -i` with a throwaway `HOME`, a throwaway `TMPDIR` and no credentials in the environment:

- `--version` printed `0.26.0` and created nothing under `HOME`.
- `-p "say hi"` stopped at "No auth type is selected". It created `~/.qwen` with `installation_id`, `output-language.md`, `extension-store/`, `extensions/` and `skills/`.
- The same run with `QWEN_USAGE_STATISTICS_ENABLED=false` created everything except `installation_id`.

This is why both `installation_id` and `output-language.md` count as markers.

## Local verification

All runs used a throwaway `HOME` with `QWEN_HOME` and `XDG_CONFIG_HOME` unset.

- `cd packages/core && npx vitest run src/config/storage.test.ts src/permissions/autoMode.test.ts` and the other suites that read the global directory: 16 files passed.
- `cd packages/cli && npx vitest run src/config/storage-paths-lite.test.ts src/config/settings.test.ts src/config/path-freshness.test.ts src/serve/fast-path.test.ts` and related suites: 9 files passed.
- `cd packages/vscode-ide-companion && npx vitest run src/utils/paths.test.ts src/ide-server.test.ts`: passed.
- `cd packages/channels/base && npx vitest run src/paths.test.ts`: passed.
- `cd packages/sdk-typescript && npx vitest run test/unit/peer/registry.test.ts`: passed.
- `npx vitest run --config ./scripts/tests/vitest.config.ts scripts/tests/cli-entry.test.js`: passed.
- Linux simulation: with the macOS exemption temporarily disabled in every resolver and `dist/` rebuilt, the same suites passed under an empty `HOME`. The only failures were the cases that assert macOS keeps `~/.qwen`, which the simulation disables by design.

## Not run

The test groups above were not executed on Linux or Windows. No machine for either was available, and no container runtime was running. The Linux rules are covered by unit tests that stub the platform, plus the simulated run described above.
