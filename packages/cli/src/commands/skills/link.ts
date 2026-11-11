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

interface LinkArgs {
  path: string;
  scope?: SkillScope;
  consent?: boolean;
}

export async function handleLink(args: LinkArgs) {
  const chalk = (await import('chalk')).default;
  const {
    requestConsentNonInteractive,
    skillsConsentString,
  } = await import('../../utils/skillConsent.js');
  const { linkSkill } = await import('../../utils/skillUtils.js');

  try {
    const { scope = 'user', consent } = args;

    await linkSkill(
      args.path,
      scope,
      (msg) => coreEvents.emitFeedback('info', msg),
      async (skills, targetDir) => {
        const consentString = await skillsConsentString(
          skills,
          args.path,
          targetDir,
          true,
        );
        if (consent) {
          coreEvents.emitFeedback(
            'info',
            'You have consented to the following:',
          );
          coreEvents.emitFeedback('info', consentString);
          return true;
        }
        return requestConsentNonInteractive(consentString);
      },
    );

    coreEvents.emitFeedback(
      'info',
      chalk.green('\nSuccessfully linked skills.'),
    );
  } catch (error) {
    coreEvents.emitFeedback('error', getErrorMessage(error));
    const { exitCli } = await import('../../utils/exitCli.js');
    await exitCli(1);
  }
}

export function createLinkCommand() {
  return new Command('link')
    .description(
      'Links an agent skill from a local path. Updates to the source will be reflected immediately.',
    )
    .argument('<path>', 'The local path of the skill to link.')
    .addOption(
      createSkillScopeOption(
        'Link scope: "user" (global, default) or "workspace" (also accepted as "project").',
      ),
    )
    .option(
      '--consent',
      'Acknowledge the security risks of linking a skill and skip the confirmation prompt.',
      false,
    )
    .action(async (linkPath, opts) => {
      const { exitCli } = await import('../../utils/exitCli.js');
      if (!linkPath) {
        process.stderr.write('The path argument must be provided.\n');
        process.exit(1);
      }
      await handleLink({
        path: linkPath,
        scope: normalizeSkillScope(opts.scope),
        consent: opts.consent as boolean | undefined,
      });
      await exitCli();
    });
}
