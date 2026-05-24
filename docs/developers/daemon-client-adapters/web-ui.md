# Daemon Web UI Adapter

## Goal

Web chat and web terminal clients should consume `qwen serve` through the
daemon HTTP/SSE APIs and render a client-side transcript. Native local TUI,
channel, and IDE integrations keep their existing default paths for now.

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

React clients can use the optional `@qwen-code/webui` binding:

```tsx
import {
  DaemonSessionProvider,
  useDaemonActions,
  useDaemonConnection,
  useDaemonPendingPermissions,
  useDaemonTranscriptBlocks,
} from '@qwen-code/webui';
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
  const blocks = useDaemonTranscriptBlocks();
  return blocks.map((block) => <RenderBlock key={block.id} block={block} />);
}
```

The provider creates or attaches a daemon session, subscribes to SSE, keeps the
last event id on `DaemonSessionClient`, and reconnects the stream by default.
Callers can disable that with `autoReconnect={false}` for tests or custom
connection management.

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
- The WebUI React binding is optional and only runs in clients that import it.
- Removed daemon TUI spike code should not be treated as a product migration.

## Follow-Ups

- Add a daemon-served local `/web` POC or equivalent same-origin web app.
- Build first-class chat and terminal renderers on top of transcript blocks.
- Add richer typed events only where existing daemon events are too low-level
  for stable browser UI behavior.
- Consider a dedicated `@qwen-code/daemon-ui-core` package if non-SDK consumers
  need the UI core as an independent dependency.
