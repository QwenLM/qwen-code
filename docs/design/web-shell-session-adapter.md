# Web Shell standalone session adapter

[English](web-shell-session-adapter.md) | [简体中文](web-shell-session-adapter.zh-CN.md)

## Goal and scope

Embedded hosts can create, restore, and prompt standalone sessions through a host service while reusing the Web Shell composer and transcript. The host can assign session IDs, omit a workspace directory, and report turn completion through its own stream. Workspace sessions and hosts without an adapter use the daemon route.

## Client and session ownership

`WebShellWithProviders` uses `sessionAdapter` for an explicit standalone context with no `lockWorkspaceCwd`, `workspaceCwd`, or `workspaceId`. The workspace provider owns the client returned by `createClient`. It keeps that client across rerenders that supply another adapter object and disposes it on teardown. The client must provide `capabilities()` or the standalone view displays a capability error. Branding is optional. The provider skips `DaemonAvailability` polling and pause handling for adapter clients because the host owns availability.

`create` returns the service-assigned session ID and applies and verifies any requested startup configuration. `load` returns the existing client attachment and restores history under the same ID. Hosts can use `StandaloneSessionMetadata` from `@qwen-code/sdk/daemon` to construct a session without a workspace. Web Shell detaches its attachment through the returned session client. Continuations, side questions, and other session operations also use that client.

## Prompt lifecycle

Built-in REST and ACP subscriptions signal readiness after establishing their event stream. Custom subscriptions signal `onEventStreamReady` once they can receive events. Foreground submissions wait for readiness so an idle subscription can receive the first turn. Hosts provide the admitted user message and assistant content as session events and include user messages in restored history.

`submitPrompt` returns the admitted `promptId` and a `completion` promise. Complete the promise after the final transcript events have been delivered, or reject it on stream failure. A matching daemon terminal event can settle the same foreground turn first. Web Shell records failed submissions locally for recovery and leaves automatic admission retries to the host. After navigation, detached submission returns at admission and releases the attachment while the host continues the turn.

## Acceptance checks

- Open standalone with an adapter against a service without the standalone daemon capability. Send the first prompt, see the host-assigned session ID and both messages, then reload and send a follow-up without creating another session.
- Submit on idle REST, ACP HTTP, and ACP WebSocket subscriptions. Check that the first prompt can proceed before any message arrives and that completion settles the foreground turn without a terminal event.
- Reject admission and verify that Web Shell retains the failed input without automatically resubmitting. Interrupt the stream after admission and verify that the failure is reported once. Navigate away during creation and verify that the detached attachment releases at admission.
