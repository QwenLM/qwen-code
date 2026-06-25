/**
 * Per-connection handler for the desktop `/voice/stream` WebSocket.
 *
 * Supports both transcription transports:
 *   - batch (qwen3-asr-flash): accumulate PCM, transcribe on stop
 *   - realtime (qwen3-asr-flash-realtime / *-realtime): open an upstream ASR
 *     WebSocket, stream PCM, forward interim transcripts, finalize on stop
 *
 * Protocol — client → server:
 *   - text   `{"type":"start"}`  resolve config + (realtime) open the stream
 *   - binary  raw s16le / 16 kHz / mono PCM frames
 *   - text   `{"type":"stop"}`   finalize and return the transcript
 *   - text   `{"type":"abort"}`  discard and close
 *
 * server → client:
 *   - `{"type":"ready","streaming":bool,"model":string}`
 *   - `{"type":"interim","text":string}`  (realtime only)
 *   - `{"type":"final","text":string}`
 *   - `{"type":"error","message":string}`
 *
 * Capture happens in the renderer; transcription runs here so provider
 * credentials never reach the renderer. Mirrors the daemon Web Shell handler
 * (packages/cli/src/serve/voice/voice-ws.ts).
 */

import type { RawData, WebSocket } from 'ws';
import type { Logger } from '../runtime/platform';
import { encodeWav } from './wav';
import { assertVoiceBaseUrlNetworkAllowed } from './net-guard';
import {
  MAX_AUDIO_BYTES,
  transcribeQwenAsrBatch,
  type VoiceConfig,
} from './transcribe';
import {
  openVoiceStream,
  type VoiceStreamCallbacks,
  type VoiceStreamConfig,
  type VoiceStreamSession,
} from './voice-stream-session';
import { openQwenAsrRealtimeStream } from './qwen-asr-realtime-session';
import { openVoiceStreamWithRetry } from './voice-stream-retry';
import { isStreamingVoiceModel, resolveVoiceTransport } from './voice-model';

// Qwen-ASR caps each file at 10 MB / ~5 minutes; guard before WAV-encoding.
const MAX_QUEUED_AUDIO_BYTES = MAX_AUDIO_BYTES * 2;
// Hard cap so a client that opens the socket and never sends `stop` can't pin
// an upstream ASR session indefinitely.
const MAX_CONNECTION_MS = 6 * 60_000;
// Cap concurrent sessions so a client can't open unbounded sockets.
const MAX_CONCURRENT_VOICE_SESSIONS = 8;

interface VoiceContext {
  config: VoiceConfig;
  streaming: boolean;
}

export interface VoiceHandlerDeps {
  /** Resolve the configured ASR endpoint + credentials at request time. */
  resolveConfig: () => Promise<VoiceConfig> | VoiceConfig;
  logger?: Logger;
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toStreamConfig(config: VoiceConfig): VoiceStreamConfig {
  return {
    baseUrl: config.baseUrl,
    model: config.model,
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
  };
}

async function openStreamFor(
  config: VoiceConfig,
  callbacks: VoiceStreamCallbacks,
): Promise<VoiceStreamSession> {
  await assertVoiceBaseUrlNetworkAllowed(config.baseUrl, config.model);
  const cfg = toStreamConfig(config);
  const transport = resolveVoiceTransport(config.model);
  return openVoiceStreamWithRetry(() =>
    transport === 'qwen-asr-realtime'
      ? openQwenAsrRealtimeStream(cfg, callbacks)
      : openVoiceStream(cfg, callbacks),
  );
}

async function transcribeBatch(
  config: VoiceConfig,
  pcm: Uint8Array,
): Promise<string> {
  await assertVoiceBaseUrlNetworkAllowed(config.baseUrl, config.model);
  return transcribeQwenAsrBatch(
    { data: encodeWav(pcm), mimeType: 'audio/wav' },
    config,
  );
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}

interface ControlMessage {
  type: 'start' | 'stop' | 'abort';
}

function parseControl(text: string): ControlMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const type = (parsed as { type?: unknown })?.type;
  if (type === 'start' || type === 'stop' || type === 'abort') {
    return { type };
  }
  return undefined;
}

export function createVoiceConnectionHandler(
  deps: VoiceHandlerDeps,
): (ws: WebSocket) => void {
  const log = deps.logger;
  // Shared across all connections from this server (factory closure).
  let activeSessions = 0;

  return (ws: WebSocket) => {
    if (activeSessions >= MAX_CONCURRENT_VOICE_SESSIONS) {
      try {
        ws.send(
          JSON.stringify({
            type: 'error',
            message: 'Too many voice sessions in progress; try again shortly.',
          }),
        );
        ws.close(1013, 'busy');
      } catch {
        // ignore
      }
      return;
    }
    activeSessions++;
    let released = false;
    const releaseSlot = () => {
      if (!released) {
        released = true;
        activeSessions--;
      }
    };

    let state: 'idle' | 'active' | 'finalizing' | 'closed' = 'idle';
    let ctx: VoiceContext | undefined;
    let session: VoiceStreamSession | undefined;
    let sessionPromise: Promise<VoiceStreamSession> | undefined;
    const pcmChunks: Buffer[] = [];
    let bufferedBytes = 0;
    let queuedBytes = 0;
    let pendingOperations = 0;
    // Serialize message handling so async start/push/finalize never interleave.
    let chain: Promise<void> = Promise.resolve();

    const hardTimer = setTimeout(() => {
      if (!isClosed()) fail('Voice session exceeded the time limit.');
    }, MAX_CONNECTION_MS);
    hardTimer.unref?.();

    // Read `state` through a helper so an async error path that flips it to
    // 'closed' isn't flow-narrowed away by an earlier guard.
    const isClosed = (): boolean => state === 'closed';

    const releaseSlotWhenIdle = (): void => {
      if (state === 'closed' && pendingOperations === 0) releaseSlot();
    };

    const sendJson = (obj: unknown): void => {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(JSON.stringify(obj));
        } catch {
          // socket already going away
        }
      }
    };

    function cleanup(): void {
      state = 'closed';
      clearTimeout(hardTimer);
      if (session) {
        try {
          session.abort();
        } catch {
          // best effort
        }
        session = undefined;
      }
      sessionPromise = undefined;
      pcmChunks.length = 0;
      bufferedBytes = 0;
      queuedBytes = 0;
    }

    function fail(message: string): void {
      if (state === 'closed') return;
      log?.debug(`[voice-ws] failed: ${message}`);
      sendJson({ type: 'error', message });
      cleanup();
      releaseSlotWhenIdle();
      try {
        ws.close(1011, 'voice error');
      } catch {
        // ignore
      }
    }

    async function ensureStarted(): Promise<void> {
      if (ctx) return;
      let config: VoiceConfig;
      try {
        config = await deps.resolveConfig();
      } catch (error) {
        // Config-resolution errors (e.g. no credentials) surface verbatim.
        fail(errMessage(error));
        return;
      }
      if (isClosed()) return;
      if (resolveVoiceTransport(config.model) === 'unsupported') {
        fail(
          `Voice model '${config.model}' is not a supported transcription model.`,
        );
        return;
      }
      ctx = { config, streaming: isStreamingVoiceModel(config.model) };
      sendJson({ type: 'ready', streaming: ctx.streaming, model: config.model });
      if (ctx.streaming) {
        const callbacks: VoiceStreamCallbacks = {
          onInterim: (text) => sendJson({ type: 'interim', text }),
          onError: (error) => fail(errMessage(error)),
        };
        const opening = openStreamFor(config, callbacks);
        sessionPromise = opening;
        let opened: VoiceStreamSession;
        try {
          opened = await opening;
        } catch (error) {
          fail(errMessage(error));
          return;
        }
        if (isClosed()) {
          try {
            opened.abort();
          } catch {
            // best effort
          }
          return;
        }
        session = opened;
      }
      if (state === 'idle') state = 'active';
    }

    async function finalize(): Promise<void> {
      if (state === 'closed' || state === 'finalizing') return;
      state = 'finalizing';
      await ensureStarted();
      if (isClosed() || !ctx) return;
      let transcript = '';
      try {
        if (ctx.streaming) {
          const active =
            session ?? (sessionPromise ? await sessionPromise : undefined);
          if (isClosed()) return;
          if (active) {
            try {
              transcript = await active.finish();
            } finally {
              session = undefined;
            }
          }
        } else if (pcmChunks.length > 0) {
          transcript = await transcribeBatch(ctx.config, Buffer.concat(pcmChunks));
        }
      } catch (error) {
        fail(errMessage(error));
        return;
      }
      sendJson({ type: 'final', text: transcript });
      cleanup();
      try {
        ws.close(1000, 'done');
      } catch {
        // ignore
      }
    }

    async function handleMessage(data: Buffer, isBinary: boolean): Promise<void> {
      if (state === 'closed' || state === 'finalizing') return;
      if (isBinary) {
        await ensureStarted();
        if (isClosed() || !ctx) return;
        if (ctx.streaming) {
          const active =
            session ?? (sessionPromise ? await sessionPromise : undefined);
          active?.pushAudio(data);
        } else {
          bufferedBytes += data.byteLength;
          if (bufferedBytes > MAX_AUDIO_BYTES) {
            fail('Recording is too long for transcription (max ~5 minutes).');
            return;
          }
          pcmChunks.push(data);
        }
        return;
      }
      const control = parseControl(data.toString('utf8'));
      if (!control) return;
      switch (control.type) {
        case 'start':
          await ensureStarted();
          return;
        case 'stop':
          await finalize();
          return;
        default:
          return;
      }
    }

    ws.on('message', (data: RawData, isBinary: boolean) => {
      const buf = toBuffer(data);
      if (!isBinary) {
        const control = parseControl(buf.toString('utf8'));
        if (control?.type === 'abort') {
          cleanup();
          try {
            ws.close(1000, 'aborted');
          } catch {
            // ignore
          }
          releaseSlotWhenIdle();
          return;
        }
      }
      const queuedSize = isBinary ? buf.byteLength : 0;
      if (queuedSize > 0) {
        queuedBytes += queuedSize;
        if (queuedBytes > MAX_QUEUED_AUDIO_BYTES) {
          fail('Queued voice audio exceeded the memory limit.');
          releaseSlotWhenIdle();
          return;
        }
      }
      chain = chain
        .then(async () => {
          pendingOperations++;
          try {
            await handleMessage(buf, isBinary);
          } finally {
            if (queuedSize > 0) {
              queuedBytes = Math.max(0, queuedBytes - queuedSize);
            }
            pendingOperations--;
            releaseSlotWhenIdle();
          }
        })
        .catch((error: unknown) => {
          fail(errMessage(error));
          releaseSlotWhenIdle();
        });
    });
    ws.on('close', () => {
      if (state !== 'closed') cleanup();
      releaseSlotWhenIdle();
    });
    ws.on('error', (error: Error) => {
      log?.debug(`[voice-ws] socket error: ${error.message}`);
      if (state !== 'closed') cleanup();
      releaseSlotWhenIdle();
    });
  };
}
