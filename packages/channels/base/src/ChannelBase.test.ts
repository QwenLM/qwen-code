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
  promptStarts: Array<{
    chatId: string;
    sessionId: string;
    messageId?: string;
  }> = [];
  promptEnds: Array<{ chatId: string; sessionId: string; messageId?: string }> =
    [];

  async connect() {
    this.connected = true;
  }
  async sendMessage(chatId: string, text: string) {
    this.sent.push({ chatId, text });
  }
  disconnect() {
    this.connected = false;
  }

  protected override onPromptStart(
    chatId: string,
    sessionId: string,
    messageId?: string,
  ): void {
    this.promptStarts.push({ chatId, sessionId, messageId });
  }

  protected override onPromptEnd(
    chatId: string,
    sessionId: string,
    messageId?: string,
  ): void {
    this.promptEnds.push({ chatId, sessionId, messageId });
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

  describe('dispatch modes', () => {
    it('collect: buffers messages and coalesces into one followup prompt', async () => {
      // Make the first prompt "slow" — we control when it resolves
      let resolveFirst!: (v: string) => void;
      const firstPrompt = new Promise<string>((r) => {
        resolveFirst = r;
      });
      let callCount = 0;
      (bridge.prompt as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        if (callCount === 1) return firstPrompt;
        return Promise.resolve('coalesced response');
      });

      const ch = createChannel({ dispatchMode: 'collect' });

      // Send first message — starts processing
      const p1 = ch.handleInbound(envelope({ text: 'first' }));

      // Wait a tick for the prompt to be registered as active
      await new Promise((r) => setTimeout(r, 10));

      // Send two more messages while first is busy — these should buffer
      const p2 = ch.handleInbound(envelope({ text: 'second' }));
      const p3 = ch.handleInbound(envelope({ text: 'third' }));

      // p2 and p3 should resolve immediately (buffered, not queued)
      await p2;
      await p3;

      // First prompt is still running, bridge.prompt called only once
      expect(callCount).toBe(1);

      // Resolve the first prompt
      resolveFirst('first response');
      await p1;

      // Wait for the coalesced followup to process
      await new Promise((r) => setTimeout(r, 50));

      // bridge.prompt should have been called twice: original + coalesced
      expect(callCount).toBe(2);

      // The second call should contain both buffered messages coalesced
      const secondCallText = (bridge.prompt as ReturnType<typeof vi.fn>).mock
        .calls[1][1] as string;
      expect(secondCallText).toContain('second');
      expect(secondCallText).toContain('third');

      // Both responses should have been sent
      expect(ch.sent).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: 'first response' }),
          expect.objectContaining({ text: 'coalesced response' }),
        ]),
      );
    });

    it('collect: no followup if no messages buffered', async () => {
      const ch = createChannel({ dispatchMode: 'collect' });
      await ch.handleInbound(envelope({ text: 'only message' }));
      expect(bridge.prompt).toHaveBeenCalledTimes(1);
      expect(ch.sent).toHaveLength(1);
    });

    it('steer: cancels running prompt and re-prompts with cancellation note', async () => {
      let resolveFirst!: (v: string) => void;
      const firstPrompt = new Promise<string>((r) => {
        resolveFirst = r;
      });
      let callCount = 0;
      (bridge.prompt as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        if (callCount === 1) return firstPrompt;
        return Promise.resolve('steered response');
      });

      // Add cancelSession mock
      (bridge as unknown as Record<string, unknown>).cancelSession = vi
        .fn()
        .mockImplementation(() => {
          // Simulate cancellation — resolve the first prompt
          resolveFirst('cancelled partial');
          return Promise.resolve();
        });

      const ch = createChannel({ dispatchMode: 'steer' });

      // Send first message — starts processing
      const p1 = ch.handleInbound(envelope({ text: 'refactor auth' }));

      // Wait for prompt to register as active
      await new Promise((r) => setTimeout(r, 10));

      // Send correction while first is busy
      const p2 = ch.handleInbound(
        envelope({ text: 'actually refactor billing' }),
      );

      // Both should resolve
      await p1;
      await p2;

      // cancelSession should have been called
      expect(
        (bridge as unknown as Record<string, () => unknown>).cancelSession,
      ).toHaveBeenCalledTimes(1);

      // First prompt's response should NOT have been sent (it was cancelled)
      expect(ch.sent).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: 'cancelled partial' }),
        ]),
      );

      // Second prompt should include the cancellation note
      const secondCallText = (bridge.prompt as ReturnType<typeof vi.fn>).mock
        .calls[1][1] as string;
      expect(secondCallText).toContain('previous request has been cancelled');
      expect(secondCallText).toContain('actually refactor billing');

      // Steered response should have been sent
      expect(ch.sent).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: 'steered response' }),
        ]),
      );
    });

    it('followup: queues messages sequentially', async () => {
      let resolveFirst!: (v: string) => void;
      const firstPrompt = new Promise<string>((r) => {
        resolveFirst = r;
      });
      let callCount = 0;
      (bridge.prompt as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        if (callCount === 1) return firstPrompt;
        return Promise.resolve(`response-${callCount}`);
      });

      const ch = createChannel({ dispatchMode: 'followup' });

      // Send first message
      const p1 = ch.handleInbound(envelope({ text: 'task one' }));

      // Wait for prompt to start
      await new Promise((r) => setTimeout(r, 10));

      // Send second message — should queue (not buffer)
      const p2 = ch.handleInbound(envelope({ text: 'task two' }));

      // Only first prompt should be running
      expect(callCount).toBe(1);

      // Resolve first
      resolveFirst('response-1');
      await p1;
      await p2;

      // Both prompts ran sequentially
      expect(callCount).toBe(2);

      // Both got their own response
      expect(ch.sent).toEqual([
        expect.objectContaining({ text: 'response-1' }),
        expect.objectContaining({ text: 'response-2' }),
      ]);
    });

    it('collect is the default mode when dispatchMode not set', async () => {
      let resolveFirst!: (v: string) => void;
      const firstPrompt = new Promise<string>((r) => {
        resolveFirst = r;
      });
      let callCount = 0;
      (bridge.prompt as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        if (callCount === 1) return firstPrompt;
        return Promise.resolve('coalesced response');
      });

      // cancelSession should NOT be called under collect — provide a mock so
      // we can assert it stays untouched.
      const cancelSessionMock = vi.fn().mockResolvedValue(undefined);
      (bridge as unknown as Record<string, unknown>).cancelSession =
        cancelSessionMock;

      // No dispatchMode set — should default to collect (matches the
      // documented default in ChannelConfig.dispatchMode JSDoc).
      const ch = createChannel();

      const p1 = ch.handleInbound(envelope({ text: 'first' }));
      await new Promise((r) => setTimeout(r, 10));

      // Second message arrives while first is in flight — collect mode
      // buffers it instead of cancelling the first.
      const p2 = ch.handleInbound(envelope({ text: 'second' }));
      await p2; // returns immediately after buffering

      // First still running, only one prompt call so far.
      expect(callCount).toBe(1);

      // Let the first prompt finish; the buffered second message drains as
      // a coalesced follow-up.
      resolveFirst('first response');
      await p1;
      await new Promise((r) => setTimeout(r, 50));

      // cancelSession should never be called under collect.
      expect(cancelSessionMock).not.toHaveBeenCalled();
      // Both prompts ran (first + coalesced follow-up).
      expect(callCount).toBe(2);
    });

    it('per-group dispatchMode overrides channel-level', async () => {
      let resolveFirst!: (v: string) => void;
      const firstPrompt = new Promise<string>((r) => {
        resolveFirst = r;
      });
      let callCount = 0;
      (bridge.prompt as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        if (callCount === 1) return firstPrompt;
        return Promise.resolve(`response-${callCount}`);
      });

      // Channel default is collect, but group overrides to followup
      const ch = createChannel({
        dispatchMode: 'collect',
        groupPolicy: 'open',
        groups: { 'group-1': { dispatchMode: 'followup' } },
      });

      const groupEnv = envelope({
        isGroup: true,
        isMentioned: true,
        chatId: 'group-1',
      });

      const p1 = ch.handleInbound({ ...groupEnv, text: 'first' });
      await new Promise((r) => setTimeout(r, 10));

      // In followup mode, second message queues (doesn't buffer and return)
      const p2Promise = ch.handleInbound({ ...groupEnv, text: 'second' });

      expect(callCount).toBe(1);

      resolveFirst('response-1');
      await p1;
      await p2Promise;

      // Both ran sequentially — followup behavior
      expect(callCount).toBe(2);
      expect(ch.sent).toEqual([
        expect.objectContaining({ text: 'response-1' }),
        expect.objectContaining({ text: 'response-2' }),
      ]);
    });
  });

  describe('prompt lifecycle hooks', () => {
    it('calls onPromptStart and onPromptEnd for each prompt', async () => {
      const ch = createChannel();
      await ch.handleInbound(envelope({ text: 'hello' }));

      expect(ch.promptStarts).toHaveLength(1);
      expect(ch.promptStarts[0]!.chatId).toBe('chat1');
      expect(ch.promptEnds).toHaveLength(1);
      expect(ch.promptEnds[0]!.chatId).toBe('chat1');
    });

    it('passes messageId to hooks', async () => {
      const ch = createChannel();
      await ch.handleInbound(envelope({ text: 'hello', messageId: 'msg-42' }));

      expect(ch.promptStarts[0]!.messageId).toBe('msg-42');
      expect(ch.promptEnds[0]!.messageId).toBe('msg-42');
    });

    it('does not call hooks for gated messages', async () => {
      const ch = createChannel({
        senderPolicy: 'allowlist',
        allowedUsers: ['admin'],
      });
      await ch.handleInbound(envelope({ senderId: 'stranger' }));

      expect(ch.promptStarts).toHaveLength(0);
      expect(ch.promptEnds).toHaveLength(0);
    });

    it('does not call hooks for buffered messages in collect mode', async () => {
      let resolveFirst!: (v: string) => void;
      const firstPrompt = new Promise<string>((r) => {
        resolveFirst = r;
      });
      let callCount = 0;
      (bridge.prompt as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        if (callCount === 1) return firstPrompt;
        return Promise.resolve('ok');
      });

      const ch = createChannel({ dispatchMode: 'collect' });

      const p1 = ch.handleInbound(
        envelope({ text: 'first', messageId: 'msg-1' }),
      );
      await new Promise((r) => setTimeout(r, 10));

      // This message gets buffered — should NOT trigger hooks
      await ch.handleInbound(envelope({ text: 'second', messageId: 'msg-2' }));

      // Only one prompt start so far (for the first message)
      expect(ch.promptStarts).toHaveLength(1);
      expect(ch.promptStarts[0]!.messageId).toBe('msg-1');

      resolveFirst('done');
      await p1;
      await new Promise((r) => setTimeout(r, 50));

      // After coalesced prompt runs, we should have 2 start/end pairs
      expect(ch.promptStarts).toHaveLength(2);
      expect(ch.promptEnds).toHaveLength(2);
    });

    it('calls onPromptEnd even when prompt throws', async () => {
      (bridge.prompt as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('agent error'),
      );

      const ch = createChannel();
      // handleInbound catches the error internally
      await ch.handleInbound(envelope({ text: 'hello' })).catch(() => {});

      expect(ch.promptStarts).toHaveLength(1);
      expect(ch.promptEnds).toHaveLength(1);
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
