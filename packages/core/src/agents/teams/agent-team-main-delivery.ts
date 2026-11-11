/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../../config/config.js';
import {
  getCustomContextFromContext,
  snapshotCustomContext,
} from '../../utils/sessionIdContext.js';
import type { AgentColor } from '../types.js';
import type { Message } from '../../protocol/transcript/message.js';
import { enqueue } from '../../services/messageQueueManager.js';
import { SEND_MESSAGE_TOOL_NAME } from '../../tools/tool-names.js';
import {
  formatAgentMessage,
  formatTeammateMessage,
} from './agent-team-peer-message.js';
import {
  markTeamMessageRead,
  readAgentTeamConfig,
  sendTeamMessage,
  TEAM_LEAD_MEMBER_NAME,
} from './agent-team-runtime.js';

const TEAMMATE_IDLE_DETAIL_LIMIT = 200;

interface PlainSendMessageInput {
  to: string;
  message: string;
  summary?: string;
}

function isPlainSendMessageInput(
  value: unknown,
): value is PlainSendMessageInput {
  if (typeof value !== 'object' || value === null) return false;
  const { to, message, summary } = value as Partial<PlainSendMessageInput>;
  return (
    typeof to === 'string' &&
    typeof message === 'string' &&
    (summary === undefined || typeof summary === 'string')
  );
}

export function deriveTeammateIdleSummary(
  messages: readonly Message[],
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (
      message.type === 'user' &&
      typeof message.message?.content === 'string'
    ) {
      break;
    }
    if (message.type !== 'assistant') continue;

    const content = message.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        block.type !== 'tool_use' ||
        block.name !== SEND_MESSAGE_TOOL_NAME ||
        !isPlainSendMessageInput(block.input)
      ) {
        continue;
      }
      const input = block.input;
      if (
        input.to === '*' ||
        input.to.toLowerCase() === TEAM_LEAD_MEMBER_NAME.toLowerCase()
      ) {
        continue;
      }
      const detail = (input.summary ?? input.message.slice(0, 80)).slice(
        0,
        TEAMMATE_IDLE_DETAIL_LIMIT,
      );
      return `[to ${input.to}] ${detail}`;
    }
  }
  return undefined;
}

function normalizeTeammateFailureReason(
  failureReason: string | undefined,
): string | undefined {
  return failureReason?.split('\n', 1)[0]?.slice(0, TEAMMATE_IDLE_DETAIL_LIMIT);
}

export function enqueueTeammateMessageForMain(params: {
  config: Config;
  from: string;
  senderTaskId?: string;
  text: string;
  summary?: string;
  color?: AgentColor;
  frame?: 'agent' | 'teammate';
  customContext?: Readonly<Record<string, string>>;
}): void {
  const prompt =
    params.frame === 'agent'
      ? formatAgentMessage({ from: params.from, text: params.text })
      : formatTeammateMessage({
          from: params.from,
          text: params.text,
          summary: params.summary,
          color: params.color,
        });
  enqueue({
    prompt,
    commandMode: 'prompt',
    priority: 'next',
    isMeta: true,
    displaySummary: params.summary,
    displayColor: params.color,
    sessionId: params.config.getSessionId(),
    ...(params.customContext !== undefined
      ? { customContext: snapshotCustomContext(params.customContext) }
      : {}),
    origin: {
      kind: 'peer',
      from: params.from,
      name: params.from,
      body: params.text,
      ...(params.senderTaskId ? { senderTaskId: params.senderTaskId } : {}),
    },
  });
}

export async function publishTeammateIdleNotification(params: {
  config: Config;
  teamName: string;
  memberName: string;
  agentId: string;
  taskId: string;
  idleReason: 'available' | 'interrupted' | 'failed';
  summary?: string;
  failureReason?: string;
}): Promise<void> {
  const member = (await readAgentTeamConfig(params.teamName))?.members.find(
    (candidate) => candidate.agentId === params.agentId,
  );
  const text = JSON.stringify({
    type: 'idle_notification',
    from: params.memberName,
    timestamp: new Date().toISOString(),
    idleReason: params.idleReason,
    summary: params.summary,
    failureReason: normalizeTeammateFailureReason(params.failureReason),
  });
  const customContext = snapshotCustomContext(getCustomContextFromContext());
  const mailboxMessage = await sendTeamMessage({
    customContext,
    teamName: params.teamName,
    from: params.memberName,
    to: TEAM_LEAD_MEMBER_NAME,
    text,
    color: member?.color,
  });
  enqueueTeammateMessageForMain({
    config: params.config,
    from: params.memberName,
    senderTaskId: params.taskId,
    text,
    color: member?.color,
    customContext,
  });
  await markTeamMessageRead({
    teamName: params.teamName,
    memberName: TEAM_LEAD_MEMBER_NAME,
    messageId: mailboxMessage.id,
  });
}
