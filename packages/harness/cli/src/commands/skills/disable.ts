/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import chalk from 'chalk';
import { resolveCommandSettings } from '../../config/createCliSettingsService.js';
import { Command } from '@commander-js/extra-typings';
import { coreEvents } from '@qwen-code/core';
import { runTerminalCommand } from '../../app-plugins/commands.js';
import type { SettingScope } from '../../config/settings.js';
import { createSkillScopeOption, normalizeSkillScope } from './scope.js';

interface DisableArgs {
  name: string;
  scope: SettingScope;
}

export async function handleDisable(args: DisableArgs) {
  const { disableSkill } = await import('../../utils/skillSettings.js');
  const { renderSkillActionFeedback } = await import(
    '../../utils/skillUtils.js'
  );

  const { name, scope } = args;
  const workspaceDir = process.cwd();
  const settings = await resolveCommandSettings(workspaceDir);

  const result = disableSkill(settings, name, scope);
  const feedback = renderSkillActionFeedback(
    result,
    (label, path) => `${chalk.bold(label)} (${chalk.dim(path)})`,
  );
  coreEvents.emitFeedback('info', feedback);
}

export function createDisableCommand(
  getManagedResourcesProvider?: () => Promise<
    import('@qwen-code/core').ManagedResourcesProvider | undefined
  >,
) {
  const command = new Command('disable')
    .description('Disables an agent skill.')
    .argument('<name>', 'The name of the skill to disable.')
    .addOption(
      createSkillScopeOption(
        'Disable scope: "user" or "workspace" (also accepted as "project", default).',
        'workspace',
      ),
    );
  command.action(async (name, opts) => {
    const action = async () => {
      const { SettingScope } = await import('../../config/settings.js');
      const scope =
        normalizeSkillScope(opts.scope) === 'workspace'
          ? SettingScope.Project
          : SettingScope.User;
      const provider = await getManagedResourcesProvider?.();
      const resource = (await provider?.readSkills())?.find(
        (skill) => skill.name === name,
      );
      if (resource) {
        if (!resource.userVisible) throw new Error('Skill is not available.');
        await provider!.setSkillEnabled(resource, false);
      } else await handleDisable({ name, scope });
      return { exitCode: 0 };
    };
    if (getManagedResourcesProvider) {
      await runTerminalCommand(command, action, { components: 'local' });
    } else {
      await action();
      const { exitCli } = await import('../../utils/exitCli.js');
      await exitCli();
    }
  });
  return command;
}
