# MAX_TOKENS recovery transcript invariant

## Problem

When an assistant response ends with `MAX_TOKENS`, Qwen Code asks the model to continue and coalesces the continuation into the original model turn in memory. Recording each attempt immediately writes adjacent assistant records to the append-only transcript, so resuming the session reconstructs history differently from the live session.

## Design

Defer assistant recording only for turns owned by output-token recovery. Recovery continuations remain visible as they stream, but their terminal chunk is held until the model turn is committed. After recovery finishes or is abandoned, derive one durable record from the surviving coalesced history turn.

Each chat serializes send admission before awaiting the previous send. This keeps recovery ownership and its deferred records isolated to one send without adding a second per-send state model.

Goal usage is accumulated per successful model attempt, independently of durable assistant recording. The final record marks those tokens as already accumulated so persistence does not bill them twice.

Recovery terminal chunks are drained for up to one second so trailing provider usage metadata can be included without allowing a provider that never closes to wedge the chat. Metadata that arrives after that bounded cutoff is unavailable; Goal accounting records the usage observed before the stream is aborted.

## Invariants

- A recovered live model turn produces exactly one assistant transcript record.
- The record's message parts equal the surviving coalesced history turn after structured-output redaction.
- Ordinary streams are not buffered through provider EOF.
- Simultaneously admitted sends execute in order and cannot share recovery state.
- Consumer abandonment persists only model output that was already visible.

## Non-goals

This change prevents new malformed transcripts. It does not rewrite append-only transcripts created before the fix.
