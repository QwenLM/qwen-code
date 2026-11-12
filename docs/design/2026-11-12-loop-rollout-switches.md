# Loop Rollout Switches and Signals

[English](2026-11-12-loop-rollout-switches.md) | [简体中文](2026-11-12-loop-rollout-switches.zh-CN.md)

- **Status**: slice 1 (nightly legs) delivered as draft PR #17050; slice 2 (per-surface defaults) in implementation; slices 3–4 not started.
- **Tracker**: #17045, block B. The ladder, the rollout rules and the capability ledger belong to the unified-loop design (`2026-10-23-unified-agent-loop.md`), the event-bus design (`2026-11-11-event-bus-agent-loop.md`) and block A of #17045; this document designs only the switch mechanics and signals that block B owns.
- **Checked at**: upstream `acc07c2eb0` (2026-11-12).

## Problem

The shared agent loop and its event-bus kernel ship behind two experimental settings, but the rollout mechanics cannot open them one surface at a time:

1. **One boolean for every surface.** `experimental.unifiedAgentLoop` covers headless, ACP, both TUIs and AgentCore at once; `experimental.eventBusAgentLoop` covers headless. A default change today moves every surface together.
2. **The environment variable can only force on.** `Config.isUnifiedAgentLoopEnabled()` returns `true` when `QWEN_CODE_ENABLE_UNIFIED_AGENT_LOOP === '1'` and otherwise the setting (`packages/core/src/config/config.ts:10833`); the event-bus getter is the same shape (`:10838`). There is no way to force a surface back off from the environment, which the rollout rules require as the switch-back.
3. **No per-surface resolution.** Every caller reads the same getter with no surface argument: headless (`packages/cli/src/nonInteractiveCli.ts:2742`), ACP (`packages/cli/src/acp-integration/session/Session.ts:7559`), Ink (`packages/cli/src/ui/hooks/use-llm-stream.ts:5063`), OpenTUI (`packages/cli/src/ui/opentui/live-session.ts:1087`), AgentCore (`packages/core/src/agents/runtime/agent-core.ts:1101` via `runtimeContext`).
4. **The nightly signal is incomplete.** The Linux E2E matrix runs a `unified` leg on schedule/dispatch (`.github/workflows/e2e.yml:270`); the OpenTUI job (`:617`) has no agent-loop matrix, and no leg anywhere runs with the event-bus kernel on. OpenTUI's 14-night count and every kernel default wait on these legs.
5. **Two parity off arms are not forced.** The ACP parity deletes the env var for its off arm (`integration-tests/cli/acp-agent-loop-parity.test.ts:331`) and the TUI parity simply omits it (`integration-tests/interactive/tui-agent-loop-parity.test.ts:500`). Once a default is on, both off arms would run the new path and the comparison would silently compare the same path twice. The headless parity already forces both arms through explicit per-arm settings (`integration-tests/cli/agent-loop-parity.test.ts:243`).
6. **A session does not say which loop it ran.** The kernel logs an `[EVENT_BUS]` debug marker (`packages/core/src/event-bus/adapter.ts:23`); the shared procedural path and the legacy paths log nothing equivalent, and `/about` and `/bug` carry no loop line.

## Slices

Each slice is one PR unless noted. Deadlines are #17045's.

| Slice | Content                                                                                | Due   |
| ----- | -------------------------------------------------------------------------------------- | ----- |
| 1     | Nightly legs: OpenTUI with the shared loop on; Linux and OpenTUI with both switches on | 11-16 |
| 2     | Per-surface defaults for both switches, env force on/off, parity arms forced           | 11-19 |
| 3     | Loop visibility: debug marker on every surface, a line in `/about` and `/bug`          | 11-19 |
| 4     | #16710 fixed; #16505, #16787, #16947 closed with a classification                      | 11-19 |

Slice 2 and slice 3 may land as one PR if the diff stays reviewable; slice 4 is investigation plus a fix and is independent of the others.

## Slice 1: nightly legs

The Linux matrix gains a third `agent-loop` value, `kernel`, and the OpenTUI job gains the same matrix it never had. Pushes keep one leg per sandbox and one OpenTUI leg, so the pool and hosted load of a push is unchanged; schedule and dispatch run the full set.

**Linux (`e2e-test-linux`).**

- Matrix: `agent-loop` resolves to `["current"]` on push and `["current","unified","kernel"]` otherwise (today: `["current","unified"]`).
- Exclusions: `sandbox:docker` excludes both `unified` and `kernel` (today it excludes only `unified`); the switch legs run without a sandbox, like the existing unified leg.
- Env on the `Run E2E tests` step:
  - `QWEN_CODE_ENABLE_UNIFIED_AGENT_LOOP`: `'1'` when `matrix.agent-loop != 'current'`, else `''`.
  - `QWEN_CODE_ENABLE_EVENT_BUS_AGENT_LOOP`: `'1'` when `matrix.agent-loop == 'kernel'`, else `''`.
- Job name suffix: ` - unified agent loop` for `unified` (unchanged), ` - event-bus kernel` for `kernel`.

**OpenTUI (`e2e-interactive-opentui`).**

- The same `agent-loop` matrix expression, `fail-fast: false`, and the same two env vars on the `Run interactive E2E tests (OpenTUI)` step.
- Job name gains the same suffixes.
- The renderer stays pinned to `opentui` by the existing `QWEN_E2E_RENDERER=opentui` in the run command; the matrix adds loop arms, not renderer arms.

**What the kernel leg exercises today.** The kernel flag only reaches headless, so the Linux kernel leg runs headless on the event-bus path and every other surface on the shared procedural path; the OpenTUI kernel leg runs OpenTUI on the shared loop (the kernel flag is inert there until its step 3). The legs exist now so the nightly count starts accruing and the wiring is proven before any surface's step 3 lands.

**Meta-tests.** `scripts/tests/e2e-workflow.test.js` gains a describe block that evaluates the actual matrix and env expressions (the way the concurrency pins evaluate theirs) for `push`, `schedule` and `workflow_dispatch`: push yields only `current` on both jobs; schedule/dispatch yield all three values; docker excludes both switch legs; each matrix value maps to the expected pair of env values on both jobs. The existing job-structure pins (install retry list, artifact time-boxing, one-build) are unchanged because no job is added or removed.

**The headless parity's kernel dimension is forced too.** The headless parity stubs `QWEN_CODE_ENABLE_UNIFIED_AGENT_LOOP` and forces its arms through per-arm settings, but it left `QWEN_CODE_ENABLE_EVENT_BUS_AGENT_LOOP` to the ambient env. On the new kernel leg that variable is `1`, so the shared arm would silently run the kernel and the suite would compare a different pair than on the other legs. The suite now stubs the kernel variable to undefined as well, so it measures legacy-vs-shared-procedural on every leg; the kernel path is still exercised by the rest of the suite, which inherits the leg's env. The ACP and TUI parity off arms force the unified variable to `0` (slice 2) rather than leaving it unset, so they keep comparing legacy-vs-shared once a default turns on; the ACP parity never reads the kernel variable and the TUI parity builds its child env from scratch (`inheritEnv: false`) — neither leaks the kernel dimension.

**Size ratchet.** `e2e.yml` is 45412 bytes against a 45412 baseline with a 4096-byte allowance; the added matrix, env lines and suffixes must stay inside the allowance or bump `.github/workflows/.size-baseline` in the same PR with a reason.

## Slice 2: per-surface defaults and forced parity arms

**Resolution order.** For each surface and each switch, the first rule that answers wins:

1. the environment variable, when it addresses that surface;
2. the explicit setting (`experimental.unifiedAgentLoop` / `experimental.eventBusAgentLoop`), when set;
3. the surface's built-in default — `false` for every surface today; a later PR flips one surface's default and only that surface's.

**Surface identifiers.** `headless`, `acp`, `ink`, `opentui`, `agent-core`, `speculation`. They name the loop entry points, not the packages: the Ink TUI is `ink`, the OpenTUI renderer is `opentui`, subagents on AgentCore are `agent-core`.

**Environment variable grammar.** Both `QWEN_CODE_ENABLE_UNIFIED_AGENT_LOOP` and `QWEN_CODE_ENABLE_EVENT_BUS_AGENT_LOOP` accept:

- `1` — force every surface on (today's only behavior, unchanged);
- `0` — force every surface off (new; the switch-back);
- a comma-separated list of tokens, each `<surface>` (force on) or `<surface>=0` / `<surface>=1` (force off/on); surfaces the list does not name fall through to rules 2–3. Example: `headless,acp=0` forces headless on and ACP off and leaves the rest to settings and defaults.

Tokens are trimmed; empty tokens are ignored; an unknown surface name is ignored with a debug log, so a list written for a newer CLI does not break an older one. A malformed token (`surface=2`) is ignored the same way rather than throwing at startup.

**Getter shape.** `Config.isUnifiedAgentLoopEnabled(surface)` and `Config.isEventBusAgentLoopEnabled(surface)` take the surface identifier; every call site names its surface. AgentCore's `runtimeContext` hook passes `agent-core`. The speculation read site arriving in #17029 passes `speculation`; the two PRs coordinate on the shared getter signature (whoever lands second adapts). The kernel flag still does nothing where the shared loop is off — resolution is per-switch, and the kernel only applies inside `runAgentLoop`.

**Setting becomes tri-state at runtime.** The CLI stops collapsing unset to `false` (`packages/cli/src/config/config.ts:2920` today does `?? false`); the core parameter becomes `boolean | undefined`. The merged settings already leave unset keys undefined — the loader does not materialize schema defaults (pinned at `packages/cli/src/config/settings.test.ts:4624`) — so the runtime distinguishes "not set" from "explicitly off" without any schema change. The schema entries **keep** `default: false` for now: `nextBooleanSettingValue` (`packages/cli/src/config/settingsUtils.ts:687`) writes `false` on the first toggle of an unset boolean when the schema default is undefined, which would flip today's first-toggle-enables behavior in both settings dialogs. The schema default is removed when the first surface's built-in default flips, together with a dialog treatment for the unset state; the Web Shell settings panel reads effective values, not schema defaults, and is unaffected either way.

**Parity arms forced.** In the same PR: the ACP parity's off arm sets the env var to `'0'` instead of deleting it; the TUI parity's off arm sets `'0'` instead of omitting it. The headless parity keeps its explicit per-arm settings. With slice 2's force-off semantics, `'0'` pins the off arm regardless of any default; before slice 2 lands, `'0'` is inert (only `'1'` is read), so the parity change is safe to land together with the mechanism but not before it.

## Slice 3: loop visibility

- Every surface logs one debug marker at its loop entry naming the surface and the resolved path (`legacy`, `shared`, `kernel`), through the same `debugLogger` channel the kernel's `[EVENT_BUS]` marker uses, so a run's path is provable from the debug log on every surface.
- `/about` gains one line naming the loop the current surface resolves to; `/bug` includes the same line in the report it builds. The line is derived from the same resolution function the surface uses, not a second copy of the rules.

## Slice 4: the CI-failure issues

- **#16710** (headless parity, `parallel read-only batch`, sandbox:docker): the two arms listed different startup directory trees. Reproduce from the run's artifacts, find what writes into the workspace between the arms (rig runtime files, debug logs, chat recording are the candidates), fix the harness or the loop, and classify. This one is a real difference until proven otherwise.
- **#16505 / #16787** (`an approved write, then a declined one`, Ink macOS / OpenTUI): the approval wait was settled by #16881. Verify the scenarios pass in the nightly runs since that merge, then close each with the classification "harness flake, fixed by #16881" and the evidence.
- **#16947** (`a retry after a model error`, Ink macOS): the startup date was settled by #16961. Same treatment: verify, classify, close.

## Design decisions

| Decision                                                    | Rationale                                                                                                                                                                                                              |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Matrix value `kernel`, both env vars set on that leg        | The leg's contract is "both switches on", independent of which surfaces read the kernel flag today; no rework when a surface's step 3 lands                                                                            |
| Push keeps `current` only                                   | The unified leg already established that the switch legs are a scheduled signal; adding two more legs to every push would multiply pool and hosted load for a signal no default change reads mid-day                   |
| Env list grammar with `surface=0/1` tokens                  | The rollout rules need force-off per surface (the switch-back) and force-on per surface (a parity arm, a targeted canary); bare `1`/`0` keeps every existing script working                                            |
| Unknown env tokens ignored, not fatal                       | Forward compatibility: a list naming a surface an older CLI does not have must not break that CLI's startup                                                                                                            |
| One boolean setting stays one boolean                       | The unified-loop design prescribes setting-when-set, else surface default; per-surface settings would multiply the schema copies (Web Shell, VS Code) for a granularity the env list already provides                  |
| Schema default stays until the first surface flip           | The runtime tri-state needs no schema change (merged settings leave unset keys undefined); removing `default: false` earlier would flip the dialogs' first toggle from enable to disable via `nextBooleanSettingValue` |
| Parity off arms switch to `'0'` in the same PR as force-off | Landing `'0'` earlier is inert but misleading; landing force-off without the parity fix leaves the off arms leaking the moment a default flips                                                                         |

## Constraints and risks

- The loop contract (`AgentLoopHost`, `runAgentLoop` options) has one owner at a time (#17045 block C); slice 2 changes the Config getters, not the contract, but the getter signature is shared with #17029 (speculation) — coordinate the landing order.
- The kernel leg runs the headless kernel path nightly before block K's cancellation and bounded close land; a kernel-path failure there is a signal, not a regression of the default path, and must not block the other legs (`fail-fast: false` already guarantees that).
- The schema default stays until the first surface default flip: removing it earlier would change the settings dialogs' first-toggle behavior (`nextBooleanSettingValue`), which is out of slice 2's scope.
- Workflow size ratchet: any `e2e.yml` growth beyond the 4096-byte allowance needs a same-PR baseline bump.

## Validation plan

- **Slice 1**: `npm run test:scripts:unit` (the e2e-workflow meta-tests, including the new expression-evaluating pins), `actionlint .github/workflows/e2e.yml`, Prettier, the workflow-size gate; then a `workflow_dispatch` run of the E2E workflow on the PR branch proving the three new legs start and pass with the switches wired.
- **Slice 2**: unit tests for the resolution matrix (env × setting × default × surface, both switches, malformed and unknown tokens), CLI config wiring tests, the three parity suites locally with retries off, `npm run build && npm run typecheck`.
- **Slice 3**: unit tests for the `/about` and `/bug` lines and the marker; a debug-log E2E check per surface.
- **Slice 4**: reproduction of #16710 from the failing run's artifacts; nightly evidence for the three flake classifications.

## Acceptance criteria

Block B's six checkboxes in #17045 are ticked, each by a merged PR or a recorded classification:

1. nightly legs exist for OpenTUI + shared loop and for Linux/OpenTUI + both switches, and run on schedule;
2. the shared loop resolves per surface with env force on/off;
3. the kernel resolves the same way;
4. every parity arm is explicitly forced;
5. every surface's loop is visible in the debug log, `/about` and `/bug`;
6. #16710 is fixed and the other three issues are closed with a classification.

## Open questions

- ~~Does the settings loader inject schema defaults into the merged settings object?~~ Resolved while preparing slice 1: it does not — the merged settings leave unset keys undefined (`packages/cli/src/config/settings.test.ts:4624` pins this for `goals.modelProposed`), so the runtime tri-state only needs the CLI to stop collapsing unset to `false`. The schema keeps `default: false` until the first surface default flips: removing it earlier would flip both settings dialogs' first toggle from enable to disable via `nextBooleanSettingValue` (`packages/cli/src/config/settingsUtils.ts:687`), so the schema-default removal is deferred to that flip, not part of the tri-state itself.
- ~~Should the env list grammar accept bare `0`/`1` tokens inside a list (e.g. `1,acp=0`)?~~ Decided: no — the whole-value `1`/`0` alone means "all surfaces"; a bare `1`/`0` inside a list has no surface name and is dropped. This is stated in the user-facing text and pinned by a resolution-module test.
- #17029's speculation read site: land slice 2 before or after it? Whoever lands second adapts the call site; the surface identifier `speculation` is reserved either way.
