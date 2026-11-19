/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WecomSettings } from './managed-wecom-adapter.js';

// The deps witnesses run against a fake SDK client mirroring the real SDK's
// verified quirks: connect() returns this synchronously (authentication is
// the async 'authenticated' event), sendMessage resolves with the receipt
// frame and rejects with the frame itself on non-zero errcode or with an
// Error on ack timeout, and a kick is 'event.disconnected_event'.

const mockState = vi.hoisted(() => ({
  options: null as null | Record<string, unknown>,
  instance: null as null | {
    connected: boolean;
    emit: (event: string, ...args: unknown[]) => void;
  },
  sendBehavior: 'ok' as 'ok' | 'errcode' | 'timeout' | 'throw',
  sent: [] as Array<{ chatid: string; body: unknown }>,
  disconnects: 0,
}));

vi.mock('@wecom/aibot-node-sdk', () => {
  class FakeWSClient {
    private listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    connected = false;
    constructor(options: Record<string, unknown>) {
      mockState.options = options;
      mockState.instance = this;
    }
    on(event: string, handler: (...args: unknown[]) => void): this {
      if (!this.listeners.has(event)) this.listeners.set(event, new Set());
      this.listeners.get(event)!.add(handler);
      return this;
    }
    off(event: string, handler: (...args: unknown[]) => void): this {
      this.listeners.get(event)?.delete(handler);
      return this;
    }
    emit(event: string, ...args: unknown[]): void {
      for (const handler of [...(this.listeners.get(event) ?? [])]) {
        handler(...args);
      }
    }
    connect(): this {
      // The real SDK constructs the socket synchronously and authenticates
      // asynchronously; the test drives the events explicitly.
      return this;
    }
    disconnect(): void {
      mockState.disconnects += 1;
      this.connected = false;
    }
    get isConnected(): boolean {
      return this.connected;
    }
    async sendMessage(chatid: string, body: unknown): Promise<unknown> {
      mockState.sent.push({ chatid, body });
      if (mockState.sendBehavior === 'errcode') {
        // The real SDK rejects with the receipt frame itself, not an Error.
        throw {
          headers: { req_id: 'r' },
          errcode: 45009,
          errmsg: 'rate limited',
        };
      }
      if (mockState.sendBehavior === 'timeout') {
        throw new Error('Reply ack timeout (5000ms) for reqId: r');
      }
      if (mockState.sendBehavior === 'throw') {
        throw new Error('WebSocket is not open');
      }
      return { headers: { req_id: 'r' }, errcode: 0, errmsg: 'ok' };
    }
  }
  return { WSClient: FakeWSClient };
});

import { createManagedWecomDeps } from './managed-wecom-deps.js';

const SETTINGS: WecomSettings = {
  botId: 'bot-1',
  secret: 'secret',
  pollInterval: 2_000,
};

function textFrame(overrides: Record<string, unknown> = {}) {
  return {
    cmd: 'aibot_msg_callback',
    headers: { req_id: 'req-1' },
    body: {
      msgid: 'msg-1',
      msgtype: 'text',
      chattype: 'single',
      aibotid: 'bot-1',
      from: { userid: 'user-1' },
      text: { content: 'hello' },
      ...overrides,
    },
  };
}

function setup() {
  const deps = createManagedWecomDeps();
  const received: Array<{ messageId: string; data: string }> = [];
  const stops: string[] = [];
  const stream = deps.createStreamClient(
    SETTINGS,
    (messageId, data) => received.push({ messageId, data }),
    (reason) => stops.push(reason),
  );
  return { deps, stream, received, stops };
}

async function authenticatedSetup() {
  const ctx = setup();
  const connecting = ctx.stream.connect();
  mockState.instance!.connected = true;
  mockState.instance!.emit('authenticated');
  await connecting;
  return ctx;
}

beforeEach(() => {
  mockState.options = null;
  mockState.instance = null;
  mockState.sendBehavior = 'ok';
  mockState.sent = [];
  mockState.disconnects = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('managed WeCom deps stream lifecycle', () => {
  it('constructs the client with infinite retry and the configured wsUrl', async () => {
    const deps = createManagedWecomDeps();
    const stream = deps.createStreamClient(
      { ...SETTINGS, wsUrl: 'wss://example.invalid/ws' },
      () => {},
      () => {},
    );
    const connecting = stream.connect();
    expect(mockState.options).toMatchObject({
      botId: 'bot-1',
      secret: 'secret',
      wsUrl: 'wss://example.invalid/ws',
      maxReconnectAttempts: -1,
      maxAuthFailureAttempts: -1,
    });
    mockState.instance!.emit('authenticated');
    await connecting;
    stream.disconnect();
  });

  it('isConnected tracks authentication, not the socket reaching OPEN', async () => {
    const { deps, stream } = setup();
    const connecting = stream.connect();
    // The SDK marks isConnected at WebSocket.OPEN, before the subscribe
    // acknowledgement. Readiness must stay false in that window so the claim
    // phase does not send on a socket that may still fail authentication.
    mockState.instance!.connected = true;
    expect(deps.isConnected()).toBe(false);
    mockState.instance!.emit('authenticated');
    await connecting;
    expect(deps.isConnected()).toBe(true);
    // A transient disconnect clears readiness; the socket reopening alone does
    // not restore it until the replacement socket authenticates.
    mockState.instance!.emit('disconnected', 'reconnect backoff');
    expect(deps.isConnected()).toBe(false);
    mockState.instance!.connected = true; // socket OPEN again, auth pending
    expect(deps.isConnected()).toBe(false);
    mockState.instance!.emit('authenticated');
    expect(deps.isConnected()).toBe(true);
    stream.disconnect();
    expect(deps.isConnected()).toBe(false);
  });

  it('connect resolves only on the authenticated event', async () => {
    const { stream } = setup();
    let resolved = false;
    const connecting = stream.connect().then(() => {
      resolved = true;
    });
    // The socket is constructed but not authenticated: connect must wait.
    await new Promise((resolve) => setImmediate(resolve));
    expect(resolved).toBe(false);
    mockState.instance!.emit('authenticated');
    await connecting;
    expect(resolved).toBe(true);
    stream.disconnect();
  });

  it('connect rejects on the authentication timeout', async () => {
    vi.useFakeTimers();
    const { stream } = setup();
    const connecting = stream.connect();
    const assertion = expect(connecting).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(mockState.disconnects).toBeGreaterThan(0);
  });

  it('connect rejects on an auth error and sanitizes the message', async () => {
    const { stream } = setup();
    const connecting = stream.connect();
    mockState.instance!.emit(
      'error',
      new Error('Authentication failed: line one\nline two'),
    );
    await expect(connecting).rejects.toThrow(/Authentication failed/);
    // The multi-line SDK error must not forge a second log line.
    await expect(connecting).rejects.toThrow(/line one\\nline two/);
    expect(mockState.disconnects).toBeGreaterThan(0);
  });

  it('connect rejects on a kick before authentication', async () => {
    const { stream, stops } = setup();
    const connecting = stream.connect();
    mockState.instance!.emit('event.disconnected_event', {});
    await expect(connecting).rejects.toThrow(/kick/);
    // The pre-auth kick is the connect failure, not a post-connect stop.
    expect(stops).toEqual([]);
  });

  it('routes only message.text frames, as (msgid, JSON body)', async () => {
    const { stream, received } = await authenticatedSetup();
    mockState.instance!.emit('message.text', textFrame());
    expect(received).toHaveLength(1);
    expect(received[0]!.messageId).toBe('msg-1');
    expect(JSON.parse(received[0]!.data)).toMatchObject({
      msgid: 'msg-1',
      text: { content: 'hello' },
    });
    // Other message types never reach the adapter: the deps subscribe only
    // to message.text.
    mockState.instance!.emit('message.image', textFrame({ msgtype: 'image' }));
    mockState.instance!.emit('message', textFrame());
    expect(received).toHaveLength(1);
    stream.disconnect();
  });

  it('drops a frame without a msgid', async () => {
    const { stream, received } = await authenticatedSetup();
    mockState.instance!.emit('message.text', textFrame({ msgid: '' }));
    mockState.instance!.emit('message.text', textFrame({ msgid: undefined }));
    expect(received).toEqual([]);
    stream.disconnect();
  });

  it('drops messages before authentication', async () => {
    const { stream, received } = setup();
    const connecting = stream.connect();
    mockState.instance!.emit('message.text', textFrame());
    expect(received).toEqual([]);
    mockState.instance!.emit('authenticated');
    await connecting;
    stream.disconnect();
  });

  it('a kick after authentication invokes onStopped exactly once and clears the send path', async () => {
    const { deps, stream, stops } = await authenticatedSetup();
    mockState.instance!.emit('event.disconnected_event', {});
    expect(stops).toHaveLength(1);
    expect(stops[0]).toContain('displaced');
    // A second kick event must not stop the adapter twice.
    mockState.instance!.emit('event.disconnected_event', {});
    expect(stops).toHaveLength(1);
    // The send path rides the live client; after the kick it fails transient.
    await expect(deps.sendMessage('user-1', 'reply')).rejects.toThrow(
      /not connected/,
    );
    expect(mockState.sent).toEqual([]);
    stream.disconnect();
  });

  it('a kick during reauthentication still displaces the established adapter', async () => {
    const { deps, stream, stops } = await authenticatedSetup();
    // A transient disconnect clears send readiness, but the stream stays
    // established (the initial handshake completed).
    mockState.instance!.emit('disconnected', 'network blip');
    expect(deps.isConnected()).toBe(false);
    // The replacement socket is kicked BEFORE it re-authenticates. The kick is
    // terminal regardless of current readiness: the displacement handler must
    // fire once, not be ignored because authenticated is false (the SDK treats
    // the kick as terminal and disables reconnect, so an ignored kick would
    // leave the adapter holding its lock and deregistering the new owner).
    mockState.instance!.emit('event.disconnected_event', {});
    expect(stops).toHaveLength(1);
    expect(stops[0]).toContain('displaced');
    expect(deps.isConnected()).toBe(false);
    // A second kick must not stop the adapter twice.
    mockState.instance!.emit('event.disconnected_event', {});
    expect(stops).toHaveLength(1);
    stream.disconnect();
  });

  it('disconnect clears the send path', async () => {
    const { deps, stream } = await authenticatedSetup();
    stream.disconnect();
    await expect(deps.sendMessage('user-1', 'reply')).rejects.toThrow(
      /not connected/,
    );
  });
});

describe('managed WeCom deps send path', () => {
  it('sends a within-budget segment as one markdown message', async () => {
    const { deps, stream } = await authenticatedSetup();
    await deps.sendMessage('user-1', 'a short reply');
    expect(mockState.sent).toEqual([
      {
        chatid: 'user-1',
        body: { msgtype: 'markdown', markdown: { content: 'a short reply' } },
      },
    ]);
    stream.disconnect();
  });

  it('splits an over-budget segment into ordered provider-sized chunks', async () => {
    const { deps, stream } = await authenticatedSetup();
    // ~12k bytes of plain text: several 3,800-byte-target chunks, each within
    // the 20,000-byte hard cap, in order, all to the same chatid.
    const text = Array.from(
      { length: 40 },
      (_, i) => `paragraph ${i} ${'x'.repeat(280)}`,
    ).join('\n\n');
    await deps.sendMessage('user-1', text);
    expect(mockState.sent.length).toBeGreaterThan(1);
    for (const send of mockState.sent) {
      expect(send.chatid).toBe('user-1');
      const body = send.body as { markdown: { content: string } };
      expect(
        Buffer.byteLength(body.markdown.content, 'utf8'),
      ).toBeLessThanOrEqual(20_000);
    }
    // Order-preserving: the concatenation of the chunks recovers the source
    // text (the splitter may normalize whitespace at boundaries, so compare
    // the paragraph sequence instead of raw bytes).
    const joined = mockState.sent
      .map(
        (send) =>
          (send.body as { markdown: { content: string } }).markdown.content,
      )
      .join('\n\n');
    for (let i = 0; i < 40; i += 1) {
      expect(joined.indexOf(`paragraph ${i} `)).toBeGreaterThanOrEqual(0);
      if (i > 0) {
        expect(joined.indexOf(`paragraph ${i} `)).toBeGreaterThan(
          joined.indexOf(`paragraph ${i - 1} `),
        );
      }
    }
    stream.disconnect();
  });

  it('re-fences an oversized code block across chunks without a lone marker', async () => {
    const { deps, stream } = await authenticatedSetup();
    // The fence must exceed the 20,000-byte HARD cap to trigger the split at
    // all: a closed fence under the cap is emitted whole, so a smaller fixture
    // would assert parity on the unsplit original and witness nothing.
    const fence = '```\n' + 'code line\n'.repeat(2_100) + '```';
    const text = `before\n\n${fence}\n\nafter`;
    await deps.sendMessage('user-1', text);
    const contents = mockState.sent.map(
      (send) =>
        (send.body as { markdown: { content: string } }).markdown.content,
    );
    expect(contents.length).toBeGreaterThan(1);
    // No chunk may carry a lone fence marker: the splitter keeps the fence
    // together (or repeats it with a notice), never cuts inside the block
    // without re-fencing.
    for (const content of contents) {
      const opens = (content.match(/```/g) ?? []).length;
      expect(opens % 2).toBe(0);
    }
    stream.disconnect();
  });

  it('surfaces a non-zero-errcode receipt frame rejection', async () => {
    const { deps, stream } = await authenticatedSetup();
    mockState.sendBehavior = 'errcode';
    await expect(deps.sendMessage('user-1', 'reply')).rejects.toMatchObject({
      errcode: 45009,
    });
    stream.disconnect();
  });

  it('surfaces an ack timeout and a socket failure', async () => {
    const { deps, stream } = await authenticatedSetup();
    mockState.sendBehavior = 'timeout';
    await expect(deps.sendMessage('user-1', 'reply')).rejects.toThrow(
      /ack timeout/,
    );
    mockState.sendBehavior = 'throw';
    await expect(deps.sendMessage('user-1', 'reply')).rejects.toThrow(
      /not open/,
    );
    stream.disconnect();
  });

  it('a multi-chunk segment stops at the first failing chunk', async () => {
    const { deps, stream } = await authenticatedSetup();
    const text = Array.from(
      { length: 40 },
      (_, i) => `paragraph ${i} ${'x'.repeat(280)}`,
    ).join('\n\n');
    mockState.sendBehavior = 'errcode';
    await expect(deps.sendMessage('user-1', text)).rejects.toMatchObject({
      errcode: 45009,
    });
    // Exactly one chunk attempted: the failure aborts the rest of the
    // segment (the adapter receipts it unknown; the control plane re-claims).
    expect(mockState.sent).toHaveLength(1);
    stream.disconnect();
  });
});

describe('managed WeCom deps review fixes (round 2)', () => {
  it('a non-text frame is dropped with a latched diagnostic naming the type', async () => {
    const written: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      });
    const { stream, received, stops } = await authenticatedSetup();
    // The real SDK emits the generic 'message' event for every type, including
    // text. A text frame must NOT trip the non-text latch: without the
    // msgtype !== 'text' exemption the first text frame of every session would
    // write a false "dropped" line and set the latch, hiding later real drops.
    mockState.instance!.emit('message', textFrame());
    expect(written.filter((l) => l.includes('non-text frame'))).toEqual([]);
    // Now a genuine non-text frame: exactly one latched line naming the type.
    mockState.instance!.emit('message', textFrame({ msgtype: 'image' }));
    mockState.instance!.emit('message', textFrame({ msgtype: 'image' }));
    const nonText = written.filter((l) => l.includes('non-text frame'));
    expect(nonText).toHaveLength(1);
    expect(nonText[0]).toContain('image');
    expect(received).toEqual([]);
    expect(stops).toEqual([]);
    spy.mockRestore();
    stream.disconnect();
  });

  it('disconnect interrupts a pending connect promptly with the stop reason', async () => {
    const { stream } = setup();
    const connecting = stream.connect();
    // Never authenticate; disconnect must settle the handshake now, not 30s later.
    await new Promise((resolve) => setImmediate(resolve));
    stream.disconnect();
    await expect(connecting).rejects.toThrow(/stopped before authentication/);
  });

  it('the SDK error logger sanitizes a multi-line credential-bearing message', async () => {
    const written: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      });
    const { stream } = await authenticatedSetup();
    mockState.instance!.emit(
      'error',
      new Error('secret=ABC123\nsecond line\r\nthird'),
    );
    const errLines = written.filter((l) => l.includes('SDK error'));
    expect(errLines).toHaveLength(1);
    // One physical line: real newlines are rendered as escapes, not emitted.
    expect(errLines[0]!.includes('\nsecond line')).toBe(false);
    expect(errLines[0]).toContain('\\n');
    spy.mockRestore();
    stream.disconnect();
  });

  it('deps.lock creates the directory 0700 and a second acquire refuses', async () => {
    const { mkdtempSync, rmSync, statSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const parent = mkdtempSync(join(tmpdir(), 'wecom-lock-'));
    const dir = join(parent, 'state-dir');
    const deps = createManagedWecomDeps();
    const release = await deps.lock(dir, () => {});
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    // retries:0 → a second owner surfaces the refusal immediately, not blocks.
    await expect(deps.lock(dir, () => {})).rejects.toThrow();
    await release();
    rmSync(parent, { recursive: true, force: true });
  });

  it('a transient disconnect keeps the inbound gate open across reconnect', async () => {
    const { stream, received, stops } = await authenticatedSetup();
    mockState.instance!.emit('disconnected', 'network blip');
    // The SDK reconnects and re-authenticates on the same client; the deps
    // must NOT close the inbound gate (only a kick is fatal).
    mockState.instance!.emit('authenticated');
    mockState.instance!.emit('message.text', textFrame());
    expect(received).toHaveLength(1);
    expect(stops).toEqual([]);
    stream.disconnect();
  });
});
