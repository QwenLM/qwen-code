/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Model IDs hidden from the composer's model picker — internal / duplicate
 * entries that must not be user-selectable. Shared by the main chat composer
 * (App) and the split-view pane composers (ChatPane) so both hide the same set.
 */
export const HIDDEN_COMPOSER_MODEL_IDS = new Set(['coder-model(qwen-oauth)']);

/** Whether a model may appear in the composer's model picker. */
export function isVisibleComposerModel(model: { id: string }): boolean {
  return !HIDDEN_COMPOSER_MODEL_IDS.has(model.id);
}

/**
 * Whether Settings ▸ Model must hide a row for the discontinued built-in OAuth
 * entry. Settings holds the structured form (`authType` on the provider, the
 * base id on the model), so it rebuilds the encoded id the composer hides by
 * and asks that shared policy instead of restating it at the call site.
 *
 * The row the session is actually running is deliberately kept, matching
 * `isDiscontinuedModel` in the VS Code webview, so a live qwen-oauth session
 * still lists its own model. `isCurrent` is the only usable signal for that:
 * the daemon's provider list skips runtime rows and hardcodes `isRuntime:
 * false`, so the runtime flag never marks the running model.
 */
export function isDiscontinuedSettingsModel(
  provider: { authType: string },
  model: { baseModelId: string; isCurrent: boolean },
): boolean {
  return (
    !isVisibleComposerModel({
      id: `${model.baseModelId}(${provider.authType})`,
    }) && !model.isCurrent
  );
}

/**
 * Whether the model picker is unavailable for a fresh standalone draft: no
 * session attached yet and the hydrated catalog has no user-selectable
 * models. Shared by every picker entry point (composer toolbar, StatusBar
 * button, /model command) so the gates never drift apart.
 */
export function isStandaloneModelPickerUnavailable(input: {
  sessionId: string | null | undefined;
  sessionContextKind: string | undefined;
  models: readonly { id: string }[] | undefined;
}): boolean {
  return (
    !input.sessionId &&
    input.sessionContextKind === 'standalone' &&
    (input.models ?? []).filter(isVisibleComposerModel).length === 0
  );
}
