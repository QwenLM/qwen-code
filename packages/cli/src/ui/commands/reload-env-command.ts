/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand } from './types.js';
import { CommandKind } from './types.js';
import { SettingScope, type Config } from '@qwen-code/qwen-code-core';
import { reloadEnvironment } from '../../config/settings.js';
import { t } from '../../i18n/index.js';

async function getCurrentCwd(config: Config | null): Promise<string> {
  if (config?.getCwd) {
    const cwd = config.getCwd();
    if (cwd) return cwd;
  }
  return process.cwd();
}

export const reloadEnvCommand: SlashCommand = {
  name: 'reload-env',
  altNames: ['reload-key', 'refresh-env'],
  get description() {
    return t(
      'Reload environment variables and API keys from settings.json and .env files without restarting',
    );
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  action: async (context) => {
    const { services } = context;
    const settings = services.settings;

    const cwd = await getCurrentCwd(services.config);

    settings.reloadScopeFromDisk(SettingScope.User);
    settings.reloadScopeFromDisk(SettingScope.Workspace);

    const result = reloadEnvironment(settings.merged, cwd);

    const parts: string[] = [];

    if (result.updatedKeys.length > 0) {
      const masked = result.updatedKeys.map((k) => {
        const val = process.env[k];
        const preview =
          val && val.length > 8
            ? val.slice(0, 4) + '...' + val.slice(-4)
            : '***';
        return `  ${k} → ${preview}`;
      });
      parts.push(`${t('Updated keys')}:`);
      parts.push(...masked);
    }

    if (result.removedKeys.length > 0) {
      parts.push(`${t('Removed keys')}: ${result.removedKeys.join(', ')}`);
    }

    if (parts.length === 0) {
      return {
        type: 'message' as const,
        messageType: 'info' as const,
        content: t('No environment changes detected.'),
      };
    }

    parts.push('');
    parts.push(
      t(
        'Environment reloaded. New API keys will take effect on the next request.',
      ),
    );

    return {
      type: 'message' as const,
      messageType: 'info' as const,
      content: parts.join('\n'),
    };
  },
};
