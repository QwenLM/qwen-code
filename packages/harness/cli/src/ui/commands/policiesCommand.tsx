/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { CommandKind, type SlashCommand } from './types.js';
import { MessageType } from '../types.js';
import { PermissionRuleList } from '../components/permissions/PermissionRuleList.js';
import { enqueue } from '@qwen-code/core';

const listPoliciesCommand: SlashCommand = {
  name: 'list',
  description: 'Manage allow & deny tool permission rules',
  kind: CommandKind.BUILT_IN,
  isSafeConcurrent: true,
  autoExecute: true,
  action: async (context) => {
    const agentContext = context.services.agentContext;
    const config = agentContext?.config;
    if (!config) {
      context.ui.addItem(
        { type: MessageType.ERROR, text: 'Error: Config not available.' },
        Date.now(),
      );
      return;
    }

    const permission = config.permission;
    if (!permission) {
      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: 'Error: permissions are not available in this session.',
        },
        Date.now(),
      );
      return;
    }

    const settingsWriter = config.permission?.getSettingsWriter?.();

    return {
      type: 'custom_dialog' as const,
      component: (
        <PermissionRuleList
          permission={permission}
          autoMode={permission.autoClassifier}
          settingsWriter={settingsWriter}
          onRetryDenials={(commands) => {
            permission.autoClassifier.clearDenials(permission.getSessionId());
            enqueue({
              prompt: `The user approved the following previously-denied commands via /permissions. Please retry them:\n${commands.map((c) => `- ${c}`).join('\n')}`,
              commandMode: 'prompt',
              priority: 'next',
              isMeta: true,
              isUserDecision: true,
            });
          }}
          onExit={(result) => {
            context.ui.removeComponent();
            if (result) {
              context.ui.addItem(
                {
                  type: MessageType.INFO,
                  text: result,
                },
                Date.now(),
              );
            }
          }}
        />
      ),
    };
  },
};

export const policiesCommand: SlashCommand = {
  name: 'permissions',
  description: 'Manage permissions',
  kind: CommandKind.BUILT_IN,
  isSafeConcurrent: true,
  autoExecute: true,
  // Default action: open the interactive permission manager
  action: listPoliciesCommand.action,
  subCommands: [listPoliciesCommand],
};
