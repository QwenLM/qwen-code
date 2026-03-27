import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChannelConfig, Envelope } from './types.js';
import type { AcpBridge } from './AcpBridge.js';
import { ChannelBase } from './ChannelBase.js';
import type { ChannelBaseOptions } from './ChannelBase.js';

// Concrete test implementation
class TestChannel extends ChannelBase {
  sent: Array<{ chatId: string; text: string }> = [];
  connected = false;

  async connect() {
    this.connected = true;
  }
  async sendMessage(chatId: string, text: string) {
    this.sent.push({ chatId, text });
  }
  disconnect() {
    this.connected = false;
  }
}

function createBridge(): AcpBridge {
  const emitter = new EventEmitter();
  let sessionCounter = 0;
  const bridge = Object.assign(emitter, {
    newSession: vi.fn().mockImplementation(() => `s-${++sessionCounter}`),
    loadSession: vi.fn(),
    prompt: vi.fn().mockResolvedValue('agent response'),
    stop: vi.fn(),
    start: vi.fn(),
    isConnected: true,
    availableCommands: [],
    setBridge: vi.fn(),
  });
  return bridge as unknown as AcpBridge;
}

function defaultConfig(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    type: 'test',
    token: 'tok',
    senderPolicy: 'open',
    allowedUsers: [],
    sessionScope: 'user',
    cwd: '/tmp',
    groupPolicy: 'disabled',
    groups: {},
    ...overrides,
  };
}

function envelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    channelName: 'test-chan',
    senderId: 'user1',
    senderName: 'User 1',
    chatId: 'chat1',
    text: 'hello',
    isGroup: false,
    isMentioned: false,
    isReplyToBot: false,
    ...overrides,
  };
}

describe('ChannelBase', () => {
  let bridge: AcpBridge;

  beforeEach(() => {
    bridge = createBridge();
  });

  function createChannel(
    configOverrides: Partial<ChannelConfig> = {},
    options?: ChannelBaseOptions,
  ): TestChannel {
    return new TestChannel(
      'test-chan',
      defaultConfig(configOverrides),
      bridge,
      options,
    );
  }

  describe('gate integration', () => {
    it('silently drops group messages when groupPolicy=disabled', async () => {
      const ch = createChannel();
      await ch.handleInbound(envelope({ isGroup: true }));
      expect(ch.sent).toEqual([]);
      expect(bridge.prompt).not.toHaveBeenCalled();
    });

    it('allows DM messages through', async () => {
      const ch = createChannel();
      await ch.handleInbound(envelope());
      expect(bridge.prompt).toHaveBeenCalled();
    });

    it('rejects sender with allowlist policy', async () => {
      const ch = createChannel({
        senderPolicy: 'allowlist',
        allowedUsers: ['admin'],
      });
      await ch.handleInbound(envelope({ senderId: 'stranger' }));
      expect(bridge.prompt).not.toHaveBeenCalled();
    });

    it('allows sender on allowlist', async () => {
      const ch = createChannel({
        senderPolicy: 'allowlist',
        allowedUsers: ['user1'],
      });
      await ch.handleInbound(envelope());
      expect(bridge.prompt).toHaveBeenCalled();
    });
  });

  describe('slash commands', () => {
    it('/help sends command list', async () => {
      const ch = createChannel();
      await ch.handleInbound(envelope({ text: '/help' }));
      expect(ch.sent).toHaveLength(1);
      expect(ch.sent[0]!.text).toContain('/help');
      expect(ch.sent[0]!.text).toContain('/clear');
      expect(bridge.prompt).not.toHaveBeenCalled();
    });

    it('/clear removes session and confirms', async () => {
      const ch = createChannel();
      // Create a session first
      await ch.handleInbound(envelope());
      ch.sent = [];
      // Now clear
      await ch.handleInbound(envelope({ text: '/clear' }));
      expect(ch.sent).toHaveLength(1);
      expect(ch.sent[0]!.text).toContain('Session cleared');
    });

    it('/clear reports when no session exists', async () => {
      const ch = createChannel();
      await ch.handleInbound(envelope({ text: '/clear' }));
      expect(ch.sent).toHaveLength(1);
      expect(ch.sent[0]!.text).toContain('No active session');
    });

    it('/reset and /new are aliases for /clear', async () => {
      for (const cmd of ['/reset', '/new']) {
        const ch = createChannel();
        await ch.handleInbound(envelope());
        ch.sent = [];
        await ch.handleInbound(envelope({ text: cmd }));
        expect(ch.sent[0]!.text).toContain('Session cleared');
      }
    });

    it('/status shows session info', async () => {
      const ch = createChannel();
      await ch.handleInbound(envelope({ text: '/status' }));
      expect(ch.sent).toHaveLength(1);
      expect(ch.sent[0]!.text).toContain('Session: none');
      expect(ch.sent[0]!.text).toContain('Access: open');
      expect(ch.sent[0]!.text).toContain('Channel: test-chan');
    });

    it('/status shows active session', async () => {
      const ch = createChannel();
      await ch.handleInbound(envelope({ text: 'hi' }));
      ch.sent = [];
      await ch.handleInbound(envelope({ text: '/status' }));
      expect(ch.sent[0]!.text).toContain('Session: active');
    });

    it('handles /command@botname format', async () => {
      const ch = createChannel();
      await ch.handleInbound(envelope({ text: '/help@mybot' }));
      expect(ch.sent).toHaveLength(1);
      expect(ch.sent[0]!.text).toContain('/help');
    });

    it('forwards unrecognized commands to agent', async () => {
      const ch = createChannel();
      await ch.handleInbound(envelope({ text: '/unknown' }));
      expect(bridge.prompt).toHaveBeenCalled();
    });
  });

  describe('custom commands', () => {
    it('subclass can register custom commands', async () => {
      const ch = createChannel();
      // Access protected method via the test subclass
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (ch as any).registerCommand('ping', async () => {
        await ch.sendMessage('chat1', 'pong');
        return true;
      });
      await ch.handleInbound(envelope({ text: '/ping' }));
      expect(ch.sent).toHaveLength(1);
      expect(ch.sent[0]!.text).toBe('pong');
      expect(bridge.prompt).not.toHaveBeenCalled();
    });

    it('/help shows platform-specific commands', async () => {
      const ch = createChannel();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (ch as any).registerCommand('start', async () => true);
      await ch.handleInbound(envelope({ text: '/help' }));
      expect(ch.sent[0]!.text).toContain('/start');
    });
  });

  describe('message enrichment', () => {
    it('prepends referenced text', async () => {
      const ch = createChannel();
      await ch.handleInbound(
        envelope({ text: 'my reply', referencedText: 'original message' }),
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const promptText = (bridge.prompt as any).mock.calls[0][1] as string;
      expect(promptText).toContain('[Replying to: "original message"]');
      expect(promptText).toContain('my reply');
    });

    it('appends file paths from attachments', async () => {
      const ch = createChannel();
      await ch.handleInbound(
        envelope({
          text: 'check this',
          attachments: [
            {
              type: 'file',
              filePath: '/tmp/test.pdf',
              mimeType: 'application/pdf',
              fileName: 'test.pdf',
            },
          ],
        }),
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const promptText = (bridge.prompt as any).mock.calls[0][1] as string;
      expect(promptText).toContain('/tmp/test.pdf');
      expect(promptText).toContain('"test.pdf"');
    });

    it('extracts image from attachments', async () => {
      const ch = createChannel();
      await ch.handleInbound(
        envelope({
          text: 'see image',
          attachments: [
            {
              type: 'image',
              data: 'base64data',
              mimeType: 'image/png',
            },
          ],
        }),
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const options = (bridge.prompt as any).mock.calls[0][2];
      expect(options.imageBase64).toBe('base64data');
      expect(options.imageMimeType).toBe('image/png');
    });

    it('uses legacy imageBase64 when no attachment image', async () => {
      const ch = createChannel();
      await ch.handleInbound(
        envelope({
          text: 'see image',
          imageBase64: 'legacydata',
          imageMimeType: 'image/jpeg',
        }),
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const options = (bridge.prompt as any).mock.calls[0][2];
      expect(options.imageBase64).toBe('legacydata');
    });

    it('prepends instructions on first message only', async () => {
      const ch = createChannel({ instructions: 'Be concise.' });
      await ch.handleInbound(envelope({ text: 'first' }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const firstPrompt = (bridge.prompt as any).mock.calls[0][1] as string;
      expect(firstPrompt).toContain('Be concise.');

      await ch.handleInbound(envelope({ text: 'second' }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const secondPrompt = (bridge.prompt as any).mock.calls[1][1] as string;
      expect(secondPrompt).not.toContain('Be concise.');
    });
  });

  describe('session routing', () => {
    it('creates new session on first message', async () => {
      const ch = createChannel();
      await ch.handleInbound(envelope());
      expect(bridge.newSession).toHaveBeenCalledTimes(1);
    });

    it('reuses session for same sender', async () => {
      const ch = createChannel();
      await ch.handleInbound(envelope());
      await ch.handleInbound(envelope());
      expect(bridge.newSession).toHaveBeenCalledTimes(1);
    });

    it('creates separate sessions for different senders', async () => {
      const ch = createChannel();
      await ch.handleInbound(envelope({ senderId: 'alice' }));
      await ch.handleInbound(envelope({ senderId: 'bob' }));
      expect(bridge.newSession).toHaveBeenCalledTimes(2);
    });
  });

  describe('response delivery', () => {
    it('sends agent response via sendMessage', async () => {
      const ch = createChannel();
      await ch.handleInbound(envelope());
      expect(ch.sent).toHaveLength(1);
      expect(ch.sent[0]!.text).toBe('agent response');
    });

    it('does not send when agent returns empty response', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (bridge.prompt as any).mockResolvedValue('');
      const ch = createChannel();
      await ch.handleInbound(envelope());
      expect(ch.sent).toEqual([]);
    });
  });

  describe('block streaming', () => {
    it('uses block streamer when blockStreaming=on', async () => {
      // The streamer sends blocks; onResponseComplete is NOT called
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (bridge.prompt as any).mockImplementation(
        (sid: string, _text: string) => {
          // Simulate streaming chunks
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (bridge as any).emit('textChunk', sid, 'Hello world! ');
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (bridge as any).emit('textChunk', sid, 'This is a test.');
          return Promise.resolve('Hello world! This is a test.');
        },
      );

      const ch = createChannel({
        blockStreaming: 'on',
        blockStreamingChunk: { minChars: 5, maxChars: 100 },
        blockStreamingCoalesce: { idleMs: 0 },
      });
      await ch.handleInbound(envelope());
      // BlockStreamer flush should have sent the accumulated text
      expect(ch.sent.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('pairing flow', () => {
    it('sends pairing code message when required', async () => {
      const ch = createChannel({ senderPolicy: 'pairing', allowedUsers: [] });
      await ch.handleInbound(envelope({ senderId: 'stranger' }));
      expect(ch.sent).toHaveLength(1);
      expect(ch.sent[0]!.text).toContain('pairing code');
      expect(bridge.prompt).not.toHaveBeenCalled();
    });
  });

  describe('setBridge', () => {
    it('replaces the bridge instance', async () => {
      const ch = createChannel();
      const newBridge = createBridge();
      ch.setBridge(newBridge);
      // The channel should use the new bridge for future messages
      // (this mainly ensures no crash)
      expect(() => ch.setBridge(newBridge)).not.toThrow();
    });
  });

  describe('isLocalCommand', () => {
    it('returns true for registered commands', () => {
      const ch = createChannel();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((ch as any).isLocalCommand('/help')).toBe(true);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((ch as any).isLocalCommand('/clear')).toBe(true);
    });

    it('returns false for non-commands', () => {
      const ch = createChannel();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((ch as any).isLocalCommand('hello')).toBe(false);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((ch as any).isLocalCommand('/unknown')).toBe(false);
    });
  });
});
