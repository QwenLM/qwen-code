# WebShell Qwen 3.8 reasoning controls

## Goal

Expose Thinking and effort controls for the exact `qwen3.8-max` model in the
WebShell model popover. Acknowledged changes apply to subsequent live-session
requests.

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

WebShell retains PR #8675's interaction design: the current reasoning state is
shown as a suffix on the model chip, reasoning options occupy the first model
popover, and model search is opened from its Model submenu.

Selecting `none` writes `reasoning: false` to the current session's live
generator configuration. Selecting an effort writes that effort and enables
reasoning. Reading the manifest does not inject a default into generation
configuration, so sessions that never use the controls retain main's existing
wire behavior.

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
- the current WebShell conversation;
- Thinking on/off and `low`, `medium`, `xhigh` effort;
- one browser smoke covering the rendered controls and real request payload.

Excluded:

- persistence across sessions or restarts;
- TUI, channel, provider, auth-refresh, and runtime-snapshot behavior;
- persisted/default-model semantics;
- preview, aliases, and future reasoning-control shapes;
- capability flags and cross-client model/config sync.

## Compatibility

Older daemons do not advertise an option containing `none`, so WebShell hides
the controls. Non-target models keep the existing generic ACP effort option,
and clients that do not consume this option remain compatible.
