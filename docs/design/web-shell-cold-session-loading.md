# Web Shell cold session initialization

Opening an existing session without an explicit workspace mounted the session
provider before workspace capabilities arrived. Publishing the primary workspace
then changed its session context and restarted restoration. A reproduction using
the real providers and SDK observed two loads, two event streams, and a stale
client detach for one navigation.

Wait for the first capabilities response before mounting an existing session.
Reuse the existing loading and retry states. An empty composer can still mount
while discovery runs, and a later discovery error must not unmount an unscoped
session whose capabilities are already known.

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

An isolated copy of the reported session took approximately 1.2–1.4 seconds to
restore after its daemon child exited. This change removes redundant frontend
restoration; it does not change daemon cold-start or transcript storage behavior.
