/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChannelAgentBridge, Envelope } from '@qwen-code/channel-base';

const { sendQQMessage } = vi.hoisted(() => ({ sendQQMessage: vi.fn() }));

vi.mock('./api.js', () => ({
  sendQQMessage,
  getApiBase: () => 'https://api.sgroup.qq.com',
  fetchAccessToken: vi.fn(),
  fetchGatewayUrl: vi.fn(),
}));
vi.mock('./accounts.js', () => ({
  getCredsFilePath: () => '/tmp/test-qq-turn-notice-creds.json',
  loadCredentials: () => null,
  saveCredentials: vi.fn(),
}));
vi.mock('./login.js', () => ({ qrCodeLogin: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
}));

const { QQChannel } = await import('./QQChannel.js');

class TestChannel extends QQChannel {
  receive(envelope: Envelope): Promise<void> {
    return this.handleInbound(envelope);
  }
}

describe('QQ turn notice delivery', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it.each([
    ['buffered', true],
    ['flushed', true],
    ['boundary', true],
    ['deferred', true],
    ['buffered', false],
    ['flushed', false],
    ['boundary', false],
    ['deferred', false],
  ] as const)(
    'delivers text once (%s, overflow=%s)',
    async (mode, overflow) => {
      vi.useFakeTimers();
      sendQQMessage.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => '',
      });
      let resolvePreviousSend: (() => void) | undefined;
      if (mode === 'deferred') {
        sendQQMessage.mockReturnValueOnce(
          new Promise((resolve) => {
            resolvePreviousSend = () =>
              resolve({ ok: true, status: 200, text: async () => '' });
          }),
        );
      }
      const notice =
        'Only the first 5 skills were loaded. Additional /skill tokens were treated as prompt text.';
      const body = 'MODEL_RESPONSE';
      const bridge = Object.assign(new EventEmitter(), {
        newSession: vi.fn().mockResolvedValue('s1'),
        prompt: vi.fn(async () => {
          if (overflow) bridge.emit('turnNotice', 's1', notice);
          bridge.emit('textChunk', 's1', body);
          if (mode === 'flushed') await vi.advanceTimersByTimeAsync(2_000);
          if (mode === 'boundary' || mode === 'deferred') {
            bridge.emit('responseBoundary', 's1');
            bridge.emit('textChunk', 's1', 'FINAL_RESPONSE');
          }
          const result =
            mode === 'boundary' || mode === 'deferred'
              ? 'FINAL_RESPONSE'
              : body;
          return overflow ? `${notice}\n\n${result}` : result;
        }),
      });
      const channel = new TestChannel(
        'test-bot',
        {
          type: 'qq',
          token: '',
          senderPolicy: 'open',
          allowedUsers: [],
          sessionScope: 'user',
          cwd: '/tmp',
          groupPolicy: 'disabled',
          dmPolicy: 'open',
          groups: {},
          appID: 'test-app',
          appSecret: 'test-secret',
        },
        bridge as unknown as ChannelAgentBridge,
        { registerBridgeEvents: false },
      );
      const raw = channel as unknown as {
        accessToken: string;
        tokenExpiresAt: number;
        chatTypeMap: Map<string, string>;
      };
      raw.accessToken = 'test-token';
      raw.tokenExpiresAt = Date.now() + 3_600_000;
      raw.chatTypeMap.set('chat1', 'c2c');

      if (mode === 'deferred') {
        bridge.prompt.mockImplementationOnce(async () => {
          bridge.emit('textChunk', 's1', 'PREVIOUS_RESPONSE');
          await vi.advanceTimersByTimeAsync(2_000);
          bridge.emit('textChunk', 's1', 'PREVIOUS_RESIDUAL');
          return 'PREVIOUS_RESPONSEPREVIOUS_RESIDUAL';
        });
        await channel.receive({
          channelName: 'test-bot',
          senderId: 'user1',
          senderName: 'Test user',
          chatId: 'chat1',
          messageId: 'previous-message',
          text: 'previous request',
          isGroup: false,
          isMentioned: false,
          isReplyToBot: false,
        });
      }

      await channel.receive({
        channelName: 'test-bot',
        senderId: 'user1',
        senderName: 'Test user',
        chatId: 'chat1',
        messageId: 'message1',
        text: overflow
          ? '/one /two /three /four /five /six request'
          : '/one /two /three /four /five request',
        isGroup: false,
        isMentioned: false,
        isReplyToBot: false,
      });

      if (resolvePreviousSend) {
        resolvePreviousSend();
        await vi.advanceTimersByTimeAsync(2_000);
      }
      expect(bridge.prompt).toHaveBeenCalledTimes(mode === 'deferred' ? 2 : 1);
      const delivered = sendQQMessage.mock.calls
        .map((call) => {
          const payload = call[3] as {
            markdown?: { content: string };
            content?: string;
          };
          return payload.markdown?.content ?? payload.content ?? '';
        })
        .join('\n');
      expect(delivered.split(body)).toHaveLength(2);
      if (mode === 'boundary' || mode === 'deferred') {
        expect(delivered.split('FINAL_RESPONSE')).toHaveLength(2);
      }
      if (mode === 'deferred') {
        expect(delivered.split('PREVIOUS_RESPONSE')).toHaveLength(2);
        expect(delivered.split('PREVIOUS_RESIDUAL')).toHaveLength(2);
      }
      expect(delivered.split(notice), delivered).toHaveLength(overflow ? 2 : 1);
    },
  );
});
