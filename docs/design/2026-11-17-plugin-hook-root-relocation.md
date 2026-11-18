# Plugin hook-root relocation

[English](2026-11-17-plugin-hook-root-relocation.md) | [简体中文](2026-11-17-plugin-hook-root-relocation.zh-CN.md)

## Status and problem

Implemented and locally verified on Darwin arm64 with Node 24 and Ink. Core Tier 2 maintainer review is required before acceptance. This change does not establish release readiness.

File-based plugin hooks previously expanded `${CLAUDE_PLUGIN_ROOT}` to a temporary conversion directory. After installation removed that directory, the persisted command still referenced it even though the installed script existed. A real public installation recorded a SessionEnd subprocess failure with `MODULE_NOT_FOUND` at the deleted temporary path. The targeted regression also reproduced the premature expansion. The larger public attempt had an unrelated UI failure and is not a whole-case pass.

The actual global `qwen` 0.22.0 baseline completed two natural exits without model requests, but produced no qualified cold Shell receipt and no concrete hook error. That result remains not qualified; it neither disproves nor independently reproduces the newer installation failure.

## Contract

Keep `${CLAUDE_PLUGIN_ROOT}` in file-hook commands and the converted manifest until installed loading expands it against the effective extension root, matching inline hooks. The converter now stores the parsed hooks directly. It does not change arbitrary literal absolute commands, inline hooks, matchers, options or resource contents and permissions. Absolute hook-file declarations, traversal and symlink escapes remain rejected by the existing guards.

## Compatibility and regression

The shared builder serves Claude marketplace plugins, standalone plugins and Qoder conversion. Their output flows through compatible-extension conversion into extension installation/update preparation and GitHub update checks. The installed extension manager expands hook variables using the effective extension path; the hook registry then consumes active extension hooks, and the hook runner executes their commands. Mod fixtures also consume converted resources. Public defining-module exports may have unknown external consumers, so maintainers must approve the change in expansion timing.

Upgrading does not repair an extension installed by a pre-fix build: loading only parses and hydrates the persisted manifest, no `${CLAUDE_PLUGIN_ROOT}` token is left in it to match, and nothing re-converts an installed extension at startup. Such an install must be updated once (`qwen extensions update <name>`) or reinstalled, because loading never rewrites a persisted absolute command.

The updated file-hook regression requires a literal token, an identical serialized hooks object, and a loaded command that reads the installed script after the converted tree is copied to an installed root and the conversion directory is deleted. Both Mod resource variants retain their content assertions after explicit expansion through the existing helper. Security refusal coverage is retained. No new loader, hook API, path rewrite policy or execution flag is introduced.

## Validation and acceptance

Run targeted RED/GREEN and the affected converter, Qoder, variables, extension-manager and hook-loading contracts, followed by build, type checking, lint and formatting. Rebind the public cold-load case to the new artifact: immutable Git publisher, actual installed script, qualified Shell executable/PID/birth/argv/cwd witness, zero model requests, unchanged budgets and two natural exits. Keep observer failures and missing receipts separate from concrete subprocess errors.

Acceptance requires tokens before loading, expansion at the installed root, and real execution after the temporary clone is deleted, with inline/Mod behavior and security refusals preserved. The public A-only Git installation now passes: hot and cold exits are natural, and each produces a qualified Bash receipt whose command references the installed script after temporary-clone cleanup. Build, type checking, affected unit contracts, lint and formatting pass. Native signals, other hook events, all Source flows, platforms and long-term stability remain outside this result.
