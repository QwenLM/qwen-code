# Fork resume live capabilities

## Problem

Legacy fork background transcripts persisted the parent's rendered system
instruction and inline tool declarations. Replaying those launch-time
declarations while execution uses the current `ToolRegistry` can leave a
removed or changed tool model-visible even though it cannot be executed.

## Design

Keep the fork's bootstrap and runtime messages as its durable identity. On
resume, rebuild its executable surface from the current parent session:

- use the current parent's rendered system instruction;
- take the current parent's advertised tool names and resolve their schemas
  through the resumed agent's current registry;
- include current MCP and Skill reminders on the continuation turn, while
  declaring earlier capability listings obsolete;
- leave the task paused when the current parent prompt or tool surface cannot
  be reconstructed.

Launch-time system instructions and tool declarations remain readable in old
transcripts for compatibility, but resume no longer treats them as executable
authority. New transcripts persist the inherited history and task prompt, not
capability snapshots; current runtime state is authoritative.

Launch-time execution restrictions are different from capability snapshots.
When a fork uses `fork_tools`, its `executionAllowedTools` policy is stored in
the `AgentMeta` sidecar and reapplied after the live tool surface is rebuilt.
An empty persisted list remains deny-all; an absent field remains unrestricted.

## Consequences

Removed tools are no longer advertised after resume, and changed tools use
their current schemas. A resumed fork can gain a tool that is newly available
to its parent only when its persisted execution policy also permits that tool.
This favors live consistency over byte-identical replay without weakening an
explicit launch restriction. Rebinding can also invalidate the old
prompt-cache prefix, which is preferable to sending stale capabilities.
