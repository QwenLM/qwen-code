import { Activity } from '@microsoft/agents-activity';
import { describe, expect, it } from 'vitest';
import {
  normalizeActivity,
  teamsServiceUrls,
  validateTarget,
} from './activity.js';

export const config = { appId: 'bot-app', tenantId: 'tenant-a' };
export function activity(overrides: Record<string, unknown> = {}): Activity {
  return Activity.fromObject({
    type: 'message',
    id: 'activity-1',
    channelId: 'msteams',
    serviceUrl: 'https://smba.trafficmanager.net/amer/',
    recipient: { id: '28:bot-app', name: 'Qwen' },
    from: { id: 'teams-user', aadObjectId: 'USER-A', name: 'Alice' },
    conversation: {
      id: 'chat-1',
      conversationType: 'personal',
      tenantId: 'tenant-a',
    },
    channelData: { tenant: { id: 'TENANT-A' } },
    text: 'hello',
    ...overrides,
  });
}
const mention = {
  type: 'mention',
  text: '<at>Qwen</at>',
  mentioned: { id: '28:bot-app' },
};

describe('Teams Activity normalization', () => {
  it('uses tenant and Entra identity, not a transient Teams ID or display name', () => {
    const first = normalizeActivity('teams', config, activity())!;
    const second = normalizeActivity(
      'teams',
      config,
      activity({
        from: { id: 'new-transient', aadObjectId: 'user-a', name: 'Renamed' },
      }),
    )!;
    expect(first.envelope.senderId).toBe('msteams:tenant-a:user-a');
    expect(second.envelope.senderId).toBe(first.envelope.senderId);
    expect(first.eventId).toBe(second.eventId);
    expect(Object.isFrozen(first.target.reference.conversation)).toBe(true);
  });

  it('requires an explicit entity mentioning this bot in groups', () => {
    const group = {
      conversation: { id: 'group', conversationType: 'groupChat' },
      text: '<at>Qwen</at> hello',
    };
    expect(normalizeActivity('teams', config, activity(group))).toBeUndefined();
    expect(
      normalizeActivity(
        'teams',
        config,
        activity({
          ...group,
          entities: [{ ...mention, mentioned: { id: '28:another-bot' } }],
        }),
      ),
    ).toBeUndefined();
    const result = normalizeActivity(
      'teams',
      config,
      activity({ ...group, entities: [mention] }),
    )!;
    expect(result.envelope.text).toBe('hello');
    expect(result.envelope.isMentioned).toBe(true);
  });

  it('normalizes channel root and replies into one group with separate threads', () => {
    const channel = {
      conversation: {
        id: 'channel-1;messageid=root-1',
        conversationType: 'channel',
      },
      channelData: { tenant: { id: 'tenant-a' }, channel: { id: 'channel-1' } },
      entities: [mention],
    };
    const first = normalizeActivity('teams', config, activity(channel))!;
    const reply = normalizeActivity(
      'teams',
      config,
      activity({ ...channel, id: 'reply-2', replyToId: 'root-1' }),
    )!;
    const other = normalizeActivity(
      'teams',
      config,
      activity({
        ...channel,
        conversation: {
          id: 'channel-1;messageid=root-2',
          conversationType: 'channel',
        },
      }),
    )!;
    expect(first.target.chatId).toBe(reply.target.chatId);
    expect(first.target.threadId).toBe('root-1');
    expect(other.target.chatId).toBe(first.target.chatId);
    expect(other.target.threadId).toBe('root-2');
    expect(first.target.reference.conversation.id).toBe(
      'channel-1;messageid=root-1',
    );
    expect(first.target.reference.activityId).toBe('root-1');
    expect(() => validateTarget(config, first.target)).not.toThrow();
  });

  it('uses the conversation thread suffix when replyToId quotes a different message', () => {
    // The Teams channel-conversations documentation shows these values can differ.
    const result = normalizeActivity(
      'teams',
      config,
      activity({
        conversation: {
          id: 'channel-1;messageid=root-1',
          conversationType: 'channel',
        },
        channelData: {
          tenant: { id: 'tenant-a' },
          channel: { id: 'channel-1' },
        },
        entities: [mention],
        replyToId: 'quoted-reply-2',
      }),
    )!;
    expect(result.target.threadId).toBe('root-1');
    expect(result.target.reference.conversation.id).toBe(
      'channel-1;messageid=root-1',
    );
  });

  it('rejects missing IDs, cross-tenant identities and conflicting channel metadata', () => {
    for (const override of [
      { id: undefined },
      { from: { id: 'user-without-aad' } },
      { recipient: { id: '28:another-bot' } },
      { channelData: { tenant: { id: 'another-tenant' } } },
      {
        conversation: {
          id: 'chat',
          conversationType: 'personal',
          tenantId: 'another-tenant',
        },
      },
      {
        conversation: {
          id: 'channel-1;messageid=root',
          conversationType: 'channel',
        },
        entities: [mention],
        channelData: {
          tenant: { id: 'tenant-a' },
          channel: { id: 'different-channel' },
        },
      },
    ])
      expect(() =>
        normalizeActivity('teams', config, activity(override)),
      ).toThrow();
  });

  it('rejects a foreign tenant even when both activity tenant fields agree', () => {
    expect(() =>
      normalizeActivity(
        'teams',
        config,
        activity({
          channelData: { tenant: { id: 'another-tenant' } },
          conversation: {
            id: 'chat-1',
            conversationType: 'personal',
            tenantId: 'another-tenant',
          },
        }),
      ),
    ).toThrow('Teams tenant does not match the configured tenant.');
  });

  it('does not admit bot messages, attachments-only messages or protocol invokes as prompts', () => {
    expect(
      normalizeActivity(
        'teams',
        config,
        activity({ from: { id: '28:bot-app', aadObjectId: 'bot' } }),
      ),
    ).toBeUndefined();
    expect(
      normalizeActivity(
        'teams',
        config,
        activity({
          text: '',
          attachments: [
            { contentType: 'image/png', contentUrl: 'https://example.test/x' },
          ],
        }),
      ),
    ).toBeUndefined();
    expect(
      normalizeActivity('teams', config, activity({ type: 'invoke' })),
    ).toBeUndefined();
  });

  it('permits only HTTPS commercial Teams service endpoints', () => {
    for (const url of [
      'http://smba.trafficmanager.net/amer/',
      'https://smba.trafficmanager.net:8443/',
      'https://smba.trafficmanager.net.evil.test/',
      'https://localhost/',
      'https://user:pass@smba.trafficmanager.net/',
    ]) {
      expect(teamsServiceUrls.isAllowed(url)).toBe(false);
      expect(() =>
        normalizeActivity('teams', config, activity({ serviceUrl: url })),
      ).toThrow();
    }
  });
});
