/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { runLogger, type SkillDefinition } from '@qwen-code/core';
import chalk from 'chalk';

import type { ConfirmationRequest } from '../ui/types.js';

export const SKILLS_WARNING_MESSAGE = chalk.yellow(
  "Agent skills inject specialized instructions and domain-specific knowledge into the agent's system prompt. This can change how the agent interprets your requests and interacts with your environment. Review the skill definitions at the location(s) provided below to ensure they meet your security standards.",
);

/**
 * Builds a consent string for installing agent skills.
 */
export async function skillsConsentString(
  skills: SkillDefinition[],
  source: string,
  targetDir?: string,
  isLink = false,
): Promise<string> {
  const action = isLink ? 'Linking' : 'Installing';
  const output: string[] = [];
  output.push(`${action} agent skill(s) from "${source}".`);
  output.push(
    `\nThe following agent skill(s) will be ${action.toLowerCase()}:\n`,
  );
  output.push(...(await renderSkillsList(skills)));

  if (targetDir) {
    const destLabel = isLink ? 'Link' : 'Install';
    output.push(`${destLabel} Destination: ${targetDir}`);
  }
  output.push('\n' + SKILLS_WARNING_MESSAGE);

  return output.join('\n');
}

/**
 * Requests consent from the user to perform an action, by reading a Y/n
 * character from stdin.
 *
 * This should not be called from interactive mode as it will break the CLI.
 */
export async function requestConsentNonInteractive(
  consentDescription: string,
): Promise<boolean> {
  runLogger.log(consentDescription);
  const result = await promptForConsentNonInteractive(
    'Do you want to continue? [Y/n]: ',
  );
  return result;
}

/**
 * Requests consent from the user to perform an action, in interactive mode.
 *
 * This should not be called from non-interactive mode as it will not work.
 */
export async function requestConsentInteractive(
  consentDescription: string,
  setConfirmationRequest: (value: ConfirmationRequest | null) => void,
): Promise<boolean> {
  return promptForConsentInteractive(
    consentDescription + '\n\nDo you want to continue?',
    setConfirmationRequest,
  );
}

/**
 * Asks users a prompt and awaits for a y/n response on stdin.
 */
export async function promptForConsentNonInteractive(
  prompt: string,
  defaultValue = true,
): Promise<boolean> {
  const readline = await import('node:readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      const trimmedAnswer = answer.trim().toLowerCase();
      if (trimmedAnswer === '') {
        resolve(defaultValue);
      } else {
        resolve(['y', 'yes'].includes(trimmedAnswer));
      }
    });
  });
}

/**
 * Asks users an interactive yes/no prompt.
 */
async function promptForConsentInteractive(
  prompt: string,
  setConfirmationRequest: (value: ConfirmationRequest | null) => void,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const close = (confirmed: boolean) => {
      setConfirmationRequest(null);
      resolve(confirmed);
    };
    setConfirmationRequest({
      prompt,
      onConfirm: (resolvedConfirmed) => {
        close(resolvedConfirmed);
      },
      onCancel: () => {
        close(false);
      },
    });
  });
}

/**
 * Shared logic for formatting a list of agent skills for a consent prompt.
 */
async function renderSkillsList(skills: SkillDefinition[]): Promise<string[]> {
  const output: string[] = [];
  for (const skill of skills) {
    output.push(`  * ${chalk.bold(skill.name)}: ${skill.description}`);
    const skillDir = path.dirname(skill.location);
    let fileCountStr = '';
    try {
      const skillDirItems = await fs.readdir(skillDir);
      fileCountStr = ` (${skillDirItems.length} items in directory)`;
    } catch {
      fileCountStr = ` ${chalk.red('(Could not count items in directory)')}`;
    }
    output.push(chalk.dim(`    (Source: ${skill.location})${fileCountStr}`));
    output.push('');
  }
  return output;
}
