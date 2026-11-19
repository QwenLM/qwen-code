# Web Shell model configuration

[English](web-shell-model-configuration.md) | [简体中文](web-shell-model-configuration.zh-CN.md)

## Problem

Settings → Models opens the provider setup flow to add models. Its advanced
configuration uses menu-like buttons without checked semantics and an unlabeled
context input. There is no output-token limit control even though the install
API already accepts `advancedConfig.maxTokens`. Invalid context sizes can be
silently changed or discarded, and the model list does not show configured
capabilities or context limits.

## Design

Keep the existing provider catalog, setup steps, persistence, and runtime refresh
behavior. Replace only the advanced step with shared Field, Switch, Checkbox,
and Input primitives. Expose thinking, individual image/video/audio/PDF input
capabilities, context-window size, and maximum output tokens. Optional numeric
values must be whole numbers from 1 to 10,000,000, matching the daemon parser.
Blank values let the registry infer limits from the model ID. Preserve input while moving backward through
the wizard and reset it when starting a new provider. Saving disables all
editable controls.

Use one advanced-config value for both the install request and a human-readable
review of provider, protocol, endpoint, model IDs, capability flags, and limits.
Only indicate whether an API key is set. Do not reconstruct settings.json:
the backend determines custom credential variable names and preset metadata.
Provider presets retain their existing catalog-defined behavior; do not
advertise overrides that the backend ignores.

Show the model ID, description, effective context limit, supported input
modalities, and credential environment-variable name in the existing model
list. Do not expose credential values. Continue using the current list grouping,
selection and deletion controls, matching persisted entries by opaque configuration key.

## Model roles and existing configuration

Advisor Model uses the shared model picker and a main-model default choice.
Configured choices retain their exact raw endpoint identity; the runtime strips
that qualifier before issuing requests and uses only that route’s credentials.
An obsolete endpoint fails instead of binding another configuration. Loading,
failed, or unresolved role choices cannot implicitly reset a saved selection.
Image Model becomes visible with an endpoint-qualified picker of configured image
routes. Voice Model lists the daemon's supported transcription models, including
voice-only entries and their display names, safe endpoints, and context limits. The voice picker retains its selected-workspace ownership.

Custom provider setup adds a purpose choice: conversation, image generation, or
voice transcription. Image routes receive supportsImageGeneration and imageOnly;
voice routes receive voiceOnly and require the OpenAI protocol and a supported ASR
model ID. Installing a service-only model preserves the current conversation model
and auth selection, including service-only presets. New service routes follow
existing conversation routes and custom service credentials use separate
environment keys. Reconnecting without an explicit purpose preserves the stored
role, generation settings, and service credential key. ACP lists IDs grouped by
endpoint and credential key; omitted credentials cannot reuse a service key for
new conversation IDs. Image and voice groups with independent keys must reconnect
separately. Installs reject new ambiguity for existing voice-only or selected voice
IDs before writing. Other preset setup behavior stays unchanged.
An edited context window survives a preset reconnect. Accepting a template update
refreshes catalog-owned names and generation defaults while preserving custom
model IDs and their settings. An omitted advanced configuration preserves saved
generation settings during credential-only reconnects; explicitly submitting the
custom advanced form, including an empty form, replaces its thinking, modality,
window, and output-limit controls while retaining unrelated settings. Web submits
`advancedConfig.replaceExisting: true` for this full-form replacement. Partial
submissions from other clients preserve omitted controls; explicitly disabling
thinking or modalities changes only that control.
A custom service reconnect with a differently
spelled URL in the same credential bucket is rejected before writing; the user
must use the saved raw endpoint so exact role selections remain valid. Saving
only service models does not complete first-time conversation authentication.
Reject service-only installs that would overwrite an existing conversation model
through either identity replacement or preset ownership before any settings or
environment write. Installs containing conversation models also reject implicit
removal of owned service models omitted from the selection. A preset can move
owned service models to a new endpoint when their IDs and purposes are retained.
Owned replacements cannot change purpose merely by changing endpoints. Append and service-only
preset reselection retain their existing behavior. Changing an existing identity
to another purpose is rejected.
Image setup describes the existing DashScope/MiniMax-compatible transports.

GET /workspace/models returns a secret-safe list of persisted model configurations,
including service-only models and the explicit context-window override. PATCH on
that route accepts an opaque model key and a context size (1–10,000,000), or null
to restore model-ID inference. DELETE accepts the same opaque key for exact
persisted targeting even when displayed URLs are redacted. The key includes scope, storage provider, model
ID, and endpoint; missing or ambiguous storage targets fail without a fallback. A locked
fresh read/modify/write preserves credentials and unrelated generation settings.
PATCH writes the unresolved settings copy so environment placeholders remain
placeholders on disk. DELETE checks its raw scope snapshots inside the writer
lock and returns a conflict if another edit committed since its read. Removing a
model clears role references when no eligible route remains for that role.
Survivors follow the registry's first-entry precedence for each protocol, ID,
and raw endpoint; shadowed aliases cannot preserve a pin. Fast accepts fast-only
models, vision accepts vision-only models, and image requires a usable image
configuration. Main, advisor, and compaction selections exclude all four
selector-only flags. Voice and fallback references retain their bare-ID behavior.
The model list attaches a small window-size editor to persisted rows; built-in and
runtime-only models do not claim to support persistent editing. Window writes refresh
the model registry for new sessions; existing sessions must restart to adopt the
new active generation limit, and the editor states this explicitly.

## Scope and ownership

The new model configuration routes, existing provider setup, and model management
remain legacy-primary scoped. Settings role selections use their existing scope
semantics. Configuration keys follow each provider bucket’s actual writable
scope, including user buckets inherited alongside unrelated workspace providers.
Route uniqueness also includes read-only System and SystemDefaults buckets, so
an alias cannot attach a writable key or role choice to a read-only model.
An independently stored writable alias retains its exact delete action and is
labelled as a saved configuration. Ambiguous runtime routes expose
`canEditContextWindow: false` and reject window updates, so an alias cannot
silently edit a value the runtime does not use. Keyless deletion resolves all
effective scopes, including read-only entries, and requires one writable target;
redacted endpoints retain an ID-only fallback only when that ID is unique.
PATCH and DELETE synchronize the scopes actually committed, including role
clears and partial persistence: any user write refreshes registered sibling
runtimes, while workspace-only writes stay in the primary runtime.
Voice continues to use the resolved selected runtime without falling
back to primary. Image configuration must reach live runtime configuration through
the existing settings/model-provider refresh path. Disabling image generation
hides its cached tool and refreshes the current conversation’s tool declarations;
re-enabling restores availability. A busy session applies missed image and provider
changes on its next idle reload. Provider comparisons use each session’s actual
registry; image setup is retried on every idle reload, including after a failure.
Code mode bindings retain the same tool availability and declaration gates as
direct tool declarations. GET projects only safe fields;
settings-change broadcasts invalidate clients without sending model credentials.
Provider installs that remain hidden by a higher-precedence provider bucket fail
and roll back before selecting the new model. The CLI adapter snapshots original
file contents separately from each write’s temporary `.orig` backup, restoring
exact contents or initial absence if the install fails. Service-only save feedback uses
the primary runtime's effective authentication environment as well as persisted
settings.

Production changes cover Web Shell components and translations, the daemon SDK,
CLI route/persistence wiring, and the provider install plan. Existing provider and
main-model status APIs retain their model filters. Credential editing and arbitrary
JSON editing are outside scope.

## Verification

Focused tests cover model identity, secret preservation, scope/trust, numeric
validation, service-only install without main selection, role picker values,
window editing/reset/error, and existing wizard behavior. Browser tests cover
Settings → Models at desktop and narrow widths against the built static UI.
Real daemon API tests use isolated settings with test-only credentials. Build,
typecheck, bundle, and audit the full diff before completion.

## Open questions

None. Voice configuration covers the transcription transports already supported
by the daemon; this change does not add speech synthesis or new transports.
