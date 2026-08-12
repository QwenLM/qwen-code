# Session media references

## Problem

Image prompts currently repeat base64 data in request JSON, pending queues,
SSE events, and the replay ring. Mid-turn batches amplify this because several
images can be emitted in one event.

## Design

The daemon stores uploaded image bytes in a session-owned temporary
directory and returns a small media reference:

```ts
{
  type: 'image';
  mediaId: string;
  mimeType: string;
  size: number;
}
```

Prompt and mid-turn APIs accept these references. Queues, reconciliation
snapshots, SSE events, and persisted user-message metadata retain only
references. Immediately before an ACP prompt or mid-turn drain crosses into the
child, the bridge resolves references to the protocol's inline base64 content
blocks.

The TypeScript session client hydrates references in replay/live events and
queue snapshots through the authenticated media download route. Existing UI
reducers and renderers therefore continue receiving their current inline image
shape without carrying base64 through the daemon event bus.

## Ownership and limits

- Media is scoped to the resolved daemon session and protected by the
  existing session client authorization.
- Each object is limited to 8 MiB, each live session to 100 MiB and 256 objects,
  and the daemon retains at most 512 MiB across sessions.
- Objects remain available across client detach and reload for up to three
  hours; explicit close, kill, and daemon shutdown remove them immediately.
- References from another or unavailable session fail instead of falling back to a
  primary runtime.

Legacy inline media remains accepted and echoed unchanged for older clients.
Media-reference-capable clients avoid placing those bytes in the replay ring.
