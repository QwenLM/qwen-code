/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandContext } from '../../ui/commands/types.js';
import {
  GITHUB_WORKFLOW_PATHS,
  setupGithub,
  updateGitignore as updateGitignoreWithStatus,
} from '../../services/setup-github.js';

import type { SlashCommand, SlashCommandActionReturn } from './types.js';
import { CommandKind } from './types.js';
import { getUrlOpenCommand } from '../../ui/utils/commandUtils.js';
import { t } from '../../i18n/index.js';

export { GITHUB_WORKFLOW_PATHS };

// Generate OS-specific commands to open the GitHub pages needed for setup.
function getOpenUrlsCommands(readmeUrl: string, secretsUrl?: string): string[] {
  // Determine the OS-specific command to open URLs, ex: 'open', 'xdg-open', etc
  const openCmd = getUrlOpenCommand();

  // Build a list of URLs to open
  const urlsToOpen = [readmeUrl];
  if (secretsUrl) urlsToOpen.push(secretsUrl);

  // Create and join the individual commands
  const commands = urlsToOpen.map((url) => `${openCmd} "${url}"`);
  return commands;
}

// Add Qwen Code specific entries to .gitignore file
export async function updateGitignore(gitRepoRoot: string): Promise<void> {
  await updateGitignoreWithStatus(gitRepoRoot);
}

export const setupGithubCommand: SlashCommand = {
  name: 'setup-github',
  get description() {
    return t('Set up GitHub Actions');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive'] as const,
  action: async (
    context: CommandContext,
  ): Promise<SlashCommandActionReturn> => {
    const abortController = new AbortController();

    // If we have a context abort signal (from ESC cancellation), link it to our controller
    if (context.abortSignal) {
      context.abortSignal.addEventListener(
        'abort',
        () => abortController.abort(),
        { once: true },
      );
    }

    const proxy = context?.services?.config?.getProxy();
    const result = await setupGithub({
      proxy,
      abortSignal: abortController.signal,
    }).finally(() => abortController.abort());

    // Print out a message
    const commands = [];
    commands.push('set -eEuo pipefail');
    commands.push(
      `echo "Successfully downloaded ${GITHUB_WORKFLOW_PATHS.length} workflows and updated .gitignore. Follow the steps in ${result.readmeUrl} (skipping the /setup-github step) to complete setup."`,
    );
    commands.push(...getOpenUrlsCommands(result.readmeUrl, result.secretsUrl));

    const command = `(${commands.join(' && ')})`;
    return {
      type: 'tool',
      toolName: 'run_shell_command',
      toolArgs: {
        description:
          'Setting up GitHub Actions to triage issues and review PRs with Qwen.',
        command,
        is_background: false,
      },
    };
  },
};
