/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Command } from '@commander-js/extra-typings';
import { coreEvents, getErrorMessage } from '@qwen-code/core';
import {
  createSkillScopeOption,
  normalizeSkillScope,
  type SkillScope,
} from './scope.js';

interface UninstallArgs {
  name: string;
  scope?: SkillScope;
}

export async function handleUninstall(args: UninstallArgs) {
  const { uninstallSkill } = await import('../../utils/skillUtils.js');
  const chalk = (await import('chalk')).default;

  try {
    const { name } = args;
    const scope = args.scope ?? 'user';

    const result = await uninstallSkill(name, scope);

    if (result) {
      coreEvents.emitFeedback(
        'info',
        chalk.green(
          `Successfully uninstalled skill: ${chalk.bold(name)} (scope: ${scope}, location: ${result.location})`,
        ),
      );
    } else {
      coreEvents.emitFeedback(
        'error',
        `Skill "${name}" is not installed in the ${scope} scope.`,
      );
    }
  } catch (error) {
    coreEvents.emitFeedback('error', getErrorMessage(error));
    const { exitCli } = await import('../../utils/exitCli.js');
    await exitCli(1);
  }
}

export function createUninstallCommand() {
  return new Command('uninstall')
    .description('Uninstalls an agent skill by name.')
    .argument('<name>', 'The name of the skill to uninstall.')
    .addOption(
      createSkillScopeOption(
        'Uninstall scope: "user" (global, default) or "workspace" (also accepted as "project").',
      ),
    )
    .action(async (name, opts) => {
      const { exitCli } = await import('../../utils/exitCli.js');
      if (!name) {
        process.stderr.write('The skill name must be provided.\n');
        process.exit(1);
      }
      await handleUninstall({
        name,
        scope: normalizeSkillScope(opts.scope),
      });
      await exitCli();
    });
}
