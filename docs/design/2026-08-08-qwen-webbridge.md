# Qwen WebBridge

## Context

Issue [#8699](https://github.com/QwenLM/qwen-code/issues/8699) asks for a
Kimi WebBridge-style path that controls the user's real Chrome profile without
making MCP, Puppeteer, or the daemon's browser-level CDP emulator part of the
required execution path.

Qwen Code already has the two expensive pieces:

- `qwen serve` owns a long-running authenticated HTTP server and the reverse
  `/acp` WebSocket used by the Chrome extension.
- The extension already attaches `chrome.debugger`, forwards arbitrary CDP
  commands, handles debugger detach, reconnects, and keeps its MV3 worker alive.

The missing layer is an Agent-friendly command contract, task-scoped tab state,
and the high-level browser actions currently supplied only through an external
MCP adapter.

## Compatibility target

The target is the observable Kimi WebBridge v1.11.5 browser contract, not its
branding, update service, telemetry, private Kimi Work orchestration, or
bug-for-bug implementation details. The implementation is clean-room: public
documentation and independently recorded input/output behavior define the
contract; no proprietary source is copied.

The compatibility surface contains seventeen actions:

| Area            | Actions                                                           |
| --------------- | ----------------------------------------------------------------- |
| Tabs and tasks  | `navigate`, `find_tab`, `list_tabs`, `close_tab`, `close_session` |
| Page inspection | `snapshot`, `evaluate`                                            |
| Interaction     | `click`, `fill`, `mouse_click`, `key_type`, `send_keys`           |
| Debugging       | `network`, `cdp`                                                  |
| Artifacts       | `screenshot`, `save_as_pdf`, `upload`                             |

The documented request envelope is:

```json
{
  "action": "navigate",
  "args": { "url": "https://example.com", "newTab": true },
  "session": "task-name-uuid-suffix"
}
```

## Goals

- Expose `POST /command` and `GET /status` from `qwen serve`.
- Keep the Agent path direct:
  `Agent/Skill -> HTTP -> daemon -> reverse WebSocket -> extension -> Chrome`.
- Operate the user's real Chrome profile and login state.
- Implement all seventeen actions and preserve the published session, tab,
  accessibility-ref, artifact-path, and error semantics.
- Reuse the existing `/acp` authentication, origin checks, reconnect behavior,
  and `chrome.debugger` transport.
- Keep the existing `/cdp` and MCP adapter path working as an optional
  compatibility surface.

## Non-goals

- Reproducing Moonshot's binary, source layout, telemetry, updater, store
  identity, prompts, model decisions, or private cloud integrations.
- Hiding Chrome's debugging banner or bypassing DevTools attachment conflicts.
- Automating Chrome internal pages, operating-system dialogs, passkeys,
  captchas, or other surfaces that Chrome does not expose to extensions/CDP.
- Supporting a remote Agent and remote browser in the first version. Upload
  paths refer to the daemon/browser host; generated artifacts stay below the
  daemon host's OS temporary directory.

## Architecture

```text
Qwen Agent / bundled Skill
        | POST /command {action,args,session}
        v
qwen serve WebBridgeService (process-global browser ownership)
        | webbridge_call / webbridge_result over authenticated /acp WS
        v
Qwen Chrome extension action registry
        | chrome.tabs / chrome.windows / chrome.tabGroups
        | chrome.debugger.sendCommand(CDP)
        v
User's real Chrome profile
```

MCP is outside this path. The current `/cdp` tunnel remains available, but a
bound `/cdp` client and a WebBridge command cannot own the single extension
debugger simultaneously; the daemon rejects the second owner rather than
silently switching its tab.

## Ownership and trust boundaries

`/command` is **process-global browser scoped**. It is not workspace scoped and
must never fall back to a secondary workspace runtime. It is mounted after the
existing host allowlist, browser-origin denial, JSON parser, and rate limiter.
Every daemon instance generates a route-scoped WebBridge token; daemon-spawned
Agent processes receive that token and the resolved daemon URL without receiving
the daemon-wide bearer token. The WebBridge credential cannot access other
daemon APIs.

The extension connection is accepted only after ACP initialization with
`clientInfo.name = qwen-cdp-bridge`, the `webbridge-v1` client capability, and a
verified `chrome-extension://<id>` origin matching `clientInfo.extensionId`.
This keeps older CDP-only extension builds and normal Web Shell or IDE clients
from claiming the browser bridge. Reconnect is last-writer-wins for new calls;
in-flight calls remain bound to their original connection, and a disconnected
replacement falls back to the previous live extension.

`upload` passes local absolute paths to Chrome's `DOM.setFileInputFiles` and
therefore inherits the route-scoped authentication boundary. Screenshot and PDF
paths are always generated below the OS temporary directory; caller-selected
artifact paths are ignored. Screenshot decoding is capped at 16 MiB, PDF
decoding at 24 MiB, and accumulated chunk text at 32 MiB.

## Daemon protocol and state

The extension transport adds two frames:

```json
{
  "type": "webbridge_call",
  "requestId": "uuid",
  "payload": { "name": "snapshot", "args": { "_tabId": 42 } }
}
```

```json
{
  "type": "webbridge_result",
  "responseToRequestId": "uuid",
  "payload": { "data": {} }
}
```

Results larger than one frame are sent as ordered `webbridge_result_chunk`
frames followed by a `webbridge_result`; artifact metadata uses `chunked:true`,
while arbitrary results also carry `encoding:"json"`. An error result carries
`payload.error` instead of `payload.data`. Calls time out and pending calls fail
immediately when the extension disconnects.

The daemon owns this task state:

```text
session -> {
  currentTabId,
  ownedTabIds,
  borrowedTabId?
}
```

Before forwarding an action it injects `_session`, `_tabId`, and `_tabIds`.
The extension never receives daemon filesystem or workspace authority. The
daemon updates ownership only after successful `navigate`, `find_tab`,
`close_tab`, or `close_session` results. Borrowed tabs are never included in
the default tab-closing behavior. Callers use a task-unique session name and
may send `close_session` with `close_tabs:false` to release state without
closing tabs.

All WebBridge commands are serialized process-wide with a 32-command bound and
a 60-second queue deadline. The extension retains debugger attachments only
while network capture is active and rejects overlapping direct actions instead
of growing a second queue. Process-wide ordering prevents commands from
different sessions targeting the wrong tab. The legacy raw tunnel, its detach
phase, and whole direct actions mutually exclude one another before browser
state is changed.

## Extension behavior

The extension owns the action registry, matching the reference architecture.
It shares the existing debugger attachment and event forwarding code instead
of creating a second `chrome.debugger` owner.

- Tab actions use `chrome.tabs`, `chrome.windows`, and `chrome.tabGroups`.
- `snapshot` uses `Accessibility.getFullAXTree` and records per-tab `@e` refs
  backed by `backendDOMNodeId`.
- `click` and `fill` use DOM-level synthetic interaction for compatibility with
  the documented behavior.
- `mouse_click`, `key_type`, and `send_keys` use the CDP `Input` domain.
- `evaluate` uses `Runtime.evaluate` with REPL-mode top-level await and by-value
  results.
- `network` owns bounded, session-isolated request maps populated from
  `Network` events.
- `cdp` is an unrestricted passthrough to the CDP domains Chrome exposes to
  `chrome.debugger`.
- Screenshots and PDFs return chunked base64 to the daemon; the daemon owns
  filesystem writes and removes base64 from the HTTP response.

The accessibility-ref map is per tab and is replaced by each new snapshot.
Navigation or session cleanup invalidates it.

## Failure behavior

- Invalid request envelopes return HTTP 400; action argument and CDP errors
  return HTTP 500.
- No connected extension returns HTTP 503.
- Command timeouts return HTTP 504. Extension disconnects return HTTP 503;
  protected pages, missing/stale tabs, invalid refs, and CDP errors return HTTP
  500 with a stable `{error}` body.
- A stale current tab during `navigate` is removed from the session and retried
  once as a new owned tab.
- Unknown actions are rejected by the extension and are never interpreted as
  raw CDP. Raw CDP requires the explicit `cdp` action.

## Agent integration

A bundled `qwen-webbridge` Skill documents the command envelope, a unique
session per task, tab ownership, non-destructive cleanup, artifacts, and
recovery. Daemon-spawned Agent processes receive `QWEN_WEBBRIDGE_URL` and the
route-scoped `QWEN_WEBBRIDGE_TOKEN`; the Skill sends that bearer on every
request. A separately launched CLI does not inherit these values and does not
automatically attach to an already-running daemon.

## Verification

Each implementation stage has a runnable gate:

1. Protocol/session tests: registration, replacement, disconnect, timeout,
   input validation, tab ownership, borrowed-tab preservation, and artifacts.
2. Extension unit tests: every action family against mocked Chrome APIs/CDP,
   including navigation invalidation and network event capture.
3. Daemon/extension integration: a fake extension initializes over `/acp`, an
   HTTP `/command` round-trip reaches it, and the result updates session state.
4. Real-Chrome acceptance: fixture pages exercise all seventeen actions using
   the packaged MV3 extension and a real `qwen serve` daemon.
5. Release gate: focused tests, nearby daemon/extension suites, formatting,
   lint, typecheck, build, extension packaging, and artifact scan.

The compatibility claim is bounded and testable: all normalized inputs,
outputs, errors, and browser side effects in the v1.11.5 conformance matrix
must pass. Dynamic tab IDs, request IDs, temporary paths, timestamps, and page
timing are normalized rather than compared byte-for-byte.
