/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';
import { createDebugLogger, getErrorMessage } from '@qwen-code/qwen-code-core';
import { loadSettings, SettingScope } from '../../config/settings.js';

const debugLogger = createDebugLogger('HOOKS_ENABLE');

interface EnableArgs {
  hookName: string;
}

/**
 * Enable a hook by removing it from the disabled list
 */
export async function handleEnableHook(hookName: string): Promise<void> {
  const workingDir = process.cwd();
  const settings = loadSettings(workingDir);

  try {
    // Get current hooks settings
    const mergedSettings = settings.merged as
      | Record<string, unknown>
      | undefined;
    const hooksSettings = (mergedSettings?.['hooks'] || {}) as Record<
      string,
      unknown
    >;
    const disabledHooks = (hooksSettings['disabled'] || []) as string[];

    // Check if hook is in disabled list
    if (!disabledHooks.includes(hookName)) {
      debugLogger.info(`Hook "${hookName}" is not disabled.`);
      return;
    }

    // Remove hook from disabled list
    const newDisabledHooks = disabledHooks.filter((h) => h !== hookName);
    const newHooksSettings = {
      ...hooksSettings,
      disabled: newDisabledHooks,
    };

    // Save updated settings
    settings.setValue(
      SettingScope.Workspace,
      'hooks' as keyof typeof settings.merged,
      newHooksSettings as never,
    );

    debugLogger.info(`✓ Hook "${hookName}" has been enabled.`);
  } catch (error) {
    debugLogger.error(`Error enabling hook: ${getErrorMessage(error)}`);
  }
}

export const enableCommand: CommandModule = {
  command: 'enable <hook-name>',
  describe: 'Enable a disabled hook',
  builder: (yargs) =>
    yargs.positional('hook-name', {
      describe: 'Name of the hook to enable',
      type: 'string',
      demandOption: true,
    }),
  handler: async (argv) => {
    const args = argv as unknown as EnableArgs;
    await handleEnableHook(args.hookName);
    process.exit(0);
  },
};
