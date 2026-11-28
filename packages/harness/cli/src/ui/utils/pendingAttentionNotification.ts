/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type ConfirmationRequest,
  type HistoryItemWithoutId,
} from '../types.js';
import {
  ASK_USER_TOOL_NAME,
  CoreToolCallStatus,
} from '@qwen-code/core';
import { type ReactNode } from 'react';
import { type RunEventNotificationEvent } from '../../utils/terminalNotifications.js';

export interface PendingAttentionNotification {
  key: string;
  event: RunEventNotificationEvent;
}

function keyFromReactNode(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((item) => keyFromReactNode(item)).join('|');
  }
  return 'react-node';
}

export function getPendingAttentionNotification(
  pendingHistoryItems: HistoryItemWithoutId[],
  commandConfirmationRequest: ConfirmationRequest | null,
  authConsentRequest: ConfirmationRequest | null,
  hasConfirmUpdateExtensionRequests: boolean,
): PendingAttentionNotification | null {
  for (const item of pendingHistoryItems) {
    if (item.type !== 'tool_group') continue;
    const awaitingTool = item.tools.find(
      (tool) => tool.status === CoreToolCallStatus.AwaitingApproval,
    );
    if (!awaitingTool) continue;

    if (awaitingTool.confirmationDetails?.type === ASK_USER_TOOL_NAME) {
      const firstQuestion =
        awaitingTool.confirmationDetails.questions[0]?.header ??
        awaitingTool.confirmationDetails.title;
      return {
        key: `ask_user:${awaitingTool.callId}`,
        event: {
          type: 'attention',
          heading: 'Answer requested by agent',
          detail: firstQuestion,
        },
      };
    }

    return {
      key: `tool_confirmation:${awaitingTool.callId}`,
      event: {
        type: 'attention',
        heading: 'Tool confirmation required',
        detail: 'A tool is waiting for your confirmation.',
      },
    };
  }

  if (commandConfirmationRequest) {
    const promptKey = keyFromReactNode(commandConfirmationRequest.prompt);
    return {
      key: `command_confirmation:${promptKey}`,
      event: {
        type: 'attention',
        heading: 'Confirmation required',
        detail: 'A command is waiting for your confirmation.',
      },
    };
  }

  if (authConsentRequest) {
    const promptKey = keyFromReactNode(authConsentRequest.prompt);
    return {
      key: `auth_consent:${promptKey}`,
      event: {
        type: 'attention',
        heading: 'Authentication confirmation required',
        detail: 'Authentication is waiting for your confirmation.',
      },
    };
  }

  if (hasConfirmUpdateExtensionRequests) {
    return {
      key: 'extension_update_confirmation',
      event: {
        type: 'attention',
        heading: 'Extension update confirmation required',
        detail: 'An extension update is waiting for your confirmation.',
      },
    };
  }

  return null;
}
