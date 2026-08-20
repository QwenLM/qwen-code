/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

import { afterEach, describe, it, expect, vi } from 'vitest';
import { AuthType } from '@qwen-code/qwen-code-core';
import { createVoiceWsConnectionHandler } from './voice-ws.js';
import { WorkspaceVoiceCoordinator } from './workspace-voice-coordinator.js';
import type { DaemonVoiceContext } from './resolve-voice-config.js';
import type { VoiceStreamSession } from '../../ui/voice/voice-stream-session.js';
import type { WorkspaceRuntime } from '../workspace-registry.js';

// The daemon defaults (defaultOpenStream/defaultTranscribe) pass the resolved
// config into assertVoiceBaseUrlNetworkAllowed; the default-wiring tests below
// drive them without injected openStream/transcribe, so the upstream `ws`
// module is swapped for a dial-recording fake to keep the tests offline.
const { FakeUpstreamSocket } = vi.hoisted(() => {
  class FakeUpstreamSocket {
    static instances: FakeUpstreamSocket[] = [];
    readonly OPEN = 1;
    readyState = this.OPEN;
    readonly url: string;
    readonly sent: Array<string | Uint8Array> = [];
    private readonly handlers = new Map<
      string,
      Array<(...args: unknown[]) => void>
    >();

    constructor(url: string, _options?: unknown) {
      this.url = url;
      FakeUpstreamSocket.instances.push(this);
    }

    send(data: string | Uint8Array): void {
      this.sent.push(data);
    }

    close(): void {
      this.readyState = 3;
    }

    on(event: string, cb: (...args: unknown[]) => void): void {
      const list = this.handlers.get(event) ?? [];
      list.push(cb);
      this.handlers.set(event, list);
    }

    emit(event: string, ...args: unknown[]): void {
      for (const handler of this.handlers.get(event) ?? []) {
        handler(...args);
      }
    }
  }
  return { FakeUpstreamSocket };
});

vi.mock('ws', () => ({ default: FakeUpstreamSocket }));

/** Minimal stand-in for a `ws` WebSocket the handler attaches to. */
class FakeWs {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: Array<string | 'binary'> = [];
  closeCode: number | undefined;
  closeReason: string | undefined;
  private handlers: Record<string, Array<(...args: unknown[]) => void>> = {};

  constructor(private readonly emitCloseOnClose = true) {}

  on(event: string, cb: (...args: unknown[]) => void): this {
    (this.handlers[event] ??= []).push(cb);
    return this;
  }
  send(data: string | Uint8Array): void {
    this.sent.push(typeof data === 'string' ? data : 'binary');
  }
  close(code?: number, reason?: string): void {
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3;
    if (this.emitCloseOnClose) this.emit('close');
  }
  emit(event: string, ...args: unknown[]): void {
    (this.handlers[event] ?? []).forEach((cb) => cb(...args));
  }

  // ── test drivers ──
  text(obj: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(obj)), false);
  }
  binary(bytes: number[]): void {
    this.emit('message', Buffer.from(bytes), true);
  }
  binaryBuffer(buffer: Buffer): void {
    this.emit('message', buffer, true);
  }
  frames(): Array<Record<string, unknown>> {
    return this.sent
      .filter((s): s is string => s !== 'binary')
      .map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function streamingCtx(): DaemonVoiceContext {
  return {
    settings: {} as DaemonVoiceContext['settings'],
    models: { getAllConfiguredModels: () => [] },
    voiceModel: 'paraformer-realtime-v2',
    streaming: true,
  };
}

function batchCtx(): DaemonVoiceContext {
  return {
    settings: {} as DaemonVoiceContext['settings'],
    models: { getAllConfiguredModels: () => [] },
    voiceModel: 'qwen3-asr-flash',
    streaming: false,
  };
}

describe('createVoiceWsConnectionHandler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('streams audio to the upstream session and returns the final transcript', async () => {
    const pushed: Uint8Array[] = [];
    let onInterim: ((t: string) => void) | undefined;
    const session: VoiceStreamSession = {
      pushAudio: (pcm) => pushed.push(pcm),
      finish: vi.fn(async () => 'hello world'),
      abort: vi.fn(),
    };
    const openStream = vi.fn(async (_ctx, callbacks) => {
      onInterim = callbacks.onInterim;
      return session;
    });
    const ws = new FakeWs();
    const handler = createVoiceWsConnectionHandler('/ws', {
      loadContext: () => streamingCtx(),
      openStream,
    });
    handler(ws as never, {} as never);

    ws.text({ type: 'start' });
    await tick();
    expect(openStream).toHaveBeenCalledOnce();
    expect(ws.frames()[0]).toMatchObject({ type: 'ready', streaming: true });

    ws.binary([1, 2, 3, 4]);
    await tick();
    expect(pushed).toHaveLength(1);

    onInterim?.('hel');
    expect(
      ws.frames().some((f) => f['type'] === 'interim' && f['text'] === 'hel'),
    ).toBe(true);

    ws.text({ type: 'stop' });
    await tick();
    expect(session.finish).toHaveBeenCalledOnce();
    expect(ws.frames().at(-1)).toMatchObject({
      type: 'final',
      text: 'hello world',
    });
    expect(ws.closeCode).toBe(1000);
  });

  it('lazily starts on the first audio frame', async () => {
    const loadContext = vi.fn(() => streamingCtx());
    const session: VoiceStreamSession = {
      pushAudio: vi.fn(),
      finish: vi.fn(async () => ''),
      abort: vi.fn(),
    };
    const ws = new FakeWs();
    const handler = createVoiceWsConnectionHandler('/ws', {
      loadContext,
      openStream: async () => session,
    });
    handler(ws as never, {} as never);

    ws.binary([9, 9]);
    await tick();
    expect(loadContext).toHaveBeenCalledOnce();
    expect(session.pushAudio).toHaveBeenCalledOnce();
  });

  it('buffers audio and batch-transcribes non-streaming models on stop', async () => {
    const transcribe = vi.fn(
      async (_ctx, pcm: Uint8Array) => `batched:${pcm.byteLength}`,
    );
    const ws = new FakeWs();
    const handler = createVoiceWsConnectionHandler('/ws', {
      loadContext: () => batchCtx(),
      transcribe,
    });
    handler(ws as never, {} as never);

    ws.text({ type: 'start' });
    await tick();
    ws.binary([1, 2, 3]);
    ws.binary([4, 5]);
    await tick();
    ws.text({ type: 'stop' });
    await tick();

    expect(transcribe).toHaveBeenCalledOnce();
    // The two 3- and 2-byte frames concatenate to 5 bytes.
    expect(ws.frames().at(-1)).toMatchObject({
      type: 'final',
      text: 'batched:5',
    });
  });

  it('reports no-model voice config errors to the client', async () => {
    const ws = new FakeWs();
    const handler = createVoiceWsConnectionHandler('/ws', {
      loadContext: () => {
        throw new Error('No voice model is configured for this workspace.');
      },
    });
    handler(ws as never, {} as never);

    ws.text({ type: 'start' });
    await tick();
    expect(ws.frames().at(-1)).toMatchObject({
      type: 'error',
      message: 'No voice model is configured for this workspace.',
    });
    expect(ws.closeCode).toBe(1011);
  });

  it('keeps unexpected voice config errors generic', async () => {
    const ws = new FakeWs();
    const handler = createVoiceWsConnectionHandler('/ws', {
      loadContext: () => {
        throw new Error('DASHSCOPE_API_KEY from /private/config is invalid');
      },
    });
    handler(ws as never, {} as never);

    ws.text({ type: 'start' });
    await tick();
    expect(ws.frames().at(-1)).toMatchObject({
      type: 'error',
      message: 'Voice transcription failed. Please try again.',
    });
    expect(ws.closeCode).toBe(1011);
  });

  it('reports a generic error frame when streaming finalization fails', async () => {
    const session: VoiceStreamSession = {
      pushAudio: vi.fn(),
      finish: vi.fn(async () => {
        throw new Error('upstream private endpoint failed');
      }),
      abort: vi.fn(),
    };
    const ws = new FakeWs();
    const handler = createVoiceWsConnectionHandler('/ws', {
      loadContext: () => streamingCtx(),
      openStream: async () => session,
    });
    handler(ws as never, {} as never);

    ws.text({ type: 'start' });
    await tick();
    ws.text({ type: 'stop' });
    await tick();

    expect(ws.frames().at(-1)).toMatchObject({
      type: 'error',
      message: 'Voice transcription failed. Please try again.',
    });
    expect(ws.closeCode).toBe(1011);
  });

  it('aborts the upstream session on abort', async () => {
    const session: VoiceStreamSession = {
      pushAudio: vi.fn(),
      finish: vi.fn(async () => ''),
      abort: vi.fn(),
    };
    const ws = new FakeWs();
    const handler = createVoiceWsConnectionHandler('/ws', {
      loadContext: () => streamingCtx(),
      openStream: async () => session,
    });
    handler(ws as never, {} as never);

    ws.text({ type: 'start' });
    await tick();
    ws.text({ type: 'abort' });
    await tick();
    expect(session.abort).toHaveBeenCalledOnce();
    expect(ws.closeCode).toBe(1000);
  });

  it('lets abort preempt a pending streaming start', async () => {
    const sessionReady = deferred<VoiceStreamSession>();
    const session: VoiceStreamSession = {
      pushAudio: vi.fn(),
      finish: vi.fn(async () => ''),
      abort: vi.fn(),
    };
    const ws = new FakeWs();
    const handler = createVoiceWsConnectionHandler('/ws', {
      loadContext: () => streamingCtx(),
      openStream: async () => sessionReady.promise,
    });
    handler(ws as never, {} as never);

    ws.text({ type: 'start' });
    await tick();
    ws.text({ type: 'abort' });
    await tick();
    sessionReady.resolve(session);
    await tick();

    expect(ws.closeCode).toBe(1000);
    expect(session.abort).toHaveBeenCalledOnce();
  });

  it('does not finalize after abort closes a pending streaming start', async () => {
    const sessionReady = deferred<VoiceStreamSession>();
    const session: VoiceStreamSession = {
      pushAudio: vi.fn(),
      finish: vi.fn(async () => 'late final'),
      abort: vi.fn(),
    };
    const ws = new FakeWs();
    const handler = createVoiceWsConnectionHandler('/ws', {
      loadContext: () => streamingCtx(),
      openStream: async () => sessionReady.promise,
    });
    handler(ws as never, {} as never);

    ws.text({ type: 'stop' });
    await tick();
    ws.text({ type: 'abort' });
    await tick();
    sessionReady.resolve(session);
    await tick();

    expect(session.abort).toHaveBeenCalledOnce();
    expect(session.finish).not.toHaveBeenCalled();
    expect(ws.frames().some((frame) => frame['type'] === 'final')).toBe(false);
  });

  it('aborts a streaming session that resolves after the socket closed', async () => {
    const sessionReady = deferred<VoiceStreamSession>();
    const session: VoiceStreamSession = {
      pushAudio: vi.fn(),
      finish: vi.fn(async () => ''),
      abort: vi.fn(),
    };
    const ws = new FakeWs();
    const handler = createVoiceWsConnectionHandler('/ws', {
      loadContext: () => streamingCtx(),
      openStream: async () => sessionReady.promise,
    });
    handler(ws as never, {} as never);

    ws.text({ type: 'start' });
    await tick();
    ws.close();
    sessionReady.resolve(session);
    await tick();

    expect(session.abort).toHaveBeenCalledOnce();
  });

  it('aborts an in-flight upstream open and releases the lease on disconnect', async () => {
    const coordinator = new WorkspaceVoiceCoordinator();
    const runtime = { workspaceId: 'secondary' } as WorkspaceRuntime;
    let openSignal: AbortSignal | undefined;
    const ws = new FakeWs();
    const handler = createVoiceWsConnectionHandler('/ws', {
      loadContext: () => streamingCtx(),
      acquireVoiceLease: () => coordinator.acquire(runtime),
      openStream: async (_ctx, _callbacks, abortSignal) => {
        openSignal = abortSignal;
        return await new Promise<VoiceStreamSession>((_resolve, reject) => {
          abortSignal?.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true },
          );
        });
      },
    });
    handler(ws as never, {} as never);
    ws.text({ type: 'start' });
    await tick();
    expect(coordinator.getWorkspaceActivity(runtime)).toBe(1);

    ws.close();
    await tick();
    await tick();

    expect(openSignal?.aborted).toBe(true);
    expect(coordinator.getWorkspaceActivity(runtime)).toBe(0);
  });

  it('aborts the streaming session if finalization times out', async () => {
    vi.useFakeTimers();
    const session: VoiceStreamSession = {
      pushAudio: vi.fn(),
      finish: vi.fn(() => new Promise<string>(() => {})),
      abort: vi.fn(),
    };
    const ws = new FakeWs();
    const handler = createVoiceWsConnectionHandler('/ws', {
      loadContext: () => streamingCtx(),
      openStream: async () => session,
    });
    handler(ws as never, {} as never);

    ws.text({ type: 'start' });
    await vi.runAllTicks();
    ws.text({ type: 'stop' });
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(6 * 60_000);

    expect(session.abort).toHaveBeenCalledOnce();
    expect(ws.frames().at(-1)).toMatchObject({
      type: 'error',
      message: 'Voice session exceeded the time limit.',
    });
    expect(ws.closeCode).toBe(1011);
  });

  it('fails oversized batch audio before buffering it', async () => {
    const ws = new FakeWs();
    const handler = createVoiceWsConnectionHandler('/ws', {
      loadContext: () => batchCtx(),
    });
    handler(ws as never, {} as never);

    ws.text({ type: 'start' });
    await tick();
    ws.binaryBuffer(Buffer.alloc(10 * 1024 * 1024 + 1));
    await tick();

    expect(ws.frames().at(-1)).toMatchObject({
      type: 'error',
      message: 'Recording is too long for transcription (max ~5 minutes).',
    });
    expect(ws.closeCode).toBe(1011);
  });

  it('rejects queued audio while streaming start is pending', async () => {
    const sessionReady = deferred<VoiceStreamSession>();
    const ws = new FakeWs();
    const handler = createVoiceWsConnectionHandler('/ws', {
      loadContext: () => streamingCtx(),
      openStream: async () => sessionReady.promise,
    });
    handler(ws as never, {} as never);

    ws.text({ type: 'start' });
    await tick();
    ws.binaryBuffer(Buffer.alloc(20 * 1024 * 1024 + 1));
    await tick();

    expect(ws.frames().at(-1)).toMatchObject({
      type: 'error',
      message: 'Queued voice audio exceeded the memory limit.',
    });
    expect(ws.closeCode).toBe(1011);
  });

  it('fails and cleans up when the hard timer fires', async () => {
    vi.useFakeTimers();
    const session: VoiceStreamSession = {
      pushAudio: vi.fn(),
      finish: vi.fn(async () => ''),
      abort: vi.fn(),
    };
    const ws = new FakeWs();
    const handler = createVoiceWsConnectionHandler('/ws', {
      loadContext: () => streamingCtx(),
      openStream: async () => session,
    });
    handler(ws as never, {} as never);

    ws.text({ type: 'start' });
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(6 * 60_000);

    expect(session.abort).toHaveBeenCalledOnce();
    expect(ws.frames().at(-1)).toMatchObject({
      type: 'error',
      message: 'Voice session exceeded the time limit.',
    });
    expect(ws.closeCode).toBe(1011);
  });

  it('frees a voice slot when a failed socket ignores close', async () => {
    vi.useFakeTimers();
    const handler = createVoiceWsConnectionHandler('/ws', {
      loadContext: () => streamingCtx(),
      openStream: async () => ({
        pushAudio: vi.fn(),
        finish: vi.fn(async () => ''),
        abort: vi.fn(),
      }),
    });
    const open = Array.from({ length: 8 }, () => new FakeWs(false));
    for (const ws of open) handler(ws as never, {} as never);

    await vi.advanceTimersByTimeAsync(6 * 60_000);

    const next = new FakeWs();
    handler(next as never, {} as never);
    expect(next.closeCode).not.toBe(1013);
  });

  it('rejects connections past the concurrency cap and frees slots on close', async () => {
    const handler = createVoiceWsConnectionHandler('/ws', {
      loadContext: () => streamingCtx(),
      openStream: async () => ({
        pushAudio: vi.fn(),
        finish: vi.fn(async () => ''),
        abort: vi.fn(),
      }),
    });
    // Open the cap (8) and hold them; the 9th must be refused with 1013.
    const open = Array.from({ length: 8 }, () => new FakeWs());
    for (const ws of open) handler(ws as never, {} as never);
    const overflow = new FakeWs();
    handler(overflow as never, {} as never);
    expect(overflow.closeCode).toBe(1013);
    expect(overflow.frames().at(-1)).toMatchObject({ type: 'error' });

    // Closing one frees a slot for a new connection.
    open[0].close();
    const next = new FakeWs();
    handler(next as never, {} as never);
    expect(next.closeCode).not.toBe(1013);
  });

  it('releases a finalized session even when the socket never emits close', async () => {
    const handler = createVoiceWsConnectionHandler('/ws', {
      loadContext: () => streamingCtx(),
      openStream: async () => ({
        pushAudio: vi.fn(),
        finish: vi.fn(async () => 'done'),
        abort: vi.fn(),
      }),
    });
    const finalized = new FakeWs(false);
    handler(finalized as never, {} as never);
    finalized.text({ type: 'stop' });
    await tick();
    await tick();
    expect(finalized.closeCode).toBe(1000);

    const next = Array.from({ length: 8 }, () => new FakeWs());
    for (const ws of next) handler(ws as never, {} as never);
    expect(next.every((ws) => ws.closeCode !== 1013)).toBe(true);
  });

  it('closes with restart semantics when the target runtime is draining', () => {
    const ws = new FakeWs();
    const handler = createVoiceWsConnectionHandler('/ws', {
      acquireVoiceLease: () => ({ kind: 'rejected', reason: 'draining' }),
    });

    handler(ws as never, {} as never);

    expect(ws.closeCode).toBe(1012);
    expect(ws.frames()).toEqual([]);
  });

  it('closes with busy semantics when Voice capacity is exhausted', () => {
    const ws = new FakeWs();
    const handler = createVoiceWsConnectionHandler('/ws', {
      acquireVoiceLease: () => ({ kind: 'rejected', reason: 'capacity' }),
    });

    handler(ws as never, {} as never);

    expect(ws.closeCode).toBe(1013);
    expect(ws.frames()).toEqual([expect.objectContaining({ type: 'error' })]);
  });

  it('closes only the disposed runtime session and releases its lease', async () => {
    const coordinator = new WorkspaceVoiceCoordinator();
    const runtime = { workspaceId: 'secondary' } as WorkspaceRuntime;
    const ws = new FakeWs(false);
    const handler = createVoiceWsConnectionHandler('/ws', {
      acquireVoiceLease: () => coordinator.acquire(runtime),
    });
    handler(ws as never, {} as never);
    expect(coordinator.getWorkspaceActivity(runtime)).toBe(1);

    await coordinator.disposeRuntime(runtime, 'workspace_removed');

    expect(ws.closeCode).toBe(1012);
    expect(ws.closeReason).toBe('Workspace removed');
    expect(coordinator.getWorkspaceActivity(runtime)).toBe(0);
  });

  it('reports trust reconfiguration when replacing a runtime', async () => {
    const coordinator = new WorkspaceVoiceCoordinator();
    const runtime = { workspaceId: 'primary' } as WorkspaceRuntime;
    const ws = new FakeWs(false);
    const handler = createVoiceWsConnectionHandler('/ws', {
      acquireVoiceLease: () => coordinator.acquire(runtime),
    });
    handler(ws as never, {} as never);

    await coordinator.disposeRuntime(runtime, 'trust_reconfigured');

    expect(ws.closeCode).toBe(1012);
    expect(ws.closeReason).toBe('Workspace trust reconfigured');
  });

  it('reports daemon shutdown when its runtime lease is aborted on shutdown', async () => {
    const coordinator = new WorkspaceVoiceCoordinator();
    const runtime = { workspaceId: 'primary' } as WorkspaceRuntime;
    const ws = new FakeWs(false);
    const handler = createVoiceWsConnectionHandler('/ws', {
      acquireVoiceLease: () => coordinator.acquire(runtime),
    });
    handler(ws as never, {} as never);

    await coordinator.disposeRuntime(runtime, 'daemon_shutdown');

    expect(ws.closeCode).toBe(1012);
    expect(ws.closeReason).toBe('Server shutting down');
  });
});

// These tests drive the production defaults (no injected openStream/transcribe)
// so a revert that drops allowInsecureBaseUrl from the default guard wiring
// fails instead of staying green (CLI analogue of the desktop
// voice-ws-handler.isolated.ts default-wiring tests).
describe('daemon default guard wiring', () => {
  const PRIVATE_BASE_URL = 'http://10.0.0.8/v1';

  function allowlistedCtx(
    voiceModel: string,
    streaming: boolean,
  ): DaemonVoiceContext {
    return {
      settings: {
        merged: {
          security: { allowedInsecureVoiceBaseUrls: [PRIVATE_BASE_URL] },
        },
      } as unknown as DaemonVoiceContext['settings'],
      models: {
        getAllConfiguredModels: () => [
          {
            id: voiceModel,
            label: 'Private ASR',
            authType: AuthType.USE_OPENAI,
            baseUrl: PRIVATE_BASE_URL,
          },
        ],
      },
      voiceModel,
      streaming,
    };
  }

  it('reaches the default batch transport when the private-network opt-in is set', async () => {
    const fetchedUrls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: unknown) => {
      fetchedUrls.push(String(input));
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'hello gateway' } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;

    try {
      const ws = new FakeWs();
      const handler = createVoiceWsConnectionHandler('/ws', {
        loadContext: () => allowlistedCtx('qwen3-asr-flash', false),
      });
      handler(ws as never, {} as never);

      ws.text({ type: 'start' });
      await tick();
      ws.binary([1, 2, 3, 4]);
      await tick();
      ws.text({ type: 'stop' });
      await tick();

      expect(fetchedUrls).toContain('http://10.0.0.8/v1/chat/completions');
      expect(ws.frames()).toContainEqual({
        type: 'final',
        text: 'hello gateway',
      });
      expect(ws.frames().some((f) => f['type'] === 'error')).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('blocks the default batch transport for a private gateway without the opt-in', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn() as typeof fetch;

    try {
      const ws = new FakeWs();
      const handler = createVoiceWsConnectionHandler('/ws', {
        loadContext: () =>
          ({
            settings: {
              merged: {},
            } as unknown as DaemonVoiceContext['settings'],
            models: {
              getAllConfiguredModels: () => [
                {
                  id: 'qwen3-asr-flash',
                  label: 'Private ASR',
                  authType: AuthType.USE_OPENAI,
                  baseUrl: 'https://10.0.0.8/v1',
                },
              ],
            },
            voiceModel: 'qwen3-asr-flash',
            streaming: false,
          }) satisfies DaemonVoiceContext,
      });
      handler(ws as never, {} as never);

      ws.text({ type: 'start' });
      await tick();
      ws.binary([1, 2, 3, 4]);
      await tick();
      ws.text({ type: 'stop' });
      await tick();

      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(ws.frames().some((f) => f['type'] === 'error')).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reaches the default streaming transport when the private-network opt-in is set', async () => {
    FakeUpstreamSocket.instances.length = 0;
    const ws = new FakeWs();
    const handler = createVoiceWsConnectionHandler('/ws', {
      loadContext: () => allowlistedCtx('qwen3-asr-flash-realtime', true),
    });
    handler(ws as never, {} as never);

    ws.text({ type: 'start' });
    await tick();

    // The guard let the allowlisted gateway through: the production default
    // dialed the upstream realtime socket instead of rejecting.
    const upstream = FakeUpstreamSocket.instances.at(-1);
    expect(upstream?.url).toBe(
      'ws://10.0.0.8/api-ws/v1/realtime?model=qwen3-asr-flash-realtime',
    );
    expect(ws.frames().some((f) => f['type'] === 'error')).toBe(false);
  });
});
