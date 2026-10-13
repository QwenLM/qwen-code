/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Whether a model may appear in the composer or Settings model list.
 * Keep the non-runtime OAuth rule in sync with the CLI's acpModelUtils.ts
 * encoding and the VSCode webview's utils/discontinuedModel.ts. Derive it from
 * the auth marker so new OAuth registry entries cannot bypass the filter.
 */
export function isVisibleComposerModel(model: { id: string }): boolean {
  const id = model.id.trim();
  return id.startsWith('$runtime|') || !id.endsWith('(qwen-oauth)');
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
