# Browser Use profile ownership

[English](browser-use-profile-ownership.md) | [简体中文](browser-use-profile-ownership.zh-CN.md)

## Problem and scope

Multiple Chrome profiles can load the Qwen extension and share one Native Host
registration. Each connects independently to the same Browser Use socket.
Previously, every handshake replaced the current connection, invalidating tabs
and routing later requests to another profile. A single Browser Use session
could therefore fail repeatedly as profiles reconnected.

This change retains the [single-session boundary](browser-use.md): one active
Browser Use runtime per OS user. It fixes profile contention without adding a
profile picker or concurrent Browser Use sessions.

## Identity and selection

Each extension profile persists a random UUID in `chrome.storage.local` under
`browserUseInstanceId`. It writes the value before connecting and reuses it
after Native Host, service worker, and browser restarts. A failed storage write
prevents that connection attempt; the existing reconnect alarm retries it.
Clearing extension data or reinstalling can change the identity.

Protocol version `2` requires `extensionInstanceId` in `hello`, alongside the
shared `extensionId`. The transport rejects missing or invalid instance IDs
before selection. Extension and runtime must be updated together; version `1`
handshakes cannot safely identify profiles and are rejected. Native Host remains
an opaque relay. These identifiers distinguish compatible instances; they do
not authenticate other processes running as the same OS user.

The first valid handshake selects a profile for the current transport lifetime.
Initial selection depends on connection order, not a prediction of the user's
preferred work or personal account. Other profiles remain connected but idle.
Their messages cannot resolve active requests, emit events to the SDK, replace
the selected socket, or reset its tabs and session name.

## Disconnect and stop

A disconnect fails the selected connection's pending requests and invalidates
its tab handles using the existing lifecycle. It retains the selected instance
identity. Only that instance can reconnect; another connected profile cannot
take over while it is absent. Requests time out with `BROWSER_DISCONNECTED` if
the selected profile does not return. Existing pages may be rediscovered and
claimed after reconnection; old handles are not transparently restored.

Stopping the transport closes active and idle connections and clears selection.
A new transport lifetime can select a different profile. The extension's
persistent instance identity is not cleared by stopping a Browser Use session.

## Validation and acceptance

- Reproduce two profiles exposing the same tab ID; connecting the second must
  not change where the first profile's request is sent.
- Pending requests and events remain isolated from idle profiles, and stopping
  an idle connection does not notify the SDK that its browser disconnected.
- Two real isolated Chrome profiles share the same socket for at least 95
  seconds without invalidating the original tab or resetting its group name.
- Closing and reopening the idle profile leaves the active profile usable.
  Closing the active profile never fails over; restarting it permits recovery.
- An identity survives extension reconnects and worker restarts, differs across
  profiles, and is persisted before use. A storage failure must not publish a
  temporary identity.
- Stopping and restarting the transport permits a new selection and closes all
  old connections. The existing second-runtime `BROWSER_USE_BUSY` behavior stays
  in place.

## Concurrent-session follow-up

Tracked in [#11609](https://github.com/QwenLM/qwen-code/issues/11609).

Profile identity and Browser Use session identity are separate concepts. Future
sessions may share one profile while owning different tabs. That work requires
shared connection routing, session-scoped tab ownership, events, cleanup and
reconnection. It must not reuse CDP child-target `sessionId` as the Browser Use
session identity. This fix does not implement those mechanisms.
