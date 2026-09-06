# ACP Tool-Result Text Projection

## Problem

ACP tool-result display fields are assembled after model-facing response
finalization. A complete display value can therefore appear in both structured
`content` and `rawOutput`, producing a much larger ACP frame than the bounded
model response. Live delivery and history replay also leave through different
paths, so applying a limit at only one of them would leave a replay bypass.

## Contract

Each eligible field has a fixed 65,536-byte budget measured as the UTF-8 byte
length of that field's JSON serialization. Eligible `content` is an array made
only of canonical ACP text-content blocks with no extra fields. Eligible
`rawOutput` is a primitive string. The fields are evaluated independently and
remain present after projection.

A2UI tool updates are exempt as a whole because the daemon extracts command
JSON after the child ACP wire boundary. Structured, diff, terminal, media,
mixed, and otherwise non-canonical content remains unchanged. The projection
does not change the canonical transcript, model response, artifact metadata,
or offline export.

## Projection

String size is computed with a linear scanner that matches native JSON escaping
for controls, quotes, backslashes, Unicode, valid surrogate pairs, and lone
surrogates. Oversized strings retain an approximately 20 percent head and 80
percent tail around a fixed transport-truncation marker. Selected slices are
copied so a bounded preview does not retain an oversized backing string.

For multi-block content, the array and object wrappers count toward the same
field budget. A deterministic max-min allocation preserves block order and
lets small blocks remain complete. Reduced blocks reserve marker space before
sharing the remaining payload budget. Fit is decided with a cumulative
early-stopping scan, then each block is scanned only through its largest
possible allocation. If the empty structure or minimum marker set cannot fit,
the field collapses to one canonical omission marker.

The projector does not stringify an original oversized field, join blocks, or
perform repeated binary searches. Native serialization is used only to verify
the already bounded result. Applying the projector twice is a no-op after the
first projection.

## Boundaries

Live updates are projected in `Session.sendUpdate()`. Replay updates are
projected when the replay collector accepts them, covering bulk load,
`qwen/session/loadUpdates`, paged transcript routes, and virtual subagent
replay. The canonical replay machine and transcript update constructors remain
unchanged, and offline export continues to replay through its dedicated export
context without this transport projection.

## Compatibility and Non-Goals

ACP schemas, capabilities, and field types do not change. Keeping both
`content` and `rawOutput` avoids a wire-deduplication compatibility decision.
When no artifact exists, the marker makes no recovery claim.

This design is not a universal ACP frame limit. Structured payload bounds,
generic NDJSON caps, backpressure, replay aggregate limits, Headless display
projection, diagnostics, and artifact lifecycle remain separate work tracked
by #8091, #8447, #8448, and the later phases of #7306.
