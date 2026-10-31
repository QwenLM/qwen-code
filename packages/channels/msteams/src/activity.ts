import { createHash } from 'node:crypto';
import type { Activity } from '@microsoft/agents-activity';
import { OutboundHostValidator } from '@microsoft/agents-hosting';
import type {
  TeamsCredentials,
  TeamsInboundEvent,
  TeamsTarget,
} from './types.js';

const serviceHosts = new OutboundHostValidator({
  enabled: true,
  includeDefaultMicrosoftHosts: false,
  hosts: ['smba.trafficmanager.net', 'smba.infra.teams.microsoft.com'],
});

export const teamsServiceUrls = {
  enabled: true,
  isAllowed(input: string | URL | null | undefined): boolean {
    try {
      const url = input instanceof URL ? input : new URL(input ?? '');
      return (
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        (!url.port || url.port === '443') &&
        serviceHosts.isAllowed(url)
      );
    } catch {
      return false;
    }
  },
};

export class TeamsActivityError extends Error {}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

export function referenceKey(
  target: Pick<TeamsTarget, 'chatId' | 'threadId'>,
): string {
  return JSON.stringify([target.chatId, target.threadId ?? null]);
}

function botId(id: string): string {
  return id.replace(/^28:/, '').toLowerCase();
}

/** Called only after the Microsoft SDK has authenticated the request. */
export function normalizeActivity(
  name: string,
  config: Pick<TeamsCredentials, 'appId' | 'tenantId'>,
  activity: Activity,
): TeamsInboundEvent | undefined {
  if (activity.type !== 'message' || activity.channelId !== 'msteams') return;
  const data = record(activity.channelData);
  const tenantId = string(record(data['tenant'])['id']).toLowerCase();
  if (!tenantId || tenantId !== config.tenantId.toLowerCase()) {
    throw new TeamsActivityError(
      'Teams tenant does not match the configured tenant.',
    );
  }
  if (
    activity.conversation?.tenantId &&
    activity.conversation.tenantId.toLowerCase() !== tenantId
  ) {
    throw new TeamsActivityError('Teams conversation tenant does not match.');
  }
  if (botId(activity.recipient?.id ?? '') !== config.appId.toLowerCase()) {
    throw new TeamsActivityError(
      'Teams recipient does not match the configured bot.',
    );
  }
  if (
    activity.from?.id === activity.recipient?.id ||
    activity.from?.role === 'bot'
  )
    return;
  const actorId = activity.from?.aadObjectId?.toLowerCase();
  if (!activity.id || !actorId || !activity.conversation?.id) {
    throw new TeamsActivityError(
      'Teams message requires an activity, conversation, and Entra user ID.',
    );
  }
  if (!teamsServiceUrls.isAllowed(activity.serviceUrl)) {
    throw new TeamsActivityError('Teams service URL is not allowed.');
  }
  const conversationType = activity.conversation.conversationType;
  if (!['personal', 'groupChat', 'channel'].includes(conversationType ?? ''))
    return;
  const isGroup = conversationType !== 'personal';
  const mentions = (activity.entities ?? [])
    .map(record)
    .filter(
      (entity) =>
        entity['type'] === 'mention' &&
        botId(string(record(entity['mentioned'])['id'])) ===
          config.appId.toLowerCase(),
    );
  if (isGroup && mentions.length === 0) return;
  let text = activity.text ?? '';
  for (const mention of mentions) {
    const token = string(mention['text']);
    if (token) text = text.split(token).join('');
  }
  text = text.trim();
  if (!text) return;
  if (Buffer.byteLength(text, 'utf8') > 64 * 1024)
    throw new TeamsActivityError('Teams message is too large.');
  const rawConversationId = activity.conversation.id;
  const separator = rawConversationId.indexOf(';messageid=');
  const baseConversationId =
    separator < 0 ? rawConversationId : rawConversationId.slice(0, separator);
  const conversationId =
    conversationType === 'channel'
      ? string(record(data['channel'])['id']) || baseConversationId
      : rawConversationId;
  if (conversationType === 'channel' && conversationId !== baseConversationId) {
    throw new TeamsActivityError(
      'Teams channel and conversation do not match.',
    );
  }
  const threadId =
    conversationType === 'channel'
      ? separator < 0
        ? activity.replyToId || activity.id
        : rawConversationId.slice(separator + ';messageid='.length)
      : undefined;
  if (conversationType === 'channel' && !threadId)
    throw new TeamsActivityError('Teams channel thread is missing.');
  const chatId = `msteams:${tenantId}:${encodeURIComponent(conversationId)}`;
  const eventId = createHash('sha256')
    .update(
      JSON.stringify([
        name,
        tenantId,
        conversationId,
        threadId ?? null,
        activity.id,
        activity.type,
      ]),
    )
    .digest('hex');
  const reference = structuredClone(activity.getConversationReference());
  if (threadId) {
    reference.conversation.id = `${conversationId};messageid=${threadId}`;
    reference.activityId = threadId;
  }
  return freeze({
    version: 1,
    eventId,
    activityId: activity.id,
    tenantId,
    actorId,
    envelope: {
      channelName: name,
      senderId: `msteams:${tenantId}:${actorId}`,
      senderName: activity.from?.name || actorId,
      chatId,
      chatName: activity.conversation.name,
      threadId,
      messageId: eventId,
      text,
      isGroup,
      isMentioned: mentions.length > 0,
      isReplyToBot: false,
    },
    target: { chatId, threadId, reference },
  });
}

export function validateTarget(
  config: Pick<TeamsCredentials, 'appId' | 'tenantId'>,
  target: TeamsTarget,
): void {
  if (
    !target.chatId.startsWith(`msteams:${config.tenantId.toLowerCase()}:`) ||
    target.reference.channelId !== 'msteams' ||
    botId(target.reference.agent?.id ?? '') !== config.appId.toLowerCase() ||
    !teamsServiceUrls.isAllowed(target.reference.serviceUrl)
  )
    throw new TeamsActivityError(
      'Teams reply target is not valid for this bot.',
    );
  const expectedId = decodeURIComponent(
    target.chatId.slice(`msteams:${config.tenantId.toLowerCase()}:`.length),
  );
  const actualId = target.threadId
    ? `${expectedId};messageid=${target.threadId}`
    : expectedId;
  if (target.reference.conversation.id !== actualId)
    throw new TeamsActivityError(
      'Teams reply conversation does not match its route.',
    );
}
