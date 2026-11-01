# Session Workflow mode

[English](workflow-mode.md) | [简体中文](workflow-mode.zh-CN.md)

Workflow mode saves a preference to consider the Workflow tool for ordinary
new submissions in the current session. It defaults to off. The model still
decides whether a workflow is useful, and all permission, trust, budget and
tool restrictions continue to apply. Enabling the mode does not start a run,
change reasoning effort, or change your default settings.

Workflow tools are opt-in. Enable `tools.workflowsEnabled` in settings or set
`QWEN_CODE_ENABLE_WORKFLOWS=1` before turning the mode on:

```sh
QWEN_CODE_ENABLE_WORKFLOWS=1 qwen --workflow-mode on
qwen --resume <session-id> --workflow-mode off
```

Starting with `--workflow-mode on` while the tools are unavailable fails
initialization. `QWEN_CODE_DISABLE_WORKFLOWS=1` takes precedence over enabling
them.

In either terminal renderer, use `/workflows mode` or
`/workflows mode status` to read the state, and `/workflows mode on` or
`/workflows mode off` to change it. These mode controls can run while a response
is streaming; they affect subsequent eligible submissions. The footer shows
`Workflow mode: on`, or `Workflow mode: on (unavailable)` if the saved preference
cannot currently be applied. The existing `/workflows` run list and pause
controls retain their original behavior.

The state separates `requested` (the saved preference), `available` (the
required tools are currently usable), and `effective` (both are true).
Turning on requires the Workflow tools to be available. Turning off remains
possible when they are unavailable. Losing a tool does not erase a saved on
preference; restoring the tool makes that preference effective again.

The mode is supported by ordinary local sessions and normal daemon sessions,
including secondary workspace owners. Managed, SSH, derived/subagent and
session-agent sessions, and sessions with chat recording disabled, do not
support mode changes. Unsupported protocol sessions do not advertise the
capability or option. A failed write leaves the published mode unchanged.

## Web Shell and VS Code

The composer in Web Shell, split panes, and the modern VS Code chat includes
an independent **Workflow** control for supported sessions. The switch shows
the saved preference, not whether the mode can currently take effect. If the
preference is on but the tools are unavailable, it stays checked and can still
be turned off. Click the Workflow label or focus and activate it to open its status details;
the same details are available by tapping on touch devices.

Before a session is created or restored, the control shows an availability
placeholder. It does not create a session or save a future preference. Hosts
that do not advertise support, including older servers, hide the mode switch.

Changes from another client update the same session's control automatically.
During a write or reconnection, the last confirmed value remains visible and
the switch is disabled until state is confirmed. A timeout is an unconfirmed
outcome, not a successful change; the client reads the current state instead
of automatically repeating the write. An active response does not disable the
switch: the change applies to the next fresh turn and leaves effort unchanged.

## Reminder and input behavior

The first eligible submission receives a model-only reminder. With no other
changes, sparse reminders follow on submissions 11 and 21, then every ten
eligible submissions. Turning off or losing capability sends one exit notice
on the next eligible submission. Only an actual model dispatch consumes a
reminder or advances the count; cancellation or rejection before dispatch
does not. Retries and fallback attempts share the same delivery token. If
cancellation removes a dispatched mode reminder from model history, the next
eligible submission announces the current state again.

Ordinary CLI, SDK and ACP submissions can use this explicit mode without a
human-origin declaration. Tool continuations, retries, hooks, slash-generated
prompts, shell mode, side queries, automatic Goal/Cron/notification/channel
turns, and subagents do not add a new mode reminder or advance its count.
Prompt speculation is paused while the mode or an undelivered transition
needs context.

The [one-turn keyword hint](workflow-intent.md) remains separate. Its human
provenance requirement and opt-out setting are unchanged. A valid keyword and
a mode reminder share one envelope; turning the persistent mode off does not
disable a valid one-turn keyword. A mode-only reminder does not activate the
transient keyword indicator or keyword telemetry.

## Session lifecycle

Resume restores the last valid Boolean record on the selected transcript
branch and announces a saved on or off state once. An explicit CLI or SDK
initial value overrides that restored value once, after the session is ready.
Conflicting initial values or an initial on value while Workflow tools are
unavailable fail initialization. A new or cleared session starts off. A fork
inherits its selected checkpoint independently; rewind preserves
the current preference and anchors it in the restored branch. Successful
compression reannounces the state on the next eligible fresh submission.
After a failed resume or branch switch rebuilds the previous session's history,
the next eligible submission reannounces its saved state. A session with no
saved preference stays quiet.

## TypeScript SDK and ACP

```ts
const session = query({
  prompt: messages(),
  options: { workflowMode: true },
});
const state = await session.getWorkflowMode();
await session.setWorkflowMode(false);
```

`workflowMode` is optional: omission preserves a resumed value, while `false`
explicitly saves off. Initialization negotiates and stages the initial value;
`Query.initialized` is the control handshake. Get/set operations wait for
session readiness. Repeated initialize requests are rejected while session
initialization is in progress. An older CLI rejects an explicit mode request
before the first prompt instead of silently ignoring it. Custom transports use the same
control protocol.

ACP advertises a standard `workflow_mode` config option with values `on` and
`off`. Its `currentValue` reflects the requested state, while
`_meta['qwen.workflowMode']` contains `available`, `effective`, and an optional
`reason`. Committed changes and capability refreshes publish the full options
through `config_option_update`.

Daemon clients use the existing session config-option endpoint or
`setSessionConfigOption(sessionId, 'workflow_mode', 'on', clientId)`. The option
does not accept a `persist` override: it is always session-persistent. Context
readback and updates belong to the live owner of that session, including its
lease and generation checks. Web Shell and the modern VS Code host consume
these same session controls and updates.
