/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config, OutputStyleDefinition } from '@qwen-code/qwen-code-core';
import {
  BUILT_IN_OUTPUT_STYLES,
  createDebugLogger,
  findOutputStyle,
  isSystemMdActive,
  loadOutputStyleCatalog,
  resolveMainSessionOutputStyle,
} from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import { SettingScope } from '../../config/settings.js';
import { t } from '../../i18n/index.js';

const debugLogger = createDebugLogger('OUTPUT_STYLE_COMMAND');

/** Comma-separated list of the built-in style names, for the command description. */
export const OUTPUT_STYLE_LIST = BUILT_IN_OUTPUT_STYLES.map(
  (style) => style.name,
).join(', ');

/** Comma-separated names of a catalog, for messages. */
export function formatOutputStyleNames(
  styles: readonly OutputStyleDefinition[],
): string {
  return styles.map((style) => style.name).join(', ');
}

/**
 * The styles this session can select: built-ins plus the user's and (in a
 * trusted workspace) the project's style files, re-read on every call so a
 * file added mid-session is picked up without a restart.
 */
export async function loadSessionOutputStyles(
  config: Config,
): Promise<readonly OutputStyleDefinition[]> {
  return loadOutputStyleCatalog({
    projectRoot: config.isTrustedFolder() ? config.getProjectRoot() : undefined,
  });
}

/**
 * Maps a user-supplied name to a style, where the literal `default`
 * (case-insensitively) means "no style". Returns `null` for an unknown name,
 * which is distinct from the `undefined` that selects the default style.
 */
export function resolveOutputStyleChoice(
  name: string,
  available: readonly OutputStyleDefinition[],
): OutputStyleDefinition | undefined | null {
  if (name.trim().toLowerCase() === 'default') {
    return undefined;
  }
  return findOutputStyle(available, name) ?? null;
}

/**
 * Applies an output style to the running session and persists it. `undefined`
 * selects the default style.
 *
 * Returns the feedback message to show in-chat.
 */
export async function applyOutputStyleSelection(
  config: Config,
  settings: LoadedSettings,
  style: OutputStyleDefinition | undefined,
  options: { allowWorkspaceSettingsWrite?: boolean } = {},
): Promise<string> {
  if (config.getBareMode() || config.isSafeMode()) {
    throw new Error(
      t('Output styles are unavailable in --bare and --safe-mode.'),
    );
  }

  const workspaceOwnsOutputStyle =
    settings.isTrusted &&
    Object.prototype.hasOwnProperty.call(
      settings.workspace.settings.general ?? {},
      'outputStyle',
    );
  if (
    workspaceOwnsOutputStyle &&
    options.allowWorkspaceSettingsWrite === false
  ) {
    throw new Error(
      t('Project output style settings are not available in this session.'),
    );
  }
  settings.setValue(
    workspaceOwnsOutputStyle ? SettingScope.Workspace : SettingScope.User,
    'general.outputStyle',
    style ? style.name : 'default',
    undefined,
    { throwOnWriteFailure: true },
  );

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
  if (!style) {
    return t('Output style cleared; responses use the default style.');
  }
  let message = t('Output style set to {{name}}.', { name: style.name });
  if (!resolveMainSessionOutputStyle(config)) {
    message +=
      config.getSystemPrompt() || isSystemMdActive()
        ? ` ${t(
            'It is saved but has no effect in this session because the system prompt is replaced (--system-prompt or QWEN_SYSTEM_MD).',
          )}`
        : ` ${t('It is saved but Learning is skipped in headless runs.')}`;
  }
  return message;
}
