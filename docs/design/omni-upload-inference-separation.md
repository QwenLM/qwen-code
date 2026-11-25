# Omni upload and inference separation

## Problem

Omni delivery currently derives the temporary-upload endpoint, credential,
model, activation gate, and upload-cache scope from the inference
`ContentGeneratorConfig`. That makes Omni inactive when inference is routed to
a self-hosted OpenAI-compatible endpoint, even when a valid DashScope upload
channel is available.

Two model-facing gaps are also confirmed in normal use:

- media policy tools expose result artifacts to the client but omit the output
  file path from `llmContent`, so the model cannot reliably call `read_file` on
  a clip or other derivative;
- the `read_file` declaration supports audio and video at runtime but does not
  advertise either modality.

## Configuration

Add three optional settings under `omni.delivery.upload`:

- `baseUrl`: DashScope-compatible endpoint whose origin owns `/api/v1/uploads`;
- `apiKeyEnv`: name of the environment variable containing the upload API key;
- `model`: DashScope model identifier sent to the upload-policy endpoint.

If all three are absent, retain the existing behavior: a static
DashScope-compatible inference configuration is also the upload configuration.
If any dedicated upload setting is present, all three are required. Invalid or
incomplete explicit configuration, a missing/empty key environment variable,
or a non-DashScope upload endpoint is a startup configuration error. The raw
key is never written to settings or diagnostics.

## Runtime boundary

The resolved upload configuration is the only source for:

- Omni delivery activation after the existing enabled/trust checks;
- every `DashScopeUploader` construction, including reactive re-upload after a
  server token-limit rejection;
- the upload model passed to `getPolicy` and the persistent upload-cache key;
- the endpoint/credential cache-scope fingerprint.

Inference configuration remains unchanged and is used only by the model
provider. No upload key is sent to the inference endpoint, and no inference key
is sent to the upload endpoint.

## Model-visible tool results

Successful media policy tools include the absolute output path in
`llmContent`, while retaining the relative artifact path used by fixed-policy
staging and promotion. Fixed-policy results do not feed the model; direct
model/client calls receive a path that is immediately usable by `read_file`.

The `read_file` declaration explicitly lists audio and video, qualified by the
selected model's modality support. No new media wire format such as
`audio_url` is introduced.

## Verification

- Dedicated DashScope upload configuration activates Omni while inference uses
  a bare-IP custom endpoint.
- Legacy DashScope inference-only configuration remains active.
- Invalid explicit upload configuration fails at startup.
- Normal delivery and reactive degradation use the upload endpoint, key, and
  model; cache reuse is isolated from inference configuration changes.
- Media policy tool success text contains an absolute readable output path.
- The `read_file` schema names audio and video, and existing audio/video
  execution tests remain green.
