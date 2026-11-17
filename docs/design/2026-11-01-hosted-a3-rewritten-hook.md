# Hosted A3 — rewritten command inputs and Hook no-rerun

Status: implemented; packaged MySQL/Linux acceptance passed. Pending review/merge. Slice of Issue #14481 (G3 Step 3 recovery matrix), row **A3** ("mixed calls and rewritten inputs"), covering only its remaining rewritten-input / Hook-no-rerun half.

中文版：[2026-11-01-hosted-a3-rewritten-hook.zh-CN.md](2026-11-01-hosted-a3-rewritten-hook.zh-CN.md).
Parent: [G3 Step 3 recovery](2026-10-09-hosted-g3-step3-recovery.md).

## Problem and current state

The merged native A3 arm proves earlier decisions and pending sibling identity/order. It deliberately does not cover rewritten input or Hooks: native continuation refuses Hook/MCP owners, while input rewrite and Hook occurrences exist on the commandStep path.

Production already has the required mechanisms; this slice must not presume a new production defect:

- `commandPermission` applies PreToolUse/PermissionRequest replacements before constructing the approval. A new `command_approval_*` Action stores the final input and its commandStep continuation (`hosted-workspace-tool-turn.ts:8660-8813`).
- Re-entry to an existing Action compares its saved input with the current final input and throws `Command step approval input changed.` on conflict (`hosted-workspace-tool-turn.ts:8730-8749`). `inputRevision: 1` is not a content version; the protection is immutable Action options, `inputRef` identity, and this comparison.
- `HostedHookSession.fireOccurrence` validates a saved occurrence and returns its durable `resultRef` output instead of physically dispatching the Hook again (`hosted-hook-session.ts:995-1037`).
- `expandHostedExtensionCommand` reuses a saved `tool_stage` and its result, but still calls `options.completed`; the saved PostToolUse occurrence is therefore what prevents a physical Hook rerun (`hosted-extension-command.ts:121-246`).

The missing evidence is their composition across Harness replacement. No current fixture combines a real commandStep, Hook input rewriting, durable Hook occurrences, and a new owner. There is no direct test of `command_approval_*`, and the packaged runner currently assumes native `tool_approval_*` Actions and native tool executions.

The packaged counterexample exposed one production defect before Action 1 could be projected: TypeScript emitted `command_approval_<48 hex>`, while Java still accepted only `tool_approval_<32 hex>`. This slice therefore also makes the managed Java Action ID grammar accept both existing shapes in journal projection, detail lookup, and public/child pagination cursors, and makes the independent SDK client's resolveAction accept the same two shapes. Regression inputs failed against the old grammar before the fix; the complete affected managed Java suites pass 68/68 and the SDK HostedHarnessClient suite passes 235/235 afterward.

After Action 1 became durable, the same real counterexample exposed a second recovery defect with two required halves. The HTTP commit closure omitted `managed-extension-config-bundle` and `managed-extension-contributions`, so contribution manifests/parts were never uploaded. The active `config_install` projection also retained only its latest record, not the package configuration's recovery closure. Once the original owner sealed, its active bundle and contributions could therefore be absent, and the replacement's load read returned `managed_session_resource_not_found`. The commit now uploads the bundle-to-contribution chain, and the projection owns the record chain and the recovery dependencies present in the Session. The closure witness failed before these changes, failed again when the new clauses were deleted, and passed after byte-identical restoration; the two affected Java suites pass 39/39 afterward.

The next load boundary exposed two commandStep-specific route gaps. Workspace verification rejected `config_install` and `tool_stage` even with extensions enabled, and both pre-answer paths tried to expand an approval-pending Skill before the existing `resumeApproval` branch could run. Verification now admits those extension domains, while a saved commandStep continuation skips ordinary pre-answering and enters approval recovery through the Hooks load route. The early commandStep read only gates pre-answering; the native takeover path still performs its own approval-continuation lookup, as four existing native recovery tests require.

The replacement load then exposed an owner-construction ordering gap: `manager.open()` ran before `session.hooks` existed, so an adoption placed there could not bind the saved continuation's owner. The Hook session now receives the deterministic `extensions-components-<hash>` runtime id at construction when an active extension bundle supplies the Hook catalog.

Two further packaged failures were execution-lifecycle gaps, not approval identity gaps. A very fast extension Shell could emit `close` before `owners.start()` returned; the later listener then waited forever and reported output closure unknown even though the command effect and stop receipt existed. The Shell now adopts an already-closed stdout/stderr pair, with a real ChildProcess regression that failed on the old listener. Separately, extension command receipts settled without acknowledging their legacy native executor entries, so reliable close kept refusing retirement with HTTP 409. The command runtime now acknowledges only after the durable receipt is settled; unknown outcomes remain unacknowledged.

## Goal and scope

Prove the two remaining A3 observations together:

1. A different rewritten command input never inherits an earlier step's Allow. Each step has its own Action, final input, and original deadline.
2. A completed PreToolUse/PostToolUse occurrence does not physically rerun when recovery re-enters the command expansion or its completion callback. The corresponding command executes only once with the rewritten input.

The first deliverable is a focused three-generation witness using the real `ManagedSession`, `HostedHookSession`, and commandStep continuation. The second is a packaged MySQL/Linux arm using the real load route, Broker, Runtime, extension command, and physical Hook process. The slice began as evidence-only; the packaged counterexample exposed the small production gaps recorded below, and each was fixed from a failing input before acceptance.

Out of scope: native+Hook mixed continuation, the merged native A3 arm, R2 reader/bundle compatibility, real-provider acceptance, multi-instance binding fencing, and a new general recovery architecture.

## Proposed counterexample

Use one outer `skill` call whose expansion contains two `!{...}` command steps. A real PreToolUse Hook rewrites each step to a distinct final input and returns `ask`, forcing a human approval.

| Generation | Durable boundary                         | Required observations                                                                                                                                                                                                          |
| ---------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| gen1       | step 1 is waiting for its first decision | PreToolUse rewrote step 1; Action 1 and `await_action` are durable; no step effect                                                                                                                                             |
| gen2       | Allow step 1, then step 2 waits          | Action 1 is decided with its original identity; step 1 executed once and its PostToolUse has a `resultRef`; Action 2 is requested with step 2's rewritten input and a fixed deadline; step 2 has no `tool_stage` or effect     |
| gen3       | recover, then Allow step 2               | Action 2 keeps its ID/deadline and is not authorized by Action 1; step 1's saved stage and PostToolUse replay without another physical execution; step 2 executes once with its own rewritten input; the Turn has one terminal |

The gen2 crash needs no production fault hook. A requested command Action waits indefinitely until answered, so the runner can crash immediately after proving Action 2, `await_action`, step 1's settled stage, and step 1's completed PostToolUse. This barrier also proves the Hook had already completed before the crash; a later window that skipped `decide()` would not test no-rerun.

## Design decisions

- **Two steps, not one.** Recovery re-enters step 1's `completed` before it reaches step 2. Only this shape distinguishes a harmless callback replay from a physical PostToolUse rerun.
- **Runner-only crash barrier.** Do not add a `QWEN_E2E_*` production hook, an approval hold, or the A5a Broker proxy. The requested Action itself is the hold.
- **Assert evidence, not HTTP success.** Read Action options, `commandStep.inputRef`, `tool_stage`, `hook_execution.resultRef`, model traffic, physical Hook counts, extension-command receipts, and terminal counts. Do not reuse native prepare-key or `HOSTED_CLEANUP` assertions where they do not apply.
- **Route-level coverage matters.** Direct `resumeSavedNativeBatch` tests are useful but insufficient for the packaged claim; the packaged arm must enter through the real load route with Hooks and extensions enabled.
- **Mutation witnesses are mandatory.** At minimum, bypassing saved Hook output must increase a named physical Hook count; bypassing saved stage results must repeat step 1's command; reusing step 1's approval for step 2 must fail the two-Action identity assertions. Every mutation is restored byte-identically.

## Files affected (expected)

- `packages/cli/src/serve/hosted-approval-continuation.test.ts` or a collocated commandStep recovery suite: the focused three-generation witness.
- `packages/cli/src/serve/hosted-harness-session.ts`: extension-domain verification and the commandStep approval load route.
- `packages/core/src/managed-runtime/http-managed-session-store.ts` and its test: the extension bundle/contribution commit closure.
- `packages/managed-agent-server/{contracts,persistence,control-plane}`: the shared Action ID grammar and its journal/detail/cursor consumers, plus package-configuration recovery-closure retention.
- `packages/sdk-java/qwencode/.../HostedHarnessClient.java` and its test: command Action delivery through the real SDK client.
- `ManagedActionStoreTest`, `ManagedActionsTest`, `ManagedExtensionConfigurationAdmissionTest`: command Action and recovery-closure regression witnesses.
- `scripts/run-managed-agent-server-e2e.ts`: the two-step Hook/extension fixture, runner-only barrier, and packaged assertions.
- `scripts/tests/managed-agent-server-e2e.test.js` and `scripts/tests/hosted-process-ci.test.js`: runner and CI contracts.
- `package.json` and `.github/workflows/sdk-java.yml`: one named arm and its CI step.
- This design pair and `.qwen/e2e-tests/2026-11-01-hosted-a3-rewritten-hook.md`.

## Acceptance criteria

- Focused gen1/gen2/gen3 boundaries match the table, with two distinct rewritten inputs and two distinct Actions.
- Action 2 retains its original ID and deadline across replacement; Action 1's Allow does not settle or authorize Action 2.
- Step 1's PreToolUse and PostToolUse physical counts remain one after gen3; its extension command is not re-executed. Step 2 executes once with its own rewritten input.
- The packaged arm reaches the same boundary through the real load route after SIGKILL and Harness-home removal, then proves the same durable and physical observations on MySQL/Linux.
- Each named mutation reds its named assertion and is restored byte-identically; existing A3/A5/A5a and Hook/extension suites remain green.
- Build, typecheck, bundle, focused unit tests, runner/CI contract tests, formatting and lint pass. Bilingual docs and the E2E ledger record the actual evidence boundary.

## Open questions

- Whether the existing real-stack extension fixture needs a separate delegated cgroup configuration on the selected Linux host; record the exact setup rather than weakening the arm.
- Whether a focused counterexample exposes a production defect. If so, scope the fix to that evidence and rerun the baseline before continuing.

## Focused evidence (implemented)

`hosted-command-step-hook-recovery.test.ts` implements the three-generation
witness without a production change. It passes 1/1 on unmodified main and uses
physical `hook-execute` and `extensionCommand` records rather than expectations
shared with production helpers. Gen3 waits for step 1's PostToolUse replay
entry before checking that its physical count stayed at one, so the assertion
cannot pass merely because recovery had not reached the callback.

Three sequential mutations all red the named test and restore
sha256-identically (`tmp/a3-command-hook-mutations.py`): ignoring a saved Hook
`resultRef`, ignoring a saved `tool_stage.resultRef`, and sharing one approval
ID between the two steps. CLI typecheck, ESLint and Prettier pass. The focused
result does not by itself claim MySQL/Linux packaged acceptance.

## Packaged evidence (implemented)

The named arm passed on the real ARM Linux/MySQL host with exit code 0
(`owner-r44`, Temurin 21, registered storage, delegated cgroup v2). The deployed
CLI bundle sha256 is
`ed8796473dd19b04eaab3247cb0e4e9d6dcd85985bb669d41e8713683c2f18b0`.
The crash/final/summary evidence is copied under `.qwen/e2e-tests/`
(`command-rewrite-crash-barrier.json`, `command-rewrite-result.json`,
`summary.json`, and the supporting approval/post-turn files).

The final evidence shows two distinct `command_approval_*` Actions with the two
rewritten inputs; Action 2 keeps its ID, `createdAt`, `expiresAt`, and
`inputRef` across gen3 and only then becomes decided. Both stages are settled
with `resultRef`; the actual PreToolUse/PostToolUse Hook for each stage has one
durable settled result and one physical execution; the two extension-command
receipts are settled; model traffic is one initial request plus one
after-results request. The relief Turn completes, the Session has two terminals,
and reliable close completes.

The runner evidence reader also needed three corrections: HEX-decode MySQL
resources instead of trusting `--batch` text escaping, match a Hook's command
stage from the persisted `tool_use_id` rather than the opaque `hook-plan-*`
occurrence, and exclude `__plan__` markers from actual Hook counts. The
Hook-profile arm skips the native `hosted-cleanup` receipt wait because its
component Runtime stays mounted between Turns, but it still proves relief and
reliable close.
