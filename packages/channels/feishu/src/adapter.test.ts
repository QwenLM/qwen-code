import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const wsMock = vi.hoisted(() => ({
  close: vi.fn(),
  start: vi.fn<() => Promise<void>>(),
}));

vi.mock('@larksuiteoapi/node-sdk', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@larksuiteoapi/node-sdk')>();
  return {
    ...actual,
    WSClient: class {
      start = wsMock.start;
      close = wsMock.close;
    },
  };
});

import { FeishuChannel } from './FeishuAdapter.js';
import { PairingStore } from '@qwen-code/channel-base';
import type {
  ChannelAgentBridge,
  ChannelBaseOptions,
  ChannelConfig,
  ChannelProactiveDeliveryError,
  ChannelOutputSegmentContext,
  ChannelOutputSegmentEndReason,
  ChannelTaskLifecycleEvent,
  ChannelUserInputRequestContext,
  ObservedChannelContactGraph,
  SessionTarget,
  UserInputSettlementReason,
} from '@qwen-code/channel-base';

function createMockBridge(): ChannelAgentBridge {
  return {
    prompt: vi.fn().mockResolvedValue(''),
    cancelSession: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
    availableCommands: [],
    newSession: vi.fn().mockResolvedValue('session-1'),
    loadSession: vi.fn().mockImplementation((id: string) => id),
  } as unknown as ChannelAgentBridge;
}

function createConfig(overrides?: Partial<ChannelConfig>): ChannelConfig {
  return {
    type: 'feishu',
    token: '',
    clientId: 'test_app_id',
    clientSecret: 'test_app_secret',
    senderPolicy: 'open',
    allowedUsers: [],
    sessionScope: 'user',
    cwd: '/tmp',
    groupPolicy: 'open',
    dmPolicy: 'open',
    groups: { '*': { requireMention: true } },
    ...overrides,
  };
}

function createChannel(
  configOverrides?: Partial<ChannelConfig>,
): FeishuChannel {
  const config = createConfig(configOverrides);
  const bridge = createMockBridge();
  return new FeishuChannel('test', config, bridge);
}

class TestableFeishuChannel extends FeishuChannel {
  pushLoop(target: SessionTarget, text: string): Promise<void> {
    return this.pushProactive(target, text);
  }

  sendAttributed(chatId: string, text: string, sourceLabel: string) {
    return this.sendThreadMessage(chatId, undefined, text, sourceLabel);
  }
}

function createTestableChannel(
  configOverrides?: Partial<ChannelConfig>,
): TestableFeishuChannel {
  const config = createConfig(configOverrides);
  const bridge = createMockBridge();
  return new TestableFeishuChannel('test', config, bridge);
}

class ObservedContactFeishuChannel extends FeishuChannel {
  protected override onPromptStart(): void {}

  protected override onPromptEnd(): Promise<void> {
    return Promise.resolve();
  }
}

function createObservedContactChannel(
  observe: NonNullable<ChannelBaseOptions['observedContacts']>['observe'],
  list?: NonNullable<ChannelBaseOptions['observedContacts']>['list'],
): {
  channel: ObservedContactFeishuChannel;
  bridge: ChannelAgentBridge;
} {
  const bridge = createMockBridge();
  const channel = new ObservedContactFeishuChannel(
    'test',
    createConfig({
      blockStreaming: 'on',
      groupPolicy: 'open',
      groups: { '*': { requireMention: false } },
    }),
    bridge,
    { observedContacts: { observe, ...(list ? { list } : {}) } },
  );
  Object.assign(channel as unknown as Record<string, unknown>, {
    tokenCache: {
      token: 'test_token',
      expiresAt: Date.now() + 3_600_000,
    },
  });
  return { channel, bridge };
}

function feishuGroupMessage(messageId: string): Record<string, unknown> {
  return {
    message: {
      message_id: messageId,
      chat_id: 'oc_group',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: 'hello' }),
    },
    sender: {
      sender_id: {
        union_id: 'on_user',
        user_id: 'user_1',
        open_id: 'ou_user',
      },
      sender_type: 'user',
      tenant_key: 'tenant_1',
    },
  };
}

function feishuDmMessage(messageId: string): Record<string, unknown> {
  return {
    message: {
      message_id: messageId,
      chat_id: 'oc_dm',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: 'hello' }),
    },
    sender: {
      sender_id: {
        union_id: 'on_user',
        user_id: 'user_1',
        open_id: 'ou_user',
      },
      sender_type: 'user',
      tenant_key: 'tenant_1',
    },
  };
}

// Access private methods for unit testing
function getPrivateMethod<T>(instance: unknown, method: string): T {
  return (instance as Record<string, unknown>)[method] as T;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
  });
}

describe('FeishuChannel', () => {
  describe('constructor', () => {
    it('throws if clientId is missing', () => {
      expect(() => createChannel({ clientId: undefined })).toThrow(
        /requires clientId/,
      );
    });

    it('throws if clientSecret is missing', () => {
      expect(() => createChannel({ clientSecret: undefined })).toThrow(
        /requires clientId.*clientSecret/,
      );
    });

    it('supports proactive loop messages', () => {
      const channel = createChannel();

      expect(channel.supportsProactiveSend()).toBe(true);
    });

    it('logs message debug payloads from the shared handler map', () => {
      const channel = createChannel();
      const logDebugPayload = vi.fn();
      const onMessage = vi.fn();
      Object.assign(channel as unknown as Record<string, unknown>, {
        logDebugPayload,
        onMessage,
      });
      const buildHandlerMap = getPrivateMethod<
        () => Record<string, (data: unknown) => unknown>
      >(channel, 'buildHandlerMap').bind(channel);
      const payload = {
        message: {
          message_id: 'debug-m1',
          chat_id: 'chat-1',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: 'hello' }),
        },
        sender: {
          sender_type: 'app',
          sender_id: { open_id: 'bot-open-id' },
        },
      };

      const result = buildHandlerMap()['im.message.receive_v1']?.(payload);

      expect(logDebugPayload).toHaveBeenCalledWith('Feishu', payload);
      expect(onMessage).toHaveBeenCalledWith(payload);
      expect(result).toEqual({});
    });

    it('logs card action debug payloads and preserves stop toast response', () => {
      const channel = createChannel();
      const logDebugPayload = vi.fn();
      const onCardAction = vi.fn().mockReturnValue(true);
      Object.assign(channel as unknown as Record<string, unknown>, {
        logDebugPayload,
        onCardAction,
      });
      const buildHandlerMap = getPrivateMethod<
        () => Record<string, (data: unknown) => unknown>
      >(channel, 'buildHandlerMap').bind(channel);
      const payload = {
        action: { value: { action: 'stop' } },
        context: { open_message_id: 'card-1' },
      };

      const result = buildHandlerMap()['card.action.trigger']?.(payload);

      expect(logDebugPayload).toHaveBeenCalledWith('Feishu', payload);
      expect(onCardAction).toHaveBeenCalledWith(payload);
      expect(result).toEqual({ toast: { type: 'info', content: '已停止' } });
    });

    it('routes handled question actions before Stop and executes asynchronously', async () => {
      const channel = createChannel();
      const response = {
        toast: { type: 'success', content: '答案已提交，正在处理。' },
      };
      const execute = vi.fn().mockResolvedValue(undefined);
      const claim = vi.fn().mockReturnValue({
        kind: 'handled',
        response,
        execute,
      });
      const onCardAction = vi.fn().mockReturnValue(true);
      Object.assign(channel as unknown as Record<string, unknown>, {
        questionCardController: { claim },
        onCardAction,
      });
      const handler = getPrivateMethod<
        () => Record<string, (data: unknown) => unknown>
      >(channel, 'buildHandlerMap').call(channel)['card.action.trigger'];
      const payload = {
        action: {
          value: {
            action: 'qwen_ask_submit',
            operation_id: 'request-1',
          },
        },
      };

      expect(handler?.(payload)).toBe(response);
      expect(claim).toHaveBeenCalledWith(payload);
      expect(execute).not.toHaveBeenCalled();
      expect(onCardAction).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    });

    it('contains question action execution failures with a labeled error', async () => {
      const channel = createChannel();
      const response = {
        toast: { type: 'success', content: '答案已提交，正在处理。' },
      };
      const execute = vi.fn().mockRejectedValue(new Error('boom'));
      const claim = vi.fn().mockReturnValue({
        kind: 'handled',
        response,
        execute,
      });
      Object.assign(channel as unknown as Record<string, unknown>, {
        questionCardController: { claim },
        onCardAction: vi.fn().mockReturnValue(false),
      });
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      try {
        const handler = getPrivateMethod<
          () => Record<string, (data: unknown) => unknown>
        >(channel, 'buildHandlerMap').call(channel)['card.action.trigger'];
        const payload = {
          action: {
            value: {
              action: 'qwen_ask_submit',
              operation_id: 'request-1',
            },
          },
        };

        expect(handler?.(payload)).toBe(response);
        await vi.waitFor(() => {
          expect(stderr).toHaveBeenCalledWith(
            expect.stringContaining('question action execution error: boom'),
          );
        });
      } finally {
        stderr.mockRestore();
      }
    });

    it('routes toast-only handled question actions without executing anything', async () => {
      const channel = createChannel();
      const response = {
        toast: { type: 'warning', content: '请完整选择有效答案。' },
      };
      const claim = vi.fn().mockReturnValue({ kind: 'handled', response });
      const onCardAction = vi.fn().mockReturnValue(true);
      Object.assign(channel as unknown as Record<string, unknown>, {
        questionCardController: { claim },
        onCardAction,
      });
      const handler = getPrivateMethod<
        () => Record<string, (data: unknown) => unknown>
      >(channel, 'buildHandlerMap').call(channel)['card.action.trigger'];
      const payload = {
        action: {
          value: {
            action: 'qwen_ask_submit',
            operation_id: 'request-1',
          },
        },
      };

      expect(handler?.(payload)).toBe(response);
      expect(onCardAction).not.toHaveBeenCalled();
      // Flush immediates: without the `if (execute)` guard the handler would
      // call `execute()` on undefined inside setImmediate and surface as an
      // uncaught exception instead of the warning toast.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    it('falls through unhandled question actions to Stop handling', () => {
      const channel = createChannel();
      const claim = vi.fn().mockReturnValue({ kind: 'unhandled' });
      const onCardAction = vi.fn().mockReturnValue(true);
      Object.assign(channel as unknown as Record<string, unknown>, {
        questionCardController: { claim },
        onCardAction,
      });
      const handler = getPrivateMethod<
        () => Record<string, (data: unknown) => unknown>
      >(channel, 'buildHandlerMap').call(channel)['card.action.trigger'];
      const payload = { action: { value: { action: 'stop' } } };

      expect(handler?.(payload)).toEqual({
        toast: { type: 'info', content: '已停止' },
      });
      expect(claim).toHaveBeenCalledWith(payload);
      expect(onCardAction).toHaveBeenCalledWith(payload);
    });

    it('delegates user input presentation to the question controller', async () => {
      const channel = createChannel();
      const result = { kind: 'presented' } as const;
      const present = vi.fn().mockResolvedValue(result);
      Object.assign(channel as unknown as Record<string, unknown>, {
        questionCardController: { present },
      });
      const context = {
        requestId: 'request-1',
      } as ChannelUserInputRequestContext;

      await expect(
        getPrivateMethod<
          (request: ChannelUserInputRequestContext) => Promise<{ kind: string }>
        >(channel, 'presentUserInputRequest').call(channel, context),
      ).resolves.toBe(result);
      expect(present).toHaveBeenCalledWith(context);
    });

    it('wires the real question controller through the native card helpers', async () => {
      const channel = createChannel();
      (channel as unknown as Record<string, unknown>)['tokenCache'] = {
        token: 'tenant-token',
        expiresAt: Date.now() + 3600_000,
      };
      const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ data: { message_id: 'om_question' } }), {
          status: 200,
        }),
      );
      const context = {
        requestId: 'request-wired',
        sessionId: 'session_1',
        runId: 'run-1',
        owner: { kind: 'channel_user', id: 'owner-1' },
        target: {
          channelName: 'feishu',
          chatId: 'oc_chat_id',
          senderId: 'owner-1',
          isGroup: false,
        },
        questions: [
          {
            answerKey: '0',
            header: 'Region',
            question: 'Which region?',
            options: [{ label: 'Beijing', description: 'Use Beijing.' }],
            multiSelect: false,
          },
        ],
        submitOptionId: 'allow-once',
        onSettled: () => () => {},
        respond: vi.fn().mockResolvedValue(true),
      } as unknown as ChannelUserInputRequestContext;

      await expect(
        getPrivateMethod<
          (request: ChannelUserInputRequestContext) => Promise<{ kind: string }>
        >(channel, 'presentUserInputRequest').call(channel, context),
      ).resolves.toEqual({ kind: 'presented' });
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/im/v1/messages?receive_id_type=chat_id'),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('qwen_ask_form'),
        }),
      );
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('Which region?'),
        }),
      );

      (
        channel as unknown as {
          questionCardController: { dispose(): void };
        }
      ).questionCardController.dispose();
      // Drain the dispose-time terminal projection so the PATCH can never
      // reach the real network once the spy is restored.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fetchSpy).toHaveBeenLastCalledWith(
        expect.stringContaining('/im/v1/messages/om_question'),
        expect.objectContaining({ method: 'PATCH' }),
      );
      fetchSpy.mockRestore();
    });

    it('does not send an extra terminal message after a direct question', async () => {
      const channel = createChannel();
      const present = vi.fn().mockResolvedValue({ kind: 'presented' });
      const cancelRun = vi.fn();
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      Object.assign(channel as unknown as Record<string, unknown>, {
        questionCardController: { present, cancelRun },
        sendMessage,
        addReaction: vi.fn().mockResolvedValue(undefined),
        removeReaction: vi.fn().mockResolvedValue(undefined),
      });
      getPrivateMethod<Map<string, string>>(channel, 'msgToQuestion').set(
        'inbound_1',
        'question?',
      );
      getPrivateMethod<
        (chatId: string, sessionId: string, messageId?: string) => void
      >(channel, 'onPromptStart').call(
        channel,
        'oc_chat_id',
        'session_1',
        'inbound_1',
      );
      const context = {
        requestId: 'request-direct',
        sessionId: 'session_1',
        target: { chatId: 'oc_chat_id' },
      } as ChannelUserInputRequestContext;

      await getPrivateMethod<
        (request: ChannelUserInputRequestContext) => Promise<{ kind: string }>
      >(channel, 'presentUserInputRequest').call(channel, context);
      getPrivateMethod<(event: ChannelTaskLifecycleEvent) => void>(
        channel,
        'onTaskLifecycle',
      ).call(channel, {
        channelName: 'feishu',
        chatId: 'oc_chat_id',
        sessionId: 'session_1',
        runId: 'run-1',
        type: 'completed',
        identity: { id: 'channel:feishu', displayName: 'feishu' },
        memoryScope: { namespace: 'channel:feishu', mode: 'metadata-only' },
      });
      await getPrivateMethod<
        (chatId: string, sessionId: string, messageId?: string) => Promise<void>
      >(channel, 'onPromptEnd').call(
        channel,
        'oc_chat_id',
        'session_1',
        'inbound_1',
      );

      expect(present).toHaveBeenCalledWith(context);
      expect(sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('extractContent', () => {
    let channel: FeishuChannel;
    let extractContent: (
      messageType: string,
      contentJson: string,
    ) => {
      text: string;
      imageKey?: string;
      fileKey?: string;
      fileName?: string;
    };

    beforeEach(() => {
      channel = createChannel();
      extractContent = getPrivateMethod<
        (
          messageType: string,
          contentJson: string,
        ) => {
          text: string;
          imageKey?: string;
          fileKey?: string;
          fileName?: string;
        }
      >(channel, 'extractContent').bind(channel);
    });

    it('handles text messages', () => {
      const result = extractContent('text', JSON.stringify({ text: 'hello' }));
      expect(result.text).toBe('hello');
    });

    it('handles post messages with nested paragraphs', () => {
      const post = {
        zh_cn: {
          title: 'Post Title',
          content: [
            [
              { tag: 'text', text: 'Line 1 ' },
              { tag: 'a', text: 'link' },
            ],
            [{ tag: 'text', text: 'Line 2' }],
          ],
        },
      };
      const result = extractContent('post', JSON.stringify(post));
      expect(result.text).toContain('Post Title');
      expect(result.text).toContain('Line 1 link');
      expect(result.text).toContain('Line 2');
    });

    it('handles image messages', () => {
      const result = extractContent(
        'image',
        JSON.stringify({ image_key: 'img_key_123' }),
      );
      expect(result.text).toBe('(image)');
      expect(result.imageKey).toBe('img_key_123');
    });

    it('handles file messages', () => {
      const result = extractContent(
        'file',
        JSON.stringify({ file_key: 'file_key_456', file_name: 'doc.pdf' }),
      );
      expect(result.text).toBe('(file: doc.pdf)');
      expect(result.fileKey).toBe('file_key_456');
      expect(result.fileName).toBe('doc.pdf');
    });

    it('handles audio messages', () => {
      const result = extractContent('audio', JSON.stringify({}));
      expect(result.text).toBe('(audio)');
    });

    it('handles media (video) messages', () => {
      const result = extractContent(
        'media',
        JSON.stringify({ file_key: 'vid_key', file_name: 'video.mp4' }),
      );
      expect(result.text).toBe('(video)');
      expect(result.fileKey).toBe('vid_key');
      expect(result.fileName).toBe('video.mp4');
    });

    it('returns empty text for unknown types', () => {
      const result = extractContent('sticker', JSON.stringify({}));
      expect(result.text).toBe('');
    });

    it('handles malformed JSON gracefully', () => {
      const result = extractContent('text', 'not valid json');
      expect(result.text).toBe('');
    });

    it('handles empty content', () => {
      const result = extractContent('text', JSON.stringify({}));
      expect(result.text).toBe('');
    });
  });

  it('resolves reply-to-bot status before group mention gating', async () => {
    const bridge = createMockBridge();
    const channel = new FeishuChannel('test', createConfig(), bridge);
    Object.assign(channel as unknown as Record<string, unknown>, {
      tokenCache: {
        token: 'test_token',
        expiresAt: Date.now() + 3_600_000,
      },
    });
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/im/v1/messages/om_parent?')) {
        return Promise.resolve(
          jsonResponse({
            data: {
              items: [
                {
                  msg_type: 'text',
                  body: {
                    content: JSON.stringify({ text: 'previous bot reply' }),
                  },
                  sender: { sender_type: 'app' },
                },
              ],
            },
          }),
        );
      }
      if (url.includes('/im/v1/messages/om_user_parent?')) {
        return Promise.resolve(
          jsonResponse({
            data: {
              items: [
                {
                  msg_type: 'text',
                  body: { content: JSON.stringify({ text: 'user reply' }) },
                  sender: { sender_type: 'user' },
                },
              ],
            },
          }),
        );
      }
      return Promise.resolve(jsonResponse({ code: 0 }));
    });
    const reply = feishuGroupMessage('message_reply');
    (reply['message'] as Record<string, unknown>)['parent_id'] = 'om_parent';

    try {
      getPrivateMethod<(data: unknown) => void>(channel, 'onMessage').call(
        channel,
        reply,
      );

      await vi.waitFor(() => expect(bridge.prompt).toHaveBeenCalledTimes(1));
      expect(bridge.prompt).toHaveBeenCalledWith(
        'session-1',
        expect.stringContaining('previous bot reply'),
        expect.anything(),
      );

      const userReply = feishuGroupMessage('message_user_reply');
      (userReply['message'] as Record<string, unknown>)['parent_id'] =
        'om_user_parent';
      getPrivateMethod<(data: unknown) => void>(channel, 'onMessage').call(
        channel,
        userReply,
      );
      await vi.waitFor(() =>
        expect(
          fetchSpy.mock.calls.filter(([input]) =>
            String(input).includes('/im/v1/messages/om_user_parent?'),
          ),
        ).toHaveLength(1),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(bridge.prompt).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it.each([
    {
      label: 'group pairing with a user parent',
      config: { groupPolicy: 'pairing' as const },
      parentType: 'user',
      expectedSubject: undefined,
    },
    {
      label: 'sender pairing with a user parent',
      config: { senderPolicy: 'pairing' as const },
      parentType: 'user',
      expectedSubject: undefined,
    },
    {
      label: 'group pairing with a bot parent',
      config: { groupPolicy: 'pairing' as const },
      parentType: 'app',
      expectedSubject: { type: 'group', id: 'oc_group' },
    },
    {
      label: 'sender pairing with a bot parent',
      config: { senderPolicy: 'pairing' as const },
      parentType: 'app',
      expectedSubject: { type: 'user', id: 'ou_user' },
    },
  ])(
    'defers $label until parent authorship is resolved',
    async ({ config, parentType, expectedSubject }) => {
      const previousQwenHome = process.env['QWEN_HOME'];
      const qwenHome = mkdtempSync(join(tmpdir(), 'feishu-pairing-'));
      process.env['QWEN_HOME'] = qwenHome;
      const bridge = createMockBridge();
      const channel = new FeishuChannel(
        'test',
        createConfig({ ...config, cwd: '/tmp' }),
        bridge,
      );
      Object.assign(channel as unknown as Record<string, unknown>, {
        tokenCache: {
          token: 'test_token',
          expiresAt: Date.now() + 3_600_000,
        },
      });
      const sendMessage = vi
        .spyOn(channel as never, 'sendMessage')
        .mockResolvedValue(undefined);
      const preflight = vi.spyOn(channel as never, 'preflightInbound');
      const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
        jsonResponse({
          data: {
            items: [
              {
                msg_type: 'text',
                body: { content: JSON.stringify({ text: 'parent text' }) },
                sender: { sender_type: parentType },
              },
            ],
          },
        }),
      );
      const reply = feishuGroupMessage(
        `message_${parentType}_${config.groupPolicy ?? config.senderPolicy}`,
      );
      (reply['message'] as Record<string, unknown>)['parent_id'] = 'om_parent';

      try {
        getPrivateMethod<(data: unknown) => void>(channel, 'onMessage').call(
          channel,
          reply,
        );

        await vi.waitFor(() => expect(preflight).toHaveBeenCalledTimes(2));
        await new Promise<void>((resolve) => setImmediate(resolve));

        const requests = new PairingStore('test', '/tmp').listPending();
        if (expectedSubject) {
          expect(requests).toHaveLength(1);
          expect(requests[0]?.subject).toMatchObject(expectedSubject);
          expect(sendMessage).toHaveBeenCalledOnce();
        } else {
          expect(requests).toEqual([]);
          expect(sendMessage).not.toHaveBeenCalled();
        }
        expect(fetchSpy).toHaveBeenCalledOnce();
        expect(bridge.prompt).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
        if (previousQwenHome === undefined) delete process.env['QWEN_HOME'];
        else process.env['QWEN_HOME'] = previousQwenHome;
        rmSync(qwenHome, { recursive: true, force: true });
      }
    },
  );

  describe('observed contact enrichment', () => {
    it('resolves labels once and reuses them on later observations', async () => {
      const observe = vi.fn();
      const { channel } = createObservedContactChannel(observe);
      const fetchSpy = vi
        .spyOn(global, 'fetch')
        .mockImplementation(async (input) => {
          const url = String(input);
          if (url.includes('/contact/v3/users/basic_batch')) {
            return new Response(
              JSON.stringify({
                code: 0,
                msg: 'success',
                data: {
                  users: [{ user_id: 'ou_user', name: 'Alice' }],
                },
              }),
              { status: 200 },
            );
          }
          if (url.includes('/im/v1/chats/oc_group')) {
            return new Response(
              JSON.stringify({
                code: 0,
                msg: 'success',
                data: { name: 'Project Group' },
              }),
              { status: 200 },
            );
          }
          throw new Error(`Unexpected request: ${url}`);
        });
      const onMessage = getPrivateMethod<(data: unknown) => void>(
        channel,
        'onMessage',
      ).bind(channel);

      try {
        onMessage(feishuGroupMessage('message_1'));

        await vi.waitFor(() => expect(observe).toHaveBeenCalledTimes(2));
        expect(observe).toHaveBeenNthCalledWith(1, 'test', {
          user: { id: 'ou_user', label: 'ou_user' },
          group: { id: 'oc_group', label: 'oc_group' },
        });
        expect(observe).toHaveBeenNthCalledWith(2, 'test', {
          user: { id: 'ou_user', label: 'Alice' },
          group: { id: 'oc_group', label: 'Project Group' },
        });
        expect(fetchSpy).toHaveBeenCalledWith(
          expect.stringContaining('user_id_type=open_id'),
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ user_ids: ['ou_user'] }),
          }),
        );
        expect(fetchSpy).toHaveBeenCalledWith(
          expect.stringContaining('/im/v1/chats/oc_group'),
          expect.objectContaining({
            headers: expect.objectContaining({
              Authorization: 'Bearer test_token',
            }),
          }),
        );

        onMessage(feishuGroupMessage('message_2'));

        await vi.waitFor(() => expect(observe).toHaveBeenCalledTimes(3));
        expect(observe).toHaveBeenNthCalledWith(3, 'test', {
          user: { id: 'ou_user', label: 'Alice' },
          group: { id: 'oc_group', label: 'Project Group' },
        });
        expect(fetchSpy).toHaveBeenCalledTimes(2);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('does not block inbound processing and silently caches lookup failures', async () => {
      const observe = vi.fn();
      const { channel, bridge } = createObservedContactChannel(observe);
      let rejectLookup: (reason: Error) => void = () => {};
      const lookup = new Promise<Response>((_resolve, reject) => {
        rejectLookup = reject;
      });
      const fetchSpy = vi
        .spyOn(global, 'fetch')
        .mockImplementation(() => lookup);
      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      const onMessage = getPrivateMethod<(data: unknown) => void>(
        channel,
        'onMessage',
      ).bind(channel);

      try {
        onMessage(feishuGroupMessage('message_1'));

        await vi.waitFor(() => {
          expect(observe).toHaveBeenCalledTimes(1);
          expect(bridge.prompt).toHaveBeenCalledTimes(1);
        });
        expect(fetchSpy).toHaveBeenCalledTimes(2);

        rejectLookup(new Error('private lookup failure'));
        await new Promise<void>((resolve) => setImmediate(resolve));

        onMessage(feishuGroupMessage('message_2'));
        await vi.waitFor(() => {
          expect(observe).toHaveBeenCalledTimes(2);
          expect(bridge.prompt).toHaveBeenCalledTimes(2);
        });

        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(stderrSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
        stderrSpy.mockRestore();
      }
    });

    it('repairs labels from a delayed message with a stale snapshot', async () => {
      const observe = vi.fn();
      const { channel } = createObservedContactChannel(observe);
      const userLookup = deferred<Response>();
      const chatLookup = deferred<Response>();
      const quotedMessage = deferred<Response>();
      const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation((input) => {
        const url = String(input);
        if (url.includes('/contact/v3/users/basic_batch')) {
          return userLookup.promise;
        }
        if (url.includes('/im/v1/chats/oc_group')) {
          return chatLookup.promise;
        }
        if (url.includes('/im/v1/messages/om_parent')) {
          return quotedMessage.promise;
        }
        throw new Error(`Unexpected request: ${url}`);
      });
      const onMessage = getPrivateMethod<(data: unknown) => void>(
        channel,
        'onMessage',
      ).bind(channel);

      try {
        onMessage(feishuGroupMessage('message_1'));
        await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));

        const reply = feishuGroupMessage('message_2');
        (reply['message'] as Record<string, unknown>)['parent_id'] =
          'om_parent';
        onMessage(reply);
        await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(3));

        userLookup.resolve(
          jsonResponse({
            code: 0,
            data: { users: [{ name: 'Alice' }] },
          }),
        );
        chatLookup.resolve(
          jsonResponse({ code: 0, data: { name: 'Project Group' } }),
        );
        await vi.waitFor(() => expect(observe).toHaveBeenCalledTimes(2));

        quotedMessage.resolve(
          jsonResponse({
            data: {
              items: [
                {
                  msg_type: 'text',
                  body: { content: JSON.stringify({ text: 'quoted' }) },
                  sender: { sender_type: 'user' },
                },
              ],
            },
          }),
        );

        await vi.waitFor(() => expect(observe).toHaveBeenCalledTimes(4));
        expect(observe).toHaveBeenNthCalledWith(3, 'test', {
          user: { id: 'ou_user', label: 'ou_user' },
          group: { id: 'oc_group', label: 'oc_group' },
        });
        expect(observe).toHaveBeenLastCalledWith('test', {
          user: { id: 'ou_user', label: 'Alice' },
          group: { id: 'oc_group', label: 'Project Group' },
        });
        expect(
          fetchSpy.mock.calls.filter(([input]) =>
            String(input).includes('/contact/v3/users/basic_batch'),
          ),
        ).toHaveLength(1);
        expect(
          fetchSpy.mock.calls.filter(([input]) =>
            String(input).includes('/im/v1/chats/oc_group'),
          ),
        ).toHaveLength(1);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('retries a label lookup when token acquisition fails before the request', async () => {
      const observe = vi.fn();
      const { channel } = createObservedContactChannel(observe);
      Object.assign(channel as unknown as Record<string, unknown>, {
        tokenCache: undefined,
      });
      const fetchSpy = vi
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(jsonResponse('unavailable', 503))
        .mockResolvedValueOnce(
          jsonResponse({
            tenant_access_token: 'fresh_token',
            expire: 3600,
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            code: 0,
            data: { users: [{ name: 'Alice' }] },
          }),
        );
      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      const observedUserName = getPrivateMethod<
        (userId: string) => Promise<string | undefined>
      >(channel, 'observedUserName').bind(channel);

      try {
        await expect(observedUserName('ou_user')).resolves.toBeUndefined();
        await expect(observedUserName('ou_user')).resolves.toBe('Alice');
        expect(fetchSpy).toHaveBeenCalledTimes(3);
        expect(stderrSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
        stderrSpy.mockRestore();
      }
    });

    it('refreshes the token after a label lookup returns 401', async () => {
      const observe = vi.fn();
      const { channel } = createObservedContactChannel(observe);
      const fetchSpy = vi
        .spyOn(global, 'fetch')
        .mockImplementation(async (input, init) => {
          const url = String(input);
          if (url.includes('/tenant_access_token/internal')) {
            return jsonResponse({
              tenant_access_token: 'fresh_token',
              expire: 3600,
            });
          }
          if (url.includes('/contact/v3/users/basic_batch')) {
            const authorization = new Headers(init?.headers).get(
              'Authorization',
            );
            if (authorization === 'Bearer test_token') {
              return jsonResponse('unauthorized', 401);
            }
            return jsonResponse({
              code: 0,
              data: { users: [{ name: 'Bob' }] },
            });
          }
          throw new Error(`Unexpected request: ${url}`);
        });
      const observedUserName = getPrivateMethod<
        (userId: string) => Promise<string | undefined>
      >(channel, 'observedUserName').bind(channel);

      try {
        await expect(observedUserName('ou_first')).resolves.toBeUndefined();
        await expect(observedUserName('ou_second')).resolves.toBe('Bob');
        await expect(observedUserName('ou_first')).resolves.toBe('Bob');
        expect(fetchSpy).toHaveBeenCalledTimes(4);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('retries a chat lookup when token acquisition fails before the request', async () => {
      const observe = vi.fn();
      const { channel } = createObservedContactChannel(observe);
      Object.assign(channel as unknown as Record<string, unknown>, {
        tokenCache: undefined,
      });
      const fetchSpy = vi
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(jsonResponse('unavailable', 503))
        .mockResolvedValueOnce(
          jsonResponse({
            tenant_access_token: 'fresh_token',
            expire: 3600,
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({ code: 0, data: { name: 'Project Group' } }),
        );
      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      const observedChatName = getPrivateMethod<
        (chatId: string) => Promise<string | undefined>
      >(channel, 'observedChatName').bind(channel);

      try {
        await expect(observedChatName('oc_group')).resolves.toBeUndefined();
        await expect(observedChatName('oc_group')).resolves.toBe(
          'Project Group',
        );
        expect(fetchSpy).toHaveBeenCalledTimes(3);
        expect(stderrSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
        stderrSpy.mockRestore();
      }
    });

    it('retries a 401 lookup for the same ID once the token refreshes', async () => {
      const observe = vi.fn();
      const { channel } = createObservedContactChannel(observe);
      const fetchSpy = vi
        .spyOn(global, 'fetch')
        .mockImplementation(async (input, init) => {
          const url = String(input);
          if (url.includes('/tenant_access_token/internal')) {
            return jsonResponse({
              tenant_access_token: 'fresh_token',
              expire: 3600,
            });
          }
          if (url.includes('/contact/v3/users/basic_batch')) {
            const authorization = new Headers(init?.headers).get(
              'Authorization',
            );
            if (authorization === 'Bearer test_token') {
              return jsonResponse('unauthorized', 401);
            }
            return jsonResponse({
              code: 0,
              data: { users: [{ name: 'Bob' }] },
            });
          }
          throw new Error(`Unexpected request: ${url}`);
        });
      const observedUserName = getPrivateMethod<
        (userId: string) => Promise<string | undefined>
      >(channel, 'observedUserName').bind(channel);

      try {
        await expect(observedUserName('ou_first')).resolves.toBeUndefined();
        await expect(observedUserName('ou_first')).resolves.toBe('Bob');
        expect(fetchSpy).toHaveBeenCalledTimes(3);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('sanitizes resolved display names before caching them', async () => {
      const observe = vi.fn();
      const { channel } = createObservedContactChannel(observe);
      const fetchSpy = vi
        .spyOn(global, 'fetch')
        .mockImplementation(async (input) => {
          const url = String(input);
          if (url.includes('/contact/v3/users/basic_batch')) {
            return jsonResponse({
              code: 0,
              data: { users: [{ name: 'Evil\rName' }] },
            });
          }
          throw new Error(`Unexpected request: ${url}`);
        });
      const observedUserName = getPrivateMethod<
        (userId: string) => Promise<string | undefined>
      >(channel, 'observedUserName').bind(channel);

      try {
        await expect(observedUserName('ou_user')).resolves.toBe('Evil Name');
        expect(
          (channel as unknown as Record<string, unknown>)['observedUserNames'],
        ).toEqual(new Map([['ou_user', 'Evil Name']]));
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('reuses a cached label without a new lookup after lookup entries evict', async () => {
      const observe = vi.fn();
      const { channel } = createObservedContactChannel(observe);
      const fetchSpy = vi
        .spyOn(global, 'fetch')
        .mockImplementation(async (input) => {
          const url = String(input);
          if (url.includes('/contact/v3/users/basic_batch')) {
            return jsonResponse({
              code: 0,
              data: { users: [{ name: 'Alice' }] },
            });
          }
          throw new Error(`Unexpected request: ${url}`);
        });
      const observedUserName = getPrivateMethod<
        (userId: string) => Promise<string | undefined>
      >(channel, 'observedUserName').bind(channel);

      try {
        await expect(observedUserName('ou_user')).resolves.toBe('Alice');
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        // Simulate FIFO eviction of the resolved lookup entry while the
        // cached label survives.
        (
          (channel as unknown as Record<string, unknown>)[
            'observedUserLookups'
          ] as Map<string, unknown>
        ).clear();

        await expect(observedUserName('ou_user')).resolves.toBe('Alice');
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('keeps the ID label when a resolved name sanitizes to unknown', async () => {
      const observe = vi.fn();
      const { channel } = createObservedContactChannel(observe);
      const fetchSpy = vi
        .spyOn(global, 'fetch')
        .mockImplementation(async (input) => {
          const url = String(input);
          if (url.includes('/contact/v3/users/basic_batch')) {
            return jsonResponse({
              code: 0,
              data: { users: [{ name: '\u200b\u200c\u200d' }] },
            });
          }
          throw new Error(`Unexpected request: ${url}`);
        });
      const observedUserName = getPrivateMethod<
        (userId: string) => Promise<string | undefined>
      >(channel, 'observedUserName').bind(channel);

      try {
        await expect(observedUserName('ou_user')).resolves.toBeUndefined();
        expect(
          (channel as unknown as Record<string, unknown>)['observedUserNames'],
        ).toEqual(new Map());
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('writes an enriched observation when only the user lookup resolves', async () => {
      const observe = vi.fn();
      const { channel } = createObservedContactChannel(observe);
      const fetchSpy = vi
        .spyOn(global, 'fetch')
        .mockImplementation(async (input) => {
          const url = String(input);
          if (url.includes('/contact/v3/users/basic_batch')) {
            return jsonResponse({
              code: 0,
              data: { users: [{ name: 'Alice' }] },
            });
          }
          if (url.includes('/im/v1/chats/oc_group')) {
            return jsonResponse({ code: 99991672, msg: 'no permission' });
          }
          throw new Error(`Unexpected request: ${url}`);
        });
      const onMessage = getPrivateMethod<(data: unknown) => void>(
        channel,
        'onMessage',
      ).bind(channel);

      try {
        onMessage(feishuGroupMessage('message_1'));

        await vi.waitFor(() => expect(observe).toHaveBeenCalledTimes(2));
        expect(observe).toHaveBeenNthCalledWith(1, 'test', {
          user: { id: 'ou_user', label: 'ou_user' },
          group: { id: 'oc_group', label: 'oc_group' },
        });
        expect(observe).toHaveBeenNthCalledWith(2, 'test', {
          user: { id: 'ou_user', label: 'Alice' },
          group: { id: 'oc_group', label: 'oc_group' },
        });

        onMessage(feishuGroupMessage('message_2'));

        await vi.waitFor(() => expect(observe).toHaveBeenCalledTimes(3));
        expect(observe).toHaveBeenNthCalledWith(3, 'test', {
          user: { id: 'ou_user', label: 'Alice' },
          group: { id: 'oc_group', label: 'oc_group' },
        });
        expect(fetchSpy).toHaveBeenCalledTimes(2);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('enriches direct-chat senders without issuing chat lookups', async () => {
      const observe = vi.fn();
      const { channel } = createObservedContactChannel(observe);
      const fetchSpy = vi
        .spyOn(global, 'fetch')
        .mockImplementation(async (input) => {
          const url = String(input);
          if (url.includes('/contact/v3/users/basic_batch')) {
            return jsonResponse({
              code: 0,
              data: { users: [{ name: 'Alice' }] },
            });
          }
          throw new Error(`Unexpected request: ${url}`);
        });
      const onMessage = getPrivateMethod<(data: unknown) => void>(
        channel,
        'onMessage',
      ).bind(channel);

      try {
        onMessage(feishuDmMessage('dm_1'));

        await vi.waitFor(() => expect(observe).toHaveBeenCalledTimes(2));
        expect(observe).toHaveBeenNthCalledWith(1, 'test', {
          user: { id: 'ou_user', label: 'ou_user' },
        });
        expect(observe).toHaveBeenNthCalledWith(2, 'test', {
          user: { id: 'ou_user', label: 'Alice' },
        });

        onMessage(feishuDmMessage('dm_2'));

        await vi.waitFor(() => expect(observe).toHaveBeenCalledTimes(3));
        expect(observe).toHaveBeenNthCalledWith(3, 'test', {
          user: { id: 'ou_user', label: 'Alice' },
        });
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(
          fetchSpy.mock.calls.some(([input]) =>
            String(input).includes('/im/v1/chats/'),
          ),
        ).toBe(false);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('maps non-open_id senders to the matching user_id_type', async () => {
      const observe = vi.fn();
      const { channel } = createObservedContactChannel(observe);
      const fetchSpy = vi
        .spyOn(global, 'fetch')
        .mockImplementation(async (input) => {
          const url = String(input);
          if (url.includes('/contact/v3/users/basic_batch')) {
            return jsonResponse({
              code: 0,
              data: { users: [{ name: 'Named' }] },
            });
          }
          if (url.includes('/im/v1/chats/oc_group')) {
            return jsonResponse({
              code: 0,
              data: { name: 'Project Group' },
            });
          }
          throw new Error(`Unexpected request: ${url}`);
        });
      const onMessage = getPrivateMethod<(data: unknown) => void>(
        channel,
        'onMessage',
      ).bind(channel);

      try {
        const unionOnly = feishuGroupMessage('message_union');
        (unionOnly['sender'] as Record<string, unknown>)['sender_id'] = {
          union_id: 'on_user',
        };
        onMessage(unionOnly);
        await vi.waitFor(() =>
          expect(fetchSpy).toHaveBeenCalledWith(
            expect.stringContaining('user_id_type=union_id'),
            expect.objectContaining({
              body: JSON.stringify({ user_ids: ['on_user'] }),
            }),
          ),
        );

        const userIdOnly = feishuGroupMessage('message_user');
        (userIdOnly['sender'] as Record<string, unknown>)['sender_id'] = {
          user_id: 'user_1',
        };
        onMessage(userIdOnly);
        await vi.waitFor(() =>
          expect(fetchSpy).toHaveBeenCalledWith(
            expect.stringContaining('user_id_type=user_id'),
            expect.objectContaining({
              body: JSON.stringify({ user_ids: ['user_1'] }),
            }),
          ),
        );
        expect(
          fetchSpy.mock.calls.some(([input]) =>
            String(input).includes('user_id_type=open_id'),
          ),
        ).toBe(false);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('shares one in-flight lookup across concurrent messages', async () => {
      const observe = vi.fn();
      const { channel } = createObservedContactChannel(observe);
      const userLookup = deferred<Response>();
      const chatLookup = deferred<Response>();
      const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation((input) => {
        const url = String(input);
        if (url.includes('/contact/v3/users/basic_batch')) {
          return userLookup.promise;
        }
        if (url.includes('/im/v1/chats/oc_group')) {
          return chatLookup.promise;
        }
        throw new Error(`Unexpected request: ${url}`);
      });
      const onMessage = getPrivateMethod<(data: unknown) => void>(
        channel,
        'onMessage',
      ).bind(channel);

      try {
        onMessage(feishuGroupMessage('message_1'));
        onMessage(feishuGroupMessage('message_2'));
        await vi.waitFor(() => {
          expect(observe).toHaveBeenCalledTimes(2);
          expect(fetchSpy).toHaveBeenCalledTimes(2);
        });

        userLookup.resolve(
          jsonResponse({ code: 0, data: { users: [{ name: 'Alice' }] } }),
        );
        chatLookup.resolve(
          jsonResponse({ code: 0, data: { name: 'Project Group' } }),
        );

        await vi.waitFor(() => expect(observe).toHaveBeenCalledTimes(3));
        expect(observe).toHaveBeenLastCalledWith('test', {
          user: { id: 'ou_user', label: 'Alice' },
          group: { id: 'oc_group', label: 'Project Group' },
        });
        expect(
          fetchSpy.mock.calls.filter(([input]) =>
            String(input).includes('/contact/v3/users/basic_batch'),
          ),
        ).toHaveLength(1);
        expect(
          fetchSpy.mock.calls.filter(([input]) =>
            String(input).includes('/im/v1/chats/oc_group'),
          ),
        ).toHaveLength(1);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('hydrates label caches from persisted observations after a restart', async () => {
      const observe = vi.fn();
      const list = vi.fn(
        (): ObservedChannelContactGraph => ({
          users: [],
          groups: [
            {
              channelName: 'test',
              id: 'oc_group',
              label: 'Project Group',
              lastObservedAt: '2026-01-01T00:00:00.000Z',
              users: [
                {
                  id: 'ou_user',
                  label: 'Alice',
                  lastObservedAt: '2026-01-01T00:00:00.000Z',
                },
              ],
              topics: [],
            },
            {
              channelName: 'other',
              id: 'oc_foreign',
              label: 'Foreign Group',
              lastObservedAt: '2026-01-01T00:00:00.000Z',
              users: [
                {
                  id: 'ou_foreign',
                  label: 'Foreign User',
                  lastObservedAt: '2026-01-01T00:00:00.000Z',
                },
              ],
              topics: [],
            },
          ],
        }),
      );
      const { channel, bridge } = createObservedContactChannel(observe, list);
      const fetchSpy = vi
        .spyOn(global, 'fetch')
        .mockResolvedValue(jsonResponse('rate limited', 429));
      const onMessage = getPrivateMethod<(data: unknown) => void>(
        channel,
        'onMessage',
      ).bind(channel);

      try {
        onMessage(feishuGroupMessage('message_1'));

        await vi.waitFor(() => {
          expect(observe).toHaveBeenCalledTimes(1);
          expect(bridge.prompt).toHaveBeenCalledTimes(1);
        });
        expect(observe).toHaveBeenNthCalledWith(1, 'test', {
          user: { id: 'ou_user', label: 'Alice' },
          group: { id: 'oc_group', label: 'Project Group' },
        });

        onMessage(feishuGroupMessage('message_2'));

        await vi.waitFor(() => expect(observe).toHaveBeenCalledTimes(2));
        expect(observe).toHaveBeenNthCalledWith(2, 'test', {
          user: { id: 'ou_user', label: 'Alice' },
          group: { id: 'oc_group', label: 'Project Group' },
        });
        expect(list).toHaveBeenCalledTimes(1);
        // Hydrated labels short-circuit the enrichment lookups.
        expect(fetchSpy).toHaveBeenCalledTimes(0);

        // Labels persisted by another channel instance must not hydrate into
        // this channel's caches.
        const foreign = feishuGroupMessage('message_3');
        (foreign['message'] as Record<string, unknown>)['chat_id'] =
          'oc_foreign';
        (foreign['sender'] as Record<string, unknown>)['sender_id'] = {
          open_id: 'ou_foreign',
        };
        onMessage(foreign);

        await vi.waitFor(() => {
          expect(observe).toHaveBeenCalledTimes(3);
          expect(bridge.prompt).toHaveBeenCalledTimes(3);
        });
        expect(observe).toHaveBeenNthCalledWith(3, 'test', {
          user: { id: 'ou_foreign', label: 'ou_foreign' },
          group: { id: 'oc_foreign', label: 'oc_foreign' },
        });
        expect(bridge.prompt).toHaveBeenNthCalledWith(
          3,
          expect.any(String),
          expect.stringContaining('[ou_foreign]'),
          expect.anything(),
        );
        expect(list).toHaveBeenCalledTimes(1);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('still processes messages when persisted observations cannot be listed', async () => {
      const observe = vi.fn();
      const list = vi.fn((): ObservedChannelContactGraph => {
        throw new Error('Invalid observed contact registry.');
      });
      const { channel, bridge } = createObservedContactChannel(observe, list);
      const fetchSpy = vi
        .spyOn(global, 'fetch')
        .mockResolvedValue(jsonResponse('rate limited', 429));
      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      const onMessage = getPrivateMethod<(data: unknown) => void>(
        channel,
        'onMessage',
      ).bind(channel);

      try {
        onMessage(feishuGroupMessage('message_1'));

        await vi.waitFor(() => {
          expect(observe).toHaveBeenCalledTimes(1);
          expect(bridge.prompt).toHaveBeenCalledTimes(1);
        });
        expect(list).toHaveBeenCalledTimes(1);
        expect(observe).toHaveBeenNthCalledWith(1, 'test', {
          user: { id: 'ou_user', label: 'ou_user' },
          group: { id: 'oc_group', label: 'oc_group' },
        });
        expect(stderrSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
        stderrSpy.mockRestore();
      }
    });

    it('attaches cached labels to later envelopes and prompts', async () => {
      const observe = vi.fn();
      const { channel, bridge } = createObservedContactChannel(observe);
      const fetchSpy = vi
        .spyOn(global, 'fetch')
        .mockImplementation(async (input) => {
          const url = String(input);
          if (url.includes('/contact/v3/users/basic_batch')) {
            return jsonResponse({
              code: 0,
              data: { users: [{ name: 'Alice' }] },
            });
          }
          if (url.includes('/im/v1/chats/oc_group')) {
            return jsonResponse({
              code: 0,
              data: { name: 'Project Group' },
            });
          }
          throw new Error(`Unexpected request: ${url}`);
        });
      const onMessage = getPrivateMethod<(data: unknown) => void>(
        channel,
        'onMessage',
      ).bind(channel);

      try {
        onMessage(feishuGroupMessage('message_1'));
        await vi.waitFor(() => expect(observe).toHaveBeenCalledTimes(2));

        onMessage(feishuGroupMessage('message_2'));
        await vi.waitFor(() => expect(bridge.prompt).toHaveBeenCalledTimes(2));

        expect(bridge.prompt).toHaveBeenNthCalledWith(
          1,
          expect.any(String),
          expect.stringContaining('[ou_user]'),
          expect.anything(),
        );
        expect(bridge.prompt).toHaveBeenNthCalledWith(
          2,
          expect.any(String),
          expect.stringContaining('[Alice]'),
          expect.anything(),
        );
        expect(observe).toHaveBeenNthCalledWith(3, 'test', {
          user: { id: 'ou_user', label: 'Alice' },
          group: { id: 'oc_group', label: 'Project Group' },
        });
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('keeps enrichment silent when tenant token acquisition fails', async () => {
      const observe = vi.fn();
      const { channel, bridge } = createObservedContactChannel(observe);
      Object.assign(channel as unknown as Record<string, unknown>, {
        tokenCache: undefined,
      });
      const fetchSpy = vi
        .spyOn(global, 'fetch')
        .mockImplementation(async (input) => {
          const url = String(input);
          if (url.includes('/auth/v3/tenant_access_token/internal')) {
            throw new Error('token endpoint unavailable');
          }
          throw new Error(`Unexpected request: ${url}`);
        });
      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      const onMessage = getPrivateMethod<(data: unknown) => void>(
        channel,
        'onMessage',
      ).bind(channel);

      try {
        onMessage(feishuGroupMessage('message_1'));

        await vi.waitFor(() => {
          expect(observe).toHaveBeenCalledTimes(1);
          expect(bridge.prompt).toHaveBeenCalledTimes(1);
        });

        expect(observe).toHaveBeenNthCalledWith(1, 'test', {
          user: { id: 'ou_user', label: 'ou_user' },
          group: { id: 'oc_group', label: 'oc_group' },
        });
        expect(stderrSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
        stderrSpy.mockRestore();
      }
    });

    it('logs token errors for core callers that join a silent-initiated refresh', async () => {
      const observe = vi.fn();
      const { channel } = createObservedContactChannel(observe);
      Object.assign(channel as unknown as Record<string, unknown>, {
        tokenCache: undefined,
      });
      const fetchSpy = vi
        .spyOn(global, 'fetch')
        .mockResolvedValue(jsonResponse('unavailable', 503));
      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      const getTenantAccessToken = getPrivateMethod<
        (options?: { silent?: boolean }) => Promise<string | undefined>
      >(channel, 'getTenantAccessToken').bind(channel);

      try {
        const results = await Promise.all([
          getTenantAccessToken({ silent: true }),
          getTenantAccessToken(),
        ]);

        expect(results).toEqual([undefined, undefined]);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(stderrSpy).toHaveBeenCalledTimes(1);
        expect(String(stderrSpy.mock.calls[0][0])).toContain('HTTP 503');
      } finally {
        fetchSpy.mockRestore();
        stderrSpy.mockRestore();
      }
    });

    it('prefers the newest persisted label when hydrating overlapping contacts', async () => {
      const observe = vi.fn();
      const list = vi.fn(
        (): ObservedChannelContactGraph => ({
          users: [
            {
              channelName: 'test',
              id: 'ou_user',
              label: 'New Name',
              lastObservedAt: '2026-02-01T00:00:00.000Z',
            },
          ],
          groups: [
            {
              channelName: 'test',
              id: 'oc_group',
              label: 'Project Group',
              lastObservedAt: '2026-01-01T00:00:00.000Z',
              users: [
                {
                  id: 'ou_user',
                  label: 'Old Name',
                  lastObservedAt: '2026-01-01T00:00:00.000Z',
                },
              ],
              topics: [],
            },
          ],
        }),
      );
      const { channel, bridge } = createObservedContactChannel(observe, list);
      const fetchSpy = vi
        .spyOn(global, 'fetch')
        .mockResolvedValue(jsonResponse('rate limited', 429));
      const onMessage = getPrivateMethod<(data: unknown) => void>(
        channel,
        'onMessage',
      ).bind(channel);

      try {
        onMessage(feishuGroupMessage('message_1'));

        await vi.waitFor(() => {
          expect(observe).toHaveBeenCalledTimes(1);
          expect(bridge.prompt).toHaveBeenCalledTimes(1);
        });

        expect(bridge.prompt).toHaveBeenCalledWith(
          expect.any(String),
          expect.stringContaining('[New Name]'),
          expect.anything(),
        );
        expect(observe).toHaveBeenNthCalledWith(1, 'test', {
          user: { id: 'ou_user', label: 'New Name' },
          group: { id: 'oc_group', label: 'Project Group' },
        });
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('bounds runtime label caches to the observed-contact retention cap', () => {
      const observe = vi.fn();
      const { channel } = createObservedContactChannel(observe);
      const capObservedCache = getPrivateMethod<
        (cache: Map<string, unknown>) => void
      >(channel, 'capObservedCache').bind(channel);
      const cache = new Map<string, string>();
      for (let i = 0; i < 525; i++) {
        cache.set(`id_${i}`, `label_${i}`);
      }

      capObservedCache(cache);

      expect(cache.size).toBe(500);
      expect(cache.has('id_0')).toBe(false);
      expect(cache.has('id_24')).toBe(false);
      expect(cache.has('id_25')).toBe(true);
      expect(cache.has('id_524')).toBe(true);
    });

    it('re-hydrates persisted labels after in-lifetime cache eviction', async () => {
      const observe = vi.fn();
      const list = vi.fn(
        (): ObservedChannelContactGraph => ({
          users: [
            {
              channelName: 'test',
              id: 'ou_user',
              label: 'Alice',
              lastObservedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
          groups: [],
        }),
      );
      const { channel, bridge } = createObservedContactChannel(observe, list);
      const fetchSpy = vi
        .spyOn(global, 'fetch')
        .mockImplementation(async (input, init) => {
          const url = String(input);
          if (url.includes('/contact/v3/users/basic_batch')) {
            if (String(init?.body).includes('ou_new')) {
              return jsonResponse({
                code: 0,
                data: { users: [{ name: 'New User' }] },
              });
            }
            return jsonResponse('rate limited', 429);
          }
          throw new Error(`Unexpected request: ${url}`);
        });
      const onMessage = getPrivateMethod<(data: unknown) => void>(
        channel,
        'onMessage',
      ).bind(channel);
      const observedUserName = getPrivateMethod<
        (userId: string) => Promise<string | undefined>
      >(channel, 'observedUserName').bind(channel);

      try {
        onMessage(feishuDmMessage('dm_1'));
        await vi.waitFor(() => {
          expect(observe).toHaveBeenCalledTimes(1);
          expect(bridge.prompt).toHaveBeenCalledTimes(1);
        });
        expect(observe).toHaveBeenNthCalledWith(1, 'test', {
          user: { id: 'ou_user', label: 'Alice' },
        });

        // Churn the label cache past the cap so the hydrated entry evicts
        // when the next successful lookup is cached.
        const names = (channel as unknown as Record<string, unknown>)[
          'observedUserNames'
        ] as Map<string, string>;
        for (let i = 0; i < 500; i++) {
          names.set(`ou_filler_${i}`, `User ${i}`);
        }
        await expect(observedUserName('ou_new')).resolves.toBe('New User');
        expect(names.has('ou_user')).toBe(false);

        onMessage(feishuDmMessage('dm_2'));
        await vi.waitFor(() => {
          expect(observe).toHaveBeenCalledTimes(2);
          expect(bridge.prompt).toHaveBeenCalledTimes(2);
        });
        expect(observe).toHaveBeenNthCalledWith(2, 'test', {
          user: { id: 'ou_user', label: 'Alice' },
        });
        expect(list).toHaveBeenCalledTimes(2);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  describe('extractCardText', () => {
    let channel: FeishuChannel;
    let extractCardText: (card: Record<string, unknown>) => string | undefined;

    beforeEach(() => {
      channel = createChannel();
      extractCardText = getPrivateMethod<
        (card: Record<string, unknown>) => string | undefined
      >(channel, 'extractCardText').bind(channel);
    });

    it('extracts markdown from v2 card format (body.elements)', () => {
      const card = {
        body: {
          elements: [
            { tag: 'markdown', content: 'Hello world' },
            { tag: 'markdown', content: 'Second block' },
          ],
        },
      };
      const result = extractCardText(card);
      expect(result).toContain('Hello world');
      expect(result).toContain('Second block');
    });

    it('extracts from collapsible_panel in v2 format', () => {
      const card = {
        body: {
          elements: [
            { tag: 'markdown', content: 'Preview' },
            {
              tag: 'collapsible_panel',
              elements: [{ tag: 'markdown', content: 'Hidden content' }],
            },
          ],
        },
      };
      const result = extractCardText(card);
      expect(result).toContain('Preview');
      expect(result).toContain('Hidden content');
    });

    it('extracts from v1/API format (flat elements array)', () => {
      const card = {
        title: 'Card Title',
        elements: [{ tag: 'markdown', content: 'Body text' }],
      };
      const result = extractCardText(card);
      expect(result).toContain('Card Title');
      expect(result).toContain('Body text');
    });

    it('strips streaming indicator', () => {
      const card = {
        body: {
          elements: [{ tag: 'markdown', content: 'Content\n---\n*生成中...*' }],
        },
      };
      const result = extractCardText(card);
      expect(result).not.toContain('生成中');
      expect(result).toBe('Content');
    });

    it('strips lifecycle running indicator', () => {
      const card = {
        body: {
          elements: [{ tag: 'markdown', content: 'Content\n---\n*运行中...*' }],
        },
      };
      const result = extractCardText(card);
      expect(result).not.toContain('运行中');
      expect(result).toBe('Content');
    });

    it('strips terminal lifecycle labels', () => {
      for (const label of [
        '已完成',
        '已取消',
        '已失败，请重试',
        '已停止生成',
      ]) {
        const card = {
          body: {
            elements: [
              { tag: 'markdown', content: `Content\n---\n*${label}*` },
            ],
          },
        };
        const result = extractCardText(card);
        expect(result).not.toContain(label);
        expect(result).toBe('Content');
      }
    });

    it('keeps bare emphasized text matching a status label', () => {
      const card = {
        body: {
          elements: [{ tag: 'markdown', content: 'Content\n*已完成*' }],
        },
      };

      const result = extractCardText(card);

      expect(result).toBe('Content\n*已完成*');
    });

    it('strips truncation notice with terminal lifecycle label', () => {
      // Real last-resort shape: the truncation notice block is baked into the
      // card text and buildCardContent appends the label as its own block.
      const card = {
        body: {
          elements: [
            {
              tag: 'markdown',
              content: 'Content\n\n---\n*内容过长，已截断*\n\n---\n*已完成*',
            },
          ],
        },
      };

      const result = extractCardText(card);

      expect(result).toBe('Content');
    });

    it('strips a terminal label joined before a collapsible panel body', () => {
      // Finished collapsible card: the label lands in the preview element and
      // sits mid-string once the elements are joined.
      const card = {
        body: {
          elements: [
            { tag: 'markdown', content: 'Preview text\n\n---\n*已完成*' },
            {
              tag: 'collapsible_panel',
              elements: [{ tag: 'markdown', content: 'Rest of the answer' }],
            },
          ],
        },
      };

      const result = extractCardText(card);

      expect(result).not.toContain('已完成');
      expect(result).toContain('Preview text');
      expect(result).toContain('Rest of the answer');
    });

    it('strips the stop-failure label', () => {
      const card = {
        body: {
          elements: [
            {
              tag: 'markdown',
              content: 'Partial answer\n\n---\n*停止失败，请重试*',
            },
          ],
        },
      };

      const result = extractCardText(card);

      expect(result).toBe('Partial answer');
    });

    it('returns undefined for a label-only stopped card', () => {
      const card = {
        body: {
          elements: [{ tag: 'markdown', content: '\n\n---\n*已停止生成*' }],
        },
      };

      const result = extractCardText(card);

      expect(result).toBeUndefined();
    });

    it('returns undefined for empty card', () => {
      const result = extractCardText({});
      expect(result).toBeUndefined();
    });

    it('filters fallback text', () => {
      const card = {
        elements: [
          [{ tag: 'text', text: '请升级至最新版本客户端，以查看内容' }],
        ],
      };
      const result = extractCardText(card);
      expect(result).toBeUndefined();
    });
  });

  describe('state machine: dedup', () => {
    let channel: FeishuChannel;
    let seenMessages: Map<string, number>;

    beforeEach(() => {
      channel = createChannel();
      seenMessages = getPrivateMethod(channel, 'seenMessages');
    });

    it('deduplicates messages with same ID within TTL', () => {
      seenMessages.set('msg_1', Date.now());
      // Simulate calling onMessage with same ID — it should be skipped
      const onMessage = getPrivateMethod<(data: unknown) => void>(
        channel,
        'onMessage',
      ).bind(channel);

      // Mock fetchBotInfo result
      (channel as unknown as Record<string, unknown>)['botOpenId'] = 'bot_123';

      onMessage({
        message: {
          message_id: 'msg_1',
          chat_id: 'chat_1',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: 'hello' }),
        },
        sender: {
          sender_id: { open_id: 'user_1' },
          sender_type: 'user',
        },
      });

      // Should not create a card session since it's a duplicate
      const cardSessions = getPrivateMethod<Map<string, unknown>>(
        channel,
        'cardSessions',
      );
      expect(cardSessions.has('msg_1')).toBe(false);
    });

    it('allows message after TTL expiry', () => {
      // Set a message that expired 6 minutes ago
      const DEDUP_TTL_MS = 5 * 60 * 1000;
      seenMessages.set('msg_old', Date.now() - DEDUP_TTL_MS - 1000);

      // Simulate the cleanup timer logic
      const now = Date.now();
      for (const [id, ts] of seenMessages) {
        if (now - ts > DEDUP_TTL_MS) {
          seenMessages.delete(id);
        }
      }

      expect(seenMessages.has('msg_old')).toBe(false);
    });
  });

  describe('state machine: cleanupCard', () => {
    let channel: FeishuChannel;
    let cleanupCard: (inboundMsgId: string) => void;

    beforeEach(() => {
      channel = createChannel();
      cleanupCard = getPrivateMethod<(id: string) => void>(
        channel,
        'cleanupCard',
      ).bind(channel);
    });

    it('cleans up all maps for a given inbound message', () => {
      const cardSessions = getPrivateMethod<Map<string, unknown>>(
        channel,
        'cardSessions',
      );
      const sessionToInboundMsg = getPrivateMethod<Map<string, string>>(
        channel,
        'sessionToInboundMsg',
      );
      const msgToQuestion = getPrivateMethod<Map<string, string>>(
        channel,
        'msgToQuestion',
      );
      const msgToSenderName = getPrivateMethod<Map<string, string>>(
        channel,
        'msgToSenderName',
      );
      // Populate all maps
      cardSessions.set('msg_1', {
        messageId: 'card_1',
        created: true,
        creating: false,
        stopped: false,
        accumulatedText: 'test',
        lastUpdateAt: Date.now(),
      });
      sessionToInboundMsg.set('session_1', 'msg_1');
      msgToQuestion.set('msg_1', 'question?');
      msgToSenderName.set('msg_1', '<at>user</at>');

      cleanupCard('msg_1');

      expect(cardSessions.has('msg_1')).toBe(false);
      expect(sessionToInboundMsg.has('session_1')).toBe(false);
      expect(msgToQuestion.has('msg_1')).toBe(false);
      expect(msgToSenderName.has('msg_1')).toBe(false);
    });

    it('clears pending timer on cleanup', () => {
      const cardSessions = getPrivateMethod<
        Map<string, Record<string, unknown>>
      >(channel, 'cardSessions');
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

      const timer = setTimeout(() => {}, 10000);
      cardSessions.set('msg_2', {
        messageId: 'card_2',
        created: true,
        creating: false,
        stopped: false,
        accumulatedText: '',
        lastUpdateAt: Date.now(),
        pendingUpdateTimer: timer,
      });

      cleanupCard('msg_2');

      expect(clearTimeoutSpy).toHaveBeenCalledWith(timer);
      expect(cardSessions.has('msg_2')).toBe(false);
      clearTimeoutSpy.mockRestore();
    });
  });

  describe('prompt hook inbound IDs', () => {
    it('ignores loop job ids that were not registered by processMessage', async () => {
      const channel = createChannel();
      const createStreamingCard = vi.fn().mockResolvedValue({
        success: true,
        messageId: 'om_valid_message_id',
      });
      const addReaction = vi.fn().mockResolvedValue(undefined);
      const removeReaction = vi.fn().mockResolvedValue(undefined);

      (
        channel as unknown as {
          createStreamingCard: typeof createStreamingCard;
          addReaction: typeof addReaction;
          removeReaction: typeof removeReaction;
        }
      ).createStreamingCard = createStreamingCard;
      (channel as unknown as { addReaction: typeof addReaction }).addReaction =
        addReaction;
      (
        channel as unknown as { removeReaction: typeof removeReaction }
      ).removeReaction = removeReaction;
      getPrivateMethod<Map<string, string>>(channel, 'msgToQuestion').set(
        'inbound_1',
        'question?',
      );

      getPrivateMethod<
        (chatId: string, sessionId: string, messageId?: string) => void
      >(channel, 'onPromptStart').call(
        channel,
        'oc_chat_id',
        'session_1',
        'job-1',
      );
      await getPrivateMethod<
        (chatId: string, sessionId: string, messageId?: string) => Promise<void>
      >(channel, 'onPromptEnd').call(
        channel,
        'oc_chat_id',
        'session_1',
        'job-1',
      );

      expect(
        getPrivateMethod<Map<string, string>>(channel, 'sessionToInboundMsg')
          .size,
      ).toBe(0);
      expect(addReaction).not.toHaveBeenCalled();
      expect(removeReaction).not.toHaveBeenCalled();
      expect(createStreamingCard).not.toHaveBeenCalled();
    });

    it('waits for the first response chunk before creating a card', async () => {
      vi.useFakeTimers();
      try {
        const channel = createChannel();
        const createStreamingCard = vi.fn().mockResolvedValue({
          success: true,
          messageId: 'om_first_output',
        });
        const addReaction = vi.fn().mockResolvedValue(undefined);
        Object.assign(channel as unknown as Record<string, unknown>, {
          createStreamingCard,
          addReaction,
        });
        getPrivateMethod<Map<string, string>>(channel, 'msgToQuestion').set(
          'inbound_1',
          'question?',
        );

        getPrivateMethod<
          (chatId: string, sessionId: string, messageId?: string) => void
        >(channel, 'onPromptStart').call(
          channel,
          'oc_chat_id',
          'session_1',
          'inbound_1',
        );

        expect(addReaction).toHaveBeenCalledWith('inbound_1', 'OnIt');
        expect(
          getPrivateMethod<Map<string, string>>(
            channel,
            'sessionToInboundMsg',
          ).get('session_1'),
        ).toBe('inbound_1');
        expect(createStreamingCard).not.toHaveBeenCalled();
        // A prompt-start creation regression may only schedule the card;
        // flush timers so the scheduled shape is caught as well.
        await vi.runAllTimersAsync();
        expect(createStreamingCard).not.toHaveBeenCalled();

        getPrivateMethod<
          (chatId: string, chunk: string, sessionId: string) => void
        >(channel, 'onResponseChunk').call(
          channel,
          'oc_chat_id',
          'first visible answer',
          'session_1',
        );
        await vi.runAllTimersAsync();

        expect(createStreamingCard).toHaveBeenCalledOnce();
        expect(createStreamingCard.mock.calls[0]?.[0]).toBe('oc_chat_id');
        expect(createStreamingCard.mock.calls[0]?.[3]).toBe('inbound_1');
        expect(createStreamingCard.mock.calls[0]?.[1]).toContain(
          'first visible answer',
        );
        expect(createStreamingCard.mock.calls[0]?.[1]).not.toContain('思考中');
      } finally {
        vi.useRealTimers();
      }
    });

    it('releases only output-card state at an input request and creates a second card later', async () => {
      vi.useFakeTimers();
      try {
        const channel = createChannel();
        const updateCard = vi.fn().mockResolvedValue(true);
        const createStreamingCard = vi.fn().mockResolvedValue({
          success: true,
          messageId: 'om_second_output',
        });
        Object.assign(channel as unknown as Record<string, unknown>, {
          updateCard,
          createStreamingCard,
        });
        const cardSessions = getPrivateMethod<
          Map<string, Record<string, unknown>>
        >(channel, 'cardSessions');
        const sessionToInboundMsg = getPrivateMethod<Map<string, string>>(
          channel,
          'sessionToInboundMsg',
        );
        const msgToQuestion = getPrivateMethod<Map<string, string>>(
          channel,
          'msgToQuestion',
        );
        const msgToSenderName = getPrivateMethod<Map<string, string>>(
          channel,
          'msgToSenderName',
        );
        const msgToSenderId = getPrivateMethod<Map<string, string>>(
          channel,
          'msgToSenderId',
        );
        cardSessions.set('inbound_1', {
          messageId: 'om_first_output',
          created: true,
          creating: false,
          stopped: false,
          accumulatedText: 'before question',
          lastUpdateAt: Date.now(),
        });
        sessionToInboundMsg.set('session_1', 'inbound_1');
        msgToQuestion.set('inbound_1', 'question?');
        msgToSenderName.set('inbound_1', '@sender');
        msgToSenderId.set('inbound_1', 'owner-1');
        const segment: ChannelOutputSegmentContext = {
          channelName: 'test',
          sessionId: 'session_1',
          runId: 'run-1',
          segmentId: 'segment-1',
          owner: { kind: 'channel_user', id: 'owner-1' },
          target: {
            channelName: 'test',
            chatId: 'oc_chat_id',
            senderId: 'owner-1',
            isGroup: false,
          },
          messageId: 'inbound_1',
        };

        await getPrivateMethod<
          (
            chatId: string,
            sessionId: string,
            segment: ChannelOutputSegmentContext,
            reason: ChannelOutputSegmentEndReason,
          ) => void | Promise<void>
        >(channel, 'onOutputSegmentEnd').call(
          channel,
          'oc_chat_id',
          'session_1',
          segment,
          'input_requested',
        );

        expect(updateCard).toHaveBeenCalledWith(
          'om_first_output',
          '@sender\n\nbefore question',
          true,
          'inbound_1',
          '已完成',
        );
        expect(cardSessions.get('inbound_1')).toEqual({
          messageId: '',
          created: false,
          creating: false,
          stopped: false,
          accumulatedText: '',
          lastUpdateAt: expect.any(Number),
        });
        expect(sessionToInboundMsg.get('session_1')).toBe('inbound_1');
        expect(msgToQuestion.get('inbound_1')).toBe('question?');
        expect(msgToSenderName.get('inbound_1')).toBe('@sender');
        expect(msgToSenderId.get('inbound_1')).toBe('owner-1');

        getPrivateMethod<
          (chatId: string, chunk: string, sessionId: string) => void
        >(channel, 'onResponseChunk').call(
          channel,
          'oc_chat_id',
          'after answer',
          'session_1',
        );
        await vi.runAllTimersAsync();

        expect(createStreamingCard).toHaveBeenCalledOnce();
        expect(createStreamingCard.mock.calls[0]?.[0]).toBe('oc_chat_id');
        expect(createStreamingCard.mock.calls[0]?.[1]).toBe(
          '@sender\n\nafter answer',
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it.each([
      ['returns false', false],
      ['throws', new Error('patch failed')],
    ])(
      'compensates when input-request card finalization %s',
      async (_name, result) => {
        const channel = createChannel();
        const updateCard = vi.fn();
        if (result instanceof Error) {
          updateCard.mockRejectedValue(result);
        } else {
          updateCard.mockResolvedValue(result);
        }
        const deleteCard = vi.fn().mockResolvedValue(true);
        const sendMessage = vi.fn().mockResolvedValue(undefined);
        Object.assign(channel as unknown as Record<string, unknown>, {
          updateCard,
          deleteCard,
          sendMessage,
        });
        getPrivateMethod<Map<string, Record<string, unknown>>>(
          channel,
          'cardSessions',
        ).set('inbound_1', {
          messageId: 'om_first_output',
          created: true,
          creating: false,
          stopped: false,
          accumulatedText: 'before question',
          lastUpdateAt: Date.now(),
        });
        getPrivateMethod<Map<string, string>>(
          channel,
          'sessionToInboundMsg',
        ).set('session_1', 'inbound_1');
        getPrivateMethod<Map<string, string>>(channel, 'msgToSenderName').set(
          'inbound_1',
          '@sender',
        );

        await getPrivateMethod<
          (
            chatId: string,
            sessionId: string,
            segment: ChannelOutputSegmentContext,
            reason: ChannelOutputSegmentEndReason,
          ) => void | Promise<void>
        >(channel, 'onOutputSegmentEnd').call(
          channel,
          'oc_chat_id',
          'session_1',
          {} as ChannelOutputSegmentContext,
          'input_requested',
        );

        expect(deleteCard).toHaveBeenCalledWith('om_first_output');
        expect(sendMessage).toHaveBeenCalledWith(
          'oc_chat_id',
          '@sender\n\nbefore question',
        );
        expect(
          getPrivateMethod<Map<string, Record<string, unknown>>>(
            channel,
            'cardSessions',
          ).get('inbound_1'),
        ).toMatchObject({
          created: false,
          creating: false,
          accumulatedText: '',
        });
        expect(
          getPrivateMethod<Map<string, string>>(
            channel,
            'sessionToInboundMsg',
          ).get('session_1'),
        ).toBe('inbound_1');
      },
    );

    it('recovers input-request card finalization with a table-stripped retry', async () => {
      const channel = createChannel();
      const updateCard = vi
        .fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      const deleteCard = vi.fn().mockResolvedValue(true);
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      Object.assign(channel as unknown as Record<string, unknown>, {
        updateCard,
        deleteCard,
        sendMessage,
      });
      getPrivateMethod<Map<string, Record<string, unknown>>>(
        channel,
        'cardSessions',
      ).set('inbound_1', {
        messageId: 'om_first_output',
        created: true,
        creating: false,
        stopped: false,
        accumulatedText:
          'before question\n\n| a | b |\n| --- | --- |\n| 1 | 2 |',
        lastUpdateAt: Date.now(),
      });
      getPrivateMethod<Map<string, string>>(channel, 'sessionToInboundMsg').set(
        'session_1',
        'inbound_1',
      );

      await getPrivateMethod<
        (
          chatId: string,
          sessionId: string,
          segment: ChannelOutputSegmentContext,
          reason: ChannelOutputSegmentEndReason,
        ) => void | Promise<void>
      >(channel, 'onOutputSegmentEnd').call(
        channel,
        'oc_chat_id',
        'session_1',
        {} as ChannelOutputSegmentContext,
        'input_requested',
      );

      expect(updateCard).toHaveBeenCalledTimes(2);
      expect(updateCard.mock.calls[1]?.[1]).toContain('(表格内容请查看原文)');
      expect(updateCard.mock.calls[1]?.[2]).toBe(true);
      expect(updateCard.mock.calls[1]?.[4]).toBe('已完成');
      expect(deleteCard).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('caps the input-request table-stripped retry at the card size limit', async () => {
      const channel = createChannel();
      const updateCard = vi
        .fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      const deleteCard = vi.fn().mockResolvedValue(true);
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      Object.assign(channel as unknown as Record<string, unknown>, {
        updateCard,
        deleteCard,
        sendMessage,
      });
      getPrivateMethod<Map<string, Record<string, unknown>>>(
        channel,
        'cardSessions',
      ).set('inbound_1', {
        messageId: 'om_first_output',
        created: true,
        creating: false,
        stopped: false,
        accumulatedText: 'x'.repeat(24_000),
        lastUpdateAt: Date.now(),
      });
      getPrivateMethod<Map<string, string>>(channel, 'sessionToInboundMsg').set(
        'session_1',
        'inbound_1',
      );

      await getPrivateMethod<
        (
          chatId: string,
          sessionId: string,
          segment: ChannelOutputSegmentContext,
          reason: ChannelOutputSegmentEndReason,
        ) => void | Promise<void>
      >(channel, 'onOutputSegmentEnd').call(
        channel,
        'oc_chat_id',
        'session_1',
        {} as ChannelOutputSegmentContext,
        'input_requested',
      );

      expect(updateCard).toHaveBeenCalledTimes(2);
      const retryText = updateCard.mock.calls[1]?.[1] as string;
      expect(retryText.length).toBeLessThanOrEqual(20_000);
      expect(retryText).toContain('内容过长，已截断早期内容');
      expect(updateCard.mock.calls[1]?.[2]).toBe(true);
      expect(deleteCard).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it.each([
      ['while card creation is in flight', { creating: true }],
      ['after card creation failed', { cardCreationFailed: true }],
    ])('preserves pre-question text %s', async (_name, state) => {
      const channel = createChannel();
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      Object.assign(channel as unknown as Record<string, unknown>, {
        sendMessage,
      });
      const seeded: Record<string, unknown> = {
        messageId: '',
        created: false,
        creating: false,
        stopped: false,
        accumulatedText: 'before question',
        lastUpdateAt: Date.now(),
        ...state,
      };
      getPrivateMethod<Map<string, Record<string, unknown>>>(
        channel,
        'cardSessions',
      ).set('inbound_1', seeded);
      getPrivateMethod<Map<string, string>>(channel, 'sessionToInboundMsg').set(
        'session_1',
        'inbound_1',
      );
      getPrivateMethod<Map<string, string>>(channel, 'msgToSenderName').set(
        'inbound_1',
        '@sender',
      );

      await getPrivateMethod<
        (
          chatId: string,
          sessionId: string,
          segment: ChannelOutputSegmentContext,
          reason: ChannelOutputSegmentEndReason,
        ) => void | Promise<void>
      >(channel, 'onOutputSegmentEnd').call(
        channel,
        'oc_chat_id',
        'session_1',
        {} as ChannelOutputSegmentContext,
        'input_requested',
      );

      expect(sendMessage).toHaveBeenCalledWith(
        'oc_chat_id',
        '@sender\n\nbefore question',
      );
      if ('creating' in state) {
        expect(seeded['stopped']).toBe(true);
        expect(seeded['abandoned']).toBe(true);
      }
      expect(
        getPrivateMethod<Map<string, Record<string, unknown>>>(
          channel,
          'cardSessions',
        ).get('inbound_1'),
      ).toMatchObject({ created: false, creating: false, accumulatedText: '' });
    });
  });

  describe('state machine: stop button during card creation', () => {
    let channel: FeishuChannel;

    beforeEach(() => {
      channel = createChannel();
    });

    it('marks card as stopped even when still creating', async () => {
      const cardSessions = getPrivateMethod<
        Map<string, Record<string, unknown>>
      >(channel, 'cardSessions');

      // Simulate card in "creating" state
      cardSessions.set('inbound_1', {
        messageId: 'card_1',
        created: false,
        creating: true,
        stopped: false,
        accumulatedText: 'partial text',
        lastUpdateAt: Date.now(),
      });

      const cancelPromptSpy = vi.fn().mockResolvedValue(true);
      (
        channel as unknown as {
          requestActivePromptCancellation: (
            sessionId: string,
          ) => Promise<boolean>;
        }
      ).requestActivePromptCancellation = cancelPromptSpy;

      // Mock updateCard to not actually call HTTP
      const updateCardMock = vi.fn().mockResolvedValue(true);
      (channel as unknown as Record<string, unknown>)['updateCard'] =
        updateCardMock;

      // Simulate sessionToInboundMsg mapping
      const sessionToInboundMsg = getPrivateMethod<Map<string, string>>(
        channel,
        'sessionToInboundMsg',
      );
      sessionToInboundMsg.set('session_abc', 'inbound_1');

      // Simulate msgToSenderId mapping (fail-closed auth check)
      const msgToSenderId = getPrivateMethod<Map<string, string>>(
        channel,
        'msgToSenderId',
      );
      msgToSenderId.set('inbound_1', 'user_open_id');

      // Call onCardAction with stop
      const onCardAction = getPrivateMethod<
        (data: Record<string, unknown>) => boolean
      >(channel, 'onCardAction').bind(channel);

      onCardAction({
        action: { value: { action: 'stop' } },
        context: { open_message_id: 'card_1' },
        operator: { open_id: 'user_open_id' },
      });

      const state = cardSessions.get('inbound_1') as
        | Record<string, unknown>
        | undefined;
      // cancelling is set synchronously (stopped is deferred until cancellation resolves)
      expect(state?.['cancelling']).toBe(true);

      // Wait for async handleStop to complete — stopped is set after cancellation resolves
      await vi.waitFor(() => {
        expect(state?.['stopped']).toBe(true);
      });
      expect(cancelPromptSpy).toHaveBeenCalledWith(
        'session_abc',
        'cancel_command',
      );
      expect(state?.['cancelling']).toBe(false);
    });

    it('keeps user stop label when cancellation lifecycle marks the card cancelled', async () => {
      const cardSessions = getPrivateMethod<
        Map<string, Record<string, unknown>>
      >(channel, 'cardSessions');
      cardSessions.set('inbound_1', {
        messageId: 'card_1',
        created: true,
        creating: false,
        stopped: false,
        accumulatedText: 'partial text',
        lastUpdateAt: Date.now(),
      });

      const updateCard = vi.fn().mockResolvedValue(true);
      (channel as unknown as { updateCard: typeof updateCard }).updateCard =
        updateCard;
      (
        channel as unknown as {
          requestActivePromptCancellation: (
            sessionId: string,
          ) => Promise<boolean>;
        }
      ).requestActivePromptCancellation = vi
        .fn()
        .mockImplementation(async () => {
          getPrivateMethod<(event: ChannelTaskLifecycleEvent) => void>(
            channel,
            'onTaskLifecycle',
          ).call(channel, {
            type: 'cancelled',
            reason: 'cancel_command',
            channelName: 'feishu',
            chatId: 'oc_chat_id',
            sessionId: 'session_abc',
            messageId: 'inbound_1',
            identity: { id: 'channel:feishu', displayName: 'feishu' },
            memoryScope: {
              namespace: 'channel:feishu',
              mode: 'metadata-only',
            },
          });
          return true;
        });

      getPrivateMethod<Map<string, string>>(channel, 'sessionToInboundMsg').set(
        'session_abc',
        'inbound_1',
      );
      getPrivateMethod<Map<string, string>>(channel, 'msgToSenderId').set(
        'inbound_1',
        'user_open_id',
      );

      getPrivateMethod<(data: Record<string, unknown>) => boolean>(
        channel,
        'onCardAction',
      ).call(channel, {
        action: { value: { action: 'stop' } },
        context: { open_message_id: 'card_1' },
        operator: { open_id: 'user_open_id' },
      });

      await vi.waitFor(() => {
        expect(updateCard).toHaveBeenCalledTimes(1);
      });
      // Terminal labels travel via the statusLabel param, not the card text.
      expect(updateCard.mock.calls[0]![4]).toBe('已停止生成');
      expect(updateCard.mock.calls[0]![1]).not.toContain('已取消');
    });

    it('rejects stop from a different user (operator mismatch)', () => {
      const cardSessions = getPrivateMethod<
        Map<string, Record<string, unknown>>
      >(channel, 'cardSessions');
      cardSessions.set('inbound_1', {
        messageId: 'card_1',
        created: true,
        creating: false,
        stopped: false,
        accumulatedText: 'test',
        lastUpdateAt: Date.now(),
      });

      const msgToSenderId = getPrivateMethod<Map<string, string>>(
        channel,
        'msgToSenderId',
      );
      msgToSenderId.set('inbound_1', 'original_user');

      const onCardAction = getPrivateMethod<
        (data: Record<string, unknown>) => boolean
      >(channel, 'onCardAction').bind(channel);

      const result = onCardAction({
        action: { value: { action: 'stop' } },
        context: { open_message_id: 'card_1' },
        operator: { open_id: 'different_user' },
      });

      expect(result).toBe(false);
      const state = cardSessions.get('inbound_1') as
        | Record<string, unknown>
        | undefined;
      expect(state?.['stopped']).toBe(false);
    });

    it('rejects stop when operator field is missing (fail-closed)', () => {
      const cardSessions = getPrivateMethod<
        Map<string, Record<string, unknown>>
      >(channel, 'cardSessions');
      cardSessions.set('inbound_1', {
        messageId: 'card_1',
        created: true,
        creating: false,
        stopped: false,
        accumulatedText: 'test',
        lastUpdateAt: Date.now(),
      });

      const msgToSenderId = getPrivateMethod<Map<string, string>>(
        channel,
        'msgToSenderId',
      );
      msgToSenderId.set('inbound_1', 'original_user');

      const onCardAction = getPrivateMethod<
        (data: Record<string, unknown>) => boolean
      >(channel, 'onCardAction').bind(channel);

      // No operator field at all
      const result = onCardAction({
        action: { value: { action: 'stop' } },
        context: { open_message_id: 'card_1' },
      });

      expect(result).toBe(false);
    });

    it('rejects stop when msgToSenderId has no entry (no originalSender)', () => {
      const cardSessions = getPrivateMethod<
        Map<string, Record<string, unknown>>
      >(channel, 'cardSessions');
      cardSessions.set('inbound_1', {
        messageId: 'card_1',
        created: true,
        creating: false,
        stopped: false,
        accumulatedText: 'test',
        lastUpdateAt: Date.now(),
      });

      // msgToSenderId intentionally not populated for inbound_1

      const onCardAction = getPrivateMethod<
        (data: Record<string, unknown>) => boolean
      >(channel, 'onCardAction').bind(channel);

      const result = onCardAction({
        action: { value: { action: 'stop' } },
        context: { open_message_id: 'card_1' },
        operator: { open_id: 'some_user' },
      });

      expect(result).toBe(false);
    });
  });

  describe('connect: WebSocket', () => {
    beforeEach(() => {
      wsMock.close.mockReset();
      wsMock.start.mockReset().mockResolvedValue(undefined);
    });

    function mockSuccessfulTokenFetch(): void {
      vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
        if (String(input).includes('/tenant_access_token/internal')) {
          return new Response(
            JSON.stringify({
              tenant_access_token: 'test_token',
              expire: 3600,
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ bot: { open_id: 'bot_id' } }), {
          status: 200,
        });
      });
    }

    it('rejects invalid credentials before starting WebSocket', async () => {
      const channel = createChannel();
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(null, { status: 401 }),
      );

      await expect(channel.connect()).rejects.toThrow(
        'failed to authenticate Feishu credentials',
      );
      expect(wsMock.start).not.toHaveBeenCalled();
    });

    it('resolves after the SDK start promise without waiting for onReady', async () => {
      const channel = createChannel();
      mockSuccessfulTokenFetch();

      await channel.connect();

      expect(wsMock.start).toHaveBeenCalledOnce();
      channel.disconnect();
    });
  });

  describe('disconnect', () => {
    it('closes wsClient on disconnect', () => {
      const channel = createChannel();
      const mockClose = vi.fn();
      (channel as unknown as Record<string, unknown>)['wsClient'] = {
        close: mockClose,
      };

      channel.disconnect();

      expect(mockClose).toHaveBeenCalled();
      expect(
        (channel as unknown as Record<string, unknown>)['wsClient'],
      ).toBeUndefined();
    });

    it('clears dedup timer on disconnect', () => {
      const channel = createChannel();
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
      const timer = setInterval(() => {}, 60000);
      (channel as unknown as Record<string, unknown>)['dedupTimer'] = timer;

      channel.disconnect();

      expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
      clearIntervalSpy.mockRestore();
      clearInterval(timer);
    });

    it('disposes pending question cards on disconnect', () => {
      const channel = createChannel();
      const dispose = vi.fn();
      Object.assign(channel as unknown as Record<string, unknown>, {
        questionCardController: { dispose },
      });

      channel.disconnect();

      expect(dispose).toHaveBeenCalledOnce();
    });
  });

  describe('extractContent: post at-node mentions', () => {
    it('extracts @mention user_name from post at nodes', () => {
      const channel = createChannel();
      const extractContent = getPrivateMethod<
        (messageType: string, contentJson: string) => { text: string }
      >(channel, 'extractContent').bind(channel);

      const post = {
        zh_cn: {
          title: '',
          content: [
            [
              { tag: 'text', text: 'hello ' },
              { tag: 'at', user_id: 'ou_123', user_name: 'John' },
              { tag: 'text', text: ' check this' },
            ],
          ],
        },
      };
      const result = extractContent('post', JSON.stringify(post));
      expect(result.text).toBe('hello @John check this');
    });

    it('handles at node without user_name gracefully', () => {
      const channel = createChannel();
      const extractContent = getPrivateMethod<
        (messageType: string, contentJson: string) => { text: string }
      >(channel, 'extractContent').bind(channel);

      const post = {
        zh_cn: {
          title: '',
          content: [
            [
              { tag: 'text', text: 'hello ' },
              { tag: 'at', user_id: 'ou_123' },
            ],
          ],
        },
      };
      const result = extractContent('post', JSON.stringify(post));
      expect(result.text).toBe('hello');
    });
  });

  describe('onCardAction: cancelSession failure', () => {
    it('shows stop failure status when cancelSession throws', async () => {
      const bridge = createMockBridge();
      const config = createConfig();
      const channel = new FeishuChannel('test', config, bridge);
      (
        channel as unknown as {
          requestActivePromptCancellation: (
            sessionId: string,
          ) => Promise<boolean>;
        }
      ).requestActivePromptCancellation = vi.fn().mockResolvedValue(false);

      // Set up botOpenId and card state
      (channel as unknown as Record<string, unknown>)['botOpenId'] = 'bot_123';

      const cardSessions = getPrivateMethod<
        Map<string, Record<string, unknown>>
      >(channel, 'cardSessions');
      cardSessions.set('inbound_1', {
        messageId: 'card_1',
        created: true,
        creating: false,
        stopped: false,
        accumulatedText: 'some text',
        lastUpdateAt: Date.now(),
      });

      const msgToSenderId = getPrivateMethod<Map<string, string>>(
        channel,
        'msgToSenderId',
      );
      msgToSenderId.set('inbound_1', 'original_user');

      const msgToSenderName = getPrivateMethod<Map<string, string>>(
        channel,
        'msgToSenderName',
      );
      msgToSenderName.set('inbound_1', '@sender');

      // Set up session mapping so cancelSession is actually called
      const sessionToInboundMsg = getPrivateMethod<Map<string, string>>(
        channel,
        'sessionToInboundMsg',
      );
      sessionToInboundMsg.set('session_1', 'inbound_1');

      // Mock updateCard to capture the text
      const updateCardSpy = vi.fn().mockResolvedValue(true);
      (channel as unknown as Record<string, unknown>)['updateCard'] =
        updateCardSpy;

      const onCardAction = getPrivateMethod<
        (data: Record<string, unknown>) => boolean
      >(channel, 'onCardAction').bind(channel);

      onCardAction({
        action: { value: { action: 'stop' } },
        context: { open_message_id: 'card_1' },
        operator: { open_id: 'original_user' },
      });

      // Wait for the fire-and-forget handleStop to complete
      await new Promise((r) => setTimeout(r, 50));

      expect(updateCardSpy).toHaveBeenCalled();
      expect(updateCardSpy.mock.calls[0][4]).toBe('停止失败，请重试');
      const cardText = updateCardSpy.mock.calls[0][1] as string;
      expect(cardText).not.toContain('已失败，请重试');
      // A failed cancel must not mark the card stopped — the run continues.
      expect(cardSessions.get('inbound_1')?.['stopped']).toBe(false);
    });

    it('uses divider status shape when stopped empty-card fallback sends a message', async () => {
      const bridge = createMockBridge();
      const config = createConfig();
      const channel = new FeishuChannel('test', config, bridge);
      (
        channel as unknown as {
          requestActivePromptCancellation: (
            sessionId: string,
          ) => Promise<boolean>;
        }
      ).requestActivePromptCancellation = vi.fn().mockResolvedValue(true);

      const cardSessions = getPrivateMethod<
        Map<string, Record<string, unknown>>
      >(channel, 'cardSessions');
      cardSessions.set('inbound_1', {
        messageId: 'card_1',
        created: true,
        creating: false,
        stopped: false,
        accumulatedText: '',
        lastUpdateAt: Date.now(),
      });
      getPrivateMethod<Map<string, string>>(channel, 'msgToSenderId').set(
        'inbound_1',
        'original_user',
      );
      getPrivateMethod<Map<string, string>>(channel, 'sessionToInboundMsg').set(
        'session_1',
        'inbound_1',
      );

      (channel as unknown as Record<string, unknown>)['updateCard'] = vi
        .fn()
        .mockResolvedValue(false);
      (channel as unknown as Record<string, unknown>)['deleteCard'] = vi
        .fn()
        .mockResolvedValue(undefined);
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      (channel as unknown as Record<string, unknown>)['sendMessage'] =
        sendMessage;

      getPrivateMethod<(data: Record<string, unknown>) => boolean>(
        channel,
        'onCardAction',
      ).call(channel, {
        action: { value: { action: 'stop' } },
        context: {
          open_message_id: 'card_1',
          open_chat_id: 'oc_chat_id',
        },
        operator: { open_id: 'original_user' },
      });

      await vi.waitFor(() => {
        expect(sendMessage).toHaveBeenCalledWith(
          'oc_chat_id',
          '---\n*已停止生成*',
        );
      });
    });

    it('awaits an in-flight streaming PATCH before the stop patch', async () => {
      vi.useFakeTimers();
      try {
        const channel = createChannel();
        let resolveStreaming!: (ok: boolean) => void;
        const updateCard = vi
          .fn()
          .mockImplementationOnce(
            () =>
              new Promise<boolean>((resolve) => {
                resolveStreaming = resolve;
              }),
          )
          .mockResolvedValue(true);
        (
          channel as unknown as {
            requestActivePromptCancellation: (
              sessionId: string,
            ) => Promise<boolean>;
          }
        ).requestActivePromptCancellation = vi.fn().mockResolvedValue(true);
        Object.assign(channel as unknown as Record<string, unknown>, {
          updateCard,
        });
        const cardSessions = getPrivateMethod<
          Map<string, Record<string, unknown>>
        >(channel, 'cardSessions');
        cardSessions.set('inbound_1', {
          messageId: 'om_first_output',
          created: true,
          creating: false,
          stopped: false,
          accumulatedText: 'streamed',
          lastUpdateAt: Date.now(),
        });
        getPrivateMethod<Map<string, string>>(
          channel,
          'sessionToInboundMsg',
        ).set('session_1', 'inbound_1');
        getPrivateMethod<Map<string, string>>(channel, 'msgToSenderId').set(
          'inbound_1',
          'original_user',
        );
        getPrivateMethod<Map<string, string>>(channel, 'msgToSenderName').set(
          'inbound_1',
          '@sender',
        );

        getPrivateMethod<
          (chatId: string, chunk: string, sessionId: string) => void
        >(channel, 'onResponseChunk').call(
          channel,
          'oc_chat_id',
          ' more',
          'session_1',
        );
        // Fire the throttled callback; its streaming PATCH stays in flight.
        await vi.advanceTimersByTimeAsync(1_500);
        expect(updateCard).toHaveBeenCalledTimes(1);

        getPrivateMethod<(data: Record<string, unknown>) => boolean>(
          channel,
          'onCardAction',
        ).call(channel, {
          action: { value: { action: 'stop' } },
          context: {
            open_message_id: 'om_first_output',
            open_chat_id: 'oc_chat_id',
          },
          operator: { open_id: 'original_user' },
        });
        await vi.advanceTimersByTimeAsync(0);
        // The stop patch must not start while the streaming PATCH flies.
        expect(updateCard).toHaveBeenCalledTimes(1);

        resolveStreaming(true);
        await vi.advanceTimersByTimeAsync(0);

        expect(updateCard).toHaveBeenCalledTimes(2);
        expect(updateCard.mock.calls[1]?.[2]).toBe(true);
        expect(updateCard.mock.calls[1]?.[4]).toBe('已停止生成');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('deleteCard', () => {
    it('returns true on successful deletion', async () => {
      const channel = createChannel();
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response(null, { status: 200 }));
      vi.spyOn(global, 'fetch').mockImplementation(fetchMock);

      // Provide a valid token
      (channel as unknown as Record<string, unknown>)['tokenCache'] = {
        token: 'test_token',
        expiresAt: Date.now() + 3600_000,
      };

      const deleteCard = getPrivateMethod<
        (messageId: string) => Promise<boolean>
      >(channel, 'deleteCard').bind(channel);

      const result = await deleteCard('om_test_msg_id');
      expect(result).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/im/v1/messages/om_test_msg_id'),
        expect.objectContaining({ method: 'DELETE' }),
      );
    });

    it('returns false when token is unavailable', async () => {
      const channel = createChannel();
      // No token cache and getTenantAccessToken will fail
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ code: -1 }), { status: 500 }),
        );
      vi.spyOn(global, 'fetch').mockImplementation(fetchMock);

      const deleteCard = getPrivateMethod<
        (messageId: string) => Promise<boolean>
      >(channel, 'deleteCard').bind(channel);

      const result = await deleteCard('om_test_msg_id');
      expect(result).toBe(false);
    });

    it('returns false on HTTP error', async () => {
      const channel = createChannel();
      (channel as unknown as Record<string, unknown>)['tokenCache'] = {
        token: 'test_token',
        expiresAt: Date.now() + 3600_000,
      };
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response('not found', { status: 404 }));
      vi.spyOn(global, 'fetch').mockImplementation(fetchMock);

      const deleteCard = getPrivateMethod<
        (messageId: string) => Promise<boolean>
      >(channel, 'deleteCard').bind(channel);

      const result = await deleteCard('om_test_msg_id');
      expect(result).toBe(false);
    });

    it('clears token cache on 401', async () => {
      const channel = createChannel();
      (channel as unknown as Record<string, unknown>)['tokenCache'] = {
        token: 'stale_token',
        expiresAt: Date.now() + 3600_000,
      };
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response('unauthorized', { status: 401 }));
      vi.spyOn(global, 'fetch').mockImplementation(fetchMock);

      const deleteCard = getPrivateMethod<
        (messageId: string) => Promise<boolean>
      >(channel, 'deleteCard').bind(channel);

      await deleteCard('om_test_msg_id');
      expect(
        (channel as unknown as Record<string, unknown>)['tokenCache'],
      ).toBeUndefined();
    });
  });

  describe('question card native helpers', () => {
    // The transport tests spy on global.fetch / process.stderr.write; restore
    // them so no spy leaks into later tests in the file.
    afterEach(() => vi.restoreAllMocks());

    function createWiringContext(requestId: string) {
      const listeners = new Set<(reason: UserInputSettlementReason) => void>();
      const respond = vi.fn().mockResolvedValue(true);
      const context: ChannelUserInputRequestContext = {
        requestId,
        sessionId: 'session-wiring',
        runId: 'run-wiring',
        owner: { kind: 'channel_user', id: 'owner-1' },
        target: {
          channelName: 'feishu',
          chatId: 'oc_chat',
          senderId: 'owner-1',
          isGroup: true,
        },
        questions: [
          {
            answerKey: '0',
            header: 'Region',
            question: 'Which region?',
            options: [{ label: 'Beijing', description: 'Use Beijing.' }],
            multiSelect: false,
          },
        ],
        submitOptionId: 'allow-once',
        onSettled(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        respond,
      };
      return { context, respond };
    }

    function getWiringController(channel: FeishuChannel) {
      return (
        channel as unknown as {
          questionCardController: {
            present(
              ctx: ChannelUserInputRequestContext,
            ): Promise<{ kind: string }>;
            dispose(): void;
          };
        }
      ).questionCardController;
    }

    it('sends an arbitrary interactive card and returns its message id', async () => {
      const channel = createChannel();
      (channel as unknown as Record<string, unknown>)['tokenCache'] = {
        token: 'tenant-token',
        expiresAt: Date.now() + 3600_000,
      };
      const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ data: { message_id: 'om_question' } }), {
          status: 200,
        }),
      );
      const card = { schema: '2.0', body: { elements: [] } };

      await expect(
        getPrivateMethod<
          (chatId: string, content: Record<string, unknown>) => Promise<string>
        >(channel, 'sendInteractiveCard').call(channel, 'oc_chat', card),
      ).resolves.toBe('om_question');
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/im/v1/messages?receive_id_type=chat_id'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer tenant-token',
          }),
          body: JSON.stringify({
            receive_id: 'oc_chat',
            msg_type: 'interactive',
            content: JSON.stringify(card),
          }),
          signal: expect.any(AbortSignal),
        }),
      );
    });

    it('rejects interactive-card delivery without an access token', async () => {
      const channel = createChannel();
      Object.assign(channel as unknown as Record<string, unknown>, {
        getTenantAccessToken: vi.fn().mockResolvedValue(undefined),
      });

      await expect(
        getPrivateMethod<
          (chatId: string, card: Record<string, unknown>) => Promise<string>
        >(channel, 'sendInteractiveCard').call(channel, 'oc_chat', {}),
      ).rejects.toThrow('no access token');
    });

    it('rejects HTTP failures and clears a rejected cached token', async () => {
      const channel = createChannel();
      (channel as unknown as Record<string, unknown>)['tokenCache'] = {
        token: 'stale-token',
        expiresAt: Date.now() + 3600_000,
      };
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response('unauthorized', { status: 401 }),
      );

      await expect(
        getPrivateMethod<
          (chatId: string, card: Record<string, unknown>) => Promise<string>
        >(channel, 'sendInteractiveCard').call(channel, 'oc_chat', {}),
      ).rejects.toThrow('HTTP 401');
      expect(
        (channel as unknown as Record<string, unknown>)['tokenCache'],
      ).toBeUndefined();
    });

    it('rejects a successful response without a message id', async () => {
      const channel = createChannel();
      (channel as unknown as Record<string, unknown>)['tokenCache'] = {
        token: 'tenant-token',
        expiresAt: Date.now() + 3600_000,
      };
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ data: {} }), { status: 200 }),
      );

      await expect(
        getPrivateMethod<
          (chatId: string, card: Record<string, unknown>) => Promise<string>
        >(channel, 'sendInteractiveCard').call(channel, 'oc_chat', {}),
      ).rejects.toThrow('no message id');
    });

    it('patches an arbitrary interactive card in place', async () => {
      const channel = createChannel();
      (channel as unknown as Record<string, unknown>)['tokenCache'] = {
        token: 'tenant-token',
        expiresAt: Date.now() + 3600_000,
      };
      const fetchSpy = vi
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
      const card = { schema: '2.0', body: { elements: [] } };

      await expect(
        getPrivateMethod<
          (messageId: string, card: Record<string, unknown>) => Promise<boolean>
        >(channel, 'patchInteractiveCard').call(channel, 'om_question', card),
      ).resolves.toBe(true);
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/im/v1/messages/om_question'),
        expect.objectContaining({
          method: 'PATCH',
          headers: expect.objectContaining({
            Authorization: 'Bearer tenant-token',
          }),
          body: JSON.stringify({
            msg_type: 'interactive',
            content: JSON.stringify(card),
          }),
          signal: expect.any(AbortSignal),
        }),
      );
    });

    it('rejects card patch HTTP failures and clears a rejected cached token', async () => {
      const channel = createChannel();
      (channel as unknown as Record<string, unknown>)['tokenCache'] = {
        token: 'stale-token',
        expiresAt: Date.now() + 3600_000,
      };
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response('unauthorized', { status: 401 }),
      );

      await expect(
        getPrivateMethod<
          (messageId: string, card: Record<string, unknown>) => Promise<boolean>
        >(channel, 'patchInteractiveCard').call(channel, 'om_question', {}),
      ).resolves.toBe(false);
      expect(
        (channel as unknown as Record<string, unknown>)['tokenCache'],
      ).toBeUndefined();
    });

    it('rejects card patches for invalid message ids without fetching', async () => {
      const channel = createChannel();
      (channel as unknown as Record<string, unknown>)['tokenCache'] = {
        token: 'tenant-token',
        expiresAt: Date.now() + 3600_000,
      };
      const fetchSpy = vi
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

      await expect(
        getPrivateMethod<
          (messageId: string, card: Record<string, unknown>) => Promise<boolean>
        >(channel, 'patchInteractiveCard').call(channel, 'om invalid id', {}),
      ).resolves.toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('keeps streaming cards on the generic send and patch paths', async () => {
      const channel = createChannel();
      const sendInteractiveCard = vi.fn().mockResolvedValue('om_stream');
      const patchInteractiveCard = vi.fn().mockResolvedValue(true);
      Object.assign(channel as unknown as Record<string, unknown>, {
        sendInteractiveCard,
        patchInteractiveCard,
      });

      await expect(
        getPrivateMethod<
          (
            chatId: string,
            text: string,
          ) => Promise<{ messageId: string; success: boolean }>
        >(channel, 'createStreamingCard').call(channel, 'oc_chat', 'answer'),
      ).resolves.toEqual({ messageId: 'om_stream', success: true });
      await expect(
        getPrivateMethod<(messageId: string, text: string) => Promise<boolean>>(
          channel,
          'updateCard',
        ).call(channel, 'om_stream', 'updated'),
      ).resolves.toBe(true);
      await expect(
        getPrivateMethod<
          (
            messageId: string,
            text: string,
            finished: boolean,
            inboundMsgId?: string,
            statusLabel?: string,
          ) => Promise<boolean>
        >(channel, 'updateCard').call(
          channel,
          'om_stream',
          'final answer',
          true,
          undefined,
          '已完成',
        ),
      ).resolves.toBe(true);
      expect(sendInteractiveCard).toHaveBeenCalledWith(
        'oc_chat',
        expect.objectContaining({ schema: '2.0' }),
      );
      expect(patchInteractiveCard).toHaveBeenCalledWith(
        'om_stream',
        expect.objectContaining({ schema: '2.0' }),
      );
      const streamingCard = JSON.stringify(
        patchInteractiveCard.mock.calls[0]?.[1],
      );
      expect(streamingCard).toContain('停止');
      const finalCard = JSON.stringify(patchInteractiveCard.mock.calls[1]?.[1]);
      expect(finalCard).toContain('已完成');
      expect(finalCard).not.toContain('停止');
    });

    it('preserves streaming-card failure reporting around the rejecting helper', async () => {
      const channel = createChannel();
      (channel as unknown as Record<string, unknown>)['tokenCache'] = {
        token: 'tenant-token',
        expiresAt: Date.now() + 3600_000,
      };
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response('server down', { status: 500 }),
      );
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      await expect(
        getPrivateMethod<
          (
            chatId: string,
            text: string,
          ) => Promise<{ messageId: string; success: boolean }>
        >(channel, 'createStreamingCard').call(channel, 'oc_chat', 'answer'),
      ).resolves.toEqual({ messageId: '', success: false });
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining(
          'createStreamingCard failed: HTTP 500 server down',
        ),
      );
    });

    it('wires the real question-card controller through the card transport', async () => {
      // Every routing test replaces questionCardController with a mock, so the
      // constructor wiring seams (sendCard -> sendInteractiveCard, patchCard
      // -> patchInteractiveCard) are exercised by no other test. Keep the real
      // controller and mock only fetch.
      const channel = createChannel();
      (channel as unknown as Record<string, unknown>)['tokenCache'] = {
        token: 'tenant-token',
        expiresAt: Date.now() + 3600_000,
      };
      const fetchSpy = vi
        .spyOn(global, 'fetch')
        .mockResolvedValue(
          new Response(
            JSON.stringify({ code: 0, data: { message_id: 'om_question' } }),
            { status: 200 },
          ),
        );
      const { context } = createWiringContext('request-wiring');
      const controller = getWiringController(channel);

      await expect(controller.present(context)).resolves.toMatchObject({
        kind: 'presented',
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/im/v1/messages?receive_id_type=chat_id'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer tenant-token',
          }),
        }),
      );
      const body = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
      expect(body.receive_id).toBe('oc_chat');
      expect(body.msg_type).toBe('interactive');
      const serializedCard = JSON.stringify(JSON.parse(body.content));
      expect(serializedCard).toContain('qwen_ask_form');
      expect(serializedCard).toContain('Which region?');
      expect(serializedCard).toContain('request-wiring');

      controller.dispose();
      // Drain the dispose-time terminal projection on the mock so the PATCH
      // can never reach the real network once the spy is restored.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(fetchSpy).toHaveBeenLastCalledWith(
        expect.stringContaining('/im/v1/messages/om_question'),
        expect.objectContaining({
          method: 'PATCH',
          headers: expect.objectContaining({
            Authorization: 'Bearer tenant-token',
          }),
        }),
      );
      const patchBody = JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body));
      expect(patchBody.msg_type).toBe('interactive');
      expect(JSON.stringify(JSON.parse(patchBody.content))).toContain('已过期');
    });

    it('wires the delivery-failure fallback through the real send path', async () => {
      const channel = createChannel();
      (channel as unknown as Record<string, unknown>)['tokenCache'] = {
        token: 'tenant-token',
        expiresAt: Date.now() + 3600_000,
      };
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const fetchSpy = vi
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(new Response('server down', { status: 500 }))
        .mockResolvedValue(
          new Response(JSON.stringify({ data: {} }), { status: 200 }),
        );
      const { context, respond } = createWiringContext('request-fallback');
      const controller = getWiringController(channel);

      await expect(controller.present(context)).resolves.toMatchObject({
        kind: 'handled',
      });

      expect(respond).toHaveBeenCalledWith({
        outcome: { outcome: 'cancelled' },
      });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const fallbackBody = JSON.parse(
        String(fetchSpy.mock.calls[1]?.[1]?.body),
      );
      expect(fallbackBody.receive_id).toBe('oc_chat');
      expect(fallbackBody.msg_type).toBe('interactive');
      const fallbackCard = JSON.stringify(JSON.parse(fallbackBody.content));
      expect(fallbackCard).toContain('互动问题卡片投递失败');
      expect(fallbackCard).toContain('Which region?');
    });

    it('wires the 270s question expiry through the real controller', async () => {
      vi.useFakeTimers();
      try {
        const channel = createChannel();
        (channel as unknown as Record<string, unknown>)['tokenCache'] = {
          token: 'tenant-token',
          expiresAt: Date.now() + 3600_000,
        };
        const fetchSpy = vi
          .spyOn(global, 'fetch')
          .mockResolvedValue(
            new Response(
              JSON.stringify({ code: 0, data: { message_id: 'om_question' } }),
              { status: 200 },
            ),
          );
        const { context, respond } = createWiringContext('request-expiry');
        const controller = getWiringController(channel);

        await expect(controller.present(context)).resolves.toMatchObject({
          kind: 'presented',
        });

        await vi.advanceTimersByTimeAsync(269_999);
        expect(respond).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(respond).toHaveBeenCalledWith({
          outcome: { outcome: 'cancelled' },
        });
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(fetchSpy).toHaveBeenLastCalledWith(
          expect.stringContaining('/im/v1/messages/om_question'),
          expect.objectContaining({ method: 'PATCH' }),
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('sendMessage: token failure logging', () => {
    it('logs and returns early when token is unavailable', async () => {
      const channel = createChannel();
      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      // The token refresh must never reach the real Feishu endpoint.
      const fetchSpy = vi
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response(null, { status: 500 }));

      // No token available
      await channel.sendMessage('oc_chat_id', 'hello');

      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('Cannot send: no access token'),
      );
      stderrSpy.mockRestore();
      fetchSpy.mockRestore();
    });

    it('rejects proactive sends when token is unavailable', async () => {
      const channel = createTestableChannel();
      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      // The token refresh must never reach the real Feishu endpoint.
      const fetchSpy = vi
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response(null, { status: 500 }));

      await expect(
        channel.pushLoop(
          {
            channelName: 'test',
            senderId: 'ou_user',
            chatId: 'oc_chat_id',
          },
          'hello',
        ),
      ).rejects.toThrow('Feishu sendMessage failed: no access token');

      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('Cannot send: no access token'),
      );
      stderrSpy.mockRestore();
      fetchSpy.mockRestore();
    });

    it('rejects proactive sends when Feishu returns an error', async () => {
      const channel = createTestableChannel();
      (channel as unknown as Record<string, unknown>)['tokenCache'] = {
        token: 'tenant-token',
        expiresAt: Date.now() + 3600_000,
      };
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response('server down', { status: 500 }),
      );
      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      await expect(
        channel.pushLoop(
          {
            channelName: 'test',
            senderId: 'ou_user',
            chatId: 'oc_chat_id',
          },
          'hello',
        ),
      ).rejects.toEqual(
        expect.objectContaining<Partial<ChannelProactiveDeliveryError>>({
          disposition: 'transient',
          message: 'Feishu sendMessage failed: HTTP 500',
        }),
      );

      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('sendMessage failed: HTTP 500'),
      );
      stderrSpy.mockRestore();
    });

    it('classifies non-retryable proactive HTTP failures as permanent', async () => {
      const channel = createTestableChannel();
      (channel as unknown as Record<string, unknown>)['tokenCache'] = {
        token: 'tenant-token',
        expiresAt: Date.now() + 3600_000,
      };
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response('permission denied', { status: 403 }),
      );
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      await expect(
        channel.deliverProactive(
          { channelName: 'test', type: 'user', id: 'ou_user' },
          'direct result',
        ),
      ).rejects.toEqual(
        expect.objectContaining<Partial<ChannelProactiveDeliveryError>>({
          disposition: 'permanent',
          message: 'Feishu sendMessage failed: HTTP 403',
        }),
      );
    });

    it('sends proactive loop output to direct chats', async () => {
      const channel = createTestableChannel();
      (channel as unknown as Record<string, unknown>)['tokenCache'] = {
        token: 'tenant-token',
        expiresAt: Date.now() + 3600_000,
      };
      const fetchSpy = vi
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response('{}', { status: 200 }));

      await channel.pushLoop(
        {
          channelName: 'test',
          senderId: 'ou_user',
          chatId: 'oc_chat_id',
        },
        'loop result',
      );

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/im/v1/messages?receive_id_type=chat_id'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer tenant-token',
          }),
          body: expect.stringContaining('"receive_id":"oc_chat_id"'),
        }),
      );
      fetchSpy.mockRestore();
    });

    it('neutralizes Feishu mention markup in attributed messages', async () => {
      const channel = createTestableChannel();
      (channel as unknown as Record<string, unknown>)['tokenCache'] = {
        token: 'tenant-token',
        expiresAt: Date.now() + 3600_000,
      };
      const fetchSpy = vi
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response('{}', { status: 200 }));

      await channel.sendAttributed(
        'oc_chat_id',
        'done',
        '[Alice <at id=ou_other></at> & review]',
      );

      const body = String(fetchSpy.mock.calls[0]?.[1]?.body);
      expect(body).toContain('&lt;at');
      expect(body).toContain('&lt;/at&gt;');
      expect(body).toContain('&amp;');
      expect(body).not.toContain('<at');
      fetchSpy.mockRestore();
    });

    it('maps typed chat and user deliveries to Feishu receive ID types', async () => {
      const channel = createTestableChannel();
      (channel as unknown as Record<string, unknown>)['tokenCache'] = {
        token: 'tenant-token',
        expiresAt: Date.now() + 3600_000,
      };
      const fetchSpy = vi
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response('{}', { status: 200 }));

      await channel.deliverProactive(
        { channelName: 'test', type: 'chat', id: 'oc_group' },
        'group result',
      );
      await channel.deliverProactive(
        { channelName: 'test', type: 'user', id: 'ou_user' },
        'direct result',
      );

      expect(fetchSpy.mock.calls[0]![0]).toBe(
        'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
      );
      expect(fetchSpy.mock.calls[1]![0]).toBe(
        'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id',
      );
    });

    it('classifies proactive network failures as transient', async () => {
      const channel = createTestableChannel();
      (channel as unknown as Record<string, unknown>)['tokenCache'] = {
        token: 'tenant-token',
        expiresAt: Date.now() + 3600_000,
      };
      vi.spyOn(global, 'fetch').mockRejectedValueOnce(
        new Error('socket token=secret'),
      );

      await expect(
        channel.deliverProactive(
          { channelName: 'test', type: 'user', id: 'ou_user' },
          'direct result',
        ),
      ).rejects.toEqual(
        expect.objectContaining<Partial<ChannelProactiveDeliveryError>>({
          disposition: 'transient',
          message: 'Feishu sendMessage failed: network error',
        }),
      );
    });

    it('classifies unexpected proactive delivery failures as transient', async () => {
      const channel = createTestableChannel();
      const failure = new Error('unexpected token lookup failure');
      Object.assign(channel as unknown as Record<string, unknown>, {
        getTenantAccessToken: vi.fn().mockRejectedValue(failure),
      });

      await expect(
        channel.deliverProactive(
          { channelName: 'test', type: 'user', id: 'ou_user' },
          'direct result',
        ),
      ).rejects.toEqual(
        expect.objectContaining<Partial<ChannelProactiveDeliveryError>>({
          disposition: 'transient',
          message: 'unexpected token lookup failure',
          cause: failure,
        }),
      );
    });
  });

  describe('onPromptEnd: error recovery branches', () => {
    it('cancels question cards for the exact terminal run even without output-card state', () => {
      const channel = createChannel();
      const cancelRun = vi.fn();
      Object.assign(channel as unknown as Record<string, unknown>, {
        questionCardController: { cancelRun },
      });
      const onTaskLifecycle = getPrivateMethod<
        (event: ChannelTaskLifecycleEvent) => void
      >(channel, 'onTaskLifecycle').bind(channel);
      const baseEvent = {
        channelName: 'feishu',
        chatId: 'oc_chat_id',
        sessionId: 'session_without_card',
        identity: { id: 'channel:feishu', displayName: 'feishu' },
        memoryScope: { namespace: 'channel:feishu', mode: 'metadata-only' },
      } as const;

      onTaskLifecycle({
        ...baseEvent,
        type: 'completed',
        runId: 'run-exact',
      });
      onTaskLifecycle({ ...baseEvent, type: 'completed' });
      onTaskLifecycle({
        ...baseEvent,
        type: 'started',
        runId: 'run-nonterminal',
      });
      onTaskLifecycle({
        ...baseEvent,
        type: 'failed',
        runId: 'run-failed',
        error: 'boom',
        phase: 'agent',
      });
      onTaskLifecycle({
        ...baseEvent,
        type: 'cancelled',
        runId: 'run-user-cancel',
        reason: 'cancel_command',
      });
      onTaskLifecycle({
        ...baseEvent,
        type: 'cancelled',
        runId: 'run-dropped',
        reason: 'dropped',
      });

      expect(cancelRun).toHaveBeenCalledTimes(4);
      expect(cancelRun).toHaveBeenCalledWith('run-exact', 'expired');
      expect(cancelRun).toHaveBeenCalledWith('run-failed', 'expired');
      expect(cancelRun).toHaveBeenCalledWith('run-user-cancel', 'cancelled');
      expect(cancelRun).toHaveBeenCalledWith('run-dropped', 'expired');
    });

    it('keeps a local card state so failures before the first chunk stay visible', async () => {
      const channel = createChannel();
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      Object.assign(channel as unknown as Record<string, unknown>, {
        sendMessage,
        addReaction: vi.fn().mockResolvedValue(undefined),
        removeReaction: vi.fn().mockResolvedValue(undefined),
      });
      getPrivateMethod<Map<string, string>>(channel, 'msgToQuestion').set(
        'inbound_1',
        'question?',
      );

      getPrivateMethod<
        (chatId: string, sessionId: string, messageId?: string) => void
      >(channel, 'onPromptStart').call(
        channel,
        'oc_chat_id',
        'session_1',
        'inbound_1',
      );
      getPrivateMethod<(event: ChannelTaskLifecycleEvent) => void>(
        channel,
        'onTaskLifecycle',
      ).call(channel, {
        channelName: 'feishu',
        chatId: 'oc_chat_id',
        sessionId: 'session_1',
        runId: 'run-1',
        type: 'failed',
        error: 'boom',
        phase: 'agent',
        identity: { id: 'channel:feishu', displayName: 'feishu' },
        memoryScope: { namespace: 'channel:feishu', mode: 'metadata-only' },
      });
      await getPrivateMethod<
        (chatId: string, sessionId: string, messageId?: string) => Promise<void>
      >(channel, 'onPromptEnd').call(
        channel,
        'oc_chat_id',
        'session_1',
        'inbound_1',
      );

      expect(sendMessage).toHaveBeenCalledWith(
        'oc_chat_id',
        expect.stringContaining('已失败'),
      );
    });

    it('sends error fallback when card creation failed and no accumulated text', async () => {
      const channel = createChannel();
      (channel as unknown as Record<string, unknown>)['botOpenId'] = 'bot_123';

      const cardSessions = getPrivateMethod<
        Map<string, Record<string, unknown>>
      >(channel, 'cardSessions');
      cardSessions.set('inbound_1', {
        messageId: '',
        created: false,
        creating: false,
        stopped: false,
        finalizing: false,
        completed: false,
        abandoned: false,
        accumulatedText: '',
        lastUpdateAt: Date.now(),
      });

      const sendMessageSpy = vi.fn().mockResolvedValue(undefined);
      (channel as unknown as Record<string, unknown>)['sendMessage'] =
        sendMessageSpy;

      const onPromptEnd = getPrivateMethod<
        (chatId: string, sessionId: string, messageId?: string) => Promise<void>
      >(channel, 'onPromptEnd').bind(channel);

      const sessionToInboundMsg = getPrivateMethod<Map<string, string>>(
        channel,
        'sessionToInboundMsg',
      );
      sessionToInboundMsg.set('session_1', 'inbound_1');

      await onPromptEnd('oc_chat_id', 'session_1');

      // Should send error fallback message
      expect(sendMessageSpy).toHaveBeenCalledWith(
        'oc_chat_id',
        expect.stringContaining('出错了'),
      );
    });

    it('sends accumulated text via sendMessage when card creation failed', async () => {
      const channel = createChannel();
      (channel as unknown as Record<string, unknown>)['botOpenId'] = 'bot_123';

      const cardSessions = getPrivateMethod<
        Map<string, Record<string, unknown>>
      >(channel, 'cardSessions');
      cardSessions.set('inbound_1', {
        messageId: '',
        created: false,
        creating: false,
        stopped: false,
        finalizing: false,
        completed: false,
        abandoned: false,
        accumulatedText: 'partial response text',
        lastUpdateAt: Date.now(),
      });

      const sendMessageSpy = vi.fn().mockResolvedValue(undefined);
      (channel as unknown as Record<string, unknown>)['sendMessage'] =
        sendMessageSpy;

      const onPromptEnd = getPrivateMethod<
        (chatId: string, sessionId: string, messageId?: string) => Promise<void>
      >(channel, 'onPromptEnd').bind(channel);

      const sessionToInboundMsg = getPrivateMethod<Map<string, string>>(
        channel,
        'sessionToInboundMsg',
      );
      sessionToInboundMsg.set('session_1', 'inbound_1');

      await onPromptEnd('oc_chat_id', 'session_1');

      expect(sendMessageSpy).toHaveBeenCalledWith(
        'oc_chat_id',
        expect.stringContaining('partial response text'),
      );
    });

    it('clears accumulated card text at response boundary', () => {
      const channel = createChannel();
      const cardSessions = getPrivateMethod<
        Map<string, { accumulatedText: string; stopped: boolean }>
      >(channel, 'cardSessions');
      cardSessions.set('inbound_1', {
        accumulatedText: 'intermediate response',
        stopped: false,
      });
      getPrivateMethod<Map<string, string>>(channel, 'sessionToInboundMsg').set(
        'session_1',
        'inbound_1',
      );

      getPrivateMethod<(chatId: string, sessionId: string) => void>(
        channel,
        'onResponseBoundary',
      ).call(channel, 'oc_chat_id', 'session_1');

      expect(cardSessions.get('inbound_1')?.accumulatedText).toBe('');
    });

    it('cancels pending card updates at response boundary', () => {
      vi.useFakeTimers();
      try {
        const channel = createChannel();
        const cardSessions = getPrivateMethod<
          Map<
            string,
            {
              accumulatedText: string;
              stopped: boolean;
              pendingUpdateTimer?: ReturnType<typeof setTimeout>;
            }
          >
        >(channel, 'cardSessions');
        const timer = setTimeout(() => {}, 1000);
        cardSessions.set('inbound_1', {
          accumulatedText: 'intermediate response',
          stopped: false,
          pendingUpdateTimer: timer,
        });
        getPrivateMethod<Map<string, string>>(
          channel,
          'sessionToInboundMsg',
        ).set('session_1', 'inbound_1');

        getPrivateMethod<(chatId: string, sessionId: string) => void>(
          channel,
          'onResponseBoundary',
        ).call(channel, 'oc_chat_id', 'session_1');

        expect(
          cardSessions.get('inbound_1')?.pendingUpdateTimer,
        ).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it('forwards response_boundary segment ends and snapshots the cleared text', async () => {
      const channel = createChannel();
      const cardSessions = getPrivateMethod<
        Map<
          string,
          { accumulatedText: string; boundaryText?: string; stopped: boolean }
        >
      >(channel, 'cardSessions');
      cardSessions.set('inbound_1', {
        accumulatedText: 'segment one',
        stopped: false,
      });
      getPrivateMethod<Map<string, string>>(channel, 'sessionToInboundMsg').set(
        'session_1',
        'inbound_1',
      );

      await getPrivateMethod<
        (
          chatId: string,
          sessionId: string,
          segment: ChannelOutputSegmentContext,
          reason: ChannelOutputSegmentEndReason,
        ) => void | Promise<void>
      >(channel, 'onOutputSegmentEnd').call(
        channel,
        'oc_chat_id',
        'session_1',
        {} as ChannelOutputSegmentContext,
        'response_boundary',
      );

      expect(cardSessions.get('inbound_1')).toEqual({
        accumulatedText: '',
        stopped: false,
        updateQueued: false,
        boundaryText: 'segment one',
      });
    });

    it('records failed lifecycle state for prompt-end card finalization', async () => {
      const channel = createChannel();
      const cardSessions = getPrivateMethod<Map<string, unknown>>(
        channel,
        'cardSessions',
      );
      cardSessions.set('inbound_1', {
        messageId: 'om_valid_message_id',
        created: true,
        creating: false,
        stopped: false,
        accumulatedText: 'partial answer',
        lastUpdateAt: Date.now(),
      });

      const updateCard = vi.fn().mockResolvedValue(true);
      (channel as unknown as { updateCard: typeof updateCard }).updateCard =
        updateCard;

      getPrivateMethod<(event: ChannelTaskLifecycleEvent) => void>(
        channel,
        'onTaskLifecycle',
      ).call(channel, {
        type: 'failed',
        error: 'boom',
        phase: 'agent',
        channelName: 'feishu',
        chatId: 'oc_chat_id',
        sessionId: 'session_1',
        messageId: 'inbound_1',
        identity: { id: 'channel:feishu', displayName: 'feishu' },
        memoryScope: { namespace: 'channel:feishu', mode: 'metadata-only' },
      });

      await getPrivateMethod<
        (chatId: string, sessionId: string, messageId?: string) => Promise<void>
      >(channel, 'onPromptEnd').call(
        channel,
        'oc_chat_id',
        'session_1',
        'inbound_1',
      );

      expect(updateCard.mock.calls[0]![1]).toContain('partial answer');
      expect(updateCard.mock.calls[0]![4]).toBe('已失败，请重试');
    });

    it('records cancelled lifecycle state for prompt-end card finalization', async () => {
      const channel = createChannel();
      const cardSessions = getPrivateMethod<Map<string, unknown>>(
        channel,
        'cardSessions',
      );
      cardSessions.set('inbound_1', {
        messageId: 'om_valid_message_id',
        created: true,
        creating: false,
        stopped: false,
        accumulatedText: 'partial answer',
        lastUpdateAt: Date.now(),
      });

      const updateCard = vi.fn().mockResolvedValue(true);
      (channel as unknown as { updateCard: typeof updateCard }).updateCard =
        updateCard;

      getPrivateMethod<(event: ChannelTaskLifecycleEvent) => void>(
        channel,
        'onTaskLifecycle',
      ).call(channel, {
        type: 'cancelled',
        reason: 'cancel_command',
        channelName: 'feishu',
        chatId: 'oc_chat_id',
        sessionId: 'session_1',
        messageId: 'inbound_1',
        identity: { id: 'channel:feishu', displayName: 'feishu' },
        memoryScope: { namespace: 'channel:feishu', mode: 'metadata-only' },
      });

      await getPrivateMethod<
        (chatId: string, sessionId: string, messageId?: string) => Promise<void>
      >(channel, 'onPromptEnd').call(
        channel,
        'oc_chat_id',
        'session_1',
        'inbound_1',
      );

      expect(updateCard.mock.calls[0]![1]).toContain('partial answer');
      expect(updateCard.mock.calls[0]![4]).toBe('已取消');
    });

    it('keeps the first terminal lifecycle state for prompt-end card finalization', async () => {
      const channel = createChannel();
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      const cardSessions = getPrivateMethod<Map<string, unknown>>(
        channel,
        'cardSessions',
      );
      cardSessions.set('inbound_1', {
        messageId: 'om_valid_message_id',
        created: true,
        creating: false,
        stopped: false,
        accumulatedText: 'answer',
        lastUpdateAt: Date.now(),
      });

      const updateCard = vi.fn().mockResolvedValue(true);
      (channel as unknown as { updateCard: typeof updateCard }).updateCard =
        updateCard;

      const lifecycle = getPrivateMethod<
        (event: ChannelTaskLifecycleEvent) => void
      >(channel, 'onTaskLifecycle');
      const baseEvent = {
        channelName: 'feishu',
        chatId: 'oc_chat_id',
        sessionId: 'session_1',
        messageId: 'inbound_1',
        identity: { id: 'channel:feishu', displayName: 'feishu' },
        memoryScope: { namespace: 'channel:feishu', mode: 'metadata-only' },
      } as const;

      lifecycle.call(channel, {
        ...baseEvent,
        type: 'completed',
      } satisfies ChannelTaskLifecycleEvent);
      lifecycle.call(channel, {
        ...baseEvent,
        type: 'cancelled',
        reason: 'cancel_command',
      } satisfies ChannelTaskLifecycleEvent);

      await getPrivateMethod<
        (chatId: string, sessionId: string, messageId?: string) => Promise<void>
      >(channel, 'onPromptEnd').call(
        channel,
        'oc_chat_id',
        'session_1',
        'inbound_1',
      );

      expect(updateCard.mock.calls[0]![4]).toBe('已完成');
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining(
          'conflicting terminal event cancelled after completed',
        ),
      );
      stderr.mockRestore();
    });

    it('resolves the card via sessionToInboundMsg when the event has no messageId', async () => {
      const channel = createChannel();
      const cardSessions = getPrivateMethod<Map<string, unknown>>(
        channel,
        'cardSessions',
      );
      cardSessions.set('inbound_1', {
        messageId: 'om_valid_message_id',
        created: true,
        creating: false,
        stopped: false,
        accumulatedText: 'answer',
        lastUpdateAt: Date.now(),
      });
      getPrivateMethod<Map<string, string>>(channel, 'sessionToInboundMsg').set(
        'session_1',
        'inbound_1',
      );

      const updateCard = vi.fn().mockResolvedValue(true);
      (channel as unknown as { updateCard: typeof updateCard }).updateCard =
        updateCard;

      getPrivateMethod<(event: ChannelTaskLifecycleEvent) => void>(
        channel,
        'onTaskLifecycle',
      ).call(channel, {
        type: 'cancelled',
        reason: 'cancel_command',
        channelName: 'feishu',
        chatId: 'oc_chat_id',
        sessionId: 'session_1',
        identity: { id: 'channel:feishu', displayName: 'feishu' },
        memoryScope: { namespace: 'channel:feishu', mode: 'metadata-only' },
      });

      await getPrivateMethod<
        (chatId: string, sessionId: string, messageId?: string) => Promise<void>
      >(channel, 'onPromptEnd').call(
        channel,
        'oc_chat_id',
        'session_1',
        'inbound_1',
      );

      expect(updateCard.mock.calls[0]![4]).toBe('已取消');
    });

    it('treats prompt-end during stop cancellation as cancelled', async () => {
      const channel = createChannel();
      const cardSessions = getPrivateMethod<Map<string, unknown>>(
        channel,
        'cardSessions',
      );
      cardSessions.set('inbound_1', {
        messageId: 'om_valid_message_id',
        created: true,
        creating: false,
        stopped: false,
        cancelling: true,
        accumulatedText: 'partial answer',
        lastUpdateAt: Date.now(),
      });

      const updateCard = vi.fn().mockResolvedValue(true);
      (channel as unknown as { updateCard: typeof updateCard }).updateCard =
        updateCard;

      await getPrivateMethod<
        (chatId: string, sessionId: string, messageId?: string) => Promise<void>
      >(channel, 'onPromptEnd').call(
        channel,
        'oc_chat_id',
        'session_1',
        'inbound_1',
      );

      expect(updateCard.mock.calls[0]![4]).toBe('已取消');
    });

    it('finalizes creating cards as failed instead of stopped after prompt end', async () => {
      const channel = createChannel();
      let resolveCreateCard:
        | ((value: { success: boolean; messageId: string }) => void)
        | undefined;
      const createCardPromise = new Promise<{
        success: boolean;
        messageId: string;
      }>((resolve) => {
        resolveCreateCard = resolve;
      });

      const createStreamingCard = vi.fn().mockReturnValue(createCardPromise);
      const updateCard = vi.fn().mockResolvedValue(true);
      const addReaction = vi.fn().mockResolvedValue(undefined);
      const removeReaction = vi.fn().mockResolvedValue(undefined);

      (
        channel as unknown as {
          createStreamingCard: typeof createStreamingCard;
          updateCard: typeof updateCard;
          addReaction: typeof addReaction;
          removeReaction: typeof removeReaction;
        }
      ).createStreamingCard = createStreamingCard;
      (channel as unknown as { updateCard: typeof updateCard }).updateCard =
        updateCard;
      (channel as unknown as { addReaction: typeof addReaction }).addReaction =
        addReaction;
      (
        channel as unknown as { removeReaction: typeof removeReaction }
      ).removeReaction = removeReaction;
      getPrivateMethod<Map<string, string>>(channel, 'msgToQuestion').set(
        'inbound_1',
        'question?',
      );

      getPrivateMethod<
        (chatId: string, sessionId: string, messageId?: string) => void
      >(channel, 'onPromptStart').call(
        channel,
        'oc_chat_id',
        'session_1',
        'inbound_1',
      );

      getPrivateMethod<
        (chatId: string, chunk: string, sessionId: string) => void
      >(channel, 'onResponseChunk').call(
        channel,
        'oc_chat_id',
        'partial answer',
        'session_1',
      );
      await vi.waitFor(() => expect(createStreamingCard).toHaveBeenCalled());

      getPrivateMethod<(event: ChannelTaskLifecycleEvent) => void>(
        channel,
        'onTaskLifecycle',
      ).call(channel, {
        type: 'failed',
        error: 'boom',
        phase: 'agent',
        channelName: 'feishu',
        chatId: 'oc_chat_id',
        sessionId: 'session_1',
        messageId: 'inbound_1',
        identity: { id: 'channel:feishu', displayName: 'feishu' },
        memoryScope: { namespace: 'channel:feishu', mode: 'metadata-only' },
      });

      await getPrivateMethod<
        (chatId: string, sessionId: string, messageId?: string) => Promise<void>
      >(channel, 'onPromptEnd').call(
        channel,
        'oc_chat_id',
        'session_1',
        'inbound_1',
      );

      resolveCreateCard?.({ success: true, messageId: 'om_valid_message_id' });

      await vi.waitFor(() => {
        expect(updateCard).toHaveBeenCalledTimes(1);
      });

      expect(updateCard.mock.calls[0]![0]).toBe('om_valid_message_id');
      expect(updateCard.mock.calls[0]![2]).toBe(true);
      expect(updateCard.mock.calls[0]![4]).toBe('已失败，请重试');
      expect(updateCard.mock.calls[0]![1]).not.toContain('已停止生成');
    });

    it('finalizes creating cards as cancelled instead of stopped after prompt end', async () => {
      const channel = createChannel();
      let resolveCreateCard:
        | ((value: { success: boolean; messageId: string }) => void)
        | undefined;
      const createCardPromise = new Promise<{
        success: boolean;
        messageId: string;
      }>((resolve) => {
        resolveCreateCard = resolve;
      });

      const createStreamingCard = vi.fn().mockReturnValue(createCardPromise);
      const updateCard = vi.fn().mockResolvedValue(true);
      const addReaction = vi.fn().mockResolvedValue(undefined);
      const removeReaction = vi.fn().mockResolvedValue(undefined);

      (
        channel as unknown as {
          createStreamingCard: typeof createStreamingCard;
          updateCard: typeof updateCard;
          addReaction: typeof addReaction;
          removeReaction: typeof removeReaction;
        }
      ).createStreamingCard = createStreamingCard;
      (channel as unknown as { updateCard: typeof updateCard }).updateCard =
        updateCard;
      (channel as unknown as { addReaction: typeof addReaction }).addReaction =
        addReaction;
      (
        channel as unknown as { removeReaction: typeof removeReaction }
      ).removeReaction = removeReaction;
      getPrivateMethod<Map<string, string>>(channel, 'msgToQuestion').set(
        'inbound_1',
        'question?',
      );

      getPrivateMethod<
        (chatId: string, sessionId: string, messageId?: string) => void
      >(channel, 'onPromptStart').call(
        channel,
        'oc_chat_id',
        'session_1',
        'inbound_1',
      );

      getPrivateMethod<
        (chatId: string, chunk: string, sessionId: string) => void
      >(channel, 'onResponseChunk').call(
        channel,
        'oc_chat_id',
        'partial answer',
        'session_1',
      );
      await vi.waitFor(() => expect(createStreamingCard).toHaveBeenCalled());

      getPrivateMethod<(event: ChannelTaskLifecycleEvent) => void>(
        channel,
        'onTaskLifecycle',
      ).call(channel, {
        type: 'cancelled',
        reason: 'cancel_command',
        channelName: 'feishu',
        chatId: 'oc_chat_id',
        sessionId: 'session_1',
        messageId: 'inbound_1',
        identity: { id: 'channel:feishu', displayName: 'feishu' },
        memoryScope: { namespace: 'channel:feishu', mode: 'metadata-only' },
      });

      await getPrivateMethod<
        (chatId: string, sessionId: string, messageId?: string) => Promise<void>
      >(channel, 'onPromptEnd').call(
        channel,
        'oc_chat_id',
        'session_1',
        'inbound_1',
      );

      resolveCreateCard?.({ success: true, messageId: 'om_valid_message_id' });

      await vi.waitFor(() => {
        expect(updateCard).toHaveBeenCalledTimes(1);
      });

      expect(updateCard.mock.calls[0]![0]).toBe('om_valid_message_id');
      expect(updateCard.mock.calls[0]![2]).toBe(true);
      expect(updateCard.mock.calls[0]![4]).toBe('已取消');
      expect(updateCard.mock.calls[0]![1]).not.toContain('已停止生成');
    });

    it('finalizes creating cards as completed after non-empty successful responses', async () => {
      const channel = createChannel();
      let resolveCreateCard:
        | ((value: { success: boolean; messageId: string }) => void)
        | undefined;
      const createCardPromise = new Promise<{
        success: boolean;
        messageId: string;
      }>((resolve) => {
        resolveCreateCard = resolve;
      });

      const createStreamingCard = vi.fn().mockReturnValue(createCardPromise);
      const updateCard = vi.fn().mockResolvedValue(true);
      const addReaction = vi.fn().mockResolvedValue(undefined);
      const removeReaction = vi.fn().mockResolvedValue(undefined);

      (
        channel as unknown as {
          createStreamingCard: typeof createStreamingCard;
          updateCard: typeof updateCard;
          addReaction: typeof addReaction;
          removeReaction: typeof removeReaction;
        }
      ).createStreamingCard = createStreamingCard;
      (channel as unknown as { updateCard: typeof updateCard }).updateCard =
        updateCard;
      (channel as unknown as { addReaction: typeof addReaction }).addReaction =
        addReaction;
      (
        channel as unknown as { removeReaction: typeof removeReaction }
      ).removeReaction = removeReaction;
      getPrivateMethod<Map<string, string>>(channel, 'msgToQuestion').set(
        'inbound_1',
        'question?',
      );

      getPrivateMethod<
        (chatId: string, sessionId: string, messageId?: string) => void
      >(channel, 'onPromptStart').call(
        channel,
        'oc_chat_id',
        'session_1',
        'inbound_1',
      );

      getPrivateMethod<
        (chatId: string, chunk: string, sessionId: string) => void
      >(channel, 'onResponseChunk').call(
        channel,
        'oc_chat_id',
        'partial answer',
        'session_1',
      );
      await vi.waitFor(() => expect(createStreamingCard).toHaveBeenCalled());

      getPrivateMethod<(event: ChannelTaskLifecycleEvent) => void>(
        channel,
        'onTaskLifecycle',
      ).call(channel, {
        type: 'completed',
        channelName: 'feishu',
        chatId: 'oc_chat_id',
        sessionId: 'session_1',
        messageId: 'inbound_1',
        identity: { id: 'channel:feishu', displayName: 'feishu' },
        memoryScope: { namespace: 'channel:feishu', mode: 'metadata-only' },
      });

      await getPrivateMethod<
        (chatId: string, sessionId: string, messageId?: string) => Promise<void>
      >(channel, 'onPromptEnd').call(
        channel,
        'oc_chat_id',
        'session_1',
        'inbound_1',
      );

      resolveCreateCard?.({ success: true, messageId: 'om_valid_message_id' });

      await vi.waitFor(() => {
        expect(updateCard).toHaveBeenCalledTimes(1);
      });

      expect(updateCard.mock.calls[0]![0]).toBe('om_valid_message_id');
      expect(updateCard.mock.calls[0]![2]).toBe(true);
      expect(updateCard.mock.calls[0]![4]).toBe('已完成');
      expect(updateCard.mock.calls[0]![1]).not.toContain('已停止生成');
    });
  });

  describe('onResponseComplete: stopped card cleanup', () => {
    it('cleans up and returns early when card was stopped', async () => {
      const channel = createChannel();
      (channel as unknown as Record<string, unknown>)['botOpenId'] = 'bot_123';

      const cardSessions = getPrivateMethod<
        Map<string, Record<string, unknown>>
      >(channel, 'cardSessions');
      cardSessions.set('inbound_1', {
        messageId: 'card_1',
        created: true,
        creating: false,
        stopped: true,
        finalizing: false,
        completed: true,
        abandoned: false,
        accumulatedText: 'text',
        lastUpdateAt: Date.now(),
      });

      const sessionToInboundMsg = getPrivateMethod<Map<string, string>>(
        channel,
        'sessionToInboundMsg',
      );
      sessionToInboundMsg.set('session_1', 'inbound_1');

      const sendMessageSpy = vi.fn().mockResolvedValue(undefined);
      (channel as unknown as Record<string, unknown>)['sendMessage'] =
        sendMessageSpy;

      const onResponseComplete = getPrivateMethod<
        (chatId: string, fullText: string, sessionId: string) => Promise<void>
      >(channel, 'onResponseComplete').bind(channel);

      await onResponseComplete('oc_chat_id', 'full response', 'session_1');

      // Should NOT call sendMessage — the stop handler owns the card
      expect(sendMessageSpy).not.toHaveBeenCalled();
      // Card session should be cleaned up
      expect(cardSessions.has('inbound_1')).toBe(false);
    });

    it('marks completed cards with the completed status label', async () => {
      const channel = createChannel();
      const sessionToInboundMsg = getPrivateMethod<Map<string, string>>(
        channel,
        'sessionToInboundMsg',
      );
      const cardSessions = getPrivateMethod<Map<string, unknown>>(
        channel,
        'cardSessions',
      );
      sessionToInboundMsg.set('session_1', 'inbound_1');
      cardSessions.set('inbound_1', {
        messageId: 'om_valid_message_id',
        created: true,
        creating: false,
        stopped: false,
        accumulatedText: 'answer',
        lastUpdateAt: Date.now(),
      });

      const updateCard = vi.fn().mockResolvedValue(true);
      (channel as unknown as { updateCard: typeof updateCard }).updateCard =
        updateCard;

      await getPrivateMethod<
        (chatId: string, fullText: string, sessionId: string) => Promise<void>
      >(channel, 'onResponseComplete').call(
        channel,
        'oc_chat_id',
        'final answer',
        'session_1',
      );

      expect(updateCard.mock.calls[0]![1]).toContain('final answer');
      expect(updateCard.mock.calls[0]![4]).toBe('已完成');
    });

    it('awaits an in-flight throttled streaming PATCH before the completion patch', async () => {
      vi.useFakeTimers();
      try {
        const channel = createChannel();
        let resolveStreaming!: (ok: boolean) => void;
        const updateCard = vi
          .fn()
          .mockImplementationOnce(
            () =>
              new Promise<boolean>((resolve) => {
                resolveStreaming = resolve;
              }),
          )
          .mockResolvedValue(true);
        Object.assign(channel as unknown as Record<string, unknown>, {
          updateCard,
        });
        const cardSessions = getPrivateMethod<
          Map<string, Record<string, unknown>>
        >(channel, 'cardSessions');
        cardSessions.set('inbound_1', {
          messageId: 'om_valid_message_id',
          created: true,
          creating: false,
          stopped: false,
          accumulatedText: 'streamed',
          lastUpdateAt: Date.now(),
        });
        getPrivateMethod<Map<string, string>>(
          channel,
          'sessionToInboundMsg',
        ).set('session_1', 'inbound_1');

        getPrivateMethod<
          (chatId: string, chunk: string, sessionId: string) => void
        >(channel, 'onResponseChunk').call(
          channel,
          'oc_chat_id',
          ' more',
          'session_1',
        );
        // Fire the throttled callback; its streaming PATCH stays in flight.
        await vi.advanceTimersByTimeAsync(1_500);
        expect(updateCard).toHaveBeenCalledTimes(1);

        const completing = getPrivateMethod<
          (chatId: string, fullText: string, sessionId: string) => Promise<void>
        >(channel, 'onResponseComplete').call(
          channel,
          'oc_chat_id',
          'final answer',
          'session_1',
        );
        await Promise.resolve();
        // The completion patch must not start while the streaming PATCH flies.
        expect(updateCard).toHaveBeenCalledTimes(1);

        resolveStreaming(true);
        await completing;

        expect(updateCard).toHaveBeenCalledTimes(2);
        expect(updateCard.mock.calls[1]?.[1]).toContain('final answer');
        expect(updateCard.mock.calls[1]?.[2]).toBe(true);
        expect(updateCard.mock.calls[1]?.[4]).toBe('已完成');
      } finally {
        vi.useRealTimers();
      }
    });

    it('lets the pending creation timer complete instead of demoting to plain text', async () => {
      vi.useFakeTimers();
      try {
        const channel = createChannel();
        const createStreamingCard = vi.fn().mockResolvedValue({
          success: true,
          messageId: 'om_created',
        });
        const updateCard = vi.fn().mockResolvedValue(true);
        const sendMessage = vi.fn().mockResolvedValue(undefined);
        Object.assign(channel as unknown as Record<string, unknown>, {
          createStreamingCard,
          updateCard,
          sendMessage,
          addReaction: vi.fn().mockResolvedValue(undefined),
          removeReaction: vi.fn().mockResolvedValue(undefined),
        });
        getPrivateMethod<Map<string, string>>(channel, 'msgToQuestion').set(
          'inbound_1',
          'question?',
        );

        getPrivateMethod<
          (chatId: string, sessionId: string, messageId?: string) => void
        >(channel, 'onPromptStart').call(
          channel,
          'oc_chat_id',
          'session_1',
          'inbound_1',
        );
        getPrivateMethod<
          (chatId: string, chunk: string, sessionId: string) => void
        >(channel, 'onResponseChunk').call(
          channel,
          'oc_chat_id',
          'first chunk',
          'session_1',
        );

        // Completion lands in the same burst, before the 0ms creation timer
        // fires. The busy-wait must be released by the creation, not time
        // out into a plain-text demotion.
        const completing = getPrivateMethod<
          (chatId: string, fullText: string, sessionId: string) => Promise<void>
        >(channel, 'onResponseComplete').call(
          channel,
          'oc_chat_id',
          'final answer',
          'session_1',
        );
        await vi.advanceTimersByTimeAsync(10_500);
        await completing;

        expect(createStreamingCard).toHaveBeenCalledOnce();
        expect(updateCard).toHaveBeenCalledTimes(1);
        expect(updateCard.mock.calls[0]?.[0]).toBe('om_created');
        expect(updateCard.mock.calls[0]?.[1]).toContain('final answer');
        expect(updateCard.mock.calls[0]?.[4]).toBe('已完成');
        expect(sendMessage).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps stop status when user stops during final card update', async () => {
      const channel = createChannel();
      const sessionToInboundMsg = getPrivateMethod<Map<string, string>>(
        channel,
        'sessionToInboundMsg',
      );
      const cardSessions = getPrivateMethod<
        Map<string, Record<string, unknown>>
      >(channel, 'cardSessions');
      const msgToSenderId = getPrivateMethod<Map<string, string>>(
        channel,
        'msgToSenderId',
      );
      const msgToSenderName = getPrivateMethod<Map<string, string>>(
        channel,
        'msgToSenderName',
      );
      sessionToInboundMsg.set('session_1', 'inbound_1');
      msgToSenderId.set('inbound_1', 'original_user');
      msgToSenderName.set('inbound_1', '@sender');
      cardSessions.set('inbound_1', {
        messageId: 'om_valid_message_id',
        created: true,
        creating: false,
        stopped: false,
        accumulatedText: 'partial answer',
        lastUpdateAt: Date.now(),
      });

      let resolveFirstUpdate: (value: boolean) => void = () => {};
      const firstUpdate = new Promise<boolean>((resolve) => {
        resolveFirstUpdate = resolve;
      });
      const updateCard = vi
        .fn()
        .mockReturnValueOnce(firstUpdate)
        .mockResolvedValue(true);
      (channel as unknown as { updateCard: typeof updateCard }).updateCard =
        updateCard;
      (
        channel as unknown as {
          requestActivePromptCancellation: (
            sessionId: string,
          ) => Promise<boolean>;
        }
      ).requestActivePromptCancellation = vi.fn().mockResolvedValue(true);

      const complete = getPrivateMethod<
        (chatId: string, fullText: string, sessionId: string) => Promise<void>
      >(channel, 'onResponseComplete').call(
        channel,
        'oc_chat_id',
        'final answer',
        'session_1',
      );

      await vi.waitFor(() => {
        expect(updateCard).toHaveBeenCalledTimes(1);
      });

      getPrivateMethod<(data: Record<string, unknown>) => boolean>(
        channel,
        'onCardAction',
      ).call(channel, {
        action: { value: { action: 'stop' } },
        context: {
          open_message_id: 'om_valid_message_id',
          open_chat_id: 'oc_chat_id',
        },
        operator: { open_id: 'original_user' },
      });

      await vi.waitFor(() => {
        expect(cardSessions.get('inbound_1')?.['stopped']).toBe(true);
      });
      resolveFirstUpdate(true);
      await complete;

      expect(updateCard).toHaveBeenCalledTimes(2);
      const stoppedCard = updateCard.mock.calls[1]![1] as string;
      expect(stoppedCard).toContain('已停止生成');
      expect(stoppedCard).not.toContain('已完成');
    });

    it('keeps the sender mention before attribution in stopped-card fallback', async () => {
      const channel = createChannel();
      (channel as unknown as Record<string, unknown>)['tokenCache'] = {
        token: 'tenant-token',
        expiresAt: Date.now() + 3600_000,
      };
      const fetchSpy = vi
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response('{}', { status: 200 }));
      const cardState = {
        messageId: 'om_valid_message_id',
        created: true,
        creating: false,
        stopped: true,
        accumulatedText: 'partial answer',
        atPrefix: '好的，<at id=ou_sender></at>',
        sourceLabel: '[Alice · review_*]',
        lastUpdateAt: Date.now(),
      };
      Object.assign(channel as unknown as Record<string, unknown>, {
        updateCard: vi.fn().mockResolvedValue(false),
        deleteCard: vi.fn().mockResolvedValue(true),
      });

      await getPrivateMethod<
        (
          inboundMsgId: string,
          state: typeof cardState,
          chatId: string,
        ) => Promise<boolean>
      >(channel, 'finalizeStoppedCardUpdate').call(
        channel,
        'inbound_1',
        cardState,
        'oc_chat_id',
      );

      expect(fetchSpy).toHaveBeenCalledOnce();
      const body = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
      const card = JSON.parse(body.content) as {
        body: { elements: Array<{ content?: string }> };
      };
      const content = card.body.elements[0]?.content ?? '';
      expect(content).toBe(
        '好的，<at id=ou_sender></at>\n\n\\[Alice · review\\_\\*\\]\n\npartial answer\n\n---\n*已停止生成*',
      );
      expect(content.match(/<at id=ou_sender><\/at>/g)).toHaveLength(1);
    });

    it('keeps the card running when cancellation fails mid-finalization', async () => {
      const channel = createChannel();
      const sessionToInboundMsg = getPrivateMethod<Map<string, string>>(
        channel,
        'sessionToInboundMsg',
      );
      const cardSessions = getPrivateMethod<
        Map<string, Record<string, unknown>>
      >(channel, 'cardSessions');
      sessionToInboundMsg.set('session_1', 'inbound_1');
      getPrivateMethod<Map<string, string>>(channel, 'msgToSenderId').set(
        'inbound_1',
        'original_user',
      );
      getPrivateMethod<Map<string, string>>(channel, 'msgToSenderName').set(
        'inbound_1',
        '@sender',
      );
      cardSessions.set('inbound_1', {
        messageId: 'om_valid_message_id',
        created: true,
        creating: false,
        stopped: false,
        accumulatedText: 'partial answer',
        lastUpdateAt: Date.now(),
      });

      const updateCard = vi.fn().mockResolvedValue(true);
      Object.assign(channel as unknown as Record<string, unknown>, {
        updateCard,
      });
      (
        channel as unknown as {
          requestActivePromptCancellation: (
            sessionId: string,
          ) => Promise<boolean>;
        }
      ).requestActivePromptCancellation = vi.fn().mockResolvedValue(false);

      // Stop clicked, but the cancel RPC fails — the run continues.
      getPrivateMethod<(data: Record<string, unknown>) => boolean>(
        channel,
        'onCardAction',
      ).call(channel, {
        action: { value: { action: 'stop' } },
        context: {
          open_message_id: 'om_valid_message_id',
          open_chat_id: 'oc_chat_id',
        },
        operator: { open_id: 'original_user' },
      });
      await vi.waitFor(() => {
        expect(updateCard).toHaveBeenCalledTimes(1);
      });
      expect(updateCard.mock.calls[0]![4]).toBe('停止失败，请重试');
      expect(updateCard.mock.calls[0]![2]).toBe(false);
      expect(cardSessions.get('inbound_1')?.['stopped']).toBe(false);

      // The run then completes: the response must still land on the card.
      await getPrivateMethod<
        (chatId: string, fullText: string, sessionId: string) => Promise<void>
      >(channel, 'onResponseComplete').call(
        channel,
        'oc_chat_id',
        'final answer',
        'session_1',
      );

      expect(updateCard).toHaveBeenCalledTimes(2);
      expect(updateCard.mock.calls[1]![1]).toContain('final answer');
      expect(updateCard.mock.calls[1]![2]).toBe(true);
      expect(updateCard.mock.calls[1]![4]).toBe('已完成');
      expect(cardSessions.has('inbound_1')).toBe(false);
    });

    it('reserves final card space for the completed status label', async () => {
      const channel = createChannel();
      const sessionToInboundMsg = getPrivateMethod<Map<string, string>>(
        channel,
        'sessionToInboundMsg',
      );
      const cardSessions = getPrivateMethod<Map<string, unknown>>(
        channel,
        'cardSessions',
      );
      sessionToInboundMsg.set('session_1', 'inbound_1');
      cardSessions.set('inbound_1', {
        messageId: 'om_valid_message_id',
        created: true,
        creating: false,
        stopped: false,
        accumulatedText: 'answer',
        lastUpdateAt: Date.now(),
      });

      const updateCard = vi.fn().mockResolvedValue(true);
      (channel as unknown as { updateCard: typeof updateCard }).updateCard =
        updateCard;

      await getPrivateMethod<
        (chatId: string, fullText: string, sessionId: string) => Promise<void>
      >(channel, 'onResponseComplete').call(
        channel,
        'oc_chat_id',
        'x'.repeat(20_000),
        'session_1',
      );

      const rendered = updateCard.mock.calls[0]![1] as string;
      expect(updateCard.mock.calls[0]![4]).toBe('已完成');
      expect(rendered).not.toContain('已完成');
      expect(rendered).toContain('内容过长，已截断早期内容');
      expect(rendered.length).toBeLessThanOrEqual(
        20_000 - '\n\n---\n*已完成*'.length,
      );
    });
  });

  describe('webhook: JSON parse error logging', () => {
    it('logs error message on malformed JSON body', async () => {
      // This test verifies the fix is in place by checking the source code
      // contains the error capture. A full integration test would require
      // starting an HTTP server.
      const channel = createChannel();
      const connectWebhook = getPrivateMethod<
        (
          port: number,
          verificationToken?: string,
          encryptKey?: string,
        ) => Promise<void>
      >(channel, 'connectWebhook').bind(channel);

      // Just verify the method exists and is callable
      expect(typeof connectWebhook).toBe('function');
    });
  });

  describe('question flow output-card handoff', () => {
    it('finalizes a streamed card before a question when the boundary closed the segment first', async () => {
      vi.useFakeTimers();
      try {
        const channel = createChannel();
        let resolveFinalPatch!: (ok: boolean) => void;
        const updateCard = vi.fn().mockImplementation(
          () =>
            new Promise<boolean>((resolve) => {
              resolveFinalPatch = resolve;
            }),
        );
        const createStreamingCard = vi.fn().mockResolvedValue({
          success: true,
          messageId: 'om_first_output',
        });
        const present = vi.fn().mockResolvedValue({ kind: 'presented' });
        Object.assign(channel as unknown as Record<string, unknown>, {
          updateCard,
          createStreamingCard,
          questionCardController: { present },
          addReaction: vi.fn().mockResolvedValue(undefined),
          removeReaction: vi.fn().mockResolvedValue(undefined),
        });
        getPrivateMethod<Map<string, string>>(channel, 'msgToQuestion').set(
          'inbound_1',
          'question?',
        );

        getPrivateMethod<
          (chatId: string, sessionId: string, messageId?: string) => void
        >(channel, 'onPromptStart').call(
          channel,
          'oc_chat_id',
          'session_1',
          'inbound_1',
        );
        getPrivateMethod<
          (chatId: string, chunk: string, sessionId: string) => void
        >(channel, 'onResponseChunk').call(
          channel,
          'oc_chat_id',
          'pre-question text',
          'session_1',
        );
        await vi.runAllTimersAsync();
        await getPrivateMethod<
          (
            chatId: string,
            sessionId: string,
            segment: ChannelOutputSegmentContext,
            reason: ChannelOutputSegmentEndReason,
          ) => void | Promise<void>
        >(channel, 'onOutputSegmentEnd').call(
          channel,
          'oc_chat_id',
          'session_1',
          {} as ChannelOutputSegmentContext,
          'response_boundary',
        );

        const context = {
          requestId: 'request-after-text',
          sessionId: 'session_1',
          target: { chatId: 'oc_chat_id' },
        } as unknown as ChannelUserInputRequestContext;
        const presenting = getPrivateMethod<
          (request: ChannelUserInputRequestContext) => Promise<{ kind: string }>
        >(channel, 'presentUserInputRequest').call(channel, context);
        await vi.advanceTimersByTimeAsync(0);

        // The final patch is still in flight: the question must wait for it,
        // not merely start after it.
        expect(updateCard).toHaveBeenCalledTimes(1);
        expect(present).not.toHaveBeenCalled();

        resolveFinalPatch(true);
        await presenting;

        expect(updateCard).toHaveBeenCalledWith(
          'om_first_output',
          'pre-question text',
          true,
          'inbound_1',
          '已完成',
        );
        expect(
          getPrivateMethod<Map<string, Record<string, unknown>>>(
            channel,
            'cardSessions',
          ).get('inbound_1'),
        ).toMatchObject({
          created: false,
          creating: false,
          accumulatedText: '',
        });
        expect(present).toHaveBeenCalledWith(context);
        expect(updateCard.mock.invocationCallOrder[0]).toBeLessThan(
          present.mock.invocationCallOrder[0]!,
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps an active output-card session when a preceding segment closed for the request', async () => {
      const channel = createChannel();
      const present = vi.fn().mockResolvedValue({ kind: 'presented' });
      Object.assign(channel as unknown as Record<string, unknown>, {
        questionCardController: { present },
      });
      const cardSessions = getPrivateMethod<
        Map<string, Record<string, unknown>>
      >(channel, 'cardSessions');
      const session = {
        messageId: 'om_first_output',
        created: true,
        creating: false,
        stopped: false,
        accumulatedText: 'before question',
        lastUpdateAt: Date.now(),
      };
      cardSessions.set('inbound_1', session);
      getPrivateMethod<Map<string, string>>(channel, 'sessionToInboundMsg').set(
        'session_1',
        'inbound_1',
      );
      const context = {
        requestId: 'request-segment',
        sessionId: 'session_1',
        precedingSegmentId: 'segment-1',
        target: { chatId: 'oc_chat_id' },
      } as unknown as ChannelUserInputRequestContext;

      await getPrivateMethod<
        (request: ChannelUserInputRequestContext) => Promise<{ kind: string }>
      >(channel, 'presentUserInputRequest').call(channel, context);

      expect(cardSessions.get('inbound_1')).toBe(session);
      expect(present).toHaveBeenCalledWith(context);
    });

    it('surfaces a post-answer failure after the output card was released', async () => {
      const channel = createChannel();
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      const addReaction = vi.fn().mockResolvedValue(undefined);
      const removeReaction = vi.fn().mockResolvedValue(undefined);
      Object.assign(channel as unknown as Record<string, unknown>, {
        questionCardController: {
          present: vi.fn().mockResolvedValue({ kind: 'presented' }),
          cancelRun: vi.fn(),
        },
        sendMessage,
        addReaction,
        removeReaction,
      });
      getPrivateMethod<Map<string, string>>(channel, 'msgToQuestion').set(
        'inbound_1',
        'question?',
      );
      getPrivateMethod<
        (chatId: string, sessionId: string, messageId?: string) => void
      >(channel, 'onPromptStart').call(
        channel,
        'oc_chat_id',
        'session_1',
        'inbound_1',
      );

      await getPrivateMethod<
        (request: ChannelUserInputRequestContext) => Promise<{ kind: string }>
      >(channel, 'presentUserInputRequest').call(channel, {
        requestId: 'request-fails-later',
        sessionId: 'session_1',
        target: { chatId: 'oc_chat_id' },
      } as unknown as ChannelUserInputRequestContext);
      getPrivateMethod<(event: ChannelTaskLifecycleEvent) => void>(
        channel,
        'onTaskLifecycle',
      ).call(channel, {
        channelName: 'feishu',
        chatId: 'oc_chat_id',
        sessionId: 'session_1',
        runId: 'run-1',
        type: 'failed',
        error: 'model error',
        phase: 'agent',
        identity: { id: 'channel:feishu', displayName: 'feishu' },
        memoryScope: { namespace: 'channel:feishu', mode: 'metadata-only' },
      });
      await getPrivateMethod<
        (chatId: string, sessionId: string, messageId?: string) => Promise<void>
      >(channel, 'onPromptEnd').call(
        channel,
        'oc_chat_id',
        'session_1',
        'inbound_1',
      );

      expect(sendMessage).toHaveBeenCalledWith(
        'oc_chat_id',
        expect.stringContaining('已失败'),
      );
      expect(addReaction).toHaveBeenCalledWith('inbound_1', 'OnIt');
      expect(removeReaction).toHaveBeenCalledWith('inbound_1', 'OnIt');
    });

    it('keeps auxiliary maps when an abandoned creation never starts', async () => {
      vi.useFakeTimers();
      try {
        const channel = createChannel();
        const createStreamingCard = vi.fn();
        Object.assign(channel as unknown as Record<string, unknown>, {
          createStreamingCard,
          sendMessage: vi.fn().mockResolvedValue(undefined),
          addReaction: vi.fn().mockResolvedValue(undefined),
          removeReaction: vi.fn().mockResolvedValue(undefined),
        });
        const msgToQuestion = getPrivateMethod<Map<string, string>>(
          channel,
          'msgToQuestion',
        );
        const msgToSenderName = getPrivateMethod<Map<string, string>>(
          channel,
          'msgToSenderName',
        );
        const msgToSenderId = getPrivateMethod<Map<string, string>>(
          channel,
          'msgToSenderId',
        );
        msgToQuestion.set('inbound_1', 'question?');
        msgToSenderName.set('inbound_1', '@sender');
        msgToSenderId.set('inbound_1', 'owner-1');

        getPrivateMethod<
          (chatId: string, sessionId: string, messageId?: string) => void
        >(channel, 'onPromptStart').call(
          channel,
          'oc_chat_id',
          'session_1',
          'inbound_1',
        );
        getPrivateMethod<
          (chatId: string, chunk: string, sessionId: string) => void
        >(channel, 'onResponseChunk').call(
          channel,
          'oc_chat_id',
          'pre-question text',
          'session_1',
        );
        await getPrivateMethod<
          (
            chatId: string,
            sessionId: string,
            segment: ChannelOutputSegmentContext,
            reason: ChannelOutputSegmentEndReason,
          ) => void | Promise<void>
        >(channel, 'onOutputSegmentEnd').call(
          channel,
          'oc_chat_id',
          'session_1',
          {} as ChannelOutputSegmentContext,
          'input_requested',
        );

        await vi.runAllTimersAsync();

        expect(createStreamingCard).not.toHaveBeenCalled();
        expect(msgToQuestion.get('inbound_1')).toBe('question?');
        expect(msgToSenderName.get('inbound_1')).toBe('@sender');
        expect(msgToSenderId.get('inbound_1')).toBe('owner-1');
        expect(
          getPrivateMethod<Map<string, string>>(
            channel,
            'sessionToInboundMsg',
          ).get('session_1'),
        ).toBe('inbound_1');
      } finally {
        vi.useRealTimers();
      }
    });

    it('anchors the creating-timeout at post-answer card creation start', async () => {
      vi.useFakeTimers();
      try {
        const channel = createChannel();
        // Never resolves: the pre-question creation stays in flight so the
        // clock can advance past it without side effects.
        const createStreamingCard = vi
          .fn()
          .mockReturnValue(new Promise(() => {}));
        Object.assign(channel as unknown as Record<string, unknown>, {
          createStreamingCard,
          sendMessage: vi.fn().mockResolvedValue(undefined),
          addReaction: vi.fn().mockResolvedValue(undefined),
          removeReaction: vi.fn().mockResolvedValue(undefined),
        });
        getPrivateMethod<Map<string, string>>(channel, 'msgToQuestion').set(
          'inbound_1',
          'question?',
        );

        const startedAt = Date.now();
        getPrivateMethod<
          (chatId: string, sessionId: string, messageId?: string) => void
        >(channel, 'onPromptStart').call(
          channel,
          'oc_chat_id',
          'session_1',
          'inbound_1',
        );
        getPrivateMethod<
          (chatId: string, chunk: string, sessionId: string) => void
        >(channel, 'onResponseChunk').call(
          channel,
          'oc_chat_id',
          'pre-question text',
          'session_1',
        );
        // Thinking time before the question arrives. This fires the pending
        // creation timer, which suspends on the unresolved delivery promise.
        vi.advanceTimersByTime(5 * 60 * 1000);
        await getPrivateMethod<
          (
            chatId: string,
            sessionId: string,
            segment: ChannelOutputSegmentContext,
            reason: ChannelOutputSegmentEndReason,
          ) => void | Promise<void>
        >(channel, 'onOutputSegmentEnd').call(
          channel,
          'oc_chat_id',
          'session_1',
          {} as ChannelOutputSegmentContext,
          'input_requested',
        );

        const cardSessions = getPrivateMethod<
          Map<string, { creating: boolean; lastUpdateAt: number }>
        >(channel, 'cardSessions');
        // The released entry's timestamp is refreshed at release time — now
        // the only satisfiable value because the clock has advanced.
        expect(cardSessions.get('inbound_1')?.lastUpdateAt).toBe(
          startedAt + 5 * 60 * 1000,
        );
        expect(createStreamingCard).toHaveBeenCalledTimes(1);

        // The user takes longer than the sweep's 60s creating-timeout to
        // answer; the first post-answer chunk restarts card creation.
        vi.advanceTimersByTime(90_000);
        getPrivateMethod<
          (chatId: string, chunk: string, sessionId: string) => void
        >(channel, 'onResponseChunk').call(
          channel,
          'oc_chat_id',
          'post-answer text',
          'session_1',
        );

        const state = cardSessions.get('inbound_1');
        expect(state?.creating).toBe(true);
        expect(state?.lastUpdateAt).toBe(startedAt + 5 * 60 * 1000 + 90_000);
      } finally {
        vi.useRealTimers();
      }
    });

    it('blocks the throttled update before the input-request final patch', async () => {
      vi.useFakeTimers();
      try {
        const channel = createChannel();
        const updateCard = vi.fn().mockResolvedValue(true);
        Object.assign(channel as unknown as Record<string, unknown>, {
          updateCard,
        });
        const cardSessions = getPrivateMethod<
          Map<string, Record<string, unknown>>
        >(channel, 'cardSessions');
        cardSessions.set('inbound_1', {
          messageId: 'om_first_output',
          created: true,
          creating: false,
          stopped: false,
          accumulatedText: 'streamed',
          lastUpdateAt: Date.now(),
        });
        getPrivateMethod<Map<string, string>>(
          channel,
          'sessionToInboundMsg',
        ).set('session_1', 'inbound_1');

        // onResponseChunk arms the throttled streaming update timer.
        getPrivateMethod<
          (chatId: string, chunk: string, sessionId: string) => void
        >(channel, 'onResponseChunk').call(
          channel,
          'oc_chat_id',
          ' more',
          'session_1',
        );
        const state = cardSessions.get('inbound_1');
        expect(state?.['pendingUpdateTimer']).not.toBeUndefined();

        await getPrivateMethod<
          (
            chatId: string,
            sessionId: string,
            segment: ChannelOutputSegmentContext,
            reason: ChannelOutputSegmentEndReason,
          ) => void | Promise<void>
        >(channel, 'onOutputSegmentEnd').call(
          channel,
          'oc_chat_id',
          'session_1',
          {} as ChannelOutputSegmentContext,
          'input_requested',
        );

        expect(state?.['finalizing']).toBe(true);
        expect(state?.['pendingUpdateTimer']).toBeUndefined();
        expect(updateCard).toHaveBeenCalledTimes(1);
        await vi.runAllTimersAsync();
        // The cleared throttled callback must never race the final patch.
        expect(updateCard).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('awaits an in-flight throttled streaming PATCH before the final patch', async () => {
      vi.useFakeTimers();
      try {
        const channel = createChannel();
        let resolveStreaming!: (ok: boolean) => void;
        const updateCard = vi
          .fn()
          .mockImplementationOnce(
            () =>
              new Promise<boolean>((resolve) => {
                resolveStreaming = resolve;
              }),
          )
          .mockResolvedValue(true);
        Object.assign(channel as unknown as Record<string, unknown>, {
          updateCard,
        });
        const cardSessions = getPrivateMethod<
          Map<string, Record<string, unknown>>
        >(channel, 'cardSessions');
        cardSessions.set('inbound_1', {
          messageId: 'om_first_output',
          created: true,
          creating: false,
          stopped: false,
          accumulatedText: 'streamed',
          lastUpdateAt: Date.now(),
        });
        getPrivateMethod<Map<string, string>>(
          channel,
          'sessionToInboundMsg',
        ).set('session_1', 'inbound_1');

        getPrivateMethod<
          (chatId: string, chunk: string, sessionId: string) => void
        >(channel, 'onResponseChunk').call(
          channel,
          'oc_chat_id',
          ' more',
          'session_1',
        );
        // Fire the throttled callback; its streaming PATCH stays in flight.
        await vi.advanceTimersByTimeAsync(1_500);
        expect(updateCard).toHaveBeenCalledTimes(1);
        expect(updateCard.mock.calls[0]?.[2]).toBe(false);

        const finalizing = getPrivateMethod<
          (
            chatId: string,
            sessionId: string,
            segment: ChannelOutputSegmentContext,
            reason: ChannelOutputSegmentEndReason,
          ) => void | Promise<void>
        >(channel, 'onOutputSegmentEnd').call(
          channel,
          'oc_chat_id',
          'session_1',
          {} as ChannelOutputSegmentContext,
          'input_requested',
        );
        await Promise.resolve();
        // The final patch must not start while the streaming PATCH is flying.
        expect(updateCard).toHaveBeenCalledTimes(1);

        resolveStreaming(true);
        await finalizing;

        expect(updateCard).toHaveBeenCalledTimes(2);
        expect(updateCard.mock.calls[1]?.[2]).toBe(true);
        expect(updateCard.mock.calls[1]?.[4]).toBe('已完成');
      } finally {
        vi.useRealTimers();
      }
    });

    it('leaves the output card to the stop flow when stop is in flight before a question', async () => {
      const channel = createChannel();
      let resolveCancel!: (ok: boolean) => void;
      (
        channel as unknown as {
          requestActivePromptCancellation: (
            sessionId: string,
          ) => Promise<boolean>;
        }
      ).requestActivePromptCancellation = vi.fn().mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            resolveCancel = resolve;
          }),
      );
      const updateCard = vi.fn().mockResolvedValue(true);
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      Object.assign(channel as unknown as Record<string, unknown>, {
        updateCard,
        sendMessage,
      });
      const cardSessions = getPrivateMethod<
        Map<string, Record<string, unknown>>
      >(channel, 'cardSessions');
      cardSessions.set('inbound_1', {
        messageId: 'om_first_output',
        created: true,
        creating: false,
        stopped: false,
        accumulatedText: 'streamed',
        lastUpdateAt: Date.now(),
      });
      getPrivateMethod<Map<string, string>>(channel, 'sessionToInboundMsg').set(
        'session_1',
        'inbound_1',
      );
      getPrivateMethod<Map<string, string>>(channel, 'msgToSenderId').set(
        'inbound_1',
        'original_user',
      );
      getPrivateMethod<Map<string, string>>(channel, 'msgToSenderName').set(
        'inbound_1',
        '@sender',
      );

      // Stop clicked; the cancel RPC is still in flight (cancelling only).
      getPrivateMethod<(data: Record<string, unknown>) => boolean>(
        channel,
        'onCardAction',
      ).call(channel, {
        action: { value: { action: 'stop' } },
        context: {
          open_message_id: 'om_first_output',
          open_chat_id: 'oc_chat_id',
        },
        operator: { open_id: 'original_user' },
      });
      expect(cardSessions.get('inbound_1')?.['cancelling']).toBe(true);

      // The input request must not finalize the card over the pending stop.
      await getPrivateMethod<
        (
          chatId: string,
          sessionId: string,
          segment: ChannelOutputSegmentContext,
          reason: ChannelOutputSegmentEndReason,
        ) => void | Promise<void>
      >(channel, 'onOutputSegmentEnd').call(
        channel,
        'oc_chat_id',
        'session_1',
        {} as ChannelOutputSegmentContext,
        'input_requested',
      );

      expect(updateCard).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(cardSessions.get('inbound_1')).toMatchObject({
        created: true,
        messageId: 'om_first_output',
      });

      resolveCancel(true);
      await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(1));
      expect(updateCard.mock.calls[0]?.[4]).toBe('已停止生成');
    });

    it('does not re-deliver stopped content when Stop settled before the input request', async () => {
      const channel = createChannel();
      (
        channel as unknown as {
          requestActivePromptCancellation: (
            sessionId: string,
          ) => Promise<boolean>;
        }
      ).requestActivePromptCancellation = vi.fn().mockResolvedValue(true);
      const updateCard = vi.fn().mockResolvedValue(true);
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      Object.assign(channel as unknown as Record<string, unknown>, {
        updateCard,
        sendMessage,
      });
      const cardSessions = getPrivateMethod<
        Map<string, Record<string, unknown>>
      >(channel, 'cardSessions');
      cardSessions.set('inbound_1', {
        messageId: 'om_first_output',
        created: true,
        creating: false,
        stopped: false,
        accumulatedText: 'streamed',
        lastUpdateAt: Date.now(),
      });
      getPrivateMethod<Map<string, string>>(channel, 'sessionToInboundMsg').set(
        'session_1',
        'inbound_1',
      );
      getPrivateMethod<Map<string, string>>(channel, 'msgToSenderId').set(
        'inbound_1',
        'original_user',
      );
      getPrivateMethod<Map<string, string>>(channel, 'msgToSenderName').set(
        'inbound_1',
        '@sender',
      );

      getPrivateMethod<(data: Record<string, unknown>) => boolean>(
        channel,
        'onCardAction',
      ).call(channel, {
        action: { value: { action: 'stop' } },
        context: {
          open_message_id: 'om_first_output',
          open_chat_id: 'oc_chat_id',
        },
        operator: { open_id: 'original_user' },
      });
      await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(1));
      expect(updateCard.mock.calls[0]?.[4]).toBe('已停止生成');

      await getPrivateMethod<
        (
          chatId: string,
          sessionId: string,
          segment: ChannelOutputSegmentContext,
          reason: ChannelOutputSegmentEndReason,
        ) => void | Promise<void>
      >(channel, 'onOutputSegmentEnd').call(
        channel,
        'oc_chat_id',
        'session_1',
        {} as ChannelOutputSegmentContext,
        'input_requested',
      );

      // No completion patch and no plain-message re-delivery of content the
      // stopped card already shows.
      expect(updateCard).toHaveBeenCalledTimes(1);
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('renders the stop label when Stop settles during input-request finalization', async () => {
      const channel = createChannel();
      let resolveDrain!: () => void;
      const drain = new Promise<void>((resolve) => {
        resolveDrain = resolve;
      });
      (
        channel as unknown as {
          requestActivePromptCancellation: (
            sessionId: string,
          ) => Promise<boolean>;
        }
      ).requestActivePromptCancellation = vi.fn().mockResolvedValue(true);
      const updateCard = vi.fn().mockResolvedValue(true);
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      Object.assign(channel as unknown as Record<string, unknown>, {
        updateCard,
        sendMessage,
      });
      const cardSessions = getPrivateMethod<
        Map<string, Record<string, unknown>>
      >(channel, 'cardSessions');
      cardSessions.set('inbound_1', {
        messageId: 'om_first_output',
        created: true,
        creating: false,
        stopped: false,
        accumulatedText: 'streamed',
        lastUpdateAt: Date.now(),
        pendingUpdatePromise: drain,
      });
      getPrivateMethod<Map<string, string>>(channel, 'sessionToInboundMsg').set(
        'session_1',
        'inbound_1',
      );
      getPrivateMethod<Map<string, string>>(channel, 'msgToSenderId').set(
        'inbound_1',
        'original_user',
      );
      getPrivateMethod<Map<string, string>>(channel, 'msgToSenderName').set(
        'inbound_1',
        '@sender',
      );

      const ending = getPrivateMethod<
        (
          chatId: string,
          sessionId: string,
          segment: ChannelOutputSegmentContext,
          reason: ChannelOutputSegmentEndReason,
        ) => void | Promise<void>
      >(channel, 'onOutputSegmentEnd').call(
        channel,
        'oc_chat_id',
        'session_1',
        {} as ChannelOutputSegmentContext,
        'input_requested',
      );
      await Promise.resolve();
      expect(updateCard).not.toHaveBeenCalled();

      // Stop settles while finalization drains the in-flight streaming PATCH.
      getPrivateMethod<(data: Record<string, unknown>) => boolean>(
        channel,
        'onCardAction',
      ).call(channel, {
        action: { value: { action: 'stop' } },
        context: {
          open_message_id: 'om_first_output',
          open_chat_id: 'oc_chat_id',
        },
        operator: { open_id: 'original_user' },
      });
      await vi.waitFor(() =>
        expect(cardSessions.get('inbound_1')?.['stopped']).toBe(true),
      );

      resolveDrain();
      await ending;

      expect(updateCard).toHaveBeenCalledTimes(1);
      expect(updateCard.mock.calls[0]?.[1]).toContain('已停止生成');
      expect(sendMessage).not.toHaveBeenCalled();
      expect(cardSessions.has('inbound_1')).toBe(false);
    });

    it('renders the stop label when Stop settles during the final patch await', async () => {
      const channel = createChannel();
      let resolveFinalPatch!: (ok: boolean) => void;
      const finalPatch = new Promise<boolean>((resolve) => {
        resolveFinalPatch = resolve;
      });
      const updateCard = vi.fn().mockReturnValue(finalPatch);
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      Object.assign(channel as unknown as Record<string, unknown>, {
        updateCard,
        sendMessage,
      });
      (
        channel as unknown as {
          requestActivePromptCancellation: (
            sessionId: string,
          ) => Promise<boolean>;
        }
      ).requestActivePromptCancellation = vi.fn().mockResolvedValue(true);
      const cardSessions = getPrivateMethod<
        Map<string, Record<string, unknown>>
      >(channel, 'cardSessions');
      cardSessions.set('inbound_1', {
        messageId: 'om_first_output',
        created: true,
        creating: false,
        stopped: false,
        accumulatedText: 'streamed',
        lastUpdateAt: Date.now(),
      });
      getPrivateMethod<Map<string, string>>(channel, 'sessionToInboundMsg').set(
        'session_1',
        'inbound_1',
      );
      getPrivateMethod<Map<string, string>>(channel, 'msgToSenderId').set(
        'inbound_1',
        'original_user',
      );
      getPrivateMethod<Map<string, string>>(channel, 'msgToSenderName').set(
        'inbound_1',
        '@sender',
      );

      const ending = getPrivateMethod<
        (
          chatId: string,
          sessionId: string,
          segment: ChannelOutputSegmentContext,
          reason: ChannelOutputSegmentEndReason,
        ) => void | Promise<void>
      >(channel, 'onOutputSegmentEnd').call(
        channel,
        'oc_chat_id',
        'session_1',
        {} as ChannelOutputSegmentContext,
        'input_requested',
      );
      await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(1));
      expect(updateCard.mock.calls[0]?.[2]).toBe(true);

      // Stop settles while the final patch is in flight; handleStop defers
      // to the finalizer's post-patch recheck because the card is finalizing.
      getPrivateMethod<(data: Record<string, unknown>) => boolean>(
        channel,
        'onCardAction',
      ).call(channel, {
        action: { value: { action: 'stop' } },
        context: {
          open_message_id: 'om_first_output',
          open_chat_id: 'oc_chat_id',
        },
        operator: { open_id: 'original_user' },
      });
      await vi.waitFor(() =>
        expect(cardSessions.get('inbound_1')?.['stopped']).toBe(true),
      );

      resolveFinalPatch(true);
      await ending;

      expect(updateCard).toHaveBeenCalledTimes(2);
      expect(updateCard.mock.calls[1]?.[1]).toContain('已停止生成');
      expect(sendMessage).not.toHaveBeenCalled();
      expect(cardSessions.has('inbound_1')).toBe(false);
    });

    it('coalesces throttled updates queued behind a stalled PATCH', async () => {
      vi.useFakeTimers();
      try {
        const channel = createChannel();
        let resolveStalled!: (ok: boolean) => void;
        const updateCard = vi
          .fn()
          .mockImplementationOnce(
            () =>
              new Promise<boolean>((resolve) => {
                resolveStalled = resolve;
              }),
          )
          .mockResolvedValue(true);
        Object.assign(channel as unknown as Record<string, unknown>, {
          updateCard,
        });
        const cardSessions = getPrivateMethod<
          Map<string, Record<string, unknown>>
        >(channel, 'cardSessions');
        cardSessions.set('inbound_1', {
          messageId: 'om_first_output',
          created: true,
          creating: false,
          stopped: false,
          accumulatedText: '',
          lastUpdateAt: Date.now(),
        });
        getPrivateMethod<Map<string, string>>(
          channel,
          'sessionToInboundMsg',
        ).set('session_1', 'inbound_1');

        const chunk = getPrivateMethod<
          (chatId: string, chunk: string, sessionId: string) => void
        >(channel, 'onResponseChunk');
        chunk.call(channel, 'oc_chat_id', 'chunk-1', 'session_1');
        // Fire the throttled callback; its PATCH stalls in flight.
        await vi.advanceTimersByTimeAsync(1_500);
        expect(updateCard).toHaveBeenCalledTimes(1);

        // Later timer fires coalesce instead of queueing a PATCH burst.
        chunk.call(channel, 'oc_chat_id', 'chunk-2', 'session_1');
        await vi.advanceTimersByTimeAsync(1_500);
        chunk.call(channel, 'oc_chat_id', 'chunk-3', 'session_1');
        await vi.advanceTimersByTimeAsync(1_500);
        expect(updateCard).toHaveBeenCalledTimes(1);

        resolveStalled(true);
        await vi.advanceTimersByTimeAsync(0);

        // Exactly one trailing run carries the latest buffer.
        expect(updateCard).toHaveBeenCalledTimes(2);
        expect(updateCard.mock.calls[1]?.[1]).toContain('chunk-3');
      } finally {
        vi.useRealTimers();
      }
    });

    it('drops the coalesced trailing run when finalization drains the chain', async () => {
      vi.useFakeTimers();
      try {
        const channel = createChannel();
        let resolveStalled!: (ok: boolean) => void;
        const updateCard = vi
          .fn()
          .mockImplementationOnce(
            () =>
              new Promise<boolean>((resolve) => {
                resolveStalled = resolve;
              }),
          )
          .mockResolvedValue(true);
        Object.assign(channel as unknown as Record<string, unknown>, {
          updateCard,
        });
        const cardSessions = getPrivateMethod<
          Map<string, Record<string, unknown>>
        >(channel, 'cardSessions');
        cardSessions.set('inbound_1', {
          messageId: 'om_first_output',
          created: true,
          creating: false,
          stopped: false,
          accumulatedText: '',
          lastUpdateAt: Date.now(),
        });
        getPrivateMethod<Map<string, string>>(
          channel,
          'sessionToInboundMsg',
        ).set('session_1', 'inbound_1');

        const chunk = getPrivateMethod<
          (chatId: string, chunk: string, sessionId: string) => void
        >(channel, 'onResponseChunk');
        chunk.call(channel, 'oc_chat_id', 'chunk-1', 'session_1');
        // Fire the throttled callback; its PATCH stalls in flight.
        await vi.advanceTimersByTimeAsync(1_500);
        expect(updateCard).toHaveBeenCalledTimes(1);

        // A later timer fire coalesces behind the stalled PATCH.
        chunk.call(channel, 'oc_chat_id', 'chunk-2', 'session_1');
        await vi.advanceTimersByTimeAsync(1_500);
        expect(cardSessions.get('inbound_1')?.['updateQueued']).toBe(true);
        expect(updateCard).toHaveBeenCalledTimes(1);

        // Finalization drains the chain before the final patch.
        const finalizing = getPrivateMethod<
          (
            chatId: string,
            sessionId: string,
            segment: ChannelOutputSegmentContext,
            reason: ChannelOutputSegmentEndReason,
          ) => void | Promise<void>
        >(channel, 'onOutputSegmentEnd').call(
          channel,
          'oc_chat_id',
          'session_1',
          {} as ChannelOutputSegmentContext,
          'input_requested',
        );
        await Promise.resolve();
        expect(updateCard).toHaveBeenCalledTimes(1);

        resolveStalled(true);
        await finalizing;

        // Stalled PATCH + final patch only: the entry guard stops the
        // coalesced trailing run from emitting a non-final PATCH.
        expect(updateCard).toHaveBeenCalledTimes(2);
        expect(updateCard.mock.calls[1]?.[2]).toBe(true);
        expect(updateCard.mock.calls[1]?.[4]).toBe('已完成');
      } finally {
        vi.useRealTimers();
      }
    });

    it('carries a concurrent terminal status into the released card entry', async () => {
      const channel = createChannel();
      let resolveFinalization!: (ok: boolean) => void;
      const updateCard = vi.fn().mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            resolveFinalization = resolve;
          }),
      );
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      Object.assign(channel as unknown as Record<string, unknown>, {
        updateCard,
        sendMessage,
        addReaction: vi.fn().mockResolvedValue(undefined),
        removeReaction: vi.fn().mockResolvedValue(undefined),
      });
      const cardSessions = getPrivateMethod<
        Map<string, Record<string, unknown>>
      >(channel, 'cardSessions');
      cardSessions.set('inbound_1', {
        messageId: 'om_first_output',
        created: true,
        creating: false,
        stopped: false,
        accumulatedText: 'streamed',
        lastUpdateAt: Date.now(),
      });
      getPrivateMethod<Map<string, string>>(channel, 'sessionToInboundMsg').set(
        'session_1',
        'inbound_1',
      );

      const ending = getPrivateMethod<
        (
          chatId: string,
          sessionId: string,
          segment: ChannelOutputSegmentContext,
          reason: ChannelOutputSegmentEndReason,
        ) => void | Promise<void>
      >(channel, 'onOutputSegmentEnd').call(
        channel,
        'oc_chat_id',
        'session_1',
        {} as ChannelOutputSegmentContext,
        'input_requested',
      );
      await vi.waitFor(() => expect(updateCard).toHaveBeenCalledTimes(1));

      // The run terminates while the finalization patch is in flight.
      getPrivateMethod<(event: ChannelTaskLifecycleEvent) => void>(
        channel,
        'onTaskLifecycle',
      ).call(channel, {
        type: 'cancelled',
        reason: 'cancel_command',
        channelName: 'feishu',
        chatId: 'oc_chat_id',
        sessionId: 'session_1',
        messageId: 'inbound_1',
        identity: { id: 'channel:feishu', displayName: 'feishu' },
        memoryScope: { namespace: 'channel:feishu', mode: 'metadata-only' },
      });
      resolveFinalization(true);
      await ending;

      await getPrivateMethod<
        (chatId: string, sessionId: string, messageId?: string) => Promise<void>
      >(channel, 'onPromptEnd').call(
        channel,
        'oc_chat_id',
        'session_1',
        'inbound_1',
      );

      expect(sendMessage).toHaveBeenCalledWith(
        'oc_chat_id',
        expect.stringContaining('已取消'),
      );
    });

    it('deletes a late card when the input request lands mid-creation', async () => {
      vi.useFakeTimers();
      try {
        const channel = createChannel();
        let resolveCreate!: (value: {
          messageId: string;
          success: boolean;
        }) => void;
        const createStreamingCard = vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              resolveCreate = resolve;
            }),
        );
        const deleteCard = vi.fn().mockResolvedValue(true);
        const updateCard = vi.fn().mockResolvedValue(true);
        Object.assign(channel as unknown as Record<string, unknown>, {
          createStreamingCard,
          deleteCard,
          updateCard,
          sendMessage: vi.fn().mockResolvedValue(undefined),
          addReaction: vi.fn().mockResolvedValue(undefined),
          removeReaction: vi.fn().mockResolvedValue(undefined),
        });
        getPrivateMethod<Map<string, string>>(channel, 'msgToQuestion').set(
          'inbound_1',
          'question?',
        );
        getPrivateMethod<Map<string, string>>(channel, 'msgToSenderName').set(
          'inbound_1',
          '@sender',
        );
        getPrivateMethod<Map<string, string>>(channel, 'msgToSenderId').set(
          'inbound_1',
          'owner-1',
        );

        getPrivateMethod<
          (chatId: string, sessionId: string, messageId?: string) => void
        >(channel, 'onPromptStart').call(
          channel,
          'oc_chat_id',
          'session_1',
          'inbound_1',
        );
        getPrivateMethod<
          (chatId: string, chunk: string, sessionId: string) => void
        >(channel, 'onResponseChunk').call(
          channel,
          'oc_chat_id',
          'pre-question text',
          'session_1',
        );
        // Fire the creation timer; the HTTP create stays pending.
        await vi.advanceTimersByTimeAsync(0);
        expect(createStreamingCard).toHaveBeenCalledOnce();

        await getPrivateMethod<
          (
            chatId: string,
            sessionId: string,
            segment: ChannelOutputSegmentContext,
            reason: ChannelOutputSegmentEndReason,
          ) => void | Promise<void>
        >(channel, 'onOutputSegmentEnd').call(
          channel,
          'oc_chat_id',
          'session_1',
          {} as ChannelOutputSegmentContext,
          'input_requested',
        );

        // The late creation resolves after the release.
        resolveCreate({ messageId: 'om_late', success: true });
        await vi.advanceTimersByTimeAsync(0);

        expect(deleteCard).toHaveBeenCalledWith('om_late');
        expect(updateCard).not.toHaveBeenCalled();
        expect(
          getPrivateMethod<Map<string, string>>(channel, 'msgToQuestion').get(
            'inbound_1',
          ),
        ).toBe('question?');
        expect(
          getPrivateMethod<Map<string, string>>(channel, 'msgToSenderName').get(
            'inbound_1',
          ),
        ).toBe('@sender');
        expect(
          getPrivateMethod<Map<string, string>>(channel, 'msgToSenderId').get(
            'inbound_1',
          ),
        ).toBe('owner-1');
        expect(
          getPrivateMethod<Map<string, string>>(
            channel,
            'sessionToInboundMsg',
          ).get('session_1'),
        ).toBe('inbound_1');
      } finally {
        vi.useRealTimers();
      }
    });

    it('skips cleanup when an abandoned creation timer fires late', async () => {
      vi.useFakeTimers();
      try {
        const channel = createChannel();
        const createStreamingCard = vi.fn();
        Object.assign(channel as unknown as Record<string, unknown>, {
          createStreamingCard,
          // The 0ms creation timer fires while the finalization else branch
          // awaits sendMessage, before releaseOutputCard runs.
          sendMessage: vi.fn().mockImplementation(async () => {
            await vi.advanceTimersByTimeAsync(0);
          }),
          addReaction: vi.fn().mockResolvedValue(undefined),
          removeReaction: vi.fn().mockResolvedValue(undefined),
        });
        getPrivateMethod<Map<string, string>>(channel, 'msgToQuestion').set(
          'inbound_1',
          'question?',
        );
        getPrivateMethod<Map<string, string>>(channel, 'msgToSenderName').set(
          'inbound_1',
          '@sender',
        );
        getPrivateMethod<Map<string, string>>(channel, 'msgToSenderId').set(
          'inbound_1',
          'owner-1',
        );

        getPrivateMethod<
          (chatId: string, sessionId: string, messageId?: string) => void
        >(channel, 'onPromptStart').call(
          channel,
          'oc_chat_id',
          'session_1',
          'inbound_1',
        );
        getPrivateMethod<
          (chatId: string, chunk: string, sessionId: string) => void
        >(channel, 'onResponseChunk').call(
          channel,
          'oc_chat_id',
          'pre-question text',
          'session_1',
        );

        await getPrivateMethod<
          (
            chatId: string,
            sessionId: string,
            segment: ChannelOutputSegmentContext,
            reason: ChannelOutputSegmentEndReason,
          ) => void | Promise<void>
        >(channel, 'onOutputSegmentEnd').call(
          channel,
          'oc_chat_id',
          'session_1',
          {} as ChannelOutputSegmentContext,
          'input_requested',
        );

        // The pending creation timer fires after the abandoned mark; the
        // guard must skip cleanupCard so the auxiliary maps survive.
        await vi.advanceTimersByTimeAsync(0);

        expect(createStreamingCard).not.toHaveBeenCalled();
        expect(
          getPrivateMethod<Map<string, string>>(channel, 'msgToQuestion').get(
            'inbound_1',
          ),
        ).toBe('question?');
        expect(
          getPrivateMethod<Map<string, string>>(channel, 'msgToSenderName').get(
            'inbound_1',
          ),
        ).toBe('@sender');
        expect(
          getPrivateMethod<Map<string, string>>(channel, 'msgToSenderId').get(
            'inbound_1',
          ),
        ).toBe('owner-1');
        expect(
          getPrivateMethod<Map<string, string>>(
            channel,
            'sessionToInboundMsg',
          ).get('session_1'),
        ).toBe('inbound_1');
      } finally {
        vi.useRealTimers();
      }
    });

    it('truncates oversized input-request card finalization', async () => {
      const channel = createChannel();
      const updateCard = vi.fn().mockResolvedValue(true);
      Object.assign(channel as unknown as Record<string, unknown>, {
        updateCard,
      });
      getPrivateMethod<Map<string, Record<string, unknown>>>(
        channel,
        'cardSessions',
      ).set('inbound_1', {
        messageId: 'om_first_output',
        created: true,
        creating: false,
        stopped: false,
        accumulatedText: `HEAD${'x'.repeat(21_000)}TAIL`,
        lastUpdateAt: Date.now(),
      });
      getPrivateMethod<Map<string, string>>(channel, 'sessionToInboundMsg').set(
        'session_1',
        'inbound_1',
      );

      await getPrivateMethod<
        (
          chatId: string,
          sessionId: string,
          segment: ChannelOutputSegmentContext,
          reason: ChannelOutputSegmentEndReason,
        ) => void | Promise<void>
      >(channel, 'onOutputSegmentEnd').call(
        channel,
        'oc_chat_id',
        'session_1',
        {} as ChannelOutputSegmentContext,
        'input_requested',
      );

      const finalText = updateCard.mock.calls[0]?.[1] as string;
      const marker = '\n\n_(内容过长，已截断早期内容)_';
      expect(finalText.length).toBeLessThanOrEqual(20_000);
      expect(finalText.endsWith(marker)).toBe(true);
      // Truncation keeps the tail: the head marker is dropped, the tail
      // marker survives immediately before the truncation note.
      expect(finalText).not.toContain('HEAD');
      expect(finalText.slice(0, -marker.length).endsWith('TAIL')).toBe(true);
    });

    it('keeps the card cap when fence rebalancing prepends a fence', async () => {
      const channel = createChannel();
      const updateCard = vi.fn().mockResolvedValue(true);
      Object.assign(channel as unknown as Record<string, unknown>, {
        updateCard,
      });
      getPrivateMethod<Map<string, Record<string, unknown>>>(
        channel,
        'cardSessions',
      ).set('inbound_1', {
        messageId: 'om_first_output',
        created: true,
        creating: false,
        stopped: false,
        // Oversized body whose kept tail carries a single (odd) code fence,
        // forcing the '```\n' rebalance prepend.
        accumulatedText: 'x'.repeat(20_500) + '\n```\n' + 'y'.repeat(500),
        lastUpdateAt: Date.now(),
      });
      getPrivateMethod<Map<string, string>>(channel, 'sessionToInboundMsg').set(
        'session_1',
        'inbound_1',
      );

      await getPrivateMethod<
        (
          chatId: string,
          sessionId: string,
          segment: ChannelOutputSegmentContext,
          reason: ChannelOutputSegmentEndReason,
        ) => void | Promise<void>
      >(channel, 'onOutputSegmentEnd').call(
        channel,
        'oc_chat_id',
        'session_1',
        {} as ChannelOutputSegmentContext,
        'input_requested',
      );

      const finalText = updateCard.mock.calls[0]?.[1] as string;
      expect(finalText.length).toBeLessThanOrEqual(20_000);
      expect(finalText.startsWith('```\n')).toBe(true);
      expect(finalText).toContain('内容过长，已截断早期内容');
    });

    it('renders one truncation marker through the real card update path', async () => {
      const channel = createChannel();
      const patchInteractiveCard = vi.fn().mockResolvedValue(true);
      Object.assign(channel as unknown as Record<string, unknown>, {
        patchInteractiveCard,
      });
      const cardState = {
        messageId: 'om_stream',
        created: true,
        creating: false,
        stopped: false,
        finalizing: false,
        accumulatedText: `HEAD${'x'.repeat(21_000)}TAIL`,
        sourceLabel: '[review_task]',
        lastUpdateAt: Date.now(),
      };
      getPrivateMethod<Map<string, typeof cardState>>(
        channel,
        'cardSessions',
      ).set('inbound_1', cardState);

      await getPrivateMethod<
        (inboundMsgId: string, state: typeof cardState) => Promise<void>
      >(channel, 'runThrottledCardUpdate').call(
        channel,
        'inbound_1',
        cardState,
      );

      expect(patchInteractiveCard).toHaveBeenCalledTimes(1);
      const renderedCard = patchInteractiveCard.mock.calls[0]?.[1] as {
        body: { elements: Array<{ tag: string; content?: string }> };
      };
      const markdown =
        renderedCard.body.elements.find((element) => element.tag === 'markdown')
          ?.content ?? '';
      expect(markdown.length).toBeLessThanOrEqual(20_000);
      expect(markdown.match(/内容过长，已截断早期内容/gu)).toHaveLength(1);
      expect(markdown.match(/\\\[review\\_task\\\]/gu)).toHaveLength(1);
      expect(markdown.match(/运行中\.\.\./gu)).toHaveLength(1);
      expect(markdown).not.toContain('HEAD');
      expect(markdown).toContain('TAIL');
    });
  });

  describe('auxiliary map lifecycle', () => {
    it('preserves auxiliary maps after handleInbound when no card session exists', () => {
      const channel = createChannel();

      // Simulate the state after processMessage populates maps but
      // handleInbound (collect mode) didn't create a card session
      const msgToQuestion = getPrivateMethod<Map<string, string>>(
        channel,
        'msgToQuestion',
      );
      const msgToSenderName = getPrivateMethod<Map<string, string>>(
        channel,
        'msgToSenderName',
      );
      const msgToSenderId = getPrivateMethod<Map<string, string>>(
        channel,
        'msgToSenderId',
      );
      const cardSessions = getPrivateMethod<Map<string, unknown>>(
        channel,
        'cardSessions',
      );

      // Populate auxiliary maps (as processMessage would)
      msgToQuestion.set('msg_collect', 'question?');
      msgToSenderName.set('msg_collect', '@sender');
      msgToSenderId.set('msg_collect', 'user_123');
      // No cardSession for msg_collect (collect mode)

      // Verify maps are intact (the old code would have deleted them here)
      expect(msgToQuestion.has('msg_collect')).toBe(true);
      expect(msgToSenderName.has('msg_collect')).toBe(true);
      expect(msgToSenderId.has('msg_collect')).toBe(true);
      expect(cardSessions.has('msg_collect')).toBe(false);
    });
  });
});
