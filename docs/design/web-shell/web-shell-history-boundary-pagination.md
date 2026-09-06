# Web Shell history boundary pagination

## Problem

Web Shell starts restored-history pagination with `beforeRecordId`, then switches
to the opaque `nextCursor` returned by the transcript endpoint. A cursor can be
rejected with `invalid_transcript_cursor` when the next request is handled by a
runtime that cannot validate the original HMAC. The user then cannot load the
remaining history.

## Design

Continue backward Web Shell pagination with record boundaries whenever a page
contains a persisted record id. Replay already stamps
`qwen.session.recordId` on transcript events, and `beforeRecordId` is exclusive,
so the earliest record id in the returned page is the next boundary.

Keep `nextCursor` as a compatibility fallback for older daemons or malformed
pages that do not expose any persisted record id. No daemon API or cursor
security semantics change.

## Verification

- A multi-page transcript uses `beforeRecordId` for every Web Shell request.
- Events already displayed remain deduplicated.
- A page without a persisted record id still advances with `nextCursor`.
- Existing retry, terminal-error, capacity, and malformed-event behavior stays
  unchanged.
