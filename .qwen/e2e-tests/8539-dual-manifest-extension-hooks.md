# Dual-manifest extension hooks reviewer plan

## Scope

Verify a trusted test extension containing `gemini-extension.json`, `.claude-plugin/plugin.json`, a Claude hooks file, `AGENTS.md`, and a Gemini TOML slash command. Do not run third-party Ponytail hook code for this review.

## How to verify

1. Build Qwen Code from this branch.
2. Create a local fixture extension whose Gemini manifest declares `contextFileName: "AGENTS.md"`, whose Claude manifest points to a hooks JSON file, and whose `commands/` directory contains a valid TOML command.
3. Make the fixture's `SessionStart` hook write a fixed marker to a temporary test directory. Install the fixture once as a standalone extension and once through a local Claude marketplace entry.
4. Remove or move the original fixture source after installation, then start a fresh session for each installed form.
5. Confirm the marker is written by the hook from the installed extension path, the `AGENTS.md` instruction is present in the session context, and the converted slash command is listed and can be invoked.
6. Uninstall both fixture extensions and remove the temporary marker directory.

## Expected result

Both install forms retain the Gemini context and TOML command while registering the Claude hook. The hook command resolves `${CLAUDE_PLUGIN_ROOT}` to the final installed extension directory and does not depend on the original source or conversion directory.
