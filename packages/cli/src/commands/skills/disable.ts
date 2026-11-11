/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { resolveCommandSettings } from '../../config/createCliSettingsService.js';
import { Command } from '@commander-js/extra-typings';
import { coreEvents } from '@qwen-code/core';
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
  const chalk = (await import('chalk')).default;

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

export function createDisableCommand() {
  return new Command('disable')
    .description('Disables an agent skill.')
    .argument('<name>', 'The name of the skill to disable.')
    .addOption(
      createSkillScopeOption(
        'Disable scope: "user" or "workspace" (also accepted as "project", default).',
        'workspace',
      ),
    )
    .action(async (name, opts) => {
      const { SettingScope } = await import('../../config/settings.js');
      const { exitCli } = await import('../../utils/exitCli.js');
      const scope =
        normalizeSkillScope(opts.scope) === 'workspace'
          ? SettingScope.Project
          : SettingScope.User;
      await handleDisable({ name, scope });
      await exitCli();
    });
}
