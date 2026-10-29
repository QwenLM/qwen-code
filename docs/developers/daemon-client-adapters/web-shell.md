# Web Shell Daemon Adapter

## Goal

Web chat and web terminal clients should consume `qwen serve` through the
daemon HTTP/SSE APIs and render a client-side transcript. Native local TUI,
channel, and IDE integrations keep their existing default paths for now.

## Interface terminology

This terminology update covers the sidebar workspace heading and workspace
creation/management labels, ordinary session-creation actions (including the
workspace overview and shared Managed workspace row action), the Recent heading,
and the workspace Memory scope. On these surfaces, the labels use
**Workspaces / 工作区**, **New session / 新建会话**, and **Recent / 最近**;
a single directory-backed entry uses **Workspace / 工作区**. The Memory scope
uses **Workspace / 工作区级**, retaining the Chinese scope-level suffix.

This is not a product-wide terminology migration. Existing Managed-agent page
copy and registration-dialog copy (including 工作空间), the session-source
**Tasks / 任务** tab, workspace execution hints, offline-host hints, and other
session help text retain their existing wording. Agent, Skills, Workflow, MCP,
and approval scope labels are outside this update. Scheduled tasks, todo items,
agent/tool executions, external services' projects, and Git worktrees retain
their domain meanings. The **No-workspace sessions / 无工作区会话** group
retains its name and placement; its naming and hierarchy are separate follow-up
work.

Existing translation keys, SDK/API fields, stored identifiers, configuration
keys, and runtime logic are unchanged. Label-derived DOM values do change,
including dialog `aria-label`, `data-web-shell-dialog-title`, and button
accessible names. Automation matching the old text must update its selectors;
for example, the dialog title is now **Add workspace**, not **Add Workspace**.
The sidebar trigger, dialog heading, and non-browse submit button all use
**Add workspace**; scope text-based dialog selectors to
`[data-web-shell-dialog]` to distinguish them from the background trigger.
The Recent heading and its region name continue to share the same translation
key; a separate descriptive region label is outside this copy-only update.

## Shared UI Contract

Use the TypeScript SDK daemon UI exports as the common boundary:

```ts
import {
  DaemonClient,
  DaemonSessionClient,
  createDaemonTranscriptStore,
  normalizeDaemonEvent,
} from '@qwen-code/sdk/daemon';
```

The split is:

- `DaemonClient` handles daemon HTTP routes.
- `DaemonSessionClient` owns session creation/attachment and SSE replay.
- `normalizeDaemonEvent()` converts daemon wire events into UI events.
- `createDaemonTranscriptStore()` reduces UI events into transcript blocks.

React clients can use the binding exported by Web Shell:

```tsx
import {
  DaemonSessionProvider,
  useActions,
  useConnection,
  usePendingPermissions,
  useTranscriptBlocks,
} from '@qwen-code/web-shell/daemon-react-sdk';
```

Minimal React shape:

```tsx
function App() {
  return (
    <DaemonSessionProvider baseUrl="http://127.0.0.1:4170">
      <Transcript />
      <PromptBox />
    </DaemonSessionProvider>
  );
}

function Transcript() {
  const blocks = useTranscriptBlocks();
  return blocks.map((block) => <RenderBlock key={block.id} block={block} />);
}
```

The provider creates or attaches a daemon session, subscribes to SSE, keeps the
last event id on `DaemonSessionClient`, and reconnects the stream by default.
Callers can disable that with `autoReconnect={false}` for tests or custom
connection management.

### Removing composer attachments

In the desktop Web Shell composer, when the text body is empty and the caret
is at its start with no selection, Backspace or Delete first removes a
removable context tag using that key's existing order. If no removable context
tag remains, it removes the last file attachment, or the last pasted image
when there are no files. File and image attachments are retained while the
text body is non-empty. Attachments can also be removed using their individual
remove buttons.

## Browser Deployment Shapes

### Same-Origin Local POC

A daemon-served page can call the daemon directly because the page and API share
one origin. This is the preferred early POC shape for local web chat and web
terminal validation.

### Remote Web Chat / Web Terminal

A production remote web app should normally talk to a backend-for-frontend. The
BFF owns daemon URL, token, workspace routing, and session metadata, then
forwards browser-safe app events to the browser. This keeps bearer tokens out of
browser storage and lets the deployment decide which daemon/workspace a user is
allowed to reach.

### Local Browser Against Local Daemon

A separate local dev server is cross-origin from `qwen serve`; it must either
proxy daemon routes through the same origin or be served by the daemon. The
daemon intentionally rejects arbitrary browser `Origin` requests.

## Rendering Responsibilities

Web Shell highlights line-leading slash tokens such as `/review` in user
messages with the same blue, bold treatment as the composer. Highlighting is
derived from the recorded text, so it also applies when reopening a session.
It is a syntax cue, not confirmation that a command exists or executed.
Message text, clickable URLs, and annotated reference chips are preserved.

The shared transcript model is semantic, not visual. UI clients decide how to
render:

- user and assistant message blocks
- collapsed thought blocks
- tool status cards
- shell output blocks
- permission request controls
- status/error/debug blocks

The web terminal is a browser-native semantic renderer. It should look and feel
terminal-like with monospace layout, scrollback, prompt input, shortcuts, and
streaming blocks, but it is not a raw PTY proxy and does not require server-side
Ink rendering.

## Merge Safety

- The native `qwen` TUI remains direct and unchanged.
- `--acp`, channel, and IDE paths remain unchanged by default.
- The SDK UI core is additive.
- The Web Shell React binding is optional and only runs in clients that import
  it.
- Removed daemon TUI spike code should not be treated as a product migration.

## Follow-Ups

- Keep the daemon-served Web Shell and embedded IDE host behavior aligned.
- Continue building first-class chat and terminal renderers on transcript
  blocks.
- Add richer typed events only where existing daemon events are too low-level
  for stable browser UI behavior.
- Consider a dedicated `@qwen-code/daemon-ui-core` package if non-SDK consumers
  need the UI core as an independent dependency.
