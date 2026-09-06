/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  classifyDwsCommandFailure,
  DwsClient,
  DwsCommandError,
  parseDwsImEvent,
  type DwsCommandRunner,
  type DwsImDispatch,
  type DwsImMessage,
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
  it('handles deeply nested command responses without overflowing the stack', async () => {
    const depth = 20_000;
    const runner = vi.fn<DwsCommandRunner>().mockResolvedValue({
      stdout: `${'{"nested":'.repeat(depth)}{"version":"1.0.57"}${'}'.repeat(depth)}`,
      stderr: '',
    });

    await expect(
      new DwsClient({ executable: '/opt/dws' }, runner).assertCompatible(),
    ).resolves.toBeUndefined();
  });

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
      selfSenderIds: ['open-user-1'],
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

  it('resolves the current openDingTalkId from an exact contact match', async () => {
    const runner = vi
      .fn<DwsCommandRunner>()
      .mockResolvedValueOnce({
        stdout: json({ profiles: [{ profile: 'corp:bot', isCurrent: true }] }),
        stderr: '',
      })
      .mockResolvedValueOnce({
        stdout: json({
          authenticated: true,
          user_id: 'AI574',
          user_name: 'QwenBot',
        }),
        stderr: '',
      })
      .mockResolvedValueOnce({
        stdout: json({
          result: [
            {
              userId: 'someone-else',
              openDingTalkId: 'open-someone-else',
            },
            { userId: 'AI574', openDingTalkId: 'open-qwen-bot' },
          ],
        }),
        stderr: '',
      });
    const client = new DwsClient(
      { executable: '/opt/dws', profile: 'corp:bot' },
      runner,
    );

    await expect(client.assertAuthenticated()).resolves.toEqual({
      profile: 'corp:bot',
      selfSenderIds: ['open-qwen-bot'],
    });
    expect(runner).toHaveBeenNthCalledWith(3, '/opt/dws', [
      '--profile',
      'corp:bot',
      'contact',
      'user',
      'search',
      '--query',
      'QwenBot',
      '--format',
      'json',
    ]);
  });

  it('returns no self sender identity when contact lookup fails', async () => {
    const runner = vi
      .fn<DwsCommandRunner>()
      .mockResolvedValueOnce({
        stdout: json({ profiles: [{ profile: 'corp:bot', isCurrent: true }] }),
        stderr: '',
      })
      .mockResolvedValueOnce({
        stdout: json({
          authenticated: true,
          user_id: 'AI574',
          user_name: 'QwenBot',
        }),
        stderr: '',
      })
      .mockRejectedValueOnce(new Error('contact unavailable'));
    const client = new DwsClient(
      { executable: '/opt/dws', profile: 'corp:bot' },
      runner,
    );

    await expect(client.assertAuthenticated()).resolves.toEqual({
      profile: 'corp:bot',
    });
  });

  it('does not select conflicting openDingTalkIds for the current user', async () => {
    const runner = vi
      .fn<DwsCommandRunner>()
      .mockResolvedValueOnce({
        stdout: json({ profiles: [{ profile: 'corp:bot', isCurrent: true }] }),
        stderr: '',
      })
      .mockResolvedValueOnce({
        stdout: json({
          authenticated: true,
          user_id: 'AI574',
          user_name: 'QwenBot',
        }),
        stderr: '',
      })
      .mockResolvedValueOnce({
        stdout: json({
          result: [
            { userId: 'AI574', openDingTalkId: 'open-one' },
            { userId: 'AI574', openDingTalkId: 'open-two' },
          ],
        }),
        stderr: '',
      });
    const client = new DwsClient(
      { executable: '/opt/dws', profile: 'corp:bot' },
      runner,
    );

    await expect(client.assertAuthenticated()).resolves.toEqual({
      profile: 'corp:bot',
    });
  });

  it('propagates cancellation during contact identity lookup', async () => {
    const abortController = new AbortController();
    const runner = vi
      .fn<DwsCommandRunner>()
      .mockResolvedValueOnce({
        stdout: json({ profiles: [{ profile: 'corp:bot', isCurrent: true }] }),
        stderr: '',
      })
      .mockResolvedValueOnce({
        stdout: json({
          authenticated: true,
          user_id: 'AI574',
          user_name: 'QwenBot',
        }),
        stderr: '',
      })
      .mockImplementationOnce(async () => {
        abortController.abort();
        throw new Error('contact lookup cancelled');
      });
    const client = new DwsClient(
      { executable: '/opt/dws', profile: 'corp:bot' },
      runner,
    );

    await expect(
      client.assertAuthenticated(abortController.signal),
    ).rejects.toThrow('aborted');
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
        content: 'check this',
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
        content: 'check this',
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

  it('does not make the direct event reader wait for message processing', async () => {
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
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const completed: string[] = [];
    const onMessage = vi.fn((message: DwsImMessage): DwsImDispatch => {
      const processing = (async () => {
        if (message.conversationId === 'conversation-a') await firstBlocked;
        completed.push(message.conversationId);
      })();
      return { admitted: Promise.resolve(), completed: processing };
    });

    await client.subscribeToIm({ kind: 'direct' }, onMessage, vi.fn());
    await onLine(
      json({
        type: 'user_im_message_receive_o2o_all',
        event_id: 'event-a',
        message_id: 'message-a',
        conversation_id: 'conversation-a',
        content: 'first request',
        sender_open_dingtalk_id: 'user-a',
        sender: 'User A',
      }),
    );
    await onLine(
      json({
        type: 'user_im_message_receive_o2o_all',
        event_id: 'event-b',
        message_id: 'message-b',
        conversation_id: 'conversation-b',
        content: 'second request',
        sender_open_dingtalk_id: 'user-b',
        sender: 'User B',
      }),
    );

    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(completed).toEqual(['conversation-b']);
    releaseFirst();
    await vi.waitFor(() =>
      expect(completed).toEqual(['conversation-b', 'conversation-a']),
    );
  });

  it('reports a detached direct-message processing failure', async () => {
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
    const onError = vi.fn();

    await client.subscribeToIm(
      { kind: 'direct' },
      vi.fn(
        (): DwsImDispatch => ({
          admitted: Promise.resolve(),
          completed: Promise.reject(new Error('turn failed')),
        }),
      ),
      onError,
    );
    await onLine(
      json({
        type: 'user_im_message_receive_o2o_all',
        event_id: 'event-1',
        message_id: 'message-1',
        conversation_id: 'conversation-a',
        content: 'request',
        sender_open_dingtalk_id: 'user-a',
        sender: 'User A',
      }),
    );

    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'turn failed' }),
      ),
    );
  });

  it('does not report completion after direct admission fails', async () => {
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
    const onError = vi.fn();

    await client.subscribeToIm(
      { kind: 'direct' },
      vi.fn(
        (): DwsImDispatch => ({
          admitted: Promise.reject(new Error('admission failed')),
          completed: Promise.reject(new Error('completion failed')),
        }),
      ),
      onError,
    );

    await expect(
      onLine(
        json({
          type: 'user_im_message_receive_o2o_all',
          event_id: 'event-1',
          message_id: 'message-1',
          conversation_id: 'conversation-a',
          content: 'request',
          sender_open_dingtalk_id: 'user-a',
          sender: 'User A',
        }),
      ),
    ).rejects.toThrow('admission failed');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onError).not.toHaveBeenCalled();
  });

  it('observes completion failure while direct admission is pending', async () => {
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
    let releaseAdmission!: () => void;
    const admitted = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    let rejectCompletion!: (error: Error) => void;
    const completed = new Promise<void>((_resolve, reject) => {
      rejectCompletion = reject;
    });
    const onError = vi.fn();

    await client.subscribeToIm(
      { kind: 'direct' },
      vi.fn((): DwsImDispatch => ({ admitted, completed })),
      onError,
    );
    const reading = Promise.resolve(
      onLine(
        json({
          type: 'user_im_message_receive_o2o_all',
          event_id: 'event-1',
          message_id: 'message-1',
          conversation_id: 'conversation-a',
          content: 'request',
          sender_open_dingtalk_id: 'user-a',
          sender: 'User A',
        }),
      ),
    );
    rejectCompletion(new Error('turn failed'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onError).not.toHaveBeenCalled();

    releaseAdmission();
    await reading;
    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'turn failed' }),
      ),
    );
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

  it('preserves literal JSON text in a normalized live event', () => {
    const content = '{"content":"review this JSON"}';

    expect(
      parseDwsImEvent(
        json({
          type: 'user_im_message_receive_o2o_all',
          message_id: 'message-1',
          conversation_id: 'cid-1',
          content,
          sender_open_dingtalk_id: 'open-alice',
        }),
      ).content,
    ).toBe(content);
  });

  it('preserves quoted message text in a normalized live event', () => {
    expect(
      parseDwsImEvent(
        json({
          type: 'user_im_message_receive_at',
          message_id: 'message-1',
          conversation_id: 'cid-1',
          content: '@QwenBot help with this',
          quoted_message: {
            content: 'Qwen Code is slow after connecting over SSH.',
          },
          sender_open_dingtalk_id: 'open-alice',
        }),
      ),
    ).toMatchObject({
      referencedText: 'Qwen Code is slow after connecting over SSH.',
    });
  });

  it.each([null, 'quoted text', {}, { content: '   ' }, { content: 42 }])(
    'ignores invalid or empty quoted message payloads: %j',
    (quotedMessage) => {
      expect(
        parseDwsImEvent(
          json({
            type: 'user_im_message_receive_at',
            message_id: 'message-1',
            conversation_id: 'cid-1',
            content: '@QwenBot help with this',
            quoted_message: quotedMessage,
            sender_open_dingtalk_id: 'open-alice',
          }),
        ).referencedText,
      ).toBeUndefined();
    },
  );

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
                quotedMessage: {
                  content: 'Original message from the nested payload.',
                },
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
      referencedText: 'Original message from the nested payload.',
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
        content: 'check this',
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

  it('lists mentioned group messages for history fallback', async () => {
    const runner = vi.fn<DwsCommandRunner>().mockResolvedValue({
      stdout: json({
        result: {
          conversationMessagesList: [
            {
              singleChat: false,
              messages: [
                {
                  content: '@QwenBot hi',
                  createTime: '2026-08-17 12:56:28',
                  openConversationId: 'external-group',
                  openMessageId: 'mention-1',
                  quotedMessage: {
                    content: 'Qwen Code is slow after connecting over SSH.',
                  },
                  sender: 'Alice',
                  senderOpenDingTalkId: 'open-alice',
                },
              ],
            },
          ],
          hasMore: false,
        },
        success: true,
      }),
      stderr: '',
    });
    const client = new DwsClient(
      { executable: '/opt/dws', profile: 'corp:bot' },
      runner,
    );

    const startTime = new Date(2026, 0, 2, 3, 4, 5).getTime();
    const endTime = new Date(2026, 0, 2, 3, 4, 6).getTime();
    await expect(
      client.listMentionedMessages(startTime, endTime),
    ).resolves.toEqual({
      messages: [
        {
          type: 'user_im_message_receive_at',
          eventId: 'mention-1',
          messageId: 'mention-1',
          conversationId: 'external-group',
          content: '@QwenBot hi',
          senderId: 'open-alice',
          senderName: 'Alice',
          referencedText: 'Qwen Code is slow after connecting over SSH.',
          eventTime: new Date(2026, 7, 17, 12, 56, 28).getTime(),
        },
      ],
    });
    expect(runner).toHaveBeenCalledWith('/opt/dws', [
      '--profile',
      'corp:bot',
      'chat',
      'message',
      'list-mentions',
      '--start',
      '2026-01-02 03:04:05',
      '--end',
      '2026-01-02 03:04:06',
      '--limit',
      '50',
      '--cursor',
      '0',
      '--format',
      'json',
    ]);
  });

  it('treats a successful mention-history response without conversations as empty', async () => {
    const runner = vi.fn<DwsCommandRunner>().mockResolvedValue({
      stdout: json({
        result: { hasMore: false, nextCursor: 'unused' },
        success: true,
      }),
      stderr: '',
    });

    await expect(
      new DwsClient({ executable: '/opt/dws' }, runner).listMentionedMessages(
        1,
        2,
      ),
    ).resolves.toEqual({ messages: [] });
  });

  it('rejects an invalid next cursor when mention history has more pages', async () => {
    const runner = vi.fn<DwsCommandRunner>().mockResolvedValue({
      stdout: json({
        result: {
          conversationMessagesList: [],
          hasMore: true,
          nextCursor: 'page-1',
        },
        success: true,
      }),
      stderr: '',
    });

    await expect(
      new DwsClient({ executable: '/opt/dws' }, runner).listMentionedMessages(
        1,
        2,
        undefined,
        'page-1',
      ),
    ).rejects.toThrow('next cursor');
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

    const page = await client.listDirectMessages(
      new Date(2026, 7, 13, 10, 55, 0).getTime(),
      new Date(2026, 7, 13, 10, 56, 0).getTime(),
    );

    expect(
      page.messages.map(({ messageId, content }) => ({ messageId, content })),
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

  it('preserves literal JSON text in direct-message history', async () => {
    const content = '{"text":"review this JSON"}';
    const runner = vi.fn<DwsCommandRunner>().mockResolvedValue({
      stdout: json({
        result: {
          conversationMessagesList: [
            {
              singleChat: true,
              messages: [
                {
                  content,
                  openConversationId: 'cid-1',
                  openMessageId: 'message-1',
                  senderOpenDingTalkId: 'open-alice',
                },
              ],
            },
          ],
          hasMore: false,
        },
      }),
      stderr: '',
    });

    const page = await new DwsClient(
      { executable: '/opt/dws' },
      runner,
    ).listDirectMessages(1, 2);

    expect(page.messages[0]?.content).toBe(content);
  });

  it('returns a continuation after a bounded history batch', async () => {
    const runner = vi.fn<DwsCommandRunner>(async (_executable, args) => {
      const cursorIndex = args.indexOf('--cursor');
      const cursor = Number(args[cursorIndex + 1]);
      return {
        stdout: json({
          result: {
            conversationMessagesList: [],
            hasMore: cursor < 100,
            nextCursor: cursor < 100 ? String(cursor + 1) : '',
          },
          success: true,
        }),
        stderr: '',
      };
    });
    const client = new DwsClient({ executable: '/opt/dws' }, runner);

    const first = await client.listDirectMessages(1, 2);
    const second = await client.listDirectMessages(
      1,
      2,
      undefined,
      first.nextCursor,
    );

    expect(first).toEqual({ messages: [], nextCursor: '100' });
    expect(second).toEqual({ messages: [] });
    expect(runner).toHaveBeenCalledTimes(101);
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

  it.each([
    'E2BIG',
    'EACCES',
    'EAGAIN',
    'EBUSY',
    'EFAULT',
    'EIO',
    'EISDIR',
    'ELOOP',
    'EMFILE',
    'ENAMETOOLONG',
    'ENFILE',
    'ENOENT',
    'ENOEXEC',
    'ENOMEM',
    'ENOSYS',
    'ENOTDIR',
    'EPERM',
    'ETXTBSY',
  ])('classifies the spawn failure %s as not sent', (code) => {
    // The resource errnos (EMFILE/ENFILE/ENOMEM/EAGAIN) are the ones that were
    // missing: under fd or memory exhaustion `uv_spawn` fails before `dws`
    // runs, so nothing was sent — but classified `unknown`, the todo and
    // document reply paths in dws-channel.ts swallow the failure and the
    // user's answer is dropped for good instead of being retried.
    expect(classifyDwsCommandFailure(code)).toBe('not_sent');
  });

  it.each([
    // A timeout kill: the child ran, `code` is null and `signal` carries SIGTERM.
    [null, 'a timeout kill'],
    // An abort through the AbortSignal.
    ['ABORT_ERR', 'an abort'],
    // stdout past maxBuffer — the command ran and may well have sent.
    ['ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 'a maxBuffer overrun'],
    // A non-zero exit: execFile reports the exit status as a NUMBER.
    [1, 'a non-zero exit'],
    [127, 'a shell not-found exit'],
    [undefined, 'a codeless error'],
  ])('leaves %j (%s) unknown', (code) => {
    // Each of these happened with a child already running, so a retry could
    // duplicate a delivery the first attempt made.
    expect(classifyDwsCommandFailure(code)).toBe('unknown');
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
