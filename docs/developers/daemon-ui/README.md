# Daemon UI SDK — Developer Guide

The `@qwen-code/sdk/daemon` subpath ships shared UI primitives for daemon
clients. The current adoption target is web chat and web terminal; native local
TUI, channel, and IDE integrations keep their existing default paths while the
daemon UI contract stabilizes. This guide covers the API surface introduced by
PR #4353 (the unified follow-up to PR #4328's shared UI transcript layer).

## Three-layer model

```
Daemon SSE wire (NDJSON envelopes)
   │
   ▼
normalizeDaemonEvent(envelope) → DaemonUiEvent[]
   │
   ▼
reduceDaemonTranscriptEvents(state, events) → DaemonTranscriptState
   │                                            { blocks, currentToolCallId,
   │                                              approvalMode, toolProgress, ... }
   ▼
daemonBlockToMarkdown(block) / ToHtml / ToPlainText  ← your renderer plugs here
```

- **Normalizer**: takes raw daemon SSE envelopes, returns typed UI events
- **Reducer**: accumulates events into a transcript state machine
- **Render helpers**: project state blocks to renderable strings

## Quick start

```ts
import {
  DaemonSessionClient,
  createDaemonTranscriptStore,
  normalizeDaemonEvent,
  daemonBlockToMarkdown,
  selectCurrentTool,
  selectApprovalMode,
} from '@qwen-code/sdk/daemon';

const session = await DaemonSessionClient.createOrAttach(client, {
  workspaceCwd,
});
const store = createDaemonTranscriptStore();

for await (const envelope of session.events({ signal })) {
  const events = normalizeDaemonEvent(envelope, {
    clientId: session.clientId,
    suppressOwnUserEcho: true,
  });
  store.dispatch(events);
}

// Read state from any subscriber
store.subscribe(() => {
  const state = store.getSnapshot();
  const currentTool = selectCurrentTool(state);
  const mode = selectApprovalMode(state);
  const markdown = state.blocks.map(daemonBlockToMarkdown).join('\n\n');
  myRenderer.render({ markdown, currentTool, mode });
});
```

## Event taxonomy (28+ types)

`DaemonUiEvent` is a discriminated union of all UI-facing events:

### Chat-stream events

| Event                        | When                                                  |
| ---------------------------- | ----------------------------------------------------- |
| `user.text.delta`            | User message chunk arrives from daemon                |
| `assistant.text.delta`       | Assistant streaming chunk                             |
| `assistant.done`             | Prompt completion (from sendPrompt resolve)           |
| `thought.text.delta`         | Agent reasoning chunk                                 |
| `tool.update`                | Tool call lifecycle (running / completed / cancelled) |
| `shell.output`               | Shell tool stdout/stderr chunk                        |
| `permission.request`         | Tool needs user authorization                         |
| `permission.resolved`        | Permission decision arrived                           |
| `model.changed`              | Session model switched                                |
| `status` / `debug` / `error` | Status / debug / error blocks                         |

### Session-meta events (PR-A)

| Event                           | When                                             |
| ------------------------------- | ------------------------------------------------ |
| `session.metadata.changed`      | Session title / display name updated             |
| `session.approval_mode.changed` | Mode toggled (plan / default / yolo / auto-edit) |
| `session.available_commands`    | Slash command list refreshed                     |

### Workspace events (PR-A, Wave 3-4)

| Event                                  | When                                  |
| -------------------------------------- | ------------------------------------- |
| `workspace.memory.changed`             | QWEN.md / memory file modified        |
| `workspace.agent.changed`              | Sub-agent created / updated / deleted |
| `workspace.tool.toggled`               | Builtin tool enabled / disabled       |
| `workspace.initialized`                | `qwen init` completed                 |
| `workspace.mcp.budget_warning`         | MCP child count approaching cap       |
| `workspace.mcp.child_refused`          | MCP server refused due to budget      |
| `workspace.mcp.server_restarted`       | Manual MCP restart succeeded          |
| `workspace.mcp.server_restart_refused` | Manual restart blocked                |

### Auth device-flow events (PR-A, Wave 4 OAuth)

`auth.device_flow.{started,throttled,authorized,failed,cancelled}`

Each carries the daemon's `deviceFlowId`. Failed events carry a closed-enum
`errorKind` (closed enum — see `KNOWN_DEVICE_FLOW_ERROR_KINDS` exported from `@qwen-code/sdk/daemon` for the canonical list, currently: `expired_token` / `access_denied` / `invalid_grant` / `upstream_error` / `persist_failed` / `not_found_or_evicted`).

## Render contract (PR-D)

Three projection helpers, one preview helper. All discriminate on `block.kind`
or `preview.kind`:

```ts
daemonBlockToMarkdown(block, { sanitizeUrls?, maxFieldLength?, locale? })
daemonBlockToHtml(block, { sanitizer?, ...renderOpts })
daemonBlockToPlainText(block, renderOpts)
daemonToolPreviewToMarkdown(preview, renderOpts)
```

### Cookbook: render a transcript to markdown

```ts
const markdown = state.blocks
  .map((b) => daemonBlockToMarkdown(b, { sanitizeUrls: true }))
  .join('\n\n');
```

### Cookbook: render to sanitized HTML for SSR

```ts
import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';
const md = new MarkdownIt();

const html = state.blocks
  .map((b) => {
    // Two-stage pipeline: markdown → HTML → DOMPurify
    const rawHtml = md.render(daemonBlockToMarkdown(b));
    return DOMPurify.sanitize(rawHtml);
  })
  .join('\n');
```

Or use the built-in conservative HTML renderer (no markdown parsing, just
HTML escape):

```ts
const html = state.blocks
  .map((b) => daemonBlockToHtml(b, { sanitizer: DOMPurify.sanitize }))
  .join('\n');
```

### Cookbook: copy-paste plain text

```ts
const plain = state.blocks.map(daemonBlockToPlainText).join('\n');
navigator.clipboard.writeText(plain);
```

## Tool preview taxonomy (13 kinds)

| Kind                  | Surface                                           |
| --------------------- | ------------------------------------------------- |
| `ask_user_question`   | Multi-choice question with options                |
| `command`             | Bash-style command + cwd                          |
| `file_diff`           | File edit with oldText/newText or patch           |
| `file_read`           | Path + optional line range                        |
| `web_fetch`           | URL + HTTP method                                 |
| `mcp_invocation`      | MCP server + tool + args summary                  |
| `code_block`          | Language-tagged code snippet                      |
| `search`              | Query + result count + top results                |
| `tabular`             | Columns + rows (capped at 50, truncation flagged) |
| `image_generation`    | Prompt + optional thumbnail URL                   |
| `subagent_delegation` | Agent name + task                                 |
| `key_value`           | Generic label/value rows                          |
| `generic`             | Fallback summary                                  |

Each has a `daemonToolPreviewToMarkdown` projection. Custom renderers can
dispatch on `preview.kind` for rich per-type display (file diff with
syntax highlighting, MCP server badge, image thumbnail, etc.).

## State selectors (PR-E)

```ts
selectCurrentTool(state); // → DaemonToolTranscriptBlock | undefined
selectApprovalMode(state); // → 'plan' | 'default' | 'auto-edit' | 'yolo' | undefined
selectToolProgress(state, toolCallId); // → { ratio?, step? } | undefined
selectPendingPermissionBlocks(state); // → ReadonlyArray<DaemonPermissionTranscriptBlock>
selectTranscriptBlocks(state); // → ReadonlyArray<DaemonTranscriptBlock>
selectTranscriptBlocksOrderedByEventId(state); // sorted by daemon-monotonic id

// PR-K — sub-agent nesting
selectSubagentChildBlocks(state, parentToolCallId); // direct children only
isSubagentChildBlock(block); // type guard: was this tool invoked inside a sub-agent?
```

`currentToolCallId` is automatically maintained by the reducer:

- Set when a tool enters in-flight status (`running` / `in_progress` / `pending` / `confirming`)
- Cleared when tool enters terminal status (`completed` / `failed` / `cancelled` / etc.)
- Unknown statuses leave it untouched (forward-compat)

## Cancellation propagation (PR-E)

When `assistant.done.reason === 'cancelled'`, the reducer walks every
in-flight tool block and force-sets its status to `'cancelled'`. Daemon
does not guarantee a terminal `tool_call_update` for every in-flight
tool when the parent prompt is cancelled — this propagation prevents UI
spinners from spinning forever.

Sub-agent children are cancelled together with their parent because
cancellation iterates every in-flight tool block in `toolBlockByCallId`,
not just the current pointer.

## Sub-agent nesting (PR-K)

When the main agent delegates to a sub-agent (the `Task` tool, or
equivalent), the daemon stamps `parentToolCallId` and `subagentType` on
the **child** tool calls via `tool_call._meta`. The reducer reads both
and:

- Mirrors `parentToolCallId` + `subagentType` onto
  `DaemonToolTranscriptBlock`
- Resolves `parentBlockId` (the parent's transcript block `id`) when the
  parent block is already in state; otherwise leaves it `undefined` and
  back-fills when the parent block later appears

Out-of-order arrival (child before parent) is handled transparently. A
child whose parent gets trimmed by `maxBlocks` keeps `parentToolCallId`
for selector queries, but `parentBlockId` is nulled (the dangling id
would no longer resolve via `blockIndexById`).

```ts
import {
  selectSubagentChildBlocks,
  isSubagentChildBlock,
} from '@qwen-code/sdk/daemon';

// Render a parent tool block, then walk children:
function renderToolBlock(state, block) {
  if (block.kind !== 'tool') return renderOther(block);
  const children = selectSubagentChildBlocks(state, block.toolCallId);
  return (
    <ToolBlock block={block}>
      {children.length > 0 && (
        <Indent>
          {children.map((c) => renderToolBlock(state, c))}
        </Indent>
      )}
    </ToolBlock>
  );
}

// Or filter top-level vs. nested at render time:
const topLevel = state.blocks.filter((b) => !isSubagentChildBlock(b));
```

`selectSubagentChildBlocks` returns **direct** children only. Walk
recursively to render nested sub-agents (a sub-agent inside a
sub-agent). Daemon does not emit cycles, but renderers walking up via
`parentBlockId` should still detect them defensively (e.g., depth cap or
visited set).

Self-references (`parentToolCallId === toolCallId`) are dropped by the
normalizer before reaching the reducer.

## Time semantics (PR-B)

```ts
interface DaemonTranscriptBlockBase {
  eventId?: number; // PRIMARY sort key — daemon-monotonic
  serverTimestamp?: number; // PREFERRED display — daemon-authoritative
  clientReceivedAt: number; // FALLBACK — local clock
  createdAt: number; // @deprecated alias for clientReceivedAt
}
```

**Always sort by `eventId`** (use `selectTranscriptBlocksOrderedByEventId`)
when displaying long sessions. The daemon-monotonic cursor is preserved
across SSE replay-after-reconnect; client clocks are not.

**Always format display timestamps from `serverTimestamp`** (with
fallback to `clientReceivedAt`). Multiple clients viewing the same session
see the same "5 minutes ago" only when both read from the daemon clock.

```ts
import { formatBlockTimestamp } from '@qwen-code/sdk/daemon';

const label = formatBlockTimestamp(block, {
  locale: 'zh-CN',
  timeZone: 'Asia/Shanghai',
  timeStyle: 'short',
});
```

## Adapter conformance (PR-G)

Validate your adapter projects the SDK's reference corpus to semantically
equivalent output:

```ts
import { runAdapterConformanceSuite } from '@qwen-code/sdk/daemon';

it('my adapter conforms to daemon UI corpus', () => {
  const result = runAdapterConformanceSuite({
    reduce: (events) => myReducer(events),
    renderToText: (state) => myRenderer(state),
  });
  expect(result.failed).toEqual([]);
});
```

The fixture corpus (`DAEMON_UI_CONFORMANCE_FIXTURES`) covers chat, tool
lifecycle, file edits, MCP, permissions, MCP budget warning, cancellation,
malformed payload redaction, OAuth, command updates, and sub-agent
nesting. (Count is derivable at runtime — read
`DAEMON_UI_CONFORMANCE_FIXTURES.length`.)

**Format-agnostic** — your adapter can render to ANSI / HTML / markdown /
JSX; the framework only checks semantic content via `expectedContains` and
`expectedAbsent`.

## Error categorization (PR-A)

`DaemonUiErrorEvent.errorKind` is a closed-enum propagated from the
daemon's typed-error taxonomy (when the daemon stamps it):

```ts
import type { DaemonErrorKind } from '@qwen-code/sdk/daemon';
// 'missing_binary' | 'blocked_egress' | 'auth_env_error' | 'init_timeout'
// | 'protocol_error' | 'missing_file' | 'parse_error' | 'budget_exhausted'
```

Renderers should branch on `errorKind` for actionable affordances:

```ts
function errorAffordance(errorKind?: DaemonErrorKind): React.ReactNode {
  switch (errorKind) {
    case 'auth_env_error': return <button>Re-authenticate</button>;
    case 'missing_file':   return <button>Choose file</button>;
    case 'blocked_egress': return <span>Network blocked — check proxy</span>;
    default:               return null;
  }
}
```

## Tool provenance dispatch (PR-A)

`DaemonUiToolUpdateEvent.provenance` is a closed-enum (`builtin` / `mcp` /
`subagent` / `unknown`). With `serverId?: string` when `mcp`. Use it for
icon dispatch and badging:

```ts
function toolIcon(event: DaemonUiToolUpdateEvent): React.ReactNode {
  switch (event.provenance) {
    case 'mcp':      return <McpIcon server={event.serverId} />;
    case 'subagent': return <SubagentIcon />;
    case 'builtin':  return <BuiltinIcon name={event.toolName} />;
    default:         return <GenericIcon />;
  }
}
```

The SDK has a `mcp__<server>__<tool>` naming heuristic fallback — even
when daemon doesn't explicitly stamp provenance, MCP tools are detectable.

## Forward-compat principles

Every layer in the daemon UI SDK follows the **forward-compat principle**:
unknown values do NOT throw; they degrade gracefully.

- Unknown daemon event types → `debug` event with the raw type name
- Unknown tool status → `currentToolCallId` left untouched (no clear)
- Unknown error kind → `errorKind` undefined (renderer falls back to text)
- Missing serverTimestamp → falls back to `clientReceivedAt`
- Unrecognized preview shape → `generic` kind with `summary`

This means **SDK can ship ahead of daemon emission**. PR-A's tool
provenance heuristic, PR-B's three-location timestamp extraction, and
PR-E's unknown-status preservation are all examples of "ready when daemon
sends; safe when it doesn't."

## Cross-references

- [PR #4328](https://github.com/QwenLM/qwen-code/pull/4328) — base PR with the shared UI transcript layer
- [PR #4353](https://github.com/QwenLM/qwen-code/pull/4353) — this PR (unified completeness follow-up)
- [Issue #3803](https://github.com/QwenLM/qwen-code/issues/3803) — daemon mode proposal
- [Issue #4175](https://github.com/QwenLM/qwen-code/issues/4175) — Mode B v0.16 implementation tracker
