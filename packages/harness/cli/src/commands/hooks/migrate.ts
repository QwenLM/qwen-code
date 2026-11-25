/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { resolveCommandSettings } from '../../config/createCliSettingsService.js';
import { Command } from '@commander-js/extra-typings';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  runLogger,
  getErrorMessage,
  BRAND_CLI_NAME,
  BRAND_CLI_BIN,
  CONFIG_DIR,
  ENV_PROJECT_DIR,
} from '@qwen-code/core';

/**
 * Migrate a Claude Code hook configuration to Gemini format
 */
function migrateClaudeHook(claudeHook: unknown): unknown {
  if (!claudeHook || typeof claudeHook !== 'object') {
    return claudeHook;
  }

  const hook = claudeHook as Record<string, unknown>;
  const migrated: Record<string, unknown> = {};

  // Map command field
  if ('command' in hook) {
    migrated['command'] = (hook['command'] as string).replace(
      /\$CLAUDE_PROJECT_DIR/g,
      () => '$' + ENV_PROJECT_DIR,
    );
  }

  // Map type field
  if ('type' in hook && hook['type'] === 'command') {
    migrated['type'] = 'command';
  }

  // Map timeout field (Claude uses seconds, Gemini uses seconds)
  // eslint-disable-next-line eslint-js/no-restricted-syntax
  if ('timeout' in hook && typeof hook['timeout'] === 'number') {
    migrated['timeout'] = hook['timeout'];
  }

  return migrated;
}

/**
 * Migrate Claude Code hooks configuration to Gemini format
 */
function migrateClaudeHooks(claudeConfig: unknown): Record<string, unknown> {
  if (!claudeConfig || typeof claudeConfig !== 'object') {
    return {};
  }

  const config = claudeConfig as Record<string, unknown>;
  const geminiHooks: Record<string, unknown> = {};

  // Check if there's a hooks section
  const hooksSection = config['hooks'] as Record<string, unknown> | undefined;
  if (!hooksSection || typeof hooksSection !== 'object') {
    return {};
  }

  for (const [eventName, eventConfig] of Object.entries(hooksSection)) {
    // CC event names are natively supported — keep as-is
    const geminiEventName = eventName;

    if (!Array.isArray(eventConfig)) {
      continue;
    }

    // Migrate each hook definition
    const migratedDefinitions = eventConfig.map((def: unknown) => {
      if (!def || typeof def !== 'object') {
        return def;
      }

      const definition = def as Record<string, unknown>;
      const migratedDef: Record<string, unknown> = {};

      // Copy matcher (CC matchers are natively supported — keep as-is)
      if (
        'matcher' in definition &&
        // eslint-disable-next-line eslint-js/no-restricted-syntax
        typeof definition['matcher'] === 'string'
      ) {
        migratedDef['matcher'] = definition['matcher'];
      }

      // Copy sequential flag
      if ('sequential' in definition) {
        migratedDef['sequential'] = definition['sequential'];
      }

      // Migrate hooks array
      if ('hooks' in definition && Array.isArray(definition['hooks'])) {
        migratedDef['hooks'] = definition['hooks'].map(migrateClaudeHook);
      }

      return migratedDef;
    });

    geminiHooks[geminiEventName] = migratedDefinitions;
  }

  return geminiHooks;
}

/**
 * Handle migration from Claude Code
 */
export async function handleMigrateFromClaude(): Promise<boolean> {
  const { SettingScope } = await import('../../config/settings.js');
  const stripJsonComments = (await import('strip-json-comments')).default;

  const workingDir = process.cwd();

  // Look for Claude settings in .claude directory
  const claudeDir = path.join(workingDir, '.claude');
  const claudeSettingsPath = path.join(claudeDir, 'settings.json');
  const claudeLocalSettingsPath = path.join(claudeDir, 'settings.local.json');

  let claudeSettings: Record<string, unknown> | null = null;
  let sourceFile = '';

  // Try to read settings.local.json first, then settings.json
  if (fs.existsSync(claudeLocalSettingsPath)) {
    sourceFile = claudeLocalSettingsPath;
    try {
      const content = fs.readFileSync(claudeLocalSettingsPath, 'utf-8');
      claudeSettings = JSON.parse(stripJsonComments(content)) as Record<
        string,
        unknown
      >;
    } catch (error) {
      runLogger.error(
        `Error reading ${claudeLocalSettingsPath}: ${getErrorMessage(error)}`,
      );
    }
  } else if (fs.existsSync(claudeSettingsPath)) {
    sourceFile = claudeSettingsPath;
    try {
      const content = fs.readFileSync(claudeSettingsPath, 'utf-8');
      claudeSettings = JSON.parse(stripJsonComments(content)) as Record<
        string,
        unknown
      >;
    } catch (error) {
      runLogger.error(
        `Error reading ${claudeSettingsPath}: ${getErrorMessage(error)}`,
      );
    }
  } else {
    runLogger.error(
      'No Claude Code settings found in .claude directory. Expected settings.json or settings.local.json',
    );
    return false;
  }

  if (!claudeSettings) {
    return false;
  }

  runLogger.log(`Found Claude Code settings in: ${sourceFile}`);

  // Migrate hooks
  const migratedHooks = migrateClaudeHooks(claudeSettings);

  if (Object.keys(migratedHooks).length === 0) {
    runLogger.log('No hooks found in Claude Code settings to migrate.');
    return true;
  }

  runLogger.log(
    `Migrating ${Object.keys(migratedHooks).length} hook event(s)...`,
  );

  // Load current settings
  const settings = await resolveCommandSettings(workingDir);
  const saved = settings.mutateScope(SettingScope.Project, (editor) => {
    for (const [event, definitions] of Object.entries(migratedHooks)) {
      editor.set(['hooks', event], definitions);
    }
  });
  if (saved) {
    runLogger.log(
      `✓ Hooks successfully migrated to ${CONFIG_DIR}/settings.json`,
    );
    runLogger.log(
      `\nMigration complete! Please review the migrated hooks in ${CONFIG_DIR}/settings.json`,
    );
  } else {
    runLogger.error('Error saving migrated hooks: settings write failed');
  }
  return saved;
}

export function createMigrateCommand(): Command {
  return new Command('migrate')
    .description(`Migrate hooks from Claude Code to ${BRAND_CLI_NAME}`)
    .option('--from-claude', 'Migrate from Claude Code hooks', false)
    .action(async (options) => {
      const { exitCli } = await import('../../utils/exitCli.js');
      if (options.fromClaude) {
        const saved = await handleMigrateFromClaude();
        await exitCli(saved ? 0 : 1);
        return;
      } else {
        runLogger.log(
          `Usage: ${BRAND_CLI_BIN} hooks migrate --from-claude\n\nMigrate hooks from Claude Code to ${BRAND_CLI_NAME} format.`,
        );
      }
      await exitCli();
    });
}
