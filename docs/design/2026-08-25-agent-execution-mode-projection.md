# Agent execution mode projection

## Problem

The runtime decides whether an agent runs in the foreground or background using both tool arguments and loaded subagent configuration. Web clients only receive the arguments, so they can classify the same call differently from the runtime.

## Design

Add the resolved execution mode to the existing task-execution display that is streamed as tool raw output. The value is available on the first running update and remains unchanged while lifecycle status advances. Web Shell normalizes that value onto its tool-call model and treats it as authoritative.

Recorded sessions and older daemons do not contain the field, so the existing argument and status inference remains as a compatibility fallback.

## Non-goals

- Change background scheduling or lifecycle status semantics.
- Add a second top-level ACP field.
- Update the separate Electron client that consumes a different result format.
