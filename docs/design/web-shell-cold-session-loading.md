# Web Shell cold session initialization

[English](web-shell-cold-session-loading.md) | [简体中文](web-shell-cold-session-loading.zh-CN.md)

Opening an existing session without an explicit workspace mounted the session
provider before workspace capabilities arrived. Publishing the primary workspace
then changed its session context and restarted restoration. A reproduction using
the real providers and SDK observed two loads, two event streams, and a stale
client detach for one navigation.

Wait for the first capabilities response before mounting an existing session.
Reuse the existing loading and retry states. An empty composer can still mount
while discovery runs, and a later discovery error must not unmount an unscoped
session whose capabilities are already known.

Initial discovery failures must publish the workspace error even after the
failed promise is removed from the cache. Track the request generation so a
late failure cannot replace a newer refresh or a different client's state.
Cached reads do not publish workspace state and must not suppress the initial
error when another reader immediately retries a failed request.
The error screen's retry action performs a fresh discovery request; restoration
starts only after that request succeeds. Display the current error message so
both initial and retry failures retain their diagnostic reason.

Seed the session connection with those known capabilities on its first render.
Otherwise activity consumers briefly select catalog fallback before discovering
live-state support, causing an extra full session-list request.

React StrictMode also discards and immediately recreates the initial connection
effect. Before starting a connection with no retained session, yield one microtask
and check whether that effect was disposed. Retained connections keep their
existing synchronous startup so recovery can claim the preserved attachment
before controlled-prop effects run.

The regression harness delays capabilities and restores a saved transcript block
through real providers and the SDK. Both ordinary and StrictMode mounts must issue
one load and one event-stream request, reach connected with the saved block, and
avoid an intervening detach. Existing provider tests cover retained attachments,
context changes, reconnection, and history pagination.

The mounting gate belongs to Web Shell's product composition. Hosts combining
the exported workspace and session providers directly must wait for initial
capabilities before mounting an existing session, and expose discovery errors
and retry above that gate. The shared-provider example in the package README
shows this ordering. This change does not remove context restarts from a bare
session provider; an actual workspace change must still restart restoration.

An isolated copy of the reported session took approximately 1.2–1.4 seconds to
restore after its daemon child exited. This change removes redundant frontend
restoration; it does not change daemon cold-start or transcript storage behavior.
