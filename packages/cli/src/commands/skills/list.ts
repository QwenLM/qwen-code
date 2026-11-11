/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createCliSettingsService } from '../../config/createCliSettingsService.js';
import { Command } from '@commander-js/extra-typings';
import type { CliArgs } from '../../config/config.js';
import {
  PermissionManager,
  type PluginManagerFactory,
} from '@qwen-code/core';

export async function handleList(
  args: { all?: boolean },
  pluginManagerFactory?: PluginManagerFactory,
) {
  const { loadCliConfig } = await import('../../config/config.js');
  const chalk = (await import('chalk')).default;

  const workspaceDir = process.cwd();
  const { restoreLoadedEnvironment,
    getFlagSettingsInput,
  } = await import('../../config/settings.js');
  const { eagerParseSettingSourcesFlag } = await import(
    '../../config/flagSettings.js'
  );
  restoreLoadedEnvironment();
  const service = await createCliSettingsService({ sessionProjection: true });
  const settings = service.resolve({
    projectPath: workspaceDir,
    sources: eagerParseSettingSourcesFlag(),
    flagSettings: getFlagSettingsInput(),
  });

  const config = await loadCliConfig(
    settings,
    'skills-list-session',
    {
      debug: false,
    } as Partial<CliArgs> as CliArgs,
    {
      cwd: workspaceDir,
      pluginManagerFactory,
      permissionManager: (() => {
        const manager = new PermissionManager(service);
        manager.initialize();
        return manager;
      })(),
    },
  );

  // Initialize to trigger extension loading and skill discovery
  await config.initialize();

  const skillManager = config.getSkillManager();
  const skills = args.all
    ? skillManager.getAllSkills()
    : skillManager.getAllSkills().filter((s) => !s.isBuiltin);

  // Sort skills: non-built-in first, then alphabetically by name
  skills.sort((a, b) => {
    if (a.isBuiltin === b.isBuiltin) {
      return a.name.localeCompare(b.name);
    }
    return a.isBuiltin ? 1 : -1;
  });

  if (skills.length === 0) {
    process.stdout.write('No skills discovered.\n');
    return;
  }

  process.stdout.write(chalk.bold('Discovered Agent Skills:') + '\n\n');

  for (const skill of skills) {
    const status = skill.disabled
      ? chalk.red('[Disabled]')
      : chalk.green('[Enabled]');

    const builtinSuffix = skill.isBuiltin ? chalk.gray(' [Built-in]') : '';

    process.stdout.write(
      `${chalk.bold(skill.name)} ${status}${builtinSuffix}\n`,
    );
    process.stdout.write(`  Description: ${skill.description}\n`);
    if (skill.whenToUse) {
      process.stdout.write(`  When to use: ${skill.whenToUse}\n`);
    }
    if (skill.model) {
      process.stdout.write(`  Model:       ${skill.model}\n`);
    }
    if (skill.allowedTools && skill.allowedTools.length > 0) {
      process.stdout.write(`  Tools:       ${skill.allowedTools.join(', ')}\n`);
    }
    process.stdout.write(`  Location:    ${skill.location}\n\n`);
  }
}

export function createListCommand(): Command {
  return new Command('list')
    .description('Lists discovered agent skills.')
    .option('--all', 'Show all skills, including built-in ones.', false)
    .action(async (opts) => {
      const { exitCli } = await import('../../utils/exitCli.js');
      await handleList({ all: opts.all });
      await exitCli();
    });
}
