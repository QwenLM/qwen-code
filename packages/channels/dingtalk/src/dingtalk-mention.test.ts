import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DWClientDownStream } from 'dingtalk-stream-sdk-nodejs';
import type { Envelope } from '@qwen-code/channel-base';
import { DingtalkChannel } from './DingtalkAdapter.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function receive(data: Record<string, unknown>): Envelope {
  const channel = new DingtalkChannel(
    'mention-test',
    {
      type: 'dingtalk',
      token: '',
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      senderPolicy: 'open',
      allowedUsers: [],
      sessionScope: 'user',
      cwd: '/tmp',
      groupPolicy: 'open',
      dmPolicy: 'open',
      groups: {},
    },
    {} as never,
    { registerBridgeEvents: false },
  );
  const inbound = vi.spyOn(channel, 'handleInbound').mockResolvedValue();
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  (
    channel as unknown as { onMessage(data: DWClientDownStream): void }
  ).onMessage({
    headers: { messageId: 'mention-test' },
    data: JSON.stringify({
      msgId: 'mention-test',
      conversationType: '2',
      conversationId: 'test-conversation',
      sessionWebhook: 'https://example.invalid/test-webhook',
      senderNick: 'Tester',
      senderStaffId: 'test-sender',
      chatbotUserId: 'test-bot',
      isInAtList: true,
      ...data,
    }),
  } as DWClientDownStream);
  expect(inbound).toHaveBeenCalledOnce();
  const envelope = inbound.mock.calls[0][0];
  return envelope;
}

describe('DingTalk mention body preservation', () => {
  it.each([
    {
      name: 'group rich text with no gap after bot name',
      conversationType: '2',
      msgtype: 'richText',
      body: '@Qwen下面是我的需求说明，请按照下面图片中的表进行开发，配置表也放在下面了\n这个是需求说明：测试页面',
    },
    {
      name: 'group rich text with an untyped at prefix and a gap',
      conversationType: '2',
      msgtype: 'richText',
      body: '@Qwen 112345 45678',
    },
    {
      name: 'private text containing a leading at symbol',
      conversationType: '1',
      msgtype: 'text',
      body: '@someone请保留这一段\n第二段',
    },
    {
      name: 'group text with mention already absent from callback',
      conversationType: '2',
      msgtype: 'text',
      body: '我问问问 你好',
    },
    {
      name: 'group command with mention already absent from callback',
      conversationType: '2',
      msgtype: 'text',
      body: '/help',
    },
  ])('retains $name', ({ conversationType, msgtype, body }) => {
    const envelope = receive({
      msgtype,
      conversationType,
      ...(msgtype === 'richText'
        ? { content: { richText: [{ text: body }] } }
        : { text: { content: body } }),
    });

    expect(envelope.text).toBe(body);
    expect(envelope.displayText ?? envelope.text).toBe(body);
  });

  it.each(['/new', '/stop', '/help'])(
    'retains a leading bot entity even when its identity matches for %s',
    (command) => {
      const envelope = receive({
        msgtype: 'richText',
        content: {
          richText: [
            { type: 'at', atName: 'Qwen', atUserId: 'test-bot' },
            { text: command },
          ],
        },
      });
      expect(envelope.text).toBe(`@Qwen ${command}`);
    },
  );

  it.each([
    {
      name: 'explicit text',
      part: { type: 'at', text: '@Someone ', atName: 'unused' },
      expected: '@Someone /stop',
    },
    {
      name: 'ID without a display name',
      part: { type: 'at', atUserId: 'test-bot' },
      expected: '@test-bot /stop',
    },
  ])('retains an at entity with $name', ({ part, expected }) => {
    const envelope = receive({
      msgtype: 'richText',
      content: {
        richText: [part, { text: '/stop' }],
      },
    });
    expect(envelope.text).toBe(expected);
  });

  it('preserves a bot entity inside prose instead of joining text into a command', () => {
    const envelope = receive({
      msgtype: 'richText',
      content: {
        richText: [
          { text: '/' },
          { type: 'at', atName: 'Qwen', atUserId: 'test-bot' },
          { text: 'stop' },
        ],
      },
    });
    expect(envelope.text).toBe('/@Qwen stop');
  });

  it('retains a bot entity after a picture', () => {
    const envelope = receive({
      msgtype: 'richText',
      content: {
        richText: [
          { type: 'picture' },
          { type: 'at', atName: 'Qwen', atUserId: 'test-bot' },
          { text: '/stop' },
        ],
      },
    });
    expect(envelope.text).toBe('@Qwen /stop');
  });

  it('does not turn an unidentified mention label into a command', () => {
    const envelope = receive({
      msgtype: 'richText',
      content: { richText: [{ type: 'at', text: '/new' }] },
    });
    expect(envelope.text).toBe('@/new');
  });

  it.each([
    '@someone 你好 @Qwen',
    '@example.com',
    'git@example.com:group/repo.git',
    '@Qwen/stop',
    '@Qwen你好\n/stop',
  ])('does not infer mention identity or boundaries in %s', (body) => {
    const envelope = receive({
      text: { content: body },
      atUsers: [{ dingtalkId: 'test-bot' }],
    });
    expect(envelope.text).toBe(body);
  });

  it('keeps text on both sides of a picture in a rich-text callback', () => {
    const envelope = receive({
      msgtype: 'richText',
      content: {
        richText: [
          { text: '@Qwen第一段\n' },
          { type: 'picture' },
          { text: '第二段' },
        ],
      },
    });
    expect(envelope.text).toBe('@Qwen第一段\n第二段');
  });
});
