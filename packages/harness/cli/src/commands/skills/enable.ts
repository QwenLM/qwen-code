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

interface EnableArgs {
  name: string;
}

export async function handleEnable(args: EnableArgs) {
  const { enableSkill } = await import('../../utils/skillSettings.js');
  const { renderSkillActionFeedback } = await import(
    '../../utils/skillUtils.js'
  );

  const { name } = args;
  const workspaceDir = process.cwd();
  const settings = await resolveCommandSettings(workspaceDir);

  const result = enableSkill(settings, name);
  const feedback = renderSkillActionFeedback(
    result,
    (label, path) => `${chalk.bold(label)} (${chalk.dim(path)})`,
  );
  coreEvents.emitFeedback('info', feedback);
}

export function createEnableCommand(
  getManagedResourcesProvider?: () => Promise<
    import('@qwen-code/core').ManagedResourcesProvider | undefined
  >,
) {
  const command = new Command('enable')
    .description('Enables an agent skill.')
    .argument('<name>', 'The name of the skill to enable.');
  command.action(async (name) => {
    const action = async () => {
      const provider = await getManagedResourcesProvider?.();
      const resource = (await provider?.readSkills())?.find(
        (skill) => skill.name === name,
      );
      if (resource) {
        if (!resource.userVisible) throw new Error('Skill is not available.');
        await provider!.setSkillEnabled(resource, true);
      } else await handleEnable({ name });
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
