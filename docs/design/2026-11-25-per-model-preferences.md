# CLI preferences by model

[English](2026-11-25-per-model-preferences.md) | [简体中文](2026-11-25-per-model-preferences.zh-CN.md)

## Goal

The CLI saves a global reasoning effort today and carries the live value when
switching models. Context capacity already comes from the model configuration
and drives the context display and automatic compaction. Let users save a
reasoning effort and a context window for each primary chat model in the local
CLI and recover both on a model switch or a fresh launch.

## Design

- Adopt the Preview settings shape, `model.preferences[routeKey]`, with two
  optional fields, `reasoning.effort` and `contextWindow`. Build the key from
  main's resolved authentication type, model ID, and endpoint identity so that
  identical IDs on different endpoints have independent preferences.
- Reuse the CLI settings writer and model-selection scope rules. Write only the
  edited field in the selected scope. Removing a field returns to the value
  resolved from the remaining settings and model defaults.
- Resolve the selected route before applying preferences at startup, on a full
  configuration rebuild, and on an OAuth hot switch. Start from the target
  model's configuration so a setting for the outgoing model cannot become the
  incoming model's default. Use the legacy `model.reasoningEffort` as the
  fallback for an absent model-specific effort. Apply the existing reasoning
  capability rules and explicit session overrides.
- Route `/effort` and both terminal effort pickers through the same
  preference writer. Use `/context-window <tokens|default>` to set or clear the
  active model's window preference. Validate the token count against the
  target's capacity before applying the stored override. The resulting
  `contextWindowSize` feeds the existing display and compaction paths.
  Apply successful changes to the active configuration as well as saving them.

## Acceptance

- Save different efforts and windows on A and B. Check both effective values
  after A → B → A, then check both models again in a fresh CLI process.
- Exercise same-ID endpoints and the OAuth hot-switch path. Verify that the
  resolved target determines which preference applies.
- Check that clearing one field preserves the other, that unsupported values
  are rejected, and that the legacy effort is used for models without a saved
  effort. Exercise field updates in the applicable settings scope and verify
  that session-only changes stay out of the settings file.
