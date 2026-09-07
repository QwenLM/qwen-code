# Mesh steps 2-3 — implementation brief

> For the agent implementing §5.2 steps 2 (capability boundary) and 3 (versioned storage protocol) of [`2026-09-06-multi-agent-board-collaboration.md`](./2026-09-06-multi-agent-board-collaboration.md). Gates and evidence are in [`2026-09-07-mesh-implementation-acceptance.md`](./2026-09-07-mesh-implementation-acceptance.md); this file records what a source read of the branch found that the implementer should not have to rediscover, plus three places where the design and the runtime disagree.
> Branch head when written: `fc869431f9` (PR #11206). Runtime facts at `origin/main @ 703678136a`. Nothing here was executed except the baseline test run in §5.

## 1. Seams to reuse — do not build parallel ones

| Need                                | Existing                                                                                          | Where                                                                                                                     | Note                                                                                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Execution-layer tool allowlist      | `ToolConfig.executionAllowedTools`                                                                | `agents/runtime/agent-types.ts:88-100`; enforced `agent-core.ts:1599`; parsed `:505-518`                                  | Exact names plus MCP `server*` patterns. Calls outside it are rejected before scheduling or approval. This is the seam for "definition may narrow, never widen" |
| Declaration filtering and blocklist | `toolConfig.tools`, `toolConfig.disallowedTools`                                                  | `agent-core.ts` `prepareTools`                                                                                            | Explicit lists are already filtered through `EXCLUDED_TOOLS_FOR_SUBAGENTS` (`agent-core.ts:203`, 20 control-plane tools)                                        |
| Definition → runtime config merge   | `convertToRuntimeConfig`                                                                          | `subagents/subagent-manager.ts:893`                                                                                       | Accepts a `toolConfigOverride`; the mesh launcher (step 4) passes the boundary here                                                                             |
| Read-only shell classification      | `classifyShellCommandSafetyInDirectory(command, cwd)` → `'read-only' \| 'write' \| 'unknown'`     | `utils/shellAstParser.ts:1186`; root table `:83`, git/npm/yarn/pnpm/docker/pip/cargo/kubectl subcommand tables `:169-538` | tree-sitter WASM; tests call `initParser()` in `beforeAll`. `shell.ts:2140` uses it only to skip confirmation, never to refuse, so refusal is new wiring        |
| Tool name enumeration               | `ToolNames`                                                                                       | `tools/tool-names.ts:21-69`                                                                                               | The classification test enumerates `Object.values(ToolNames)`                                                                                                   |
| Store primitives                    | `proper-lockfile`, `async-mutex`, `atomicWriteJSON(..., {noFollow})`, `Storage.setRuntimeBaseDir` | `mesh-store.ts`, tests                                                                                                    | Keep                                                                                                                                                            |
| Two-process tests                   | `tsx`                                                                                             | `node_modules/.bin/tsx`                                                                                                   | Spawn `tsx <script.ts>` twice against one runtime dir passed by env                                                                                             |

## 2. Step 2 — capability boundary

**Shape.** One module, `mesh/capability.ts`:

- `MESH_TOOL_CLASSIFICATION: Record<string, 'allow' | 'deny' | 'thread'>` keyed by tool name, covering every `ToolNames` value; `classifyMeshTool(name)` returns the entry or `'deny'` for anything unlisted (MCP tools included).
- `buildMeshToolConfig(definitionTools?)` → `ToolConfig` with `tools = (definition ∩ allow) ∪ thread_*` (a `'*'` or absent definition list means the full allow set), `executionAllowedTools` equal to that list, `disallowedTools` equal to the deny set. The launcher passes it as `toolConfigOverride`.
**Confirmed v1 classification:** allow `read_file`, `grep_search`, `glob`, `list_directory`, `zoom_image`, `display_image`, `skill`, `tool_search`, `structured_output`, and `get_goal`. Deny `run_shell_command`, `edit`, `write_file`, `notebook_edit`, `save_memory`, `web_fetch`, `web_search`, `lsp`, `monitor`, `read_mcp_resource`, `ask_user_question`, `enter_plan_mode`, `exit_plan_mode`, `image_gen`, `update_goal`, `propose_goal`, `report_findings`, and everything in `EXCLUDED_TOOLS_FOR_SUBAGENTS`. MCP names also fail closed. Shell can return only with a filesystem sandbox that confines reads to the canonical workspace root; classifying a command as read-only does not provide that boundary.

**Resolved by the owner.** V1 mesh agents get no MCP tools. Future admission requires an explicit policy that proves the individual tool is read-only; the definition may narrow that policy but cannot widen it.

## 3. Step 3 — versioned storage protocol

**Files.** `mesh/workspace.json` (singleton: `schemaVersion`, `workspaceId`, optional `hostSessionId`, `nextRunSequence`); `mesh/agents.json` becomes `{schemaVersion, agents}` — it is a bare array today, so a v0→v1 migration exists from the first release; `mesh/threads/<id>.json` gains `schemaVersion`.

**Lock.** One workspace mutex (in-process `Mutex` keyed by mesh dir) plus `proper-lockfile` on `workspace.json`. Every public entry point acquires it exactly once and hands internals a transaction object; the per-file locks go away. The mutex is not reentrant: add an `AsyncLocalStorage` flag so a nested acquisition throws a clear error instead of deadlocking.

**Sequences.** `ThreadMessage.sequence` from `Thread.nextMessageSequence`. `ThreadRun.queueSequence` from `workspace.nextRunSequence`, written to `workspace.json` _before_ the thread file so a crash between the two leaves a gap, never a duplicate. `queuedAt` stays diagnostic.

**Tokens.** `ThreadRun.usageByRound: {attempt, round, tokens}[]`, upserted by key; `Thread.tokensUsed` becomes a derived cache of its own runs, recomputed on every write; the tree total is a scan of threads sharing `rootThreadId` under the lock. No token outbox, no `appliedTokenChargeIds`.

**Outbox.** `Thread.outbox: ThreadEvent[]` on the _source_ thread: `{id, kind: 'parent_report' | 'notification', causedByRunId?, payload, status: 'pending' | 'acknowledged', attempts, createdAt}`. Protocol per event: persist `attempts + 1` → apply to target → persist `acknowledged`. Target idempotency for parent reports: `ThreadMessage.originEventId`; `postMessage` called with an `originEventId` that already exists returns the persisted message and its outcomes without booking (the design's "retry with the same key" rule). `deleteThread` refuses while any event is pending.

**Outcomes on the message.** `ThreadMessage.outcomes: MessageOutcome[]` (flat record, not the `DispatchDecision` type, to avoid a types↔policy import cycle). The `otherThreads` option on `postMessage` is removed; the queue count is read from disk inside the lock.

**Migration.** `ensureMigrated(projectRoot)` at every entry: fast path when `workspace.json` is current; otherwise take the lock, for each v0 file write `<name>.v0.json`, write the migrated file atomically, read it back through the validator, then delete the backup. A file with a newer version throws a typed schema error. A file with no version after migration has run is a hand edit and fails closed with a message naming the migration. The legacy aggregate `tokensUsed` is preserved as synthetic round 0 on its final legacy run; a non-zero aggregate without a run fails closed instead of being discarded.

**Schema batching — resolved by the owner.** V1 declares and validates the whole §3 shape now, including the fields whose producers land in steps 5-8. Those fields remain optional until their producer exists. This is an explicit storage-version decision: it avoids serial migrations for one already-designed contract and does not claim the later runtime behavior is implemented.

**Named tests and what each proves.**

- `capability.test.ts`: every `ToolNames` value is classified; unlisted name → deny; `'*'` and narrowing definitions; shell is absent from tool configuration and refused by the invocation guard.
- `mesh-store.test.ts`: newer `schemaVersion` on thread, agents, and workspace each fail closed; v0 fixtures (bare agents array; thread without version but with messages and runs) migrate with sequences assigned in order and the backup removed; deletion refused with a pending event; a thread-write crash after allocation leaves a run-sequence gap; crash injection — `apply` writes the target then throws, second run finds the message by `originEventId`, event acknowledged with `attempts === 2`, exactly one target message; depth-3 tree with a stale `tokensUsed` on the root gates on the true sum.
- `workspace-lock.test.ts`: two `tsx` child processes allocate N `queueSequence` each; all 2N unique, each process strictly increasing.
- `thread-actions.test.ts`: fixtures gain the new fields; message `sequence` monotonic; `queueSequence` increasing across two threads; outcomes persisted on the message; `queue_full` computed from disk.

## 4. Runtime preparation merged into #11206

- #11200 (cumulative `USAGE_METADATA.round`): `usageByRound` is keyed on it. Without it the key collides across a `finishingInputs` segment.
- #11202 (`deliveryId` on structured external input): step 5's `consumedMessageIds`.
- #11204 (typed resident continuation): step 6's dispatcher branch.

All three are merged into `codex/multi-agent-mesh-foundation` in the order #11200 → #11204 → #11202. The expected final conflict was resolved by keeping both contracts: structured `AgentExternalInput` delivery and typed continuation outcomes. GitHub records the draft PRs as merged because this branch was their base; their review history remains available, and #11206 is the only implementation and delivery PR.

## 5. Test harness on a build-less box (observed)

A worktree at the branch head with `node_modules` and `packages/core/node_modules` symlinked to a main checkout's, plus fourteen `export {};` stubs for the `./dist/*` entries in `packages/core/package.json` `exports` (gitignored), satisfies `scripts/vitest-global-setup.js`. Step 3 observed: `mesh-store.test.ts`, `workspace-lock.test.ts`, `thread-actions.test.ts`, `dispatch-policy.test.ts`, and `mentions.test.ts` → 5 files, 59 tests passed. Run named files only.

## 6. Still unexecuted after steps 2-3

`queueExternalInput(false)` detach/rebook (step 6/7); assignment trigger through admission (decision 21, step 5/6); creating and reviving the hidden host session recorded by `workspace.json` (step 4).
