/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DwsClient,
  DwsCommandError,
  parseDwsImEvent,
  type DwsCommandRunner,
} from './dws-client.js';
import type {
  DwsEventProcessStarter,
  DwsEventSubscription,
} from './dws-event-stream.js';

function json(value: unknown): string {
  return JSON.stringify(value);
}

function subscription(): DwsEventSubscription {
  return { stop: vi.fn(), closed: new Promise(() => undefined) };
}

describe('DwsClient', () => {
  it('requires a DWS release with all-message event streams', async () => {
    const compatibleRunner = vi.fn<DwsCommandRunner>().mockResolvedValue({
      stdout: json({ version: '1.0.57' }),
      stderr: '',
    });
    await expect(
      new DwsClient({ executable: 'dws' }, compatibleRunner).assertCompatible(),
    ).resolves.toBeUndefined();

    const oldRunner = vi.fn<DwsCommandRunner>().mockResolvedValue({
      stdout: json({ version: 'v1.0.52.1' }),
      stderr: '',
    });
    await expect(
      new DwsClient({ executable: 'dws' }, oldRunner).assertCompatible(),
    ).rejects.toThrow('1.0.57 or newer');
  });

  it('checks the selected profile without depending on account user metadata', async () => {
    const runner = vi
      .fn<DwsCommandRunner>()
      .mockResolvedValueOnce({
        stdout: json({
          profiles: [{ profile: 'corp:user', isCurrent: false }],
        }),
        stderr: '',
      })
      .mockResolvedValueOnce({
        stdout: json({
          authenticated: true,
          userId: 'user-1',
          openDingTalkId: 'open-user-1',
        }),
        stderr: '',
      });
    const client = new DwsClient(
      { executable: '/opt/dws', profile: 'corp:user' },
      runner,
    );

    await expect(client.assertAuthenticated()).resolves.toEqual({
      profile: 'corp:user',
    });
    expect(runner).toHaveBeenNthCalledWith(1, '/opt/dws', [
      'profile',
      'list',
      '--format',
      'json',
    ]);
    expect(runner).toHaveBeenNthCalledWith(2, '/opt/dws', [
      '--profile',
      'corp:user',
      'auth',
      'status',
      '--format',
      'json',
    ]);
  });

  it('rejects an unauthenticated DWS profile', async () => {
    const runner = vi
      .fn<DwsCommandRunner>()
      .mockResolvedValueOnce({
        stdout: json({ profiles: [{ profile: 'corp:user' }] }),
        stderr: '',
      })
      .mockResolvedValueOnce({
        stdout: json({ authenticated: false }),
        stderr: '',
      });
    const client = new DwsClient(
      { executable: 'dws', profile: 'corp:user' },
      runner,
    );

    await expect(client.assertAuthenticated()).rejects.toThrow(
      'DWS is not authenticated',
    );
  });

  it('uses corpId as a profile without exposing account user metadata', async () => {
    const runner = vi
      .fn<DwsCommandRunner>()
      .mockResolvedValueOnce({
        stdout: json({
          profiles: [{ corpId: 'corp', userId: 'user-1', isCurrent: true }],
        }),
        stderr: '',
      })
      .mockResolvedValueOnce({
        stdout: json({ authenticated: true, user_id: 'user-1' }),
        stderr: '',
      });
    const client = new DwsClient({ executable: 'dws' }, runner);

    await expect(client.assertAuthenticated()).resolves.toEqual({
      profile: 'corp',
    });
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('does not query self identity when profile metadata omits user IDs', async () => {
    const runner = vi
      .fn<DwsCommandRunner>()
      .mockResolvedValueOnce({
        stdout: json({
          profiles: [{ corpId: 'corp', isCurrent: true }],
        }),
        stderr: '',
      })
      .mockResolvedValueOnce({
        stdout: json({ authenticated: true }),
        stderr: '',
      });
    const client = new DwsClient({ executable: 'dws' }, runner);

    await expect(client.assertAuthenticated()).resolves.toEqual({
      profile: 'corp',
    });
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('keeps an authenticated profile usable without self metadata', async () => {
    const runner = vi
      .fn<DwsCommandRunner>()
      .mockResolvedValueOnce({
        stdout: json({ profiles: [{ profile: 'corp', isCurrent: true }] }),
        stderr: '',
      })
      .mockResolvedValueOnce({
        stdout: json({ authenticated: true }),
        stderr: '',
      });
    const client = new DwsClient({ executable: 'dws' }, runner);

    await expect(client.assertAuthenticated()).resolves.toEqual({
      profile: 'corp',
    });
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('rejects ambiguous or multi-profile selectors', async () => {
    expect(
      () =>
        new DwsClient({
          executable: 'dws',
          profile: 'corp:user-1,corp:user-2',
        }),
    ).toThrow('exactly one login profile');

    const runner = vi.fn<DwsCommandRunner>().mockResolvedValue({
      stdout: json({
        profiles: [{ profile: 'corp:user-1', isCurrent: true }],
      }),
      stderr: '',
    });
    const client = new DwsClient(
      { executable: 'dws', profile: 'corp' },
      runner,
    );

    await expect(client.assertAuthenticated()).rejects.toThrow(
      'exactly match one entry',
    );
  });

  it('subscribes to @ messages and normalizes compact events', async () => {
    let onLine!: (line: string) => void | Promise<void>;
    const eventStarter = vi.fn<DwsEventProcessStarter>(
      async (_executable, _args, lineHandler) => {
        onLine = lineHandler;
        return subscription();
      },
    );
    const client = new DwsClient(
      { executable: '/opt/dws', profile: 'corp:user' },
      vi.fn(),
      eventStarter,
    );
    const onMessage = vi.fn();

    await client.subscribeToIm({ kind: 'at' }, onMessage, vi.fn());
    await onLine(
      json({
        type: 'user_im_message_receive_at',
        event_id: 'event-1',
        message_id: 'message-1',
        conversation_id: 'cid-1',
        content: '{"content":"check this"}',
        sender_open_dingtalk_id: 'open-alice',
        sender: 'Alice',
        event_time: 1_725_000_000_000,
      }),
    );

    expect(eventStarter).toHaveBeenCalledWith(
      '/opt/dws',
      [
        '--profile',
        'corp:user',
        'event',
        'consume',
        'user_im_message_receive_at',
        '--format',
        'compact',
      ],
      expect.any(Function),
      expect.any(Function),
    );
    expect(onMessage).toHaveBeenCalledWith({
      type: 'user_im_message_receive_at',
      eventId: 'event-1',
      messageId: 'message-1',
      conversationId: 'cid-1',
      content: 'check this',
      senderId: 'open-alice',
      senderName: 'Alice',
      eventTime: 1_725_000_000_000,
    });
  });

  it('subscribes to all ordinary direct messages without a user filter', async () => {
    let onLine!: (line: string) => void | Promise<void>;
    const eventStarter = vi.fn<DwsEventProcessStarter>(
      async (_executable, _args, lineHandler) => {
        onLine = lineHandler;
        return subscription();
      },
    );
    const client = new DwsClient(
      { executable: '/opt/dws' },
      vi.fn(),
      eventStarter,
    );
    const onMessage = vi.fn();

    await client.subscribeToIm({ kind: 'direct' }, onMessage, vi.fn());
    await onLine(
      json({
        type: 'user_im_message_receive_o2o_all',
        event_id: 'event-1',
        message_id: 'message-1',
        conversation_id: 'cid-1',
        content: '{"content":"check this"}',
        sender_open_dingtalk_id: 'open-alice',
        sender: 'Alice',
      }),
    );

    expect(eventStarter).toHaveBeenCalledWith(
      '/opt/dws',
      [
        'event',
        'consume',
        'user_im_message_receive_o2o_all',
        '--format',
        'compact',
      ],
      expect.any(Function),
      expect.any(Function),
    );
    expect(onMessage).toHaveBeenCalledWith({
      type: 'user_im_message_receive_o2o_all',
      eventId: 'event-1',
      messageId: 'message-1',
      conversationId: 'cid-1',
      content: 'check this',
      senderId: 'open-alice',
      senderName: 'Alice',
    });
  });

  it('subscribes to all ordinary group messages without a group filter', async () => {
    const eventStarter = vi.fn<DwsEventProcessStarter>(async () =>
      subscription(),
    );
    const client = new DwsClient(
      { executable: '/opt/dws', profile: 'corp:user' },
      vi.fn(),
      eventStarter,
    );

    await client.subscribeToIm({ kind: 'group-all' }, vi.fn(), vi.fn());

    expect(eventStarter).toHaveBeenCalledWith(
      '/opt/dws',
      [
        '--profile',
        'corp:user',
        'event',
        'consume',
        'user_im_message_receive_group_all',
        '--format',
        'compact',
      ],
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('parses the NDJSON envelope emitted by the default event format', () => {
    expect(
      parseDwsImEvent(
        json({
          data: json({
            type: 'user_im_message_receive_at',
            message_id: 'message-1',
            conversation_id: 'cid-1',
            content: 'help me',
            sender_open_dingtalk_id: 'open-alice',
            sender: 'Alice',
          }),
        }),
      ),
    ).toMatchObject({
      type: 'user_im_message_receive_at',
      eventId: 'message-1',
      content: 'help me',
    });
  });

  it('extracts message identity from the nested DWS payload body', () => {
    expect(
      parseDwsImEvent(
        json({
          data: json({
            type: 'user_im_message_receive_at',
            event_id: 'event-1',
            payload: {
              body: {
                openMessageId: 'message-1',
                openConversationId: 'cid-1',
                content: '{"content":"check this"}',
                senderOpenDingTalkId: 'open-alice',
                sender: 'Alice',
              },
            },
          }),
        }),
      ),
    ).toEqual({
      type: 'user_im_message_receive_at',
      eventId: 'event-1',
      messageId: 'message-1',
      conversationId: 'cid-1',
      content: 'check this',
      senderId: 'open-alice',
      senderName: 'Alice',
    });
  });

  it('subscribes to a selected group and normalizes ambient messages', async () => {
    let onLine!: (line: string) => void | Promise<void>;
    const eventStarter = vi.fn<DwsEventProcessStarter>(
      async (_executable, _args, lineHandler) => {
        onLine = lineHandler;
        return subscription();
      },
    );
    const client = new DwsClient(
      { executable: '/opt/dws', profile: 'corp:user' },
      vi.fn(),
      eventStarter,
    );
    const onMessage = vi.fn();

    await client.subscribeToIm(
      { kind: 'group', conversationId: 'cid-1' },
      onMessage,
      vi.fn(),
    );
    await onLine(
      json({
        type: 'user_im_message_receive_group',
        event_id: 'event-1',
        message_id: 'message-1',
        conversation_id: 'cid-1',
        content: '{"content":"check this"}',
        sender_open_dingtalk_id: 'open-alice',
        sender: 'Alice',
      }),
    );

    expect(eventStarter).toHaveBeenCalledWith(
      '/opt/dws',
      [
        '--profile',
        'corp:user',
        'event',
        'consume',
        'user_im_message_receive_group',
        '--format',
        'compact',
        '--group',
        'cid-1',
      ],
      expect.any(Function),
      expect.any(Function),
    );
    expect(onMessage).toHaveBeenCalledWith({
      type: 'user_im_message_receive_group',
      eventId: 'event-1',
      messageId: 'message-1',
      conversationId: 'cid-1',
      content: 'check this',
      senderId: 'open-alice',
      senderName: 'Alice',
    });
  });

  it('uses DWS idempotency keys for message sends and replies', async () => {
    const runner = vi.fn<DwsCommandRunner>().mockResolvedValue({
      stdout: json({ success: true }),
      stderr: '',
    });
    const client = new DwsClient({ executable: '/opt/dws' }, runner);

    await client.sendImMessage(
      { kind: 'group', conversationId: 'cid-1' },
      'hello $(id)',
      'uuid-send',
    );
    await client.replyToImMessage(
      'cid-1',
      'message-1',
      'open-alice',
      'done',
      'uuid-reply',
    );

    expect(runner.mock.calls[0]).toEqual([
      '/opt/dws',
      [
        'chat',
        'message',
        'send',
        '--group',
        'cid-1',
        '--text',
        'hello $(id)',
        '--uuid',
        'uuid-send',
        '--format',
        'json',
      ],
    ]);
    expect(runner.mock.calls[1]?.[1]).toEqual([
      'chat',
      'message',
      'reply',
      '--conversation-id',
      'cid-1',
      '--ref-msg-id',
      'message-1',
      '--ref-sender',
      'open-alice',
      '--text',
      'done',
      '--uuid',
      'uuid-reply',
      '--format',
      'json',
    ]);
  });

  it('adds and removes the working reaction from an IM message', async () => {
    const runner = vi.fn<DwsCommandRunner>().mockResolvedValue({
      stdout: json({ success: true }),
      stderr: '',
    });
    const client = new DwsClient({ executable: '/opt/dws' }, runner);

    await client.addImReaction('cid-1', 'message-1', '暗中观察');
    await client.removeImReaction('cid-1', 'message-1', '暗中观察');

    expect(runner.mock.calls.map((call) => call[1])).toEqual([
      [
        'chat',
        'message',
        'add-emoji',
        '--conversation-id',
        'cid-1',
        '--msg-id',
        'message-1',
        '--emoji',
        '暗中观察',
        '--format',
        'json',
      ],
      [
        'chat',
        'message',
        'remove-emoji',
        '--conversation-id',
        'cid-1',
        '--msg-id',
        'message-1',
        '--emoji',
        '暗中观察',
        '--format',
        'json',
      ],
    ]);
  });

  it('paginates recent direct-message history for notification fallback', async () => {
    const runner = vi.fn<DwsCommandRunner>(async (_executable, args) => ({
      stdout: json({
        result: {
          conversationMessagesList: [
            {
              singleChat: true,
              messages: [
                {
                  content: args.includes('page-2') ? 'second' : 'first',
                  createTime: args.includes('page-2')
                    ? '2026-08-13 10:55:02'
                    : '2026-08-13 10:55:01',
                  openConversationId: 'cid-1',
                  openMessageId: args.includes('page-2')
                    ? 'message-2'
                    : 'message-1',
                  sender: 'Alice',
                  senderOpenDingTalkId: 'open-alice',
                },
              ],
            },
            {
              singleChat: false,
              messages: [
                {
                  content: 'ignore group history',
                  openConversationId: 'group-1',
                  openMessageId: 'group-message',
                  senderOpenDingTalkId: 'open-bob',
                },
              ],
            },
          ],
          hasMore: !args.includes('page-2'),
          nextCursor: args.includes('page-2') ? '' : 'page-2',
        },
        success: true,
      }),
      stderr: '',
    }));
    const client = new DwsClient(
      { executable: '/opt/dws', profile: 'corp:user' },
      runner,
    );

    const messages = await client.listDirectMessages(
      new Date(2026, 7, 13, 10, 55, 0).getTime(),
      new Date(2026, 7, 13, 10, 56, 0).getTime(),
    );

    expect(
      messages.map(({ messageId, content }) => ({ messageId, content })),
    ).toEqual([
      { messageId: 'message-1', content: 'first' },
      { messageId: 'message-2', content: 'second' },
    ]);
    expect(runner.mock.calls.map((call) => call[1])).toEqual([
      [
        '--profile',
        'corp:user',
        'chat',
        'message',
        'list-all',
        '--start',
        '2026-08-13 10:55:00',
        '--end',
        '2026-08-13 10:56:00',
        '--limit',
        '50',
        '--cursor',
        '0',
        '--format',
        'json',
      ],
      expect.arrayContaining(['--cursor', 'page-2']),
    ]);
  });

  it('reads document Markdown and replies without shell interpolation', async () => {
    const runner = vi
      .fn<DwsCommandRunner>()
      .mockResolvedValueOnce({
        stdout: json({ result: { data: { markdown: '# Decision' } } }),
        stderr: '',
      })
      .mockResolvedValueOnce({
        stdout: json({ success: true }),
        stderr: '',
      });
    const client = new DwsClient({ executable: '/opt/dws' }, runner);

    await expect(client.readDocument('doc-1')).resolves.toBe('# Decision');
    await client.replyToComment('doc;one-arg', 'comment-1', 'done $(id)');

    expect(runner.mock.calls[1]).toEqual([
      '/opt/dws',
      [
        'doc',
        'comment',
        'reply',
        '--node',
        'doc;one-arg',
        '--comment-key',
        'comment-1',
        '--content',
        'done $(id)',
        '--format',
        'json',
      ],
    ]);
  });

  it('lists pending executor todos across pages and parses creator identity', async () => {
    const runner = vi
      .fn<DwsCommandRunner>()
      .mockImplementation(async (_executable, args) => ({
        stdout: json({
          result: {
            todoCards: [
              {
                taskId: args.includes('2') ? 'task-2' : 'task-1',
                subject: args.includes('2') ? 'Second task' : 'First task',
                creator: args.includes('2')
                  ? 'bob'
                  : { userId: 'alice', name: 'Alice' },
                creatorName: args.includes('2') ? 'Bob' : undefined,
              },
            ],
            hasMore: !args.includes('2'),
          },
          success: true,
        }),
        stderr: '',
      }));
    const client = new DwsClient(
      { executable: '/opt/dws', profile: 'corp:user' },
      runner,
    );

    await expect(client.listTodoTasks()).resolves.toEqual([
      expect.objectContaining({
        taskId: 'task-1',
        title: 'First task',
        creatorId: 'alice',
        creatorName: 'Alice',
      }),
      expect.objectContaining({
        taskId: 'task-2',
        title: 'Second task',
        creatorId: 'bob',
        creatorName: 'Bob',
      }),
    ]);
    expect(runner.mock.calls.map((call) => call[1])).toEqual([
      [
        '--profile',
        'corp:user',
        'todo',
        'task',
        'list',
        '--page',
        '1',
        '--size',
        '20',
        '--status',
        'false',
        '--role-types',
        'executor',
        '--format',
        'json',
      ],
      expect.arrayContaining(['--page', '2']),
    ]);
  });

  it('reads todo details and adds the final response as a comment', async () => {
    const runner = vi
      .fn<DwsCommandRunner>()
      .mockResolvedValueOnce({
        stdout: json({
          result: {
            todoDetailModel: {
              taskId: 'task-1',
              subject: 'Investigate the failure',
              creatorId: 'alice',
            },
          },
        }),
        stderr: '',
      })
      .mockResolvedValueOnce({
        stdout: json({ success: true }),
        stderr: '',
      });
    const client = new DwsClient(
      { executable: '/opt/dws', profile: 'corp:user' },
      runner,
    );

    await expect(client.getTodoTask('task-1')).resolves.toMatchObject({
      taskId: 'task-1',
      title: 'Investigate the failure',
      creatorId: 'alice',
    });
    await client.addTodoComment('task-1', 'Completed safely');

    expect(runner.mock.calls[1]).toEqual([
      '/opt/dws',
      [
        '--profile',
        'corp:user',
        'todo',
        'comment',
        'add',
        '--task-id',
        'task-1',
        '--content',
        'Completed safely',
        '--format',
        'json',
      ],
    ]);
  });

  it('classifies a local executable spawn failure as not sent', async () => {
    const client = new DwsClient({
      executable: '/definitely-missing-qwen-dws',
    });

    const error = await client
      .replyToComment('doc-1', 'comment-1', 'answer')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DwsCommandError);
    expect(error).toMatchObject({ outcome: 'not_sent' });
  });

  it.each(['', 'not-json'])(
    'classifies an unusable successful command response as unknown: %j',
    async (stdout) => {
      const runner = vi.fn<DwsCommandRunner>().mockResolvedValue({
        stdout,
        stderr: '',
      });
      const client = new DwsClient({ executable: '/opt/dws' }, runner);

      const error = await client
        .replyToComment('doc-1', 'comment-1', 'answer')
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(DwsCommandError);
      expect(error).toMatchObject({ outcome: 'unknown' });
    },
  );
});
