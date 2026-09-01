/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config, OutputStyleDefinition } from '@qwen-code/qwen-code-core';
import {
  BUILT_IN_OUTPUT_STYLES,
  createDebugLogger,
  getBuiltInOutputStyle,
  resolveMainSessionOutputStyle,
} from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import { SettingScope } from '../../config/settings.js';
import { t } from '../../i18n/index.js';

const debugLogger = createDebugLogger('OUTPUT_STYLE_COMMAND');

/** Comma-separated list of the selectable style names, for messages. */
export const OUTPUT_STYLE_LIST = BUILT_IN_OUTPUT_STYLES.map(
  (style) => style.name,
).join(', ');

/**
 * Maps a user-supplied name to a style, where the literal `default`
 * (case-insensitively) means "no style". Returns `null` for an unknown name,
 * which is distinct from the `undefined` that selects the default style.
 */
export function resolveOutputStyleChoice(
  name: string,
): OutputStyleDefinition | undefined | null {
  if (name.trim().toLowerCase() === 'default') {
    return undefined;
  }
  return getBuiltInOutputStyle(name) ?? null;
}

/**
 * Applies an output style to the running session and persists it to user
 * settings. `undefined` selects the default style; the persisted value is the
 * literal `default` rather than a deleted key, so a workspace-level setting
 * cannot silently resurface on the next start.
 *
 * Returns the feedback message to show in-chat.
 */
export async function applyOutputStyleSelection(
  config: Config,
  settings: LoadedSettings,
  style: OutputStyleDefinition | undefined,
): Promise<string> {
  config.setOutputStyle(style);
  try {
    // The style lives in the stable layer of an already-bound system
    // instruction, so it must be rebuilt for the change to reach the model.
    await config.getLlmClient().refreshSystemInstruction();
  } catch (error) {
    debugLogger.warn(
      'Failed to apply output style to the running session:',
      error,
    );
  }
  try {
    settings.setValue(
      SettingScope.User,
      'general.outputStyle',
      style ? style.name : 'default',
    );
  } catch (error) {
    debugLogger.warn('Failed to save output style setting:', error);
  }

  if (!style) {
    return t('Output style cleared; responses use the default style.');
  }
  let message = t('Output style set to {{name}}.', { name: style.name });
  if (!resolveMainSessionOutputStyle(config)) {
    message += ` ${t(
      'It is saved but has no effect in this session because the system prompt is replaced (--system-prompt or QWEN_SYSTEM_MD).',
    )}`;
  }
  return message;
}
