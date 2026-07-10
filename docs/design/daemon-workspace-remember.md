# Daemon Workspace Memory Tasks — Sessionless Managed Memory

> **Status**: Proposed — implementation in [PR #5884](https://github.com/QwenLM/qwen-code/pull/5884) (branch `codex/sessionless-daemon-remember`), not yet merged.

---

## 1. Problem Statement

The daemon's managed-memory system (auto-extraction, dream agent) previously
required an active chat session to write memories. This created two problems:

1. **Settings UI cannot write memories** — the web-shell settings panel needs to
   save user-provided facts (e.g. "always use TypeScript strict mode") without
   creating or polluting a visible chat session.
2. **Session list pollution** — creating a throwaway session just to run a
   `/remember` command adds noise to the session list and confuses users who see
   ghost sessions they never opened.

The solution is a **sessionless workspace-level memory task API** that queues
remember, forget, and dream tasks, executes them without creating a visible
session, and exposes status via polling.

---

## 2. Design Overview

```
┌──────────────┐  POST /workspace/memory/{task}      ┌─────────────────────────┐
│  SDK / UI    │ ─────────────────────────────────►  │  workspace-remember.ts  │
│  client      │                                     │  (WorkspaceRemember-    │
│              │  GET  /workspace/memory/{task}/:id  │   TaskLane)             │
│              │ ─────────────────────────────────►  │                         │
└──────────────┘                                     └────────────┬────────────┘
                                                                  │ bridge.runWorkspaceMemory*
                                                     ┌────────────▼────────────┐
                                                     │  HttpAcpBridge          │
                                                     │  extMethod(             │
                                                     │    'qwen/control/       │
                                                     │     workspace/memory/   │
                                                     │     {task}')            │
                                                     └────────────┬────────────┘
                                                                  │ ACP stdio (JSON-RPC)
                                                     ┌────────────▼────────────┐
                                                     │  qwen --acp child       │
                                                     │  (QwenAgent.extMethod)  │
                                                     │  → remember / forget /  │
                                                     │    dream core logic     │
                                                     └─────────────────────────┘
```

Key properties:

- **No session required** — the bridge ensures the ACP child is spawned but does
  not create/load/resume any ACP session.
- **Serial execution** — tasks execute one at a time via a promise-chain lane,
  preventing concurrent writes to the managed memory filesystem.
- **Hidden** — remember/dream run through hidden agents and forget uses a hidden
  memory config; none of the operations create visible sessions.
- **Capability-advertised** — `workspace_memory_remember`,
  `workspace_memory_forget`, and `workspace_memory_dream` in the daemon's
  `/capabilities` response. Remember also advertises
  `modes: ['workspace', 'clean']`.

---

## 3. API Endpoints

### 3.1 `POST /workspace/memory/remember`

Queue a new remember task.

**Request:**

```json
{
  "content": "The user prefers dark mode in all editors",
  "contextMode": "workspace"
}
```

| Field         | Type     | Required | Description                                                                                                 |
| ------------- | -------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `content`     | `string` | yes      | The fact to remember. Max 64 KiB (UTF-8 byte length).                                                       |
| `contextMode` | `string` | no       | `"workspace"` (default) — agent sees workspace memory context. `"clean"` — agent sees no prior user memory. |

**Headers:**

- `Authorization: Bearer <token>` (required)
- `X-Qwen-Client-Id: <clientId>` (optional — scopes task visibility)

**Response `202 Accepted`:**

```json
{
  "taskId": "remember-a1b2c3d4-...",
  "status": "queued",
  "contextMode": "workspace",
  "createdAt": "2026-06-01T12:00:00.000Z",
  "updatedAt": "2026-06-01T12:00:00.000Z"
}
```

**Error responses:**

| Status | Code                         | Condition                                       |
| ------ | ---------------------------- | ----------------------------------------------- |
| 400    | `invalid_content`            | Missing, empty, or oversized content            |
| 400    | `invalid_context_mode`       | Unrecognized contextMode value                  |
| 400    | `invalid_client_id`          | X-Qwen-Client-Id not registered with the bridge |
| 409    | `managed_memory_unavailable` | Managed memory not configured for workspace     |
| 429    | `remember_queue_full`        | 16 pending tasks already queued                 |
| 500    | `remember_failed`            | Availability check threw unexpectedly           |

### 3.2 `GET /workspace/memory/remember/:taskId`

Poll task status.

**Headers:**

- `Authorization: Bearer <token>` (required)
- `X-Qwen-Client-Id: <clientId>` (optional — must match originator to see task)

**Response `200 OK` (queued/running):**

```json
{
  "taskId": "remember-a1b2c3d4-...",
  "status": "queued",
  "contextMode": "workspace",
  "createdAt": "2026-06-01T12:00:00.000Z",
  "updatedAt": "2026-06-01T12:00:00.000Z",
  "result": null,
  "error": null
}
```

- `status` will be `"queued"` or `"running"` depending on whether the task has
  started execution.
- `result`: only present (non-null) when `status === "completed"`.
- `error`: only present (non-null) when `status === "failed"`.

**Response `200 OK` (completed):**

```json
{
  "taskId": "remember-a1b2c3d4-...",
  "status": "completed",
  "contextMode": "workspace",
  "createdAt": "2026-06-01T12:00:00.000Z",
  "updatedAt": "2026-06-01T12:00:05.000Z",
  "result": {
    "summary": "Saved dark-mode preference to user memory.",
    "filesTouched": ["~/.qwen/memories/user/user.md"],
    "touchedScopes": ["user"]
  }
}
```

**Response `200 OK` (failed):**

```json
{
  "taskId": "remember-a1b2c3d4-...",
  "status": "failed",
  "contextMode": "workspace",
  "createdAt": "2026-06-01T12:00:00.000Z",
  "updatedAt": "2026-06-01T12:00:03.000Z",
  "error": {
    "code": "remember_path_escape",
    "message": "Remember agent touched a path outside managed memory."
  }
}
```

**Error responses:**

| Status | Code                      | Condition                                            |
| ------ | ------------------------- | ---------------------------------------------------- |
| 400    | `invalid_client_id`       | X-Qwen-Client-Id not registered                      |
| 404    | `remember_task_not_found` | Task does not exist or belongs to a different client |

---

### 3.3 `POST /workspace/memory/forget`

Queue a forget task. The daemon selects matching managed auto-memory entries
and removes them without creating a session.

**Request:**

```json
{
  "query": "old preference"
}
```

| Field   | Type     | Required | Description                                                             |
| ------- | -------- | -------- | ----------------------------------------------------------------------- |
| `query` | `string` | yes      | Natural-language description to forget. Max 64 KiB (UTF-8 byte length). |

The initial response is `202 Accepted` with a `forget-...` task id. Poll
`GET /workspace/memory/forget/:taskId` until terminal.

**Completed result:**

```json
{
  "summary": "Forgot 1 memory entry.",
  "removedEntries": [
    {
      "topic": "project",
      "summary": "old preference",
      "filePath": "/path/to/memory.md"
    }
  ],
  "touchedTopics": ["project"],
  "touchedScopes": ["project"]
}
```

### 3.4 `GET /workspace/memory/forget/:taskId`

Poll forget task status. The shape matches remember task polling, except there
is no `contextMode` field and terminal failures use `forget_task_not_found` for
unknown or unauthorized task ids.

### 3.5 `POST /workspace/memory/dream`

Queue a dream task. The daemon runs the managed auto-memory dream compaction
flow without creating a session.

**Request:** empty JSON object or no body.

The initial response is `202 Accepted` with a `dream-...` task id. Poll
`GET /workspace/memory/dream/:taskId` until terminal.

**Completed result:**

```json
{
  "summary": "Managed auto-memory dream completed.",
  "touchedTopics": ["project"],
  "dedupedEntries": 1
}
```

### 3.6 `GET /workspace/memory/dream/:taskId`

Poll dream task status. The shape matches remember task polling, except there
is no `contextMode` field and terminal failures use `dream_task_not_found` for
unknown or unauthorized task ids.

---

## 4. Task Lifecycle

```
            enqueue()
               │
               ▼
  ┌─────────────────────┐
  │       queued         │   (awaiting serial lane slot)
  └──────────┬──────────┘
             │  lane picks up
             ▼
  ┌─────────────────────┐
  │       running        │   (bridge.runWorkspaceMemoryRemember in progress)
  └──────────┬──────────┘
             │
     ┌───────┴────────┐
     ▼                ▼
┌──────────┐    ┌──────────┐
│ completed│    │  failed  │
└──────────┘    └──────────┘
```

- **queued** — task is created and waiting in the serial lane.
- **running** — the bridge call is in flight; the forked agent is executing.
- **completed** — agent finished successfully; `result` is populated.
- **failed** — agent threw or timed out; `error` is populated.

The lane stores up to **1000 tasks** total (terminal tasks evicted FIFO when the
cap is reached). At most **16 tasks** may be pending (queued + running) at any
time. Forget and dream tasks share a smaller **8 pending task** cap so bursty
manual maintenance cannot consume every slot needed by automatic remember work.

---

## 5. Implementation Details

### 5.1 Serial Task Lane (`WorkspaceRememberTaskLane`)

Located in `packages/cli/src/serve/workspace-remember.ts`. Maintains a
`Map<taskId, TaskRecord>` and a single promise chain (`this.tail`). Each
`enqueue()` appends a `run` function that:

1. Sets status to `running`.
2. Calls the matching bridge method:
   `runWorkspaceMemoryRemember`, `runWorkspaceMemoryForget`, or
   `runWorkspaceMemoryDream`.
3. On success: sets status to `completed`, populates `result`, and publishes a
   `memory_changed` event when the task actually touched managed memory.
4. On failure: sets status to `failed`, populates `error` with a stable public
   error code.

The lane guarantees strict serialization — only one workspace memory task
executes at a time, preventing concurrent filesystem writes to managed memory.

### 5.2 Bridge Layer (`HttpAcpBridge`)

Workspace memory methods added to `BridgeInterface`
(`packages/acp-bridge/src/bridgeTypes.ts`):

- `isWorkspaceMemoryRememberAvailable()` — calls
  `qwen/control/workspace/memory/remember/availability` ext-method on the child.
  Returns `boolean`. Used for fast-fail `409` before queuing.
- `runWorkspaceMemoryRemember(request)` — calls
  `qwen/control/workspace/memory/remember` ext-method. Times out at **300 s**
  (`WORKSPACE_MEMORY_REMEMBER_TIMEOUT_MS`). Does NOT create or load a session.
- `runWorkspaceMemoryForget(request)` — calls
  `qwen/control/workspace/memory/forget` ext-method and uses the same bridge
  timeout. Does NOT create or load a session.
- `runWorkspaceMemoryDream()` — calls `qwen/control/workspace/memory/dream`
  ext-method and uses the same bridge timeout. Does NOT create or load a
  session.

Both methods call `ensureChannel()` (spawning the ACP child if needed) and
restart the idle timer afterwards if no sessions are active.

### 5.3 ACP Child Execution (`QwenAgent.extMethod`)

In `packages/cli/src/acp-integration/acpAgent.ts`, the handler for
`workspaceMemoryRemember`, `workspaceMemoryForget`, and `workspaceMemoryDream`:

1. Validates task-specific input (`content`/`contextMode` for remember,
   `query` for forget).
2. Checks `config.isManagedMemoryAvailable()`.
3. Calls the matching core operation with a **295 s** abort signal
   (`WORKSPACE_MEMORY_REMEMBER_CHILD_TIMEOUT_MS` — slightly less than the bridge
   timeout to ensure the child aborts before the bridge backstop). For forget,
   the signal is threaded through `MemoryManager.forget`, selection, the model
   side query, and apply-time filesystem mutations.

### 5.4 Core Remember Logic (`packages/core/src/memory/remember.ts`)

`runManagedRememberByAgent()`:

1. Builds a clean memory system prompt from the project's managed memory index.
2. Optionally strips prior user memory (if `contextMode === 'clean'`).
3. Creates a `memoryScopedAgentConfig` that restricts file I/O to memory
   directories only.
4. Runs a **forked headless agent** (`runForkedAgent`) with:
   - Name: `managed-auto-memory-remember`
   - Tools: `read_file`, `grep`, `ls`, `write_file`, `edit`
   - Max turns: 6
   - Max time: 5 minutes
5. Validates that all touched files are within allowed memory paths
   (`classifyTouchedScopes`). Throws `remember_path_escape` if the agent wrote
   outside memory directories.
6. Rebuilds memory indexes for any touched scopes.
7. Returns `{ summary, filesTouched, touchedScopes }`.

### 5.5 Memory-Scoped Agent Config (`packages/core/src/memory/memory-scoped-agent-config.ts`)

`createMemoryScopedAgentConfig()` creates a permission-restricted `Config`
wrapper that:

- **Write tools** (`write_file`, `edit`): only allowed within the project
  auto-memory root or user memory root (`~/.qwen/memories`).
- **Read tools** (`read_file`, `grep`, `ls`): when `restrictReadsToMemoryPaths`
  is true, only allowed within memory directories.
- **Shell**: disabled by default; if enabled, only read-only commands allowed.
- Resolves symlinks to prevent path-traversal escapes.

---

## 6. Events

### `memory_changed` (scope: `managed`)

Published on the daemon SSE event stream (`GET /session/:id/events`) as a
`memory_changed` event with `scope: 'managed'` when a workspace memory task
completes successfully and actually touches managed memory. Clients subscribed
to the per-session event stream receive this notification.

**Payload:**

```json
{
  "type": "memory_changed",
  "data": {
    "scope": "managed",
    "source": "workspace_memory_remember",
    "taskId": "remember-a1b2c3d4-...",
    "touchedScopes": ["user", "project"]
  }
}
```

| Field           | Type        | Description                                                                               |
| --------------- | ----------- | ----------------------------------------------------------------------------------------- |
| `scope`         | `"managed"` | Discriminates from file-based `memory_changed` events                                     |
| `source`        | `string`    | `"workspace_memory_remember"`, `"workspace_memory_forget"`, or `"workspace_memory_dream"` |
| `taskId`        | `string`    | Correlates with the task returned by POST                                                 |
| `touchedScopes` | `string[]`  | Which managed memory scopes changed: `"user"`, `"project"`                                |

The `originatorClientId` (if provided at POST time) is attached to the event
envelope so the event bus can route it to the originating client.

---

## 7. Error Handling

### Error Codes

| Code                         | Origin              | Meaning                                                |
| ---------------------------- | ------------------- | ------------------------------------------------------ |
| `invalid_content`            | HTTP route          | Content missing, empty, or exceeds 64 KiB              |
| `invalid_context_mode`       | HTTP route          | contextMode not `"workspace"` or `"clean"`             |
| `invalid_query`              | HTTP route          | Forget query missing, empty, or exceeds 64 KiB         |
| `invalid_client_id`          | HTTP route          | Client-Id header not in bridge's known set             |
| `managed_memory_unavailable` | Bridge / ACP child  | Workspace not configured for managed memory            |
| `remember_queue_full`        | Task lane           | 16 pending tasks limit reached                         |
| `remember_path_escape`       | Core remember logic | Agent wrote to a path outside managed memory dirs      |
| `remember_failed`            | Catch-all           | Unclassified agent failure, timeout, or internal error |
| `remember_task_not_found`    | HTTP route          | GET for unknown or unauthorized task ID                |
| `forget_task_not_found`      | HTTP route          | GET for unknown or unauthorized forget task ID         |
| `dream_task_not_found`       | HTTP route          | GET for unknown or unauthorized dream task ID          |

### Timeout Chain

```
Agent forked runner:   5 min maxTimeMinutes
Child abort signal:  295 s  (WORKSPACE_MEMORY_REMEMBER_CHILD_TIMEOUT_MS)
Bridge timeout:      300 s  (WORKSPACE_MEMORY_REMEMBER_TIMEOUT_MS)
```

The child aborts before the bridge times out, ensuring a clean error propagates
rather than a transport-level timeout.

---

## 8. SDK Integration

### TypeScript SDK (`@qwen-code/sdk-typescript`)

Workspace memory methods on `DaemonClient`:

```typescript
// Queue a remember task
const task = await client.rememberWorkspaceMemory(
  'The project uses pnpm workspaces',
  { contextMode: 'workspace' },
);
// task.taskId, task.status === 'queued'

// Poll until terminal
const result = await client.getWorkspaceMemoryRememberTask(task.taskId);
// result.status === 'completed' | 'failed'

const forget = await client.forgetWorkspaceMemory('old preference');
const forgetResult = await client.getWorkspaceMemoryForgetTask(forget.taskId);

const dream = await client.dreamWorkspaceMemory();
const dreamResult = await client.getWorkspaceMemoryDreamTask(dream.taskId);
```

### UI Event Normalization

The SDK normalizer maps the raw `memory_changed` SSE event (with
`scope: 'managed'`) to a `DaemonUiWorkspaceMemoryChangedEvent`:

```typescript
{
  type: 'workspace.memory.changed',
  scope: 'managed',
  source: 'workspace_memory_remember',
  taskId: 'remember-...',
  touchedScopes: ['user', 'project']
}
```

This extends the existing `workspace.memory.changed` event type, which
previously only carried `scope: 'workspace' | 'global'` for file-based QWEN.md
writes.

---

## 9. Design Rationale

### Why sessionless?

The `/remember` slash command in the CLI already works within a session. But the
Settings UI and programmatic SDK callers should not need to create a session just
to persist a fact. A session implies conversation history, turn tracking, and
visibility in the session list — none of which apply to a fire-and-forget memory
write.

### Why serial execution?

The managed memory system stores facts in markdown files with indexes. Concurrent
writes from multiple remember tasks could corrupt indexes or produce merge
conflicts. A single-threaded lane is the simplest correct solution.

### Why a task queue (not synchronous)?

Memory writes involve an LLM agent deciding _where_ and _how_ to store the fact
(choosing between user vs. project scope, picking the right file, formatting).
This takes 2–30 seconds. A synchronous HTTP request would either time out or
block the client. The async queue + poll pattern keeps the HTTP contract simple
and lets clients show progress UI.

### Why `contextMode`?

- `"workspace"` (default) — the remember agent sees existing memories as
  context, enabling it to deduplicate or update existing entries.
- `"clean"` — the agent sees no prior user memory, useful when the caller wants
  to force a fresh write without dedup logic (e.g. bulk import).

### Why restrict reads to memory paths?

The remember agent should only read/write within managed memory directories. This
prevents a prompt-injection scenario where crafted `content` tricks the agent
into reading sensitive project files and leaking them into memory entries.
