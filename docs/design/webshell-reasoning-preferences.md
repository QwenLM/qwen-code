# WebShell model reasoning preferences

## Goal

WebShell keeps the selected model and reasoning preference across daemon
sessions without creating an empty session from the Welcome screen. The first
prompt remains the session-creation boundary.

This change uses the existing `model.reasoningEffort` setting. It does not add
a second reasoning-enabled setting and does not change provider request
mapping or the public ACP protocol.

## Stored values

`model.reasoningEffort` has one meaning at every daemon boundary:

- an absent value uses the target model's default thinking behavior;
- `none` disables thinking;
- `low`, `medium`, `high`, `xhigh`, or `max` enables thinking at that tier.

`default` is a control command only. It removes the stored value and resets the
live session to the model default. It is never stored and is never rendered as
an effort choice.

The Core `ReasoningEffort` type remains the five strict tiers. `none` and
`default` are represented only by the daemon and settings boundary type.

## Session lifecycle

Before a session exists, WebShell keeps the selected model and reasoning value
in component state. Sending the first prompt performs these operations in
order: create, attach, set model, persist reasoning, then submit the prompt.

For a regular live session, WebShell sends reasoning changes immediately with
`persist: true`. Managed standalone conversations keep their existing
session-only settings boundary and use `persist: false`. WebShell updates its
state only from the daemon's confirmed `configOptions` response. The session
owns preference writes and rollback across writable scopes; a failed write
also restores the live overrides. Model reconciliation reuses the same reset
operation. Requested persistence completes before the daemon reports success.

Turning thinking off sends `none`. Turning it on again sends `default`, which
removes `none` and uses the model default instead of restoring the old tier.

## Capability reconciliation

Every model switch reconciles the stored selection against the target model:

- a supported tier and an allowed `none` value are retained;
- an unsupported tier is removed and the live override is reset;
- a toggle-only model retains only `none` when disabling is allowed;
- a model without reasoning controls removes every explicit selection;
- mandatory thinking removes `none`.

There is no fallback or tier clamping at this layer. Once an incompatible
selection is removed, switching back does not restore it.

Session-only ACP model changes clear incompatible live overrides without
changing the shared stored preference. Only a persistent model selection may
remove it from writable settings scopes.

Welcome uses model-specific workspace previews. Once a session exists,
WebShell renders reasoning controls only from that session's authoritative
`configOptions`.

## UI and localization

Tiered models render only the real advertised tiers. Toggle-only models render
only the thinking switch: no effort heading, effort row, or Default choice is
present in the DOM. Unsupported models render no reasoning section.

WebShell translates the five fixed effort values itself in English and Chinese
and never renders daemon-provided English labels.
