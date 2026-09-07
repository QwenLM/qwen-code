# Background Agent progress watchdog

## Problem

An ordinary background Agent can remain registered as running while its model,
control flow, or one tool makes no progress. The existing workflow watchdog is
not suitable: it retries stalled work and suspends its deadline for every
running tool. Ordinary background Agents must settle once as failed instead.

## Behavior

Each fresh, restored, and resident-continuation background turn has two fixed
internal deadlines:

- 15 minutes without model or control progress.
- 10 minutes without progress from each in-flight tool.

Model streaming, round transitions, usage, and external input renew the model
deadline. Tool output and liveness heartbeats renew only that tool's deadline.
Parallel tools retain independent deadlines.

The relevant tool deadline is suspended while user approval is pending. The
model deadline is suspended only after a no-tool round enters a Monitor-owned
external-input wait, and resumes when input arrives. A timer delayed by host
suspend or a local event-loop gap is rearmed rather than charged to the Agent.

On expiry the watchdog aborts the turn with an `AgentProgressTimeoutError`.
Cooperative model and tool paths map that reason to `TIMEOUT`; the background
registry and sidecar then settle once as `failed`. There is no retry. Existing
definition-level turn and wall-clock limits are unchanged.

## Scope

Workflow dispatch remains unchanged. Runtime generation draining and an Agent
that ignores the cooperative abort remain Layers 4 and 5 of #8586.
