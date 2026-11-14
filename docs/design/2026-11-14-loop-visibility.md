# Loop Visibility (Block B, Slice 3)

[English](2026-11-14-loop-visibility.md) | [简体中文](2026-11-14-loop-visibility.zh-CN.md)

- **Status**: in implementation.
- **Tracker**: #17045 block B, slice 3. Specified by `2026-11-12-loop-rollout-switches.md` (Slice 3); slices 1–2 merged (#17050, #17055), slice 4 delivered by #17172.
- **Checked at**: upstream `0de9ca2d91` (2026-11-14).

## Problem

The per-surface switches (slice 2) decide which loop a surface runs, but a run
does not say which loop it took, and an operator cannot see the resolution:

1. **No uniform path marker.** The shared-loop surfaces log ad-hoc markers
   (`runModelRound on the shared agent loop`, `[ACP] model round …`,
   `[AgentCore] subagent …`), the kernel logs `[EVENT_BUS] runAgentLoopOnBus
started`, and the **legacy path logs nothing**. The wording differs per
   surface, so a run's path is not provable from the debug log uniformly.
2. **`/about` and `/bug` do not name the loop.** Neither reports which loop the
   current surface resolves to, so an operator filing a bug cannot tell whether
   the session ran legacy, shared, or kernel.

## Proposed changes

### Core: one path resolution, one marker

- `Config.getAgentLoopPath(surface): 'legacy' | 'shared' | 'kernel'` derives the
  path from the **same** getters the surface uses:
  `!isUnifiedAgentLoopEnabled(surface)` → `legacy`; else
  `isEventBusAgentLoopEnabled(surface)` → `kernel`; else `shared`. No second copy
  of the env/setting/default rules.
- A `logAgentLoopEntry(config, surface)` helper (core, `debugLogger` channel like
  the kernel's `[EVENT_BUS]`) logs one line naming the surface and the resolved
  path, e.g. `[LOOP] headless legacy`. Each surface calls it where it reads the
  loop switch (its loop entry), including the legacy path.

### `/about` and `/bug`: one shared line

- `ExtendedSystemInfo` gains `agentLoop?: string` (e.g. `headless: legacy`).
- `getExtendedSystemInfo` computes it from the **current surface**, determined by
  the execution mode: `non_interactive` → `headless`, `acp` → `acp`,
  `interactive` → the renderer of record (`selectTuiRenderer` → `ink`/`opentui`).
  `SystemInfoContext` gains an optional `executionMode` so the Settings dialog
  (which has no execution mode) simply omits the line.
- `getSystemInfoFields` adds an "Agent Loop" field, so `/bug` and the interactive
  `/about` (AboutBox) pick it up automatically; the non-interactive `/about`
  lines add it too.

## Key design decisions

| Decision                                                    | Rationale                                                                                            |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Path derived from the existing getters, not a new rule copy | The design requires the line to use the same resolution the surface uses; a second copy would drift. |
| Marker logged at the loop decision point, incl. legacy      | Makes every surface's path provable; legacy currently logs nothing.                                  |
| Current surface from execution mode + renderer of record    | `/about`/`/bug` run in a mode; the interactive surface is the renderer actually serving the session. |
| `executionMode` optional on `SystemInfoContext`             | The Settings dialog passes only config+settings; it omits the line rather than guessing a surface.   |

## Files affected

- `packages/core/src/config/config.ts` — `getAgentLoopPath`.
- `packages/core/src/config/agent-loop-rollout.ts` (or a small core util) — marker helper.
- Surface loop entries: `nonInteractiveCli.ts`, `use-llm-stream.ts`,
  `live-session.ts`, `Session.ts`, `agent-core.ts`, `speculation.ts`.
- `packages/cli/src/ui/systemInfo.ts`, `systemInfoFields.ts`,
  `commands/aboutCommand.ts`, `components/AboutBox.tsx` (via fields).

## Scope boundaries

- No change to the switch resolution rules or defaults (slice 2, merged).
- No new settings; the line is read-only diagnostics.
- The marker is debug-log only (no user-visible output change beyond the line).

## Resolved questions

- Marker granularity: logged where each surface reads the loop switch. Verified
  once per turn for headless and agent-core (real-env debug-log count = 1 per
  turn); ink reads the switch per model round, so its marker is per round. The
  `[LOOP]` wording is distinct from the parity suites' counted markers, so their
  counts are unaffected (verified in the shared-arm debug log).
