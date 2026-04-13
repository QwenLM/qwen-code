# Prompt Suggestion Implementation Status

> Tracks the implementation status of the prompt suggestion (NES) feature across all packages.

## Core Module (`packages/core/src/followup/`)

| Component                | Status  | Lines | Description                                                   |
| ------------------------ | ------- | ----- | ------------------------------------------------------------- |
| `followupState.ts`       | ✅ Done | ~230  | Framework-agnostic controller with timer/debounce             |
| `suggestionGenerator.ts` | ✅ Done | ~260  | LLM generation + 12 filter rules + forked query support       |
| `forkedQuery.ts`         | ✅ Done | ~240  | CacheSafeParams + createForkedChat + runForkedQuery           |
| `overlayFs.ts`           | ✅ Done | ~140  | Copy-on-write overlay filesystem                              |
| `speculationToolGate.ts` | ✅ Done | ~150  | Tool boundary enforcement with AST shell parser               |
| `speculation.ts`         | ✅ Done | ~540  | Speculation engine with pipelined suggestion + model override |

## CLI Integration (`packages/cli/`)

| Component                    | Status  | Description                                                |
| ---------------------------- | ------- | ---------------------------------------------------------- |
| `AppContainer.tsx`           | ✅ Done | Suggestion generation, speculation lifecycle, UI rendering |
| `InputPrompt.tsx`            | ✅ Done | Tab/Enter/Right Arrow acceptance, dismiss + abort          |
| `Composer.tsx`               | ✅ Done | Props threading                                            |
| `UIStateContext.tsx`         | ✅ Done | promptSuggestion + dismissPromptSuggestion                 |
| `useFollowupSuggestions.tsx` | ✅ Done | React hook with telemetry + keystroke tracking             |
| `settingsSchema.ts`          | ✅ Done | 3 feature flags + fastModel setting                        |
| `settings.schema.json`       | ✅ Done | VSCode settings schema                                     |

## WebUI Integration (`packages/webui/`)

| Component                   | Status  | Description                                 |
| --------------------------- | ------- | ------------------------------------------- |
| `InputForm.tsx`             | ✅ Done | Tab/Enter/Right Arrow + explicitText submit |
| `useFollowupSuggestions.ts` | ✅ Done | React hook with onOutcome support           |
| `followup.ts`               | ✅ Done | Subpath entry                               |
| `components.css`            | ✅ Done | Ghost text styling                          |
| `vite.config.followup.ts`   | ✅ Done | Separate build config                       |

## Telemetry (`packages/core/src/telemetry/`)

| Component               | Status  | Description          |
| ----------------------- | ------- | -------------------- |
| `PromptSuggestionEvent` | ✅ Done | 10 fields            |
| `SpeculationEvent`      | ✅ Done | 7 fields             |
| `logPromptSuggestion()` | ✅ Done | OpenTelemetry logger |
| `logSpeculation()`      | ✅ Done | OpenTelemetry logger |

## Test Coverage

| Test File                     | Tests | Description                                                     |
| ----------------------------- | ----- | --------------------------------------------------------------- |
| `followupState.test.ts`       | 14    | Controller timer, debounce, accept callback, onOutcome, clear   |
| `suggestionGenerator.test.ts` | 16    | All 12 filter rules + edge cases + false positives              |
| `overlayFs.test.ts`           | 15    | COW write, read resolution, apply, cleanup, path traversal      |
| `speculationToolGate.test.ts` | 27    | Tool categories, approval mode, shell AST, path rewrite         |
| `forkedQuery.test.ts`         | 6     | Cache params save/get/clear, deep clone, version detection      |
| `speculation.test.ts`         | 7     | ensureToolResultPairing edge cases                              |
| `smoke.test.ts`               | 21    | Cross-module E2E: filter + overlay + toolGate + cache + pairing |
| `InputPrompt.test.tsx`        | 4     | Tab, Enter+submit, Right Arrow, completion guard                |

## Audit History

| Round           | Issues Found | Issues Fixed                                             |
| --------------- | ------------ | -------------------------------------------------------- |
| R1-R4           | 10           | 10 (rule engine → LLM, state simplification)             |
| R5-R6           | 2            | 2 (Enter keybinding conflict, Right Arrow telemetry)     |
| R7-R8           | 3            | 3 (WebUI telemetry, dead type, test coverage)            |
| R9              | 0            | — (convergence)                                          |
| R10-R11         | 1            | 1 (historyManager dep)                                   |
| R12-R13         | 1            | 1 (evaluative regex word boundaries)                     |
| Phase 1+2 R1-R4 | 20+          | 20+ (permission bypass, overlay safety, race conditions) |
| **Total**       | **37+**      | **37+**                                                  |

## Claude Code Alignment

| Feature                          | Alignment | Notes                                 |
| -------------------------------- | --------- | ------------------------------------- |
| Prompt text                      | 100%      | Identical (brand name only)           |
| 12 filter rules                  | 100%+     | \b word boundaries improvement        |
| UI interaction (Tab/Enter/Right) | 100%      |                                       |
| Guard conditions                 | 100%      | 13 checks                             |
| Telemetry                        | 100%      | 10+7 fields                           |
| Cache sharing                    | ✅        | DashScope cache_control               |
| Speculation                      | ✅        | COW overlay + tool gating             |
| Pipelined suggestion             | ✅        | Generated after speculation completes |
| State management                 | 100%+     | Controller pattern, Object.freeze     |
