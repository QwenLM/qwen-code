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
configuration option. For this model only, the option contains `none`,
`default`, and the three manifest values. `default` remains an ACP instruction
for clearing an override, not a model effort. WebShell therefore renders
`none` as Thinking off and the manifest values as effort choices; when ACP
reports `default`, it displays the manifest's default effort. No second effort
configuration id is introduced.

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
session is attached. Before it is applied, this local intent is not a workspace
default and is neither persisted nor broadcast. Once WebShell applies it
through the daemon-owned config-option mutation, the live session changes.
`none`, native efforts, and custom efforts are persisted as the shared default
for later sessions. WebShell does not offer ACP's `default` instruction as an
effort choice, and settings can still clear the selected scope. Ordinary ACP
clients may send `default` to restore the live session's model or provider
baseline without persistence; a private persistent request also clears its
settings scope and applies the resulting merged preference. If the user changes
models before submission, the model-bound intent is not applied to the other
model.

WebShell retains PR #8675's interaction design: the current reasoning state is
shown as a suffix on the model chip, reasoning options occupy the first model
popover, and model search is opened from its Model submenu.

Selecting `none` applies Thinking off to the next lazy session or the current
live session. Selecting an effort applies that effort and enables reasoning.
Reading the manifest alone does not inject a default into generation
configuration, so sessions that never change the controls retain main's
existing wire behavior.

If the live session inherits a generic effort outside the manifest (`high` or
`max`), ACP projects its documented effective alias, `xhigh`, through the
registered model-specific choices. The controls stay available instead of
disappearing after session creation. DashScope likewise maps `minimal` to
`low`; a static `thinking_budget` maps to `low` at 0–4096 tokens, `medium` at
4097–16384, and `xhigh` at 16385–262144, following the
[OpenAI-compatible Qwen API](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions).

If a static DashScope thinking field currently overrides the unified setting,
ACP projects its effective off state or effort alias through the same controls.
Selecting a model-specific value removes only the competing thinking fields
from copied request-parameter maps, preserves both the original shared maps
and unrelated request parameters, and applies the selected value. This keeps
the control truthful instead of acknowledging a choice that a higher-priority
field would silently shadow.

When an ACP client selects `default`, those static thinking fields are restored
from the current model baseline in the live session. This makes clearing an
explicit preference consistent with a new session or daemon restart while
preserving unrelated request parameters and the stored model configuration.

When the active model requires thinking, ACP omits `none` from the option and
marks that constraint in metadata. WebShell keeps the Thinking switch checked
and disabled while leaving every supported effort selectable. An unmarked
generic option without `none` remains incompatible and hidden. Workspace
previews resolve this constraint from the selected provider-model entry, so the
same behavior is available before lazy session creation. A stale welcome
Thinking-off intent is discarded if refreshed model metadata makes thinking
mandatory before the first prompt.

The daemon exposes one owner-routed config-option mutation. Its public route is
restricted to `reasoning_effort`; the response carries fresh `configOptions`,
which becomes the caller's authoritative UI state. WebShell marks this update
for persistence, while ordinary ACP clients remain session-only. A successful
settings write emits the existing scope-aware `settings_changed` event; a
failed write leaves the live session updated but does not broadcast. The full
settings and lifecycle contract is defined in
[WebShell reasoning effort persistence](./webshell-reasoning-effort-persistence.md).

## Scope

Included:

- exact stable `qwen3.8-max` only;
- an editable, one-shot welcome preview with `xhigh` as the manifest default;
- application after lazy attach and model selection but before the first
  prompt;
- authoritative replacement by same-session context;
- the current WebShell conversation and the shared reasoning default for later
  sessions;
- scope-aware settings refresh after successful WebShell persistence;
- effort changes after completed messages and while a prompt is running;
- Thinking on/off and `low`, `medium`, `xhigh` effort;
- browser coverage for welcome, live override, model switching, old daemons,
  and the existing live mutation behavior.

Excluded:

- a per-model persisted/default mapping beyond the shared
  `model.reasoningEffort` setting;
- persistence for ordinary ACP config-option mutations;
- preview, aliases, and future reasoning-control shapes;
- route and runtime models;
- TUI and channel behavior;
- capability flags and general model/config broadcasts outside the existing
  scope-aware settings refresh.

## Compatibility

Only a raw, non-runtime, non-route model whose exact manifest id is
`qwen3.8-max` receives the preview. Preview, dated, aliased, opaque route,
runtime, and unrelated models do not. Older daemons omit the optional model
field, so WebShell does not infer or invent welcome-state capability. Existing
sessions continue to obey the daemon's live `configOptions`, including
Thinking off, non-default effort, missing capability, and incompatible option
shapes. Non-target sessions keep the existing generic ACP effort behavior,
and clients that do not consume the additive field remain compatible.
