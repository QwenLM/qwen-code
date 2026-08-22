# Kimi and Xiaomi MiMo authentication presets

## Goal

Expose Kimi and Xiaomi MiMo directly under `/auth` → **Third-party
Providers**, including their subscription endpoints, so users do not have to
recreate these providers through **Custom Provider**.

## Provider shape

Kimi is represented by one top-level preset with a second-level access-type
selector:

- **Coding Plan**: the Kimi membership coding benefit at
  `https://api.kimi.com/coding/v1`, with the four model IDs documented for
  third-party coding tools.
- **API Key (China)**: the Kimi Open Platform endpoint at
  `https://api.moonshot.cn/v1`.
- **API Key (International)**: the Kimi Open Platform endpoint at
  `https://api.moonshot.ai/v1`.

The two API Key choices recommend `kimi-k3`, `kimi-k2.7-code`,
`kimi-k2.7-code-highspeed`, and `kimi-k2.6`. Coding Plan and Kimi Open Platform
still use different keys, billing, and model IDs. Each endpoint option
therefore carries its own model list, and the setup flow resolves both the
model list and environment variable after the access type is selected.

Xiaomi MiMo is represented by one preset because its pay-as-you-go API and
Token Plan share the same model IDs and OpenAI-compatible request format. Its
endpoint selector includes pay-as-you-go plus the China, Singapore, and Europe
Token Plan endpoints. The recommended models are `mimo-v2.5-pro` and
`mimo-v2.5`.

Both presets remain editable so users can add later model IDs without
waiting for a Qwen Code release. The Third-party Providers list remains sorted
alphabetically by its displayed labels.

## Model metadata

- Kimi K3 uses a 1,048,576-token context window, always thinks, and accepts
  image and video input. Kimi K2.7 Code and K2.6 use a 262,144-token context
  window and accept image and video input; K2.7 Code always thinks.
- Kimi Code recommends `k3-256k` first for routine coding. `k3` uses a
  1,048,576-token context window; all other Kimi Code models use 262,144
  tokens. `k3` and both K2.7 Code IDs accept image and video input;
  `k3-256k` accepts images only. Thinking stays enabled so selecting a K3 or
  K2.7 Code ID does not silently route to K2.6.
- Both MiMo V2.5 models use a 1,048,576-token context window.
  `mimo-v2.5` accepts image, video, and audio input; the Pro model is kept
  text-only according to the published capability table.

No Qwen-specific `enable_thinking` field is installed for Kimi or MiMo. Their
OpenAI-compatible APIs use different thinking controls and enable thinking by
default.

## Sources

- [Kimi Code overview](https://www.kimi.com/code/docs/en/)
- [Kimi Code model configuration](https://www.kimi.com/code/docs/en/kimi-code/models.html)
- [Kimi API international overview](https://platform.kimi.ai/docs/api/overview)
- [Kimi API China overview](https://platform.kimi.com/docs/api/overview)
- [Kimi K3 API guide](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart)
- [Kimi K2.7 Code API guide](https://platform.kimi.ai/docs/guide/kimi-k2-7-code-quickstart)
- [Xiaomi MiMo first API call](https://mimo.mi.com/docs/en-US/quick-start/summary/first-api-call)
- [Xiaomi MiMo Token Plan](https://mimo.mi.com/docs/tokenplan/subscription)
- [Xiaomi MiMo model overview](https://mimo.mi.com/docs/quick-start/summary/model)

## Verification

Unit tests cover preset metadata, endpoint-specific model resolution,
install-plan output, registry discovery, and alphabetical ordering. A manual
E2E pass checks the `/auth` provider list and each endpoint selector without
submitting real credentials.
