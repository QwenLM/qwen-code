# Turn-scoped skill and extension revisions

[English](turn-scoped-resource-revisions.md) | [简体中文](turn-scoped-resource-revisions.zh-CN.md)

**Status: RFC for maintainer feedback.** This proposal describes a possible serve-mode implementation and its acceptance tests. It changes no runtime behavior.

Discussion: [#18178](https://github.com/QwenLM/qwen-code/issues/18178).

## Problem and scope

A long-running turn can discover a skill or extension and then wait for approval before reading its script or invoking a tool. If a later publication overwrites the installation during that wait, the earlier turn can run instructions or executable resources from different revisions. Closing the event stream does not settle the approval or tool call. Operators also need to start a new turn with the newer revision while the earlier one waits.

The proposed guarantee covers Qwen-managed skills and extension resources used by a turn, including skill bodies and companion scripts, instruction fragments, tool and command definitions, hooks, subagents, and MCP clients or processes where they can be isolated. User workspace files, the model, and remote service state keep their current semantics. A revision does not preserve authorization or credentials. Approval and tool dispatch still apply current trust, permissions, and credential rules.

## Current behavior

The [extension store](../../packages/core/src/extension/extension-store.ts) and [storage paths](../../packages/core/src/extension/storage.ts) maintain installed extensions under user storage. Workspace enablement and [extension refresh](../../packages/cli/src/serve/routes/workspace-extensions-controller.ts) control discovery and update session state. A workspace boundary or a process that waits for current work to finish is useful for coordination, but does not create two isolated revisions of the same installation.

[Skill refresh](../../packages/core/src/tools/skill.ts) already invalidates outdated loaded bodies after discovery while preserving historical accounting. See [#12182](https://github.com/QwenLM/qwen-code/pull/12182). Deployment-managed extension paths in [#12147](https://github.com/QwenLM/qwen-code/issues/12147) are complementary. Neither feature binds a complete resource view to an admitted turn or allows old and new revisions to run concurrently in one execution domain.

## Proposed lifecycle

1. **Prepare an immutable revision.** Resolve a manifest within the authorized execution domain. Each managed entry records its source, stable identity, revision, and content digest. Include the effective activation and tool configuration in the manifest. Stage the verified bundle and build its resource view away from live discovery roots. A content digest verifies identity. Access still depends on the workspace, owning runtime, and trusted caller. A failed or interrupted preparation leaves the current revision available.
2. **Publish an active pointer.** Atomically make a prepared, validated revision the default for future admissions in its execution domain. Check the expected prior pointer and runtime generation so a delayed publisher cannot reactivate an older candidate after a more recent publication. Requests pinned before publication continue on the revision they acquired. Publication leaves history and approvals intact.
3. **Pin and acknowledge in the native admission path.** When an admission succeeds, it has a resource reference before the entry is accepted into the queue. An authenticated caller expecting a particular revision may supply an internal expectation, subject to separate capability and authorization checks. Otherwise the native default pointer is read at admission. Queue insertion and reference acquisition must share one ordering with cancel, publish, and collection. Release the reference if admission fails. Carry the reference in the queued turn and through the bridge to the executor. When the queued turn starts, it uses that reference even if the default pointer has advanced.
4. **Execute and release.** The executor resolves managed resources through the pinned view, including late reads and callbacks that resume after approval. A mid-turn message that stays with the active turn keeps its view. A message promoted to a separate turn must take a reference through admission. Key current-context skill deduplication by effective resource identity and preserve accounting for bodies already in history. Rebuild effective managed instructions when revisions change. Release references after the turn outcome and tracked native work, tool callbacks, and cancellation forwarding have settled. A closed event stream, an expired client request, or an emitted terminal event alone is not a release signal.
5. **Collect when safe.** Preserve the default pointer, authorized staging references, queued and running turns, unsettled approvals and tools, and supported recovery references. Reclaim only generations without reachable references, using the same ordering as publish and admission. Bound disk usage, retained revisions, and child processes. Under pressure, reclaim unreferenced material first, then reject new preparation with a retryable capacity outcome while existing turns keep their resources. A staged or retained revision does not grant permission to use it.

The [serve admission helper](../../packages/cli/src/serve/routes/session-prompt-admission.ts) and [ACP bridge control plane](../../packages/acp-bridge/src/session-control-plane.ts) own different parts of admission and execution. Retain the bridge's ordered queue and rejection behavior. Carry the resource reference at the native queue boundary instead of rediscovering mutable resources when the worker starts. Audit both HTTP and in-process entry points, channel deliveries, promoted messages, and side-task lifetimes. The [runtime activity gate](../../packages/cli/src/serve/conversations/conversation-runtime-activity.ts) provides coordination for draining; turn references must follow the actual native work lifetime.

## Receipts, compatibility, and recovery

The current admission helper's idempotency ring maps a key to a prompt in memory. The queue it protects is also in memory. Do not infer durable acceptance after a restart or eviction from that ring.

For a caller that needs crash-safe reconciliation, a follow-up protocol would associate an authorized operation ID, request identity, session and runtime generation, revision, and outcome. A matching retry can read the original receipt. Reusing the same ID with a different request or expected revision is a conflict. Explicitly distinguish confirmed non-admission from an unknown result. A query that cannot find the receipt after a crash is insufficient proof to repeat a tool-bearing turn. Automatic replay across a restart requires a durable, fenced admission and recovery contract. The initial in-process isolation slice can preserve an unknown outcome and decline replay across a restart.

Keep existing requests and wire responses compatible. Advanced expectations or receipt queries are capability-gated. An unsupported hook, process environment, shared port, or MCP transport must not be presented as isolated. Start simultaneous revisions only if their resources can be separated. Otherwise keep the previous view and wait for a safe drain, require a separately isolated runtime, or return a capability error. Mutable user files and arbitrary shell commands can still change outside this contract. Copied material alone does not provide a host filesystem sandbox. An extension archive also leaves external executables on PATH, Python environments, and other process-level dependencies mutable. Covering those dependencies requires immutable executable paths or isolated environments. Check optional tool capabilities on first use so a missing dependency affects only that tool invocation.

## Delivery and acceptance

1. Add an opt-in immutable resource view for standalone skills and their managed companion files. Teach native admission and the executor to hold the same view. Preserve existing clients, permissions, event formats, and history accounting. Cover success, queue rejection, cancellation before execution, late approval, and collection races with deterministic fixtures.
2. Extend support to extension-provided components. Enable each kind only after discovery, script reads, registration, subprocesses, and disconnect behavior demonstrably use the pinned view. Extend to restartable execution only with a reviewed durable receipt and recovery model.
3. Exercise an end-to-end fixture. Let turn A use revision 1 and wait for approval immediately before opening a managed script. Publish revision 2 and let turn B in a separate session on the same serve runtime run with revision 2. Then authorize A and assert revision 1's actual script output. The next turn in A's session must run revision 2. Also cover a queued older turn, a rejected or cancelled admission, a lost response, a broken publication, and collection racing admission. Compare content digests and tool outputs. For extensions with MCP, use a fixture server that identifies its revision and assert that A and B reach their respective servers. A version label alone is insufficient.

## Open questions

- Where should the immutable manifest and view live, and which existing trust and workspace boundaries should own their caches?
- Which components can share a Qwen serve runtime across revisions, and which require separate child processes or workspaces?
- Which supported entry points have durable operation identities today, and what is the smallest useful restart-reconciliation contract for callers that need it?
