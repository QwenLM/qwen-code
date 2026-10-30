# Daemon requests and automatic recovery

[English](2026-10-09-daemon-request-recovery.md) | [简体中文](2026-10-09-daemon-request-recovery.zh-CN.md)

## Status and scope

Both stages are implemented on this branch and described separately for review. Stage 1 consolidates daemon HTTP requests in the SDK without changing connection policy. Stage 2 pauses business traffic while the daemon is unavailable and automatically restores it through one recovery probe loop per provider. Native WebSockets share the stage 2 connection gate. No server routes or ownership rules change. The gate is enabled by Web Shell; SDK consumers retain their existing connection policy.

## Problem and current behavior

Web Shell mixes SDK calls with direct HTTP calls. Session reconnection and heartbeat depend on an active session, so a page waiting for its first prompt can retain a connected status after the daemon exits. Independent polling and reconnect loops then generate repeated failures. Capabilities describe supported features and are not evidence of current availability.

## Stage 1: SDK request entry

Add a raw native REST request entry to DaemonClient. It uses the client's fetch implementation and credential, preserves request headers, body, cancellation, keepalive and response handling, and supports a connect-phase timeout override. Return the Response so existing JSON validation, HTTP error messages and SSE parsing remain at their current call sites. REST-only routes must not be translated through ACP. Existing typed SDK methods retain their transport selection. Ordinary native REST calls retain the SDK connection deadline; a supplied signal owns cancellation and any caller-specific deadline, preserving long prewarm requests and SSE bodies. The older peer SDK fallback uses a 30-second connection deadline when no signal is supplied.

Migrate workspace filesystem, goals and scheduled tasks; agent roster and session-agent requests and streams; Local Control; session detach; startup and candidate-credential probes; pairing exchange; remote-workspace proxies; and daemon-side desktop-relay setup. Prefer a shared SDK client where the provider already owns the relevant connection. Preserve compatibility with older supported SDKs through one compatibility adapter if required; do not scatter feature checks across callers.

Requests keep their existing ownership: health and capabilities are process-global; qualified workspace routes retain their selected or persisted workspace selector; session routes retain live-session ownership; legacy routes remain legacy-primary. Remote-workspace proxy calls authenticate to the serving daemon and carry the target token separately. Candidate authentication and pairing must remain independent of the current connection's credential.

CDN assets, service-worker navigation and asset caching, and the separate desktop-relay service are excluded. Progress uploads already enter the SDK through XMLHttpRequest; Web Shell checks availability at the upload send point and reports transport failures without changing the SDK upload protocol.

## Stage 2: Availability and recovery

A shared daemon-connection state controls business requests independently of session status. On a transport failure, pause further business traffic and coalesce a connection check. Once unavailable, independent business polls, heartbeats and reconnect loops must not send network requests. Preserve cached lists, transcript and unsent drafts. Show a persistent connection warning across the main views, with an explicit retry action inside the visible fullscreen or modal artifact panel when it owns the view. Terminal and local-file bridge connections wait for shared recovery; a terminal opened while offline shows one localized waiting notice. Explicit terminal release waits independently of the panel lifetime and uses the release-only route without creating a PTY. QR pairing refresh stops on outage and requires explicit retry after recovery. Voice and Live Host capture stop on disconnection and require a user action to restart; recovery never replays audio.

Each DaemonWorkspaceProvider owns one authenticated lightweight native REST health probe loop for its active connection, shared by all panels beneath it. Separate providers targeting the same URL and credential retain independent controllers and probe loops; endpoint-wide deduplication is not implemented. REST adapters and session-agent streams prefer the controller bound to their SDK client; endpoint lookup is a fallback for clients without an owner binding. The standalone application uses one focused provider. Retry delays are 5 seconds, 15 seconds and then 30 seconds, scheduled after completion with a bounded timeout. Ordinary checks respect pending retry delays and authentication suspension. A foreground transition or explicit retry can request an immediate coalesced probe. A successful probe revalidates capabilities and authentication before reopening business traffic. Resume reads and session attachment, never replay prompt submissions or other writes.

Business validation errors, missing sessions or workspaces, and intentional cancellation do not prove daemon failure. A raw TypeError only proves transport failure when observed at a fetch boundary; an unclassified consumer TypeError requests diagnosis without suspending healthy traffic. Authentication rejection pauses automatic probing in a separate state until credentials change or the user retries. Request deadlines, HTTP gateway errors and an ended stream request a coalesced check; they do not suspend a healthy connection merely because a business route failed. Old requests and probes cannot change a replacement connection or restore an obsolete state. Request generations also prevent late pre-outage failures from suspending a recovered connection. Disposal cancels probes and recovery waiters, including multiple providers and StrictMode remounts.

A paused connection does not certify cached live activity indefinitely. After a sustained 90-second outage (three live-state retry windows), expire live-session authority locally without issuing business requests; a shorter outage cancels that expiry. Keep the session catalog itself cached. Cold session lists and the status dashboard show unavailable feedback rather than an empty result or an endless initial load, and connection repair remains accessible. A managed view keeps the warning when its artifact panel is not mounted.

Connection recovery invalidates pending status reads independently of in-flight settings writes. Preserve the result of an already-issued settings update and never replay it. Host-handled local slash commands and local model-policy feedback still run before the network submission gate. Voice capture retains its raw error vocabulary; its UI formatter localizes the service-unavailable reason once.

## Metrics and limits

The exported transcript includes the shared Web Shell translations and availability consumers. With the same dependencies, the renderer grows from 2,048,235 bytes on merged main `65051590d9` to 2,050,022 bytes on this branch (+1,787). Both builds have the same 2,174 inputs and unchanged third-party sources. The JavaScript budget rises from 2,050,000 to 2,052,000 bytes, leaving 1,978 bytes of headroom; the forbidden-dependency guard remains unchanged.

Actual failed requests remain failures. Operations blocked locally are not HTTP requests. Recovery probes use `/health`, followed by `/capabilities` after health succeeds, and must be accounted for by endpoint so the host can account for them separately from business API success. The repository investigation did not find a generic host HTTP-success reporter, so host metric filtering cannot be claimed without integration evidence. The initial failures needed to discover an outage and already-in-flight requests cannot be eliminated. A host-provided transport may perform its own internal retries before returning an error; this gate cannot suppress network activity hidden inside that transport.

## Validation and acceptance

Stage 1 verifies native REST selection with custom ACP transports, explicit fetch injection, authentication and header merging, encoded workspace paths, empty and prefixed base URLs, cancellation, keepalive, response errors and a long-lived SSE body. Run focused package tests, build and typecheck. Browser checks use both a real daemon and deterministic mocks where useful, with each evidence source labelled.

Stage 2 verifies a session-less page, active session and multiple panels during stop and restart. After in-flight requests settle, unavailable business traffic must remain zero and only the provider’s shared recovery loop may issue probes. Restart restores reads and session attachment without losing drafts or replaying writes. Check false-positive classification, stale responses, unmount cleanup and custom transports.

## Open integration questions

Confirm how the deployment controller counts idle activity and how the host instruments health probes. Confirm restart semantics when the old session no longer exists; use the current session recovery behavior rather than creating or sending work implicitly.
