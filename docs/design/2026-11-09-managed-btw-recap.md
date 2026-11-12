# Managed BTW and recap: reviewed design

[English](2026-11-09-managed-btw-recap.md) | [简体中文](2026-11-09-managed-btw-recap.zh-CN.md)

Status: implemented locally with focused verification; integrated acceptance is pending. Date: 2026-11-09. Reviewed main: `56ea1bc3fbb794bd42e62c532c7962164e7f3786`; the implementation starts from checkout `d32faa247dfed4e0612d6a52cdf3f467ca38e934`, whose relevant source matched that review. The [implementation plan](../plans/2026-11-09-managed-btw-recap.md) records delivery, evidence and remaining acceptance work.

## 1. Review decisions and scope

Provide durable, actor-private BTW follow-up conversations and manual/optional automatic recap for Managed Sessions, including ACTIVE Sessions whose Runtime has been reclaimed. Message deletion, branches, tool-enabled side tasks, and a general job framework are outside this change.

The user selected **explicit Session `model_config` only for v1**. Catalog/default-model Sessions do not advertise BTW or recap generation. Reuse the immutable encrypted Session configuration; do not add a deployment model resolver, fast-model setting, credential editor, or fallback to Harness credentials. A missing or invalid explicit configuration fails closed.

The review requires these corrections to the earlier proposal:

- Use query-specific Harness selection. The existing pool selector assigns or takes over Session placement.
- Reuse the existing retirement read lease, but add query-scoped journal/resource authorization. A retention lease is not read permission.
- Extract a pure model-history projection. Reader-facing records and a live Session authority are not interchangeable with a frozen model input; compression can contain excluded turns.
- Add actual collection of temporary input resources. Removing references alone does not reclaim their bytes in an active Session.
- Distinguish automatic from manual recap, define a stable conversation version, and isolate browser state by authenticated actor.
- Persist provider completion outcomes and account for asynchronous query work during Harness drain. Nonempty text and an HTTP 202 response are not proof of successful completion.

The reviewed open PRs #16408, #13914, #16472, #12430, #8783 and #16636 are references, not assumed merged dependencies. At implementation time inspect their actual changes again. Reuse compatible shared fixes when present; do not import daemon lifecycle or its process-local BTW state.

## 2. Product behavior

### BTW

- `/btw <question>` and a dedicated side-panel entry submit a private query; bare `/btw` opens the existing history. Limit a question to 4096 characters and use the current actor's latest 20 successful question/answer pairs.
- Each request freezes the main conversation through the latest successful completed turn, plus the selected private history. Running, failed and cancelled turns do not become new instructions in this input. Show the source completion boundary in the panel.
- Permit one active BTW query per tenant/Session/actor. Main generation, tool execution and approval waiting do not block it. Closing the panel, changing views or losing SSE does not cancel generation; Stop only cancels the side query.
- Only a normal provider completion with visible text enters follow-up history. Preserve partial text with a non-success reason for truncation, tool requests, filtering, errors or interruption. These records remain viewable but are excluded from later model input.
- No tools, Hooks, MCP, fresh memory recall/extraction, Workspace reads or main-transcript writes run for a side query. Existing allowed conversation content remains context; no new host or personal-memory context is injected.

### Recap

- `/recap` and a Recap action return one or two sentences in the conversation's language, describing the goal, progress and next step. Use the latest 30 visible dialogue messages from successful completed turns in the original transcript, not the compressed model history. Exclude tools, reasoning, startup scaffolding, memory injections and Hook additions using source provenance and the shared pure filtering helpers.
- Manual recap can run while the main task is busy. With no summarizable dialogue, return a completed `insufficient_context` outcome without a model call. Reuse a successful result for the same actor, input identity, model configuration digest and processing version; join an equivalent running request. An explicit retry after failure uses a new idempotency key.
- Automatic recap is off by default. Store the preference per product/tenant/actor in the browser. A qualifying away window lasts at least five minutes and starts while the preference is already enabled. On return, wait for the main task and its queue to become idle, then refresh server context.
- The first automatic recap requires at least three successful real-user turns. Later automatic recaps require at least two more than the latest successful recap, including a manual recap. Tools, background inputs, BTW and queued inputs do not increment this counter.
- At most one automatic attempt is admitted for a given actor and content version, including after failure. Switching Session/actor, disabling the setting or accepting a new main input invalidates a pending automatic display. Hidden tabs never display it. Automatic failure is silent; manual failure exposes retry.

### Availability and ownership

New generation requires ACTIVE status, explicit model configuration, supported storage/Harness capability and the caller's existing main-input execution authority. Share the authorization checks, not the main Turn's busy, Runtime or placement requirements. Read-only Session access cannot spend model credentials. Revalidate execution authority before dispatch and settlement; revalidate current Session visibility and query ownership on every read, subscription and cancellation.

Closing, archiving or deleting a Session fences and cancels its unfinished queries and prevents new ones. Authorized actors can read their retained results on closed or archived Sessions. Permanent deletion removes results and receipts. A main Turn cancellation does not cancel a BTW/recap query.

## 3. Durable state and frozen input

Add one `ma_side_query` table for kind, actor, trigger, original BTW question, source boundaries, processing/model digests, input reference, claim, deadline, status, result revision, answer text, completion reason, usage and cleanup state. Keep the question and answer after temporary input collection so successful pairs remain usable across refresh and later follow-ups. Keep this outside `ma_operation`, whose execution barriers would block the main Session.

Use the existing request-receipt mechanism with a new `SIDE_QUERY` namespace for actor-and-Session-scoped idempotency and aliases to reused results. Same key and request replay the original query; changed payload conflicts. Persist automatic content-version deduplication atomically, including when the automatic request joins an existing manual query. This avoids treating a client retry as a new model attempt.

The state machine is `preparing → running → completed | failed | cancelled | interrupted`; preparation can also terminate directly. Terminal state never regresses. A database-enforced active slot permits one query per actor/Session/kind; BTW and recap have separate slots. Distinguish logical cancellation from an executor that has not yet released its physical work slot.

Maintain a small server-side conversation summary in the existing Session-record projection: latest eligible completed-turn boundary, successful real-user turn count, conversation content version and latest main-input boundary. Derive completed-conversation facts from authoritative journal events and user provenance, not public `ma_turn` status, UI block count, Workspace `contextRevision`, or arbitrary journal traffic. Advance the main-input boundary transactionally on new primary-input admission, including durable queue admission before execution; idempotent replays do not advance it. Heartbeats, titles, usage and compression alone do not advance conversation content. Backfill older Sessions from verified journal/admission evidence; unavailable evidence must not become an invented zero count.

Input preparation follows this sequence:

1. In a short admission transaction, authorize, resolve receipts, freeze the journal revision/sequence/digest and conversation boundary, capture the explicit model digest and selected private history, and obtain the existing retention read lease. No model or network I/O occurs while Session/head locks are held.
2. Assign a query claim to a healthy accepting Harness supporting `side-query/1`. Its read grant binds tenant, Session, actor, query, instance/boot/generation and the frozen prefix. New internal read endpoints expose only that prefix and its verified resource closure, never arbitrary Session resources or writer powers.
3. The Harness validates the prefix and uses a pure TypeScript projection extracted from the existing model-record logic. Build successful-turn membership from `input.accepted` and `turn.settled`. Do not construct or acquire `LocalManagedSessionAuthority`.
4. Reuse a compaction checkpoint only when its covered turns can be proven eligible. Filtering `promptIds` cannot remove failed or unfinished content already merged into summary prose. Otherwise ignore that checkpoint and rebuild from the retained original successful turns. Do not generate a replacement summary or mutate main history.
5. Apply the existing model token-budget estimator with space reserved for output. Remove oldest private BTW pairs first, then oldest complete main turns; keep the current question and any retained safe summary. If the retained minimum cannot fit, return `context_too_large`. Never split a tool call/result pair or silently switch models.
6. Materialize the final input with the existing bounded resource/chunk encoding, respecting the 64 KiB inline boundary. Register each staged chunk against the query/claim as it is written. Final publication locks the query, verifies `preparing`, claim, deadline and Session eligibility, then atomically commits the complete `SIDE_QUERY` resource closure and `inputReady`. Release the preparation lease only after this commit; cancelled/expired queries cannot publish executable input. Terminal cleanup also covers chunks staged before manifest publication.

Preparation uses the existing non-renewing 120-second read-view budget. A query has a fixed five-minute overall deadline from admission; failure to prepare in time ends that request rather than recapturing a newer context under the same key. Source journal appends are allowed: input publication checks the captured prefix and query fence, not equality with the current live head. Do not route this through native snapshot publication, whose exact-current-head CAS has different semantics.

Terminal cleanup releases input references and schedules collection of dedicated side-query input kinds through the existing active-Session collector. Include failed preparation and abandoned staging. Collection must still respect other owners and read leases. Session retirement removes queries, scoped receipts and `SIDE_QUERY` ownership in bounded batches. Only result records survive ordinary query completion.

## 4. Execution and interfaces

### Execution isolation

Add instance-level submit/status/cancel operations to the Hosted protocol and Java SDK. A narrow pool method selects an accepting compatible instance without assigning Session placement. No Session attach/load, writer acquire, Runtime creation or Broker call is permitted. If no healthy instance or slot is available before admission, return a retryable unavailable response. If availability is lost after durable admission, fail the recorded query with that reason and replay its receipt; there is no unbounded work queue.

The query claim binds `queryId + instanceId + bootId + generation`. Read the explicit model configuration through a claim-authorized, `no-store` internal endpoint and verify its saved digest with the existing parser/decryptor. Credentials never enter public responses, query input resources or logs. Use a dedicated generator built from this configuration. Do not call the full Hook/main runner, load host settings, initialize a Session, select a fast model, read host output-language files, or alter process-global credentials/proxy state.

Use one model attempt for each query, with automatic model fallback and application/provider-SDK retries disabled for this execution path. BTW uses the configured model output budget; recap caps output at 300 tokens. Each Harness permits at most four simultaneous side queries in v1, with independent cancellation and accounting. Record usage, purpose, model and timing on the query; missing usage remains unknown. Do not modify main Turn budgets, main context occupancy or the main journal.

Before the external call, fully validate and load the frozen input and any referenced attachments into the final bounded in-memory request, then CAS `inputReady` plus a valid claim from `preparing` to `running`. No query/Session resource reads occur after that CAS. Serialize it with cancellation: cancellation winning first prevents the model call; cancellation after `running` is best-effort abort. This lets terminal cleanup release persisted input even when the provider promise has not settled. Duplicate internal submits cannot start a second call. Dispatch uncertainty, lost ownership, changed boot or expired claim produces `interrupted` without automatic redispatch, including uncertainty immediately before the external call. A user can retry with a new query. This is not a guarantee of exactly-once provider billing. All result writes check the claim and terminal state; late output cannot revive a cancelled request.

Hold instance work accounting until the actual provider promise settles, including when it ignores abort. Drain stops new query admission and waits for accepted work within its deadline. Pool member retention includes query claims, not just Session placements. Reconciliation fences orphaned queries and releases their owned input; it never replays a possibly started model call.

### Public and WebShell contracts

Under `/v1/agents/sessions/{sessionId}/side-queries`, provide collection create/list, `/context`, item get, item `/events` and item `/cancel`. Use POST for create/cancel and GET for reads/SSE. The WebShell equivalents live under `/api/agent/web-shell/v1/session-side-queries/` as POST `create`, `list`, `context`, `get`, `stream` and `cancel`, following its existing authenticated fetch conventions.

Create accepts `kind`, BTW `question`, recap `trigger: manual | automatic`, and the existing idempotency key. Automatic recap additionally requires the last-read `expectedContentVersion` and `expectedMainInputBoundary`; admission compares both atomically with eligibility, and a mismatch causes no model call. Public JSON follows existing snake_case, WebShell/provider JSON camelCase. Actor, tenant, model credentials and internal resource IDs are resolved server-side.

The context response includes opaque `actorScopeKey`, `contentVersion`, successful completed-user-turn count, latest main-input boundary, automatic eligibility, generation availability/reason and the latest successful recap's source boundary/count. Results include query ID, kind/trigger, status/outcome, source version, captured main-input boundary, result revision, text and safe usage/error information. Before automatic display, fetch current context and require matching actor, content and main-input boundaries plus main/queue idle; a failed or queued input in another tab invalidates the old window even if completed conversation content is unchanged. Pages use stable scoped cursors; out-of-scope query IDs and cursors reveal no data.

SSE emits full text/state snapshots with monotonically increasing revisions, persisted at most once per second and immediately at terminal state. Each stream immediately reads the current SQL snapshot and checks for newer revisions every second, including after reconnect; intermediate revisions may be coalesced. A preceding item GET is not the stream's only snapshot: completion between that GET and stream creation must still be delivered. This also works across control-plane instances without a new event log. This is an actor-private stream, not the shared Session event stream. Recheck authorization on each poll and close on revocation; send the final snapshot before ending a terminal stream.

Expose an optional `provider.sideQueries` with actual Java-provider consumers and separate Session BTW/recap generation capabilities. Intercept these built-ins before Managed's main-submit busy/queue branches; keep side-query pending state independent. Do not route them through daemon App callbacks. Namespace browser preferences and pending intents using the existing product key plus `actorScopeKey`, and add Session ID for Session-specific state. Before submission, save the original create parameters and idempotency key so refresh can replay an uncertain admission even without a query ID; clear that payload once admission is confirmed. Do not store credentials or answer bodies in browser persistence. Clear in-memory state and subscriptions when identity changes. The opaque key is a storage namespace, not an authorization token.

## 5. Delivery and validation boundary

Use a single deployment opt-in for new side-query admission, default off. Storage/read support, API contracts and matching Harness/SDK support land before enabling generation; the UI requires both provider support and Session capabilities. Disabling admission preserves authorized result reads and lets accepted work settle or be explicitly cancelled.

Follow the current unreleased schema policy: edit shared V1 in place, leave the schema version unchanged and recreate development catalogs. Update the table inventory, receipt/resource enums, retirement, collector and lock-contract inventories together. There is no promised upgrade path for an old development catalog or downgrade across a changed baseline.

The implementation has focused TypeScript/Java, API/schema/lock, real MySQL storage and real Java SDK-to-Hosted process evidence, recorded in the implementation plan. The process fixture uses a deterministic loopback model and callback store. It does not establish the complete SQL admission-to-Harness-to-durable-result path or production-provider behavior. Full CI profiles, browser/second-device flows and the broader fault matrix remain acceptance gates. New generation stays off by default through `qwen.managed-agent.side-queries-enabled` (`QWEN_MANAGED_AGENT_SIDE_QUERIES_ENABLED`).

First-version limits are explicit: inherited branch history without original provenance and remote file attachments fail closed; original successful records are reconstructed instead of trusting compaction prose; CSI application images containing side-query rows are rejected with `unsupported_first_lane`. No CSI transfer support, production model call or deployment is claimed.

Source anchors for the review: [pool selection](../../packages/managed-agent-server/adapters/src/main/java/com/alibaba/qwen/code/managedagent/harness/HarnessPoolConnector.java), [model-record projection](../../packages/core/src/managed-runtime/managed-session-message-projection.ts), [compression restoration](../../packages/core/src/services/session-api-history.ts), [explicit model configuration](../../packages/managed-agent-server/persistence/src/main/java/com/alibaba/qwen/code/managedagent/persistence/ManagedSessionModelConfigs.java), [active resource collection](../../packages/managed-agent-server/persistence/src/main/java/com/alibaba/qwen/code/managedagent/persistence/ManagedProjectionResourceCollector.java), [browser storage scope](../../packages/web-shell/client/components/managed/java-managed-agent-provider.ts).
