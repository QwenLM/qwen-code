import type { SessionTarget } from './types.js';
import { sanitizePromptText, sanitizeQuotedText } from './sanitize.js';

const MAX_WEBHOOK_PROMPT_CHARS = 8_500;
const MAX_WEBHOOK_PAYLOAD_CHARS = 6_000;

export interface ChannelWebhookTargetConfig {
  chatId: string;
  senderId: string;
  threadId?: string;
  isGroup?: boolean;
}

export interface ChannelWebhookSourceConfig {
  secret?: string;
  secretEnv?: string;
  targets: Record<string, ChannelWebhookTargetConfig>;
}

export interface ChannelWebhookConfig {
  sources: Record<string, ChannelWebhookSourceConfig>;
}

export interface ChannelWebhookTask {
  channelName: string;
  source: string;
  eventType: string;
  targetRef: string;
  title: string;
  summary?: string;
  payload: Record<string, unknown>;
}

export interface ChannelWebhookRunOptions {
  timeoutMs?: number;
}

export function resolveChannelWebhookTarget(
  channelName: string,
  config: ChannelWebhookConfig,
  source: string,
  targetRef: string,
): SessionTarget {
  const sourceConfig = config.sources[source];
  if (!sourceConfig) {
    throw new Error(`Unknown webhook source "${source}".`);
  }

  const targetConfig = sourceConfig.targets[targetRef];
  if (!targetConfig) {
    throw new Error(
      `Unknown webhook target "${targetRef}" for source "${source}".`,
    );
  }

  const target: SessionTarget = {
    channelName,
    senderId: targetConfig.senderId,
    chatId: targetConfig.chatId,
  };
  if (targetConfig.threadId !== undefined) {
    target.threadId = targetConfig.threadId;
  }
  if (targetConfig.isGroup !== undefined) {
    target.isGroup = targetConfig.isGroup;
  }
  return target;
}

export function buildChannelWebhookPrompt(
  task: ChannelWebhookTask,
  target: SessionTarget,
): string {
  const eventType = sanitizeQuotedText(task.eventType, 128);
  const source = sanitizeQuotedText(task.source, 128);
  const title = sanitizePromptText(task.title);
  const payload = truncateCodePoints(
    sanitizePromptText(JSON.stringify(task.payload, null, 2)),
    MAX_WEBHOOK_PAYLOAD_CHARS,
  );
  const lines = [
    `[External event "${eventType}" from ${source}]`,
    'Webhook task running unattended. No human is present.',
    'Your final response is delivered to this chat automatically; do the required work and put the result in your final response.',
    '',
    `Target chat: ${sanitizeQuotedText(target.chatId, 128)}`,
    `Title: ${title}`,
  ];

  if (task.summary !== undefined) {
    lines.push(`Summary: ${sanitizePromptText(task.summary)}`);
  }

  lines.push('', 'Payload:', payload);
  return truncateCodePoints(lines.join('\n'), MAX_WEBHOOK_PROMPT_CHARS);
}

function truncateCodePoints(text: string, maxChars: number): string {
  const chars = Array.from(text);
  return chars.length > maxChars ? chars.slice(0, maxChars).join('') : text;
}
