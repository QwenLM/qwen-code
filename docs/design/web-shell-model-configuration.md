# Web Shell model configuration

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
Blank values use provider defaults. Preserve input while moving backward through
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
selection, and deletion identities.

## Model roles and existing configuration

Advisor Model uses the shared model picker and a main-model default choice.
Image Model becomes visible with an endpoint-qualified picker of configured image
routes. Voice Model lists the daemon's supported transcription models, including
voice-only entries. The voice picker retains its selected-workspace ownership.

Custom provider setup adds a purpose choice: conversation, image generation, or
voice transcription. Image routes receive supportsImageGeneration and imageOnly;
voice routes receive voiceOnly and require the OpenAI protocol and a supported ASR
model ID. Installing a service-only model preserves the current conversation model
and auth selection. Other preset setup behavior stays unchanged.
Reject service-only installs that would overwrite an existing conversation model
with the same protocol, ID, and endpoint before any settings or environment write.
Image setup describes the existing DashScope/MiniMax-compatible transports.

GET /workspace/models returns a secret-safe list of persisted model configurations,
including service-only models and the explicit context-window override. PATCH on
that route accepts an opaque model key and a context size (1–10,000,000), or null
to restore the registry default. The key includes scope, storage provider, model
ID, and endpoint; missing or ambiguous targets fail without a fallback. A locked
fresh read/modify/write preserves credentials and unrelated generation settings.
The model list attaches a small window-size editor to persisted rows; built-in and
runtime-only models do not claim to support persistent editing. Window writes refresh
the model registry for new sessions; existing sessions must restart to adopt the
new active generation limit, and the editor states this explicitly.

## Scope and ownership

The new model configuration routes, existing provider setup, and model management
remain legacy-primary scoped. Settings role selections use their existing scope
semantics. Voice continues to use the resolved selected runtime without falling
back to primary. Image configuration must reach live runtime configuration through
the existing settings/model-provider refresh path. GET projects only safe fields;
settings-change broadcasts invalidate clients without sending model credentials.

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
