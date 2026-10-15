# Preserve manual titles across `/clear`

`/clear` creates a deferred successor session. Remember the current title only
when its persisted provenance is `manual`, then rename the successor before it
attaches and before its first prompt.

The existing session catalog is the durable source of title provenance after a
reload. Live rename events provide the same provenance without another read.
`/new`, `/reset`, session navigation, and workspace changes discard the carry.

Automatic and legacy titles with unknown provenance are never carried.
