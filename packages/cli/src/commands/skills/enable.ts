/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { resolveCommandSettings } from '../../config/createCliSettingsService.js';
import { Command } from '@commander-js/extra-typings';
import { coreEvents } from '@qwen-code/core';

interface EnableArgs {
  name: string;
}

export async function handleEnable(args: EnableArgs) {
  const { enableSkill } = await import('../../utils/skillSettings.js');
  const { renderSkillActionFeedback } = await import('../../utils/skillUtils.js');
  const chalk = (await import('chalk')).default;

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

export function createEnableCommand() {
  return new Command('enable')
    .description('Enables an agent skill.')
    .argument('<name>', 'The name of the skill to enable.')
    .action(async (name) => {
      const { exitCli } = await import('../../utils/exitCli.js');
      await handleEnable({ name });
      await exitCli();
    });
}
