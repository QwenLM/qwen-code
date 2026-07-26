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
