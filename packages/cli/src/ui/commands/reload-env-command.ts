/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand } from './types.js';
import { CommandKind } from './types.js';
import {
  SettingScope,
  type Config,
  createDebugLogger,
} from '@qwen-code/qwen-code-core';
import {
  reloadEnvironment,
  getUserSettingsPath,
} from '../../config/settings.js';
import { t } from '../../i18n/index.js';
import fs from 'fs';
import path from 'path';
import stripJsonComments from 'strip-json-comments';

const debugLogger = createDebugLogger('RELOAD_ENV');

async function getCurrentCwd(config: Config | null): Promise<string> {
  if (config?.getCwd) {
    const cwd = config.getCwd();
    if (cwd) return cwd;
  }
  return process.cwd();
}

function validateSettingsFile(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) return true;
    const content = fs.readFileSync(filePath, 'utf-8');
    JSON.parse(stripJsonComments(content));
    return true;
  } catch {
    return false;
  }
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

    // Pre-check: validate settings files are parseable before reloading.
    // reloadScopeFromDisk swallows parse errors internally (debugLogger.warn
    // only), so without this check the command would report success while
    // silently using stale settings.
    const settingsWarnings: string[] = [];
    const userSettingsPath = getUserSettingsPath();
    if (!validateSettingsFile(userSettingsPath)) {
      settingsWarnings.push(userSettingsPath);
    }
    const workspaceSettingsPath = path.join(cwd, '.qwen', 'settings.json');
    if (!validateSettingsFile(workspaceSettingsPath)) {
      settingsWarnings.push(workspaceSettingsPath);
    }

    settings.reloadScopeFromDisk(SettingScope.User);
    settings.reloadScopeFromDisk(SettingScope.Workspace);

    const result = reloadEnvironment(settings.merged, cwd);

    // Refresh auth when any env keys changed (added OR removed) so the
    // ContentGenerator picks up new credentials immediately.
    type AuthState = 'success' | 'failed' | 'not_attempted';
    let authState: AuthState = 'not_attempted';
    if (
      (result.updatedKeys.length > 0 || result.removedKeys.length > 0) &&
      services.config
    ) {
      const cgConfig = services.config.getContentGeneratorConfig?.();
      if (cgConfig?.authType) {
        try {
          await services.config.refreshAuth(cgConfig.authType);
          authState = 'success';
        } catch (err) {
          debugLogger.warn(`refreshAuth failed after env reload: ${err}`);
          authState = 'failed';
        }
      }
    }

    const parts: string[] = [];

    if (settingsWarnings.length > 0) {
      parts.push(
        `${t('Warning: Failed to parse settings file. Check for JSON syntax errors.')} (${settingsWarnings.join(', ')})`,
      );
    }

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
    if (authState === 'success') {
      parts.push(
        t('Environment reloaded and API client refreshed. New keys are live.'),
      );
    } else if (authState === 'failed') {
      parts.push(
        t(
          'Environment reloaded, but API client refresh failed. Restart the CLI to pick up new keys.',
        ),
      );
    } else {
      parts.push(
        t(
          'Environment reloaded. New API keys will take effect on the next request.',
        ),
      );
    }

    return {
      type: 'message' as const,
      messageType: 'info' as const,
      content: parts.join('\n'),
    };
  },
};
