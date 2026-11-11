/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Command } from '@commander-js/extra-typings';
import { coreEvents, getErrorMessage } from '@qwen-code/core';
import type { SkillDefinition } from '@qwen-code/core';
import {
  createSkillScopeOption,
  normalizeSkillScope,
  type SkillScope,
} from './scope.js';

interface InstallArgs {
  source: string;
  scope?: SkillScope;
  path?: string;
  consent?: boolean;
}

export async function handleInstall(args: InstallArgs) {
  const { installSkill } = await import('../../utils/skillUtils.js');
  const chalk = (await import('chalk')).default;
  const {
    requestConsentNonInteractive,
    skillsConsentString,
  } = await import('../../utils/skillConsent.js');

  try {
    const { source, consent } = args;
    const scope = args.scope ?? 'user';
    const subpath = args.path;

    const requestConsent = async (
      skills: SkillDefinition[],
      targetDir: string,
    ) => {
      if (consent) {
        coreEvents.emitFeedback('info', 'You have consented to the following:');
        coreEvents.emitFeedback(
          'info',
          await skillsConsentString(skills, source, targetDir),
        );
        return true;
      }
      return requestConsentNonInteractive(
        await skillsConsentString(skills, source, targetDir),
      );
    };

    const installedSkills = await installSkill(
      source,
      scope,
      subpath,
      (msg) => {
        coreEvents.emitFeedback('info', msg);
      },
      requestConsent,
    );

    for (const skill of installedSkills) {
      coreEvents.emitFeedback(
        'info',
        chalk.green(
          `Successfully installed skill: ${chalk.bold(skill.name)} (scope: ${scope}, location: ${skill.location})`,
        ),
      );
    }
  } catch (error) {
    coreEvents.emitFeedback('error', getErrorMessage(error));
    const { exitCli } = await import('../../utils/exitCli.js');
    await exitCli(1);
  }
}

export function createInstallCommand() {
  return new Command('install')
    .description(
      'Installs an agent skill from a git repository URL, a remote HTTPS .zip URL, a local path, or a local .skill/.zip archive.',
    )
    .argument(
      '<source>',
      'The git repository URL, remote HTTPS .zip URL, local path, or local .skill/.zip archive to install.',
    )
    .addOption(
      createSkillScopeOption(
        'Installation scope: "user" (global, default) or "workspace" (also accepted as "project").',
      ),
    )
    .option(
      '--path <path>',
      'Sub-path within the repository or archive to install from.',
    )
    .option(
      '--consent',
      'Acknowledge the security risks of installing a skill and skip the confirmation prompt.',
      false,
    )
    .action(async (source, opts) => {
      const { exitCli } = await import('../../utils/exitCli.js');
      if (!source) {
        process.stderr.write('The source argument must be provided.\n');
        process.exit(1);
      }
      await handleInstall({
        source,
        scope: normalizeSkillScope(opts.scope),
        path: opts.path,
        consent: opts.consent as boolean | undefined,
      });
      await exitCli();
    });
}
