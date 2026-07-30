# Fork resume live capabilities

## Problem

Fork background agents persist the parent's rendered system instruction and
inline tool declarations. Resume sends those launch-time declarations to the
model, while execution still uses the current `ToolRegistry`. A removed or
changed tool can therefore remain model-visible even though it cannot be
executed.

## Design

Keep the fork's bootstrap and runtime messages as its durable identity. On
resume, rebuild its executable surface from the current parent session:

- use the current parent's rendered system instruction;
- take the current parent's advertised tool names and resolve their schemas
  through the resumed agent's current registry;
- include current MCP, deferred-tool, and Skill reminders on the continuation
  turn, while declaring earlier capability listings obsolete;
- leave the task paused when the current parent prompt or tool surface cannot
  be reconstructed.

Launch-time system instructions and tool declarations remain readable in old
transcripts for compatibility, but resume no longer treats them as executable
authority. New transcripts persist the inherited history and task prompt, not
capability snapshots; current runtime state is authoritative.

## Consequences

Removed tools are no longer advertised after resume, and changed tools use
their current schemas. A resumed fork can gain a tool that is newly available
to its parent, so this favors live consistency over byte-identical replay.
Rebinding can also invalidate the old prompt-cache prefix, which is preferable
to sending stale capabilities.
