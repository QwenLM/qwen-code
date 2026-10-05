# Cloud personal memory

## Goal

Add AgentWorks-compatible personal memory to the Web Shell without replacing
Qwen Code's existing project and user Markdown memory. Users configure the BFF
connection in Qwen's Settings panel and manage cloud memories from the existing
Memory dialog.

## Product shape

- Settings gains a native Memory category with a BFF origin, a credential
  environment-variable name, and a Manage cloud memory action.
- The Memory dialog keeps Project and User file memory and adds Cloud personal.
- Cloud personal provides enablement, recall preference, search, cursor
  pagination, add, delete, and local file import.
- Import accepts JSON, JSONL, Markdown, and text, then fans parsed segments out
  through the internal `CaptureMemory` operation.
- When enabled, every real user prompt performs a bounded BFF semantic search
  and injects matching memories into the native Qwen prompt pipeline. A
  completed user/assistant exchange is sent back with `infer: true` for
  automatic memory extraction. Machine continuations, retries, cron turns,
  and tool payloads are excluded.

## Boundary

The browser talks only to the authenticated local daemon. The daemon reads the
BFF origin from the launch environment or user settings and the personal token
from the configured process environment variable. It maps the UI's semantic
operations to `/dmai/mem0MemoriesList`, `mem0MemoriesSearch`,
`mem0MemoriesAdd`, and `mem0MemoriesDelete`. Tenant and user identity are never
accepted from the browser or workspace settings.

The connection settings are user-only. A workspace cannot redirect the BFF
endpoint or select another credential variable. Enablement and recall
preference are also user-scoped Qwen Code settings; existing memories remain
readable while capture and automatic recall are disabled.

Automatic recall and capture are built into both the direct CLI/headless path
and the Web Shell ACP path. They dynamically reload user settings, so the UI
switch and recall preference take effect without installing another Hook or
restarting a session. Retrieved memory is length-bounded, tag-escaped, marked
as untrusted reference data, and kept separate from the user's submitted-prompt
projection. Recall has a 1.5 second ceiling and fails open; capture runs after a
completed turn with a 5 second ceiling and also fails open.

The selected BFF environment must publish the four mem0 aliases. The BFF
origin varies by environment; `QWEN_CLOUD_MEMORY_BFF_ORIGIN` is the runtime
override, while the `/dmai/...` paths are fixed in the adapter.

## Failure behavior

Missing configuration is presented as setup guidance. BFF HTTP, envelope, and
shape errors are bounded and surfaced in the cloud panel without affecting
local memory. Recall and capture integrations must fail open so memory service
availability never blocks a conversation.

## Verification

Use focused unit tests for the BFF proxy, SDK transport, import parser, and
cloud panel behavior. Use a lightweight local HTTP fixture for browser
acceptance; Docker is not required.
