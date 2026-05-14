# DaemonClient quickstart (TypeScript)

A minimal end-to-end example: start a `qwen serve` daemon in another terminal, then drive it from a Node script with the SDK's `DaemonClient`. See also: [Daemon mode user guide](../../users/qwen-serve.md) and [HTTP protocol reference](../qwen-serve-protocol.md).

## Setup

In one terminal:

```bash
cd your-project/
qwen serve --port 4170
# → qwen serve listening on http://127.0.0.1:4170 (mode=http-bridge)
```

In another:

```bash
npm install @qwen-code/sdk
```

## Hello daemon

```ts
import { DaemonClient, type DaemonEvent } from '@qwen-code/sdk';

const client = new DaemonClient({
  baseUrl: 'http://127.0.0.1:4170',
  // token: process.env.QWEN_SERVER_TOKEN, // required for non-loopback binds
});

// 1. Confirm we can reach the daemon and gate UI on its features.
const caps = await client.capabilities();
console.log('Daemon features:', caps.features);

// 2. Spawn-or-attach a session for the current workspace.
const session = await client.createOrAttachSession({
  workspaceCwd: process.cwd(),
});
console.log(`session=${session.sessionId} attached=${session.attached}`);

// 3. Subscribe to the event stream. Pass `lastEventId: 0` so the daemon
//    replays everything from the session's start — without it, there's
//    a TOCTOU window between `subscribeEvents()` returning the iterator
//    and the underlying SSE connection actually opening (one fetch
//    round-trip), during which a fast-starting agent can emit events
//    that go into the per-session ring but won't be streamed to a fresh
//    no-cursor subscriber. `lastEventId: 0` makes the replay buffer
//    cover that gap (and any reconnect later — see below).
const abort = new AbortController();
const subscription = (async () => {
  for await (const event of client.subscribeEvents(session.sessionId, {
    signal: abort.signal,
    lastEventId: 0,
  })) {
    handleEvent(event);
  }
})();

// 4. Send a prompt and wait for it to settle. (Order-of-operations
//    note: even if `prompt()` fires before the SSE handshake
//    completes, step 3's `lastEventId: 0` guarantees every event
//    lands in the iterator.)
const result = await client.prompt(session.sessionId, {
  prompt: [{ type: 'text', text: 'Summarize src/main.ts in one sentence.' }],
});
console.log('stop reason:', result.stopReason);

// 5. Tear down the subscription so the script can exit.
abort.abort();
await subscription;

function handleEvent(event: DaemonEvent): void {
  switch (event.type) {
    case 'session_update': {
      const data = event.data as {
        sessionUpdate: string;
        content?: { text?: string };
      };
      if (data.sessionUpdate === 'agent_message_chunk' && data.content?.text) {
        process.stdout.write(data.content.text);
      }
      break;
    }
    case 'permission_request':
      // See "Voting on permissions" below for first-responder semantics.
      console.log('\n[needs permission]', event.data);
      break;
    case 'permission_resolved':
      console.log('\n[permission resolved]', event.data);
      break;
    case 'session_died':
      console.error('\n[agent crashed]', event.data);
      break;
    default:
      console.log(`\n[${event.type}]`, event.data);
  }
}
```

## Reconnect with `Last-Event-ID`

If your client process restarts mid-session, replay events you missed:

```ts
let cursor: number | undefined;

for await (const event of client.subscribeEvents(session.sessionId, {
  signal: abort.signal,
  lastEventId: cursor, // resume from after this id; undefined = live only
})) {
  if (typeof event.id === 'number') cursor = event.id;
  handleEvent(event);
}
```

The daemon retains the last 4000 events per session in a ring buffer; gaps beyond that window won't be re-deliverable.

## Voting on permissions

When the agent asks for permission to run a tool, every connected client sees the `permission_request` event. **First responder wins** — once one client votes, the rest get `404` if they try to vote on the same `requestId`.

```ts
case 'permission_request': {
  const req = event.data as {
    requestId: string;
    options: Array<{ optionId: string; name: string; kind: string }>;
  };
  // Pick whichever option you want — `proceed_once`, `allow`, etc.
  const choice = req.options.find((o) => o.kind === 'allow_once') ?? req.options[0];
  const accepted = await client.respondToPermission(req.requestId, {
    outcome: { outcome: 'selected', optionId: choice.optionId },
  });
  if (!accepted) {
    console.log('Another client voted first; nothing to do.');
  }
  break;
}
```

## Shared-session collaboration

Two clients pointed at the same daemon and `cwd` end up on the same session:

```ts
// Client A (e.g. an IDE plugin)
const a = await clientA.createOrAttachSession({ workspaceCwd: '/work/repo' });
console.log(a.attached); // false — A spawned the agent

// Client B (e.g. a web UI on the same machine)
const b = await clientB.createOrAttachSession({ workspaceCwd: '/work/repo' });
console.log(b.attached); // true — B joined A's session
console.log(a.sessionId === b.sessionId); // true
```

Both clients see the same `session_update` / `permission_request` stream. Either can send a prompt; they FIFO-queue per the agent's "one active prompt per session" guarantee.

## Authentication

When the daemon was started with a token (any non-loopback bind requires one):

```ts
const client = new DaemonClient({
  baseUrl: 'https://your-host:4170',
  token: process.env.QWEN_SERVER_TOKEN,
});
```

Wrong / missing tokens return `401` with a uniform body — the SDK throws `DaemonHttpError` on any 4xx/5xx from a route handler.

```ts
import { DaemonHttpError } from '@qwen-code/sdk';

try {
  await client.health();
} catch (err) {
  if (err instanceof DaemonHttpError) {
    console.error(`Daemon error ${err.status}:`, err.body);
  } else {
    throw err;
  }
}
```

## Cancel an in-flight prompt

If your user hits Esc:

```ts
await client.cancel(session.sessionId);
// In the event stream you'll see the prompt resolve with stopReason: "cancelled"
```

Cancel only winds down the **active** prompt — anything you'd already POSTed and that's still queued behind it will continue to run. (See protocol reference for the rationale.)

## What's next

- [HTTP protocol reference](../qwen-serve-protocol.md) — full route spec with status codes
- [Daemon mode user guide](../../users/qwen-serve.md) — operator-side docs
- Source: `packages/sdk-typescript/src/daemon/`
