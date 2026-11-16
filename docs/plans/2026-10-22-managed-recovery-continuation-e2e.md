# Managed recovery continuation E2E plan

[English](2026-10-22-managed-recovery-continuation-e2e.md) | [简体中文](2026-10-22-managed-recovery-continuation-e2e.zh-CN.md)

## Scope and baseline

This plan verifies the [recovery design](../design/2026-10-22-managed-recovery-continuation.md) ([简体中文](../design/2026-10-22-managed-recovery-continuation.zh-CN.md)). It covers Hosted Workspace failure cancellation, original-input settlement, cleanup and subsequent use, plus WebShell recovery and editable text handoff. Cross-host HA, complete history cloning and new MCP/Hook continuation remain outside this release.

Before implementation, record `qwen --version` and attempt the relevant behavior with the globally installed CLI in an isolated runtime. The Java coordinator is a separate control plane: when the global entry cannot reach it, document that limitation and use a focused Java/Hosted test fallback against the exact baseline commit. The initial investigation uses `21337f0e5131`; retain failed assertions before changing the implementation. Do not build and substitute a new binary for the baseline.

## Isolated prerequisites

Use JDK 21, Maven 3.8.9+, Node 22+, the repository's pinned package manager, and disposable MySQL 8.4. Give the task its own runtime directories, database, ports and Maven repository; do not alter existing deployments. Install the current Java SDK into that repository. Build Core/CLI before Java native conformance tests, then bundle the current CLI before process tests. Run root build, bundle and typecheck serially so readers cannot observe partially replaced `dist` output.

MySQL must have `performance_schema` enabled. Before concurrency checks, use a real blocked transaction to confirm that `sys.innodb_lock_waits` and `performance_schema.data_lock_waits` expose the waiting lock. Version, login and isolation-level checks alone do not establish this prerequisite. Preserve any failed full-suite run, then correct the isolated fixture and rerun the full suite without weakening assertions.

The positive `recovery-settlement` fixture keeps a separate Broker process and its original worker alive while killing only the Java coordinator. Both use the real JDBC authority and Workspace mount; the coordinator suppresses its optional local prewarm through instance-local test wiring, while native acquisition and tool execution use the resident Broker. Assert that the Broker and same worker survive, and that the coordinator never creates a replacement worker. Durable workers use private runtime state outside Workspace roots; trusted whole-host reboot recovery stays disabled. Recovering an embedded Broker after its own loss is a separate Linux-only boundary requiring the existing trusted reboot authority. Without it, preserving the marker and staying blocked after Broker loss is the expected negative result.

Record tool versions, commit, selected tests, database engine and process identities. Keep credentials and machine-specific paths in ignored working artifacts. The detailed local report belongs in `.qwen/e2e-tests/managed-recovery-continuation.md`; this committed plan is not a claim that every scenario has passed.

## Behavioral matrix

| Group                     | Exercise                                                                                                                                 | Required observation                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cancellation admission    | Recovery refusal, protocol error and exhausted retries after possible submission; native input still running after cancellation ACK      | The cancellation-only intent is durable before cancellation; Java retains the driver and input stays blocked. A live attachment without takeover work still receives cancellation.                                                                                                                                                                                                                                                                   |
| Coordinator crash         | Kill Java after the marker and real native cancel admission while a real Workspace tool remains executing; restart the coordinator       | Only the original identity is inspected/cancelled. No input resubmission, continuation, model call or second tool dispatch occurs. After settlement, the same Session completes another Turn.                                                                                                                                                                                                                                                        |
| Native result and cleanup | Already committed terminal, missing Java admission response, unreadable tail after a committed delta, result/terminal/cleanup crash cuts | Replay the real unconsumed output and terminal exactly once; preserve the cursor. Read failures park. Cleanup debt stays visible and blocks admission without discarding confirmed output.                                                                                                                                                                                                                                                           |
| Initial state             | Safe cancellation before a first checkpoint; an empty Session renamed and reopened before its first input                                | A valid initial state permits the first/next Turn. Missing/corrupt journal, checkpoint, resource or identity evidence never proves readiness.                                                                                                                                                                                                                                                                                                        |
| Races and fencing         | Natural completion, user cancellation, failure recovery, two tabs, stale owner/generation and delayed native cancellation                | Confirmed terminal wins; retry budgets and original identities survive rechecks. Replay the captured original cancellation while the follow-up model is active: the later Turn must complete. Repeat a stale cancellation takeover load while the later input is parked: it must remain unchanged. Missing `targeted-cancel/1` refuses before any side-effecting load or send; stale requests cannot mutate a later Turn or release newer resources. |
| API and compatibility     | Read/recheck authorization, foreign tenant/Turn, cold attachment, older Harness and failed evidence reads                                | GET performs no load, execution or unlock. Recheck wakes only existing target work and coalesces. A 202 is scheduling only. Missing evidence remains blocked.                                                                                                                                                                                                                                                                                        |
| Browser recovery          | Refresh/network loss during cancellation, visibility changes, terminal SSE and a later Turn                                              | Retain the same idempotency key/operation. Poll unresolved recovery every five seconds only while visible. Terminal evidence refreshes readiness; an old operation cannot cancel a later Turn.                                                                                                                                                                                                                                                       |
| Text handoff              | Blocked Session with completed and partial history; unauthorized defaults; a source Workspace different from the server default          | Open the existing creation form with authorized source Workspace/cwd/Agent and an editable quoted draft; do not create/send automatically. Enforce 32 KiB UTF-8, whole confirmed user/assistant messages, explicit uncertainty/truncation, and exclusion of tool output, partial output, approvals and execution identities. Preserve Workspace admission.                                                                                           |

The coordinator-crash cell retains the exact original cancellation request for A, settles A, and holds the same Session's next Turn B in an active model call. Replay A before releasing B: it must remain scoped to A, return idempotently, and let B complete with `FOLLOW_UP_OK`. Preserve the single original tool execution and binding generation 1 through the end. Focused protocol tests separately cover delayed cancellation takeover loads and capability refusal before any side-effecting request. Warm and cold cancellation of the sole parked ordinary input must still work beside an already queued wake input. Isolate the independent wake pump in this fixture and verify the cancellation chain does not act on queued work. Cover successful managed-runtime cancel/continue replays for terminal A while B holds a recovered Runtime: B must remain held and unreleased, while a replay can still retry its own original A cleanup.

The initial-state negative fixture must use the existing authorized commit path to create a fresh complete genesis with matching resource references, byte lengths and digests, but unreadable managed-definition JSON. It must remain blocked without directly mutating stored resources or weakening integrity checks. Keep the real Core-generated and cold-reopened valid fixture as the positive control.

For a terminal Java Turn, exercise a Harness generation change at both the status read and cleanup mutation. The discovering POST must return the mismatch, evict only stale connector identities and allow a later explicit recheck to negotiate cleanup-only recovery; GET must not negotiate or load. Pause a cold cleanup load across generation adoption and attachment publication: its delayed old ref must neither repopulate the stale cache nor overwrite a newer winner. Resolving the attachment or authorization must not leave the following status/cleanup RPC using a client that was replaced during that work.

Ownership assertions must follow the baseline's actual protocol. Ordinary LOCAL claims use shared Storage membership even with Session-isolated Runtime bindings. A neutral exclusive-owner row requires strict proof of the unique original member, tenant/Session/Workspace scope, capability/profile, ready binding and mount, matching physical Storage and unchanged generation, with `execution_exclusive=false`. Exclusive claims retain the original complete owner assertions. Do not replace ownership checks with nullable acceptance or relax execution identities, dispatch counts, fault signals, journal checks or single-effect assertions.

## Reusable commands

Run package tests from their package directories. From `packages/cli`, run the native status tests and the targeted recovery-cleanup cases in `src/serve/hosted-harness-session.test.ts`; record the selector and excluded count. From `packages/web-shell`, run the affected provider, Session/recovery/cancel hooks, Session page, Workspace creator and handoff tests. The browser fixture must exercise the gate, operation tracking after reload and editable handoff through real Chromium; record that its HTTP adapter is controlled.

Also cover cancellation without durable operations: an acknowledged A delivery must not prevent a later explicit stop of B; a failed A still lacking matching ready proof stays unconfirmed. Lost replies retain the original key and Turn, and a stale or foreign Session response cannot retire delivery tracking. Retiring an acknowledged delivery slot never labels A cancelled or changes the recovery send gate.

From the repository root, prepare the final artifacts in sequence:

```bash
npm run build
npm run bundle
npm run typecheck
```

From `packages/managed-agent-server`, use task-specific environment values for the current absolute Node/CLI paths, Maven repository and disposable database credentials:

```bash
managed_verify() {
  mvn --batch-mode --no-transfer-progress \
    "-Dmaven.repo.local=$QWEN_TEST_MAVEN_REPOSITORY" \
    "-Dnode.executable=$QWEN_TEST_NODE" \
    "-Dqwen.cli.entry=$QWEN_TEST_CLI" \
    "-Dmysql.url=$QWEN_TEST_MYSQL_URL" \
    "-Dmysql.user=$QWEN_TEST_MYSQL_USER" \
    "-Dmysql.password=$QWEN_TEST_MYSQL_PASSWORD" "$@"
}

managed_verify '-Dtest=RecoverySettlementTest,RecoverySettlementStoreTest,HarnessCoordinatorTest,AdmittedTurnRetryTerminalStateTest,SessionRecoveryServiceTest,SessionRecoveryInitialStateTest,ManagedAgentApiContractTest,SurfaceRegistryGateTest' test

managed_verify -Phosted-harness-mysql -Dit.test=HostedProcessCrashIT \
  -Dqwen.fg6c.case=recovery-settlement verify

managed_verify -Pmysql-integration clean verify

managed_verify -Phosted-harness-mysql -Dit.test=HostedProcessCrashIT verify

managed_verify -Phosted-harness-gates -Dit.test=HostedRecoveryWedgeGate verify
```

The combined `mysql-integration` verification runs the complete unit/H2 suite, real MySQL integration tests, Checkstyle and SpotBugs. Preserve the smoke evidence before `clean`. The Hosted profile deliberately skips repeated unit tests and still executes the selected process cases. Its database isolation clears managed tables between top-level Hosted classes, so the database must be exclusively owned by this invocation. Regenerate the public frontend types from OpenAPI and verify the affected Java SDK and SurfaceRegistry contracts in the same change.

## Evidence boundaries

The full `HostedProcessCrashIT` command must omit `qwen.fg6c.case`. Its two JUnit methods exercise nine windows: Harness prepare/start/unknown/result, Spring SIGKILL, worker SIGKILL/SIGSTOP, cancellation-admission restart with a delayed original-cancellation replay during the follow-up, and coordinator-only resident reattachment. In a selected smoke run, the other method returns without exercising a window; do not count that as another process acceptance. Preserve actual signals, tool/model/submission counts, native activity before release, native terminal projection and completed follow-up output.

The generic Store H2/MySQL fixtures test marker/lease/cursor/terminal SQL and do not alone establish Workspace integration. The non-null Workspace coordinator fixture and real Workspace process case cover that boundary. A real browser with a controlled HTTP adapter proves UI behavior, not backend recovery; a deterministic model with real Java/Harness/Broker/worker processes proves the exercised execution protocol, not live-model quality.

Recovery reads must not load, acquire a new authority, execute or unlock. Existing resource reads can renew an already held writer lease or update verification metadata; do not equate this execution boundary with zero SQL/HTTP writes.

`HostedRecoveryWedgeGate` tests whether a blocked Session prevents other Sessions from progressing, but explicitly requires Linux physical Workspace storage. `HostedShellLifecycleRecoveryIT` and `HostedExtensionsIT` are Linux-only; extension acceptance also needs a delegated cgroup v2 subtree. Record macOS skips/unavailable checks, preserve the Linux follow-up command, and never treat a skip as recovery evidence. Do not spoof the OS or weaken a gate to obtain a green result.

## Acceptance and reporting

A safely settled Session must display confirmed output and complete a later Turn without duplicate effects. A Session lacking trustworthy proof must stay blocked and offer a usable editable handoff without bypassing admission or creating work automatically.

Report baseline reproduction, focused checks, complete Maven/MySQL results, each actual process window and browser results separately. Include failures and their resolution, deliberate interruptions, excluded tests and platform limitations. Retain exact local commands and logs in the ignored report; do not add overlapping reruns as unique test counts. Keep both language plans and designs synchronized and reciprocally linked.

Final execution on 2026-10-22 completed the available macOS scopes: root build/bundle/typecheck, 754 CLI tests, 479 WebShell tests and 3 controlled-adapter Chromium cases; SDK verify (403 tests, 9 configured skips); complete unit/H2 (5,280 tests, 18 documented conditional skips); real MySQL 8.4 (1,067 tests, no skips); and the unfiltered Hosted class (2 JUnit methods, all 9 fault windows, no skips). These final runs have zero failures/errors. Checkstyle and server SpotBugs are clean. The Linux physical-Workspace gate ran with one macOS platform skip; Linux lifecycle/extensions and delegated-cgroup acceptance remain unverified. The [design](../design/2026-10-22-managed-recovery-continuation.md) and ignored execution report record the evidence and limits; preserve all earlier failed or interrupted invocations separately.
