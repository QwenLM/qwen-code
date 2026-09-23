# Web Shell backend-authoritative queue display

## Problem

The Web Shell keeps a local `unknown` queue row when a pending-prompt or
mid-turn admission request may have reached the daemon but its response was
lost. A later daemon refresh can then add the authoritative row beside the
local copy, producing duplicate-looking entries and UI such as “delivery
unknown” or “local copy discarded”.

## Design

Local rows exist only while an admission request is in flight. After the
request settles, both admission paths query the daemon and render its queue
snapshot. If the request or the follow-up query fails, the local row is
removed; a later reconnect or queue event can restore it only if the daemon
reports it.

Failures after dispatch follow the same rule and do not restore the payload
into the editor. Failures before either admission request is dispatched, such
as media upload failure, restore the draft because the daemon could not have
accepted it.

The obsolete unknown-admission row state and its restore/discard UI are
removed.
