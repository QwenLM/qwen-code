# Headless Tool-Result Text Projection

## Summary

Headless JSON transports currently serialize the complete semantic display
string selected for `tool_result.content`. A large tool display therefore
creates a large JSON array entry or JSONL event even when the model-facing tool
response and producer artifact are already bounded separately.

This change applies a fixed display-transport projection after semantic
selection and before the shared JSON adapter emits or retains the result.

## Contract

For textual `tool_result.content` created by the built-in JSON adapters:

```text
UTF8_BYTES(JSON.stringify(content)) <= 65,536
```

Oversized strings use a deterministic preview containing approximately 20%
of the available source budget from the head and 80% from the tail. The
transport marker counts toward the budget. JSON escaping, control characters,
Unicode, paired surrogates, and lone surrogates use the same accounting as
native JSON serialization.

The projection is independent of output format, covering JSON, stream-JSON,
persistent stream-JSON and SDK sessions, subagent results, internal Text-mode
retention, and Dual Output through one adapter boundary.

## Boundaries

Projection occurs only after the adapter selects the semantic display value.
It does not modify the tool response, model-facing response parts, canonical
recording, or producer artifact. Existing display footers may survive in the
tail, but internal `persistedOutputFiles` metadata is not inspected or added
to the wire.

The shared implementation contains only JSON-string byte accounting and
single-string preview selection. ACP keeps its own multi-block allocation,
A2UI exemption, and field-specific behavior while reusing those primitives.

Dual Output increments its protocol version from 1 to 2 because existing
consumers can observe bounded previews in a previously unbounded field. Event
types and SDK schemas are unchanged.

## Non-goals

This is not a universal event, JSONL frame, accumulated session, tool-input,
partial-message, replay-container, or backpressure limit. It does not change
artifact ownership or lifecycle and introduces no configuration or disk I/O.
