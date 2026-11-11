/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type CommandContext,
  type SlashCommand,
  type SlashCommandActionReturn,
  CommandKind,
} from './types.js';
import { type HistoryItemInfo, MessageType } from '../types.js';

import { getErrorMessage } from '@qwen-code/core';
import { linkSkill } from '../../utils/skillUtils.js';
import {
  requestConsentInteractive,
  skillsConsentString,
} from '../../utils/skillConsent.js';

async function linkAction(
  context: CommandContext,
  args: string,
): Promise<void | SlashCommandActionReturn> {
  const parts = args.trim().split(/\s+/);
  const sourcePath = parts[0];

  if (!sourcePath) {
    context.ui.addItem({
      type: MessageType.ERROR,
      text: 'Usage: /skills link <path> [--scope user|workspace]',
    });
    return;
  }

  let scopeArg = 'user';
  if (parts.length >= 3 && parts[1] === '--scope') {
    scopeArg = parts[2];
  } else if (parts.length >= 2 && parts[1].startsWith('--scope=')) {
    scopeArg = parts[1].split('=')[1];
  }

  const scope = scopeArg === 'workspace' ? 'workspace' : 'user';

  try {
    await linkSkill(
      sourcePath,
      scope,
      (msg) =>
        context.ui.addItem({
          type: MessageType.INFO,
          text: msg,
        }),
      async (skills, targetDir) => {
        const consentString = await skillsConsentString(
          skills,
          sourcePath,
          targetDir,
          true,
        );
        return requestConsentInteractive(
          consentString,
          context.ui.setConfirmationRequest.bind(context.ui),
        );
      },
    );

    context.ui.addItem({
      type: MessageType.INFO,
      text: `Successfully linked skills from "${sourcePath}" (${scope}).`,
    });

    if (context.services.agentContext?.config) {
      await context.services.agentContext.config.reloadSkills();
    }
  } catch (error) {
    context.ui.addItem({
      type: MessageType.ERROR,
      text: `Failed to link skills: ${getErrorMessage(error)}`,
    });
  }
}

async function reloadAction(
  context: CommandContext,
): Promise<void | SlashCommandActionReturn> {
  const config = context.services.agentContext?.config;
  if (!config) {
    context.ui.addItem({
      type: MessageType.ERROR,
      text: 'Could not retrieve configuration.',
    });
    return;
  }

  const skillManager = config.getSkillManager();
  const beforeNames = new Set(skillManager.getSkills().map((s) => s.name));

  const startTime = Date.now();
  let pendingItemSet = false;
  const pendingTimeout = setTimeout(() => {
    context.ui.setPendingItem({
      type: MessageType.INFO,
      text: 'Reloading agent skills...',
    });
    pendingItemSet = true;
  }, 100);

  try {
    await config.reloadSkills();

    clearTimeout(pendingTimeout);
    if (pendingItemSet) {
      // If we showed the pending item, make sure it stays for at least 500ms
      // total to avoid a "flicker" where it appears and immediately disappears.
      const elapsed = Date.now() - startTime;
      const minVisibleDuration = 500;
      if (elapsed < minVisibleDuration) {
        await new Promise((resolve) =>
          setTimeout(resolve, minVisibleDuration - elapsed),
        );
      }
      context.ui.setPendingItem(null);
    }

    context.ui.reloadCommands();

    const afterSkills = skillManager.getSkills();
    const afterNames = new Set(afterSkills.map((s) => s.name));

    const added = afterSkills.filter((s) => !beforeNames.has(s.name));
    const removedCount = [...beforeNames].filter(
      (name) => !afterNames.has(name),
    ).length;

    let successText = 'Agent skills reloaded successfully.';
    const details: string[] = [];

    if (added.length > 0) {
      details.push(
        `${added.length} newly available skill${added.length > 1 ? 's' : ''}`,
      );
    }
    if (removedCount > 0) {
      details.push(
        `${removedCount} skill${removedCount > 1 ? 's' : ''} no longer available`,
      );
    }

    if (details.length > 0) {
      successText += ` ${details.join(' and ')}.`;
    }

    context.ui.addItem({
      type: 'info',
      text: successText,
      icon: '✓ ',
      color: 'green',
    } as HistoryItemInfo);
  } catch (error) {
    clearTimeout(pendingTimeout);
    if (pendingItemSet) {
      context.ui.setPendingItem(null);
    }
    context.ui.addItem({
      type: MessageType.ERROR,
      text: `Failed to reload skills: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

export const skillsCommand: SlashCommand = {
  name: 'skills',
  description: 'Manage agent skills',
  kind: CommandKind.BUILT_IN,
  isSafeConcurrent: true,
  requiredStartupGates: ['commands'],
  subCommands: [
    {
      name: 'link',
      description:
        'Link an agent skill from a local path. Usage: /skills link <path> [--scope user|workspace]',
      kind: CommandKind.BUILT_IN,
      isSafeConcurrent: true,
      action: linkAction,
    },
    {
      name: 'reload',
      altNames: ['refresh'],
      description:
        'Reload the list of discovered skills. Usage: /skills reload',
      kind: CommandKind.BUILT_IN,
      isSafeConcurrent: true,
      action: reloadAction,
    },
  ],
  action: async (): Promise<SlashCommandActionReturn> => ({
    type: 'dialog',
    dialog: 'skillBrowser',
  }),
};
