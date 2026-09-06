# Migrating to `@qwen-code/sdk/daemon` v2

PR #4328 shipped the v1 daemon UI layer. PR #4353 (this PR) ships v2 with
seven additive feature commits. This guide walks through the changes for web
chat and web terminal adapter authors first. Native local TUI, channel, and IDE
maintainers can reuse the same primitives later, but those default product paths
are not migrated by this PR.

## TL;DR for existing consumers

**No breaking changes.** Every commit in this PR is additive:

- v1 fields still work (`createdAt` preserved as `@deprecated` alias for
  `clientReceivedAt`)
- v1 normalizer still maps the same 13 event types the same way
- v1 reducer still produces the same blocks for chat events
- New API is opt-in via additional parameters and helpers

The PR is safe to merge without any consumer changes. **Adoption of the
new features is incremental.**

## Recommended adoption order

For each adapter, in order of effort/value ratio:

### 1. Ordering: switch sort key from `createdAt` to `eventId`

**Before:**

```ts
const ordered = [...state.blocks].sort((a, b) => a.createdAt - b.createdAt);
```

**After:**

```ts
import { selectTranscriptBlocksOrderedByEventId } from '@qwen-code/sdk/daemon';
const ordered = selectTranscriptBlocksOrderedByEventId(state);
```

**Why**: `eventId` is daemon-monotonic; survives SSE replay-after-reconnect.
`createdAt` is client clock and shifts under replay.

### 2. Display: switch `createdAt` to `serverTimestamp ?? clientReceivedAt`

**Before:**

```tsx
<TimeLabel ms={block.createdAt} />
```

**After:**

```tsx
import { formatBlockTimestamp } from '@qwen-code/sdk/daemon';
<TimeLabel text={formatBlockTimestamp(block, { locale })} />;
```

**Why**: Multiple clients see consistent "X minutes ago" only when both
read daemon clock. Renderer plus `formatBlockTimestamp` handles tz +
locale.

**Note**: Daemon needs to stamp `_meta.serverTimestamp` on envelopes for
this to take effect. SDK forward-compat-ready; falls back to
`clientReceivedAt` until then.

### 3. Listen for new event types — pick subset to render

The 16 new event types (session-meta, workspace, auth) don't push transcript
blocks. They are sidechannel observations. Each adapter picks which to surface:

```ts
// In your SSE consumer
const uiEvents = normalizeDaemonEvent(envelope, {
  clientId,
  suppressOwnUserEcho: true,
});
store.dispatch(uiEvents);

// Then in your UI side
for (const event of uiEvents) {
  switch (event.type) {
    case 'session.approval_mode.changed':
      myApprovalModeBadge.update(event.next);
      break;
    case 'workspace.mcp.budget_warning':
      myToast.show(
        `MCP servers approaching budget: ${event.liveCount}/${event.budget}`,
      );
      break;
    case 'auth.device_flow.started':
      myAuthModal.show({
        deviceFlowId: event.deviceFlowId,
        providerId: event.providerId,
        expiresAt: event.expiresAt,
      });
      break;
    // ... etc, opt into what your UI needs
  }
}
```

Or use selectors for state-mirrored sidechannels:

```ts
import { selectApprovalMode, selectCurrentTool } from '@qwen-code/sdk/daemon';

const mode = selectApprovalMode(state); // mirrored from approval_mode.changed
const currentTool = selectCurrentTool(state); // current in-flight tool
```

### 4. Render contract: use `daemonBlockToMarkdown` (or HTML / plainText)

**Before** (each adapter does its own projection):

```ts
function blockToString(block: DaemonTranscriptBlock): string {
  switch (block.kind) {
    case 'user':
      return `You: ${block.text}`;
    case 'assistant':
      return block.text;
    case 'tool':
      return `[${block.title}]\n${block.status}`;
    // ... etc
  }
}
```

**After** (delegate to SDK):

```ts
import { daemonBlockToMarkdown } from '@qwen-code/sdk/daemon';
const md = daemonBlockToMarkdown(block);
```

For HTML SSR:

```ts
import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
const html = DOMPurify.sanitize(md.render(daemonBlockToMarkdown(block)));
```

For plain text:

```ts
import { daemonBlockToPlainText } from '@qwen-code/sdk/daemon';
const plain = daemonBlockToPlainText(block);
```

### 5. Conformance test

Add to your adapter's test suite:

```ts
import { runAdapterConformanceSuite } from '@qwen-code/sdk/daemon';

it('adapter projects daemon UI corpus correctly', () => {
  const result = runAdapterConformanceSuite({
    reduce: (events) => myReduce(events),
    renderToText: (state) => myRender(state),
  });
  expect(result.failed).toEqual([]);
});
```

This will run your adapter against 10 fixture scenarios and surface any
projection drift before it reaches users.

### 6. Tool icon dispatch via `provenance`

**Before** (string match on toolName):

```tsx
const isMcp = toolName?.startsWith('mcp__');
const isBuiltin = ['Bash', 'Edit', 'Read'].includes(toolName);
```

**After** (typed provenance from PR-A):

```tsx
import type { DaemonUiToolUpdateEvent } from '@qwen-code/sdk/daemon';

function toolIcon(event: DaemonUiToolUpdateEvent): React.ReactNode {
  switch (event.provenance) {
    case 'mcp':
      return <McpIcon server={event.serverId} />;
    case 'subagent':
      return <SubagentIcon />;
    case 'builtin':
      return <BuiltinIcon name={event.toolName} />;
    case 'unknown':
    default:
      return <GenericIcon />;
  }
}
```

SDK has a `mcp__<server>__<tool>` naming heuristic fallback — works today
even when daemon doesn't explicitly stamp provenance.

### 7. Error categorization via `errorKind`

**Before** (regex on text):

```ts
if (error.text.includes('auth')) showAuthRetry();
else if (error.text.includes('file not found')) showFilePicker();
```

**After** (closed enum from PR-A):

```ts
import type { DaemonErrorKind } from '@qwen-code/sdk/daemon';

function errorAction(errorKind?: DaemonErrorKind): React.ReactNode {
  switch (errorKind) {
    case 'auth_env_error': return <RetryAuthButton />;
    case 'missing_file':   return <FilePicker />;
    case 'blocked_egress': return <CheckProxyHint />;
    case 'init_timeout':   return <RestartDaemonButton />;
    default:               return null;
  }
}
```

**Note**: Daemon needs to stamp `data.errorKind` on session_died /
stream_error for this to populate. SDK already reads it.

### 8. Cancellation handling — already automatic

In v1, cancelled prompts left in-flight tool blocks spinning forever.
In v2 (PR-E), `propagateCancellationToInFlightTools` runs automatically
on `assistant.done.reason === 'cancelled'`. Sub-agent children are
cancelled together with their parent.

**No adapter changes needed** — your spinners will resolve correctly.

### 8a. Sub-agent nesting — opt in to nested rendering (PR-K)

Tool blocks invoked inside a sub-agent delegation now carry
`parentToolCallId`, `subagentType`, and (when the parent is in state)
`parentBlockId`. Adapters can opt in to nested rendering:

**Before** (flat list, sub-agent calls visually indistinguishable from
top-level):

```tsx
state.blocks.map((b) => <ToolBlock block={b} />);
```

**After** (recursive nested rendering):

```tsx
import {
  selectSubagentChildBlocks,
  isSubagentChildBlock,
} from '@qwen-code/sdk/daemon';

function renderTool(block) {
  const children = selectSubagentChildBlocks(state, block.toolCallId);
  return (
    <ToolBlock block={block}>
      {block.subagentType && <SubagentBadge type={block.subagentType} />}
      {children.length > 0 && <Indent>{children.map(renderTool)}</Indent>}
    </ToolBlock>
  );
}

const topLevel = state.blocks.filter((b) => !isSubagentChildBlock(b));
return topLevel.map(renderTool);
```

**No adapter changes needed if you prefer the flat view** — the new
fields are additive and ignored by code that doesn't read them.

### 9. Tool preview taxonomy — pick subset to render with custom components

PR-D + PR-F bring 13 preview kinds:

- 4 file-shaped: `file_diff`, `file_read`, `web_fetch`, `mcp_invocation`
- 5 content-shaped: `code_block`, `search`, `tabular`, `image_generation`, `subagent_delegation`
- 2 control: `ask_user_question`, `command`
- 2 generic: `key_value`, `generic`

Each adapter dispatches on `preview.kind`:

```tsx
function ToolPreviewComponent({ preview }: { preview: DaemonToolPreview }) {
  switch (preview.kind) {
    case 'file_diff':
      return (
        <UnifiedDiffView
          path={preview.path}
          old={preview.oldText}
          new={preview.newText}
        />
      );
    case 'mcp_invocation':
      return (
        <McpCard serverId={preview.serverId} toolName={preview.toolName} />
      );
    case 'tabular':
      return <DataTable columns={preview.columns} rows={preview.rows} />;
    case 'image_generation':
      return (
        <ImagePreview
          thumbnailUrl={preview.thumbnailUrl}
          prompt={preview.prompt}
        />
      );
    // ... or fall back to:
    default:
      return <Markdown text={daemonToolPreviewToMarkdown(preview)} />;
  }
}
```

Adapters without custom components for all 13 kinds can fall back to the
SDK's `daemonToolPreviewToMarkdown` for any unhandled kind.

## Backward-compat checklist

| Concern                                                | Status                                        |
| ------------------------------------------------------ | --------------------------------------------- |
| Existing `block.createdAt` reads                       | ✅ still works (alias for `clientReceivedAt`) |
| Existing reducer event handling                        | ✅ unchanged for v1 event types               |
| `daemonTranscriptToUnifiedMessages(blocks)` call sites | ✅ new options param is optional              |
| Existing `selectTranscriptBlocks` consumers            | ✅ unchanged                                  |
| New event types in v1 reducer                          | ✅ no-op, `lastEventId` still advances        |

## Cross-references

- [PR #4353 SUMMARY](https://github.com/QwenLM/qwen-code/pull/4353)
- [Daemon UI README](./README.md) — full API reference
- [PR #4328](https://github.com/QwenLM/qwen-code/pull/4328) — base PR with shared UI transcript layer
