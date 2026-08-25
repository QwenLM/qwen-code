# WebShell Qwen 3.8 reasoning controls

## Goal

Expose Thinking and effort controls for the exact `qwen3.8-max` model in the
WebShell model popover, including the welcome state before a lazy session is
created. A welcome selection applies to that lazy session before its first
prompt; acknowledged live changes apply only to subsequent requests.

## Design

A small agent-side model manifest declares that `qwen3.8-max` supports
Thinking and the native effort values `low`, `medium`, and `xhigh`, with
`xhigh` as its display default. The manifest is matched by exact model id and
does not apply to preview, dated, aliased, or runtime models.

The agent projects that entry through ACP's existing `reasoning_effort`
configuration option. For this model only, the option contains `none` plus the
three manifest values. WebShell renders `none` as Thinking off and renders the
remaining values as effort choices. No second effort configuration id is
introduced.

Both workspace-provider producers expose that same manifest-built option as
an optional, per-model `configOptions` preview. The field is an additive v1
projection: older clients can ignore it and older daemons simply omit it. The
WebUI maps a valid option onto that model's own `reasoningPreview`, rather than
onto connection-wide reasoning state, so changing models cannot leak the
capability.

WebShell applies the following priority:

1. When both `sessionId` and session context are absent, it may render the
   selected model's workspace preview. The controls update a local, one-shot
   intent bound to that exact model.
2. Once a session id is allocated but its context has not arrived, WebShell
   hides the preview.
3. Once context for that session arrives, its `currentValue`, options, and
   Thinking state are authoritative. An absent or incompatible live option
   hides the controls and never falls back to the preview.

The welcome preview deliberately does not create an empty session. Hosts such
as DataWorks use lazy creation so the first prompt can create or adopt the
real daemon session; pre-creating one would change that contract and leave
empty sessions behind. Selecting a welcome effort only records local intent.
The first prompt creates and attaches the session, sets the selected model,
applies the effort through the live config-option mutation, and then submits
the prompt. A model or effort mutation that cannot be confirmed fails closed:
WebShell releases the unused session, keeps the composer and intent available
for retry, and does not send the prompt.

The intent is cleared after successful preparation or after an unrelated
session is attached. It is not a workspace default and is never persisted or
broadcast. If the user changes models before submission, the model-bound
intent is not applied to the other model.

WebShell retains PR #8675's interaction design: the current reasoning state is
shown as a suffix on the model chip, reasoning options occupy the first model
popover, and model search is opened from its Model submenu.

Selecting `none` applies Thinking off to the next lazy session or the current
live session. Selecting an effort applies that effort and enables reasoning.
Reading the manifest alone does not inject a default into generation
configuration, so sessions that never change the controls retain main's
existing wire behavior.

If the live session already carries a generic effort outside the manifest
(`high` or `max`), ACP preserves that value through its existing generic
option and WebShell hides the model-specific controls. This avoids displaying
an inaccurate tier or changing live configuration merely by opening the
popover.

The daemon exposes one owner-routed config-option mutation. Its public route is
restricted to `reasoning_effort`; the response carries fresh `configOptions`,
which becomes the caller's authoritative UI state. No observer or broadcast is
added.

## Scope

Included:

- exact stable `qwen3.8-max` only;
- an editable, one-shot welcome preview with `xhigh` as the manifest default;
- application after lazy attach and model selection but before the first
  prompt;
- authoritative replacement by same-session context;
- the current WebShell conversation;
- Thinking on/off and `low`, `medium`, `xhigh` effort;
- browser coverage for welcome, live override, model switching, old daemons,
  and the existing live mutation behavior.

Excluded:

- persistence across sessions or restarts;
- persisted/default-model semantics;
- workspace-level, reusable, or cross-client reasoning defaults;
- preview, aliases, and future reasoning-control shapes;
- route and runtime models;
- TUI, channel, provider, auth-refresh, and runtime-snapshot behavior;
- capability flags and cross-client model/config broadcasts.

## Compatibility

Only a raw, non-runtime, non-route model whose exact manifest id is
`qwen3.8-max` receives the preview. Preview, dated, aliased, opaque route,
runtime, and unrelated models do not. Older daemons omit the optional model
field, so WebShell does not infer or invent welcome-state capability. Existing
sessions continue to obey the daemon's live `configOptions`, including
Thinking off, non-default effort, missing capability, and incompatible option
shapes. Non-target sessions keep the existing generic ACP effort behavior,
and clients that do not consume the additive field remain compatible.
