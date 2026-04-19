# Bare Mode Implementation Plan

**Issue:** `#2996`

**Goal:** Add a `--bare` startup mode for Qwen Code that matches the practical
behavior of Claude Code bare mode: skip implicit startup auto-discovery so CI,
scripts, and other non-interactive callers can start faster and with less
ambient context.

**Reference Behavior:** Claude Code's bare mode and simple-mode path. The
important behavior to preserve is not the exact internal structure, but the
contract: disable implicit startup discovery while still honoring explicit user
input.

## User Contract

When `qwen --bare` is used, startup should:

- skip automatic loading of `output-language.md`
- ignore settings-driven implicit `context.includeDirectories`
- skip implicit home/project/cwd memory discovery
- skip implicit `.qwen/rules/` loading
- skip implicit project and user skill discovery
- skip automatic extension scanning
- skip automatic discovered tool loading

Bare mode must still honor explicit inputs:

- direct CLI flags such as `--prompt`, `--prompt-interactive`, and
  `--include-directories`
- explicit extension overrides such as `-e/--extensions`
- direct process opt-in through `QWEN_CODE_SIMPLE=1`

## Scope

This issue is about startup auto-discovery only. It is not intended to change:

- normal non-bare startup behavior
- runtime command semantics after startup completes
- auth flows beyond the minimum needed to propagate bare mode state
- session resume semantics
- unrelated UI copy or documentation outside this plan

## Design Summary

### 1. Add a shared bare-mode primitive

Create a small core utility that resolves bare mode from:

- the CLI flag `--bare`
- the environment variable `QWEN_CODE_SIMPLE`

This gives one canonical startup decision point instead of duplicating checks in
CLI and core code.

### 2. Wire the CLI flag into config creation

CLI parsing must expose `bare` as a boolean argument.

`loadCliConfig(...)` must derive a single `bareMode` boolean and use it to:

- suppress automatic `output-language.md` loading
- remove implicit settings-based include directories
- pass `bareMode` into the core `Config`

### 3. Propagate bare mode through startup

Startup code should set `QWEN_CODE_SIMPLE=1` when `--bare` is provided so
subsequent startup paths see the same mode.

The CLI entry should also avoid early output-language initialization in bare
mode.

### 4. Gate implicit discovery inside core startup

`Config.initialize()` should treat bare mode as "explicit-only startup":

- if there are no explicit extension overrides, skip extension cache refresh
- if there are explicit extension overrides, refresh only those named
  extensions
- do not start skill watchers in bare mode
- refresh the skill cache once without loading project/user skills
- create the tool registry without calling discovery

This preserves built-in tools and normal runtime initialization while removing
the expensive implicit startup work.

### 5. Make memory discovery explicit-only

`loadServerHierarchicalMemory(...)` needs an explicit-only option that:

- does not automatically inject the current working directory into discovery
- does not load global home memory files
- does not walk upward from explicit include directories
- does not load `.qwen/rules/`
- still includes explicitly supplied extension context file paths

This keeps the memory layer aligned with the same bare-mode contract.

### 6. Restrict skill discovery in bare mode

The skill manager should:

- skip `project` and `user` skill levels in bare mode
- continue to allow `bundled` skills
- continue to allow `extension` skills when the extension itself was loaded
  explicitly
- avoid starting filesystem watchers in bare mode

### 7. Support explicit extension loading

The extension manager needs a filtered refresh path:

- normal mode keeps scanning all user extensions
- bare mode may call `refreshCache({ names })`
- only explicitly named extensions are loaded into the cache

This matches the intended "no ambient extension discovery" behavior while still
supporting explicit caller intent.

## Acceptance Checklist

The change is acceptable when all of the following are true:

- `qwen --bare` is parsed successfully
- bare mode does not auto-load `output-language.md`
- bare mode ignores settings-based `context.includeDirectories`
- bare mode still honors CLI `--include-directories`
- bare mode skips implicit home/project/cwd memory discovery
- bare mode skips `.qwen/rules/`
- bare mode skips implicit project and user skills
- bare mode does not start skill watchers
- bare mode does not auto-scan all extensions
- bare mode can still load explicitly named extensions
- bare mode does not call startup tool discovery
- normal startup behavior remains unchanged when `--bare` is absent

## Files Touched

Implementation:

- `packages/cli/src/config/config.ts`
- `packages/cli/src/gemini.tsx`
- `packages/core/src/config/config.ts`
- `packages/core/src/extension/extensionManager.ts`
- `packages/core/src/skills/skill-manager.ts`
- `packages/core/src/utils/memoryDiscovery.ts`
- `packages/core/src/utils/bareMode.ts`
- `packages/core/src/index.ts`

Tests:

- `packages/cli/src/config/config.test.ts`
- `packages/cli/src/gemini.test.tsx`
- `packages/cli/src/commands/auth/handler.ts`
- `packages/core/src/config/config.test.ts`
- `packages/core/src/extension/extensionManager.test.ts`
- `packages/core/src/skills/skill-manager.test.ts`
- `packages/core/src/utils/memoryDiscovery.test.ts`

## Verification Plan

Run the smallest useful verification first, then workspace-level safety checks:

1. CLI config tests

```bash
cd packages/cli
npx vitest run --coverage.enabled=false src/config/config.test.ts
```

2. CLI startup tests

```bash
cd packages/cli
npx vitest run --coverage.enabled=false src/gemini.test.tsx
```

3. Core bare-mode startup tests

```bash
cd packages/core
npx vitest run --coverage.enabled=false src/config/config.test.ts
npx vitest run --coverage.enabled=false src/skills/skill-manager.test.ts
npx vitest run --coverage.enabled=false src/extension/extensionManager.test.ts
npx vitest run --coverage.enabled=false src/utils/memoryDiscovery.test.ts
```

4. Workspace safety checks

```bash
npm run build
npm run typecheck
```

## Review Notes For Berry / CloudCode Comparison

When comparing this implementation with Berry or CloudCode, the key question is
not whether the internal entry points are identical, but whether the external
contract matches:

- Is startup context strictly explicit-only?
- Are explicit caller inputs still honored?
- Are extension and skill surfaces only loaded when explicitly requested?
- Is normal startup unchanged outside bare mode?

If Berry's behavior differs, the most likely adjustment points are:

- startup context loading in `packages/cli/src/config/config.ts`
- memory discovery semantics in `packages/core/src/utils/memoryDiscovery.ts`
- extension filtering in `packages/core/src/extension/extensionManager.ts`
- skill-level filtering in `packages/core/src/skills/skill-manager.ts`
