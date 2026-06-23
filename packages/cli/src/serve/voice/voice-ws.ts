/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IncomingMessage } from 'node:http';
import type { RawData, WebSocket } from 'ws';
import { createDebugLogger } from '@qwen-code/qwen-code-core';
import {
  loadDaemonVoiceContext,
  type DaemonVoiceContext,
} from './resolve-voice-config.js';
import {
  assertVoiceBaseUrlNetworkAllowed,
  resolveVoiceStreamConfig,
  transcribeVoiceAudio,
} from '../../ui/voice/voice-transcriber.js';
import { openVoiceStream } from '../../ui/voice/voice-stream-session.js';
import { openQwenAsrRealtimeStream } from '../../ui/voice/qwen-asr-realtime-session.js';
import { openVoiceStreamWithRetry } from '../../ui/voice/voice-stream-retry.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import type {
  VoiceStreamCallbacks,
  VoiceStreamSession,
} from '../../ui/voice/voice-stream-session.js';

const debugLogger = createDebugLogger('VOICE_WS');

// Qwen-ASR caps each audio file at 10 MB / ~5 minutes; guard the batch buffer
// before WAV-encoding so an overlong stream fails with a clear message.
const MAX_BATCH_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_QUEUED_AUDIO_BYTES = MAX_BATCH_AUDIO_BYTES * 2;
// Hard cap on a single voice connection so a client that opens the socket and
// never sends `stop` can't pin an upstream ASR session indefinitely.
const MAX_CONNECTION_MS = 6 * 60_000;
// Voice WS bypasses the ACP connection registry; cap concurrent sessions so a
// client can't open unbounded sockets (each opens an upstream ASR connection).
// Generous for one interactive user across a few tabs.
const MAX_CONCURRENT_VOICE_SESSIONS = 8;
const GENERIC_TRANSCRIPTION_ERROR =
  'Voice transcription failed. Please try again.';

// Audio is 16 kHz mono signed-16-bit PCM. Browser capture sends raw frames; the
// batch transcription path (non-streaming models) wants a WAV container.
const SAMPLE_RATE = 16_000;

function encodeWav(pcm: Uint8Array): Uint8Array {
  const header = Buffer.alloc(44);
  const dataLen = pcm.byteLength;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLen, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format = PCM
  header.writeUInt16LE(1, 22); // channels = mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate (mono, 16-bit)
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataLen, 40);
  return Buffer.concat([header, Buffer.from(pcm)]);
}

/** Injection seams for unit tests; production uses the reused CLI pipeline. */
export interface VoiceWsDeps {
  loadContext?: (workspaceCwd: string) => DaemonVoiceContext;
  openStream?: (
    ctx: DaemonVoiceContext,
    callbacks: VoiceStreamCallbacks,
  ) => Promise<VoiceStreamSession>;
  transcribe?: (ctx: DaemonVoiceContext, pcm: Uint8Array) => Promise<string>;
}

async function defaultOpenStream(
  ctx: DaemonVoiceContext,
  callbacks: VoiceStreamCallbacks,
): Promise<VoiceStreamSession> {
  try {
    const cfg = resolveVoiceStreamConfig({
      config: ctx.models,
      settings: ctx.settings,
      voiceModel: ctx.voiceModel,
    });
    await assertVoiceBaseUrlNetworkAllowed(cfg);
    return await openVoiceStreamWithRetry(() =>
      cfg.transport === 'qwen-asr-realtime'
        ? openQwenAsrRealtimeStream(cfg, callbacks)
        : openVoiceStream(cfg, callbacks),
    );
  } catch (error) {
    debugLogger.debug(`[voice-ws] stream open error: ${errMessage(error)}`);
    throw new Error(GENERIC_TRANSCRIPTION_ERROR);
  }
}

function defaultTranscribe(
  ctx: DaemonVoiceContext,
  pcm: Uint8Array,
): Promise<string> {
  return transcribeVoiceAudio(
    { data: encodeWav(pcm), mimeType: 'audio/wav' },
    { config: ctx.models, settings: ctx.settings, voiceModel: ctx.voiceModel },
  ).catch((error: unknown) => {
    debugLogger.debug(
      `[voice-ws] batch transcription error: ${errMessage(error)}`,
    );
    throw new Error(GENERIC_TRANSCRIPTION_ERROR);
  });
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Normalize a `ws` frame (Buffer | ArrayBuffer | Buffer[]) to a Buffer. */
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

/**
 * Build the per-connection handler for the daemon `/voice/stream` WebSocket.
 *
 * Protocol — client → server:
 *   - text  `{"type":"start"}`  open the upstream session (optional; lazily
 *           opened on first audio frame otherwise)
 *   - binary  raw s16le/16 kHz/mono PCM frames
 *   - text  `{"type":"stop"}`   finalize and return the transcript
 *   - text  `{"type":"abort"}`  discard and close
 *
 * server → client:
 *   - `{"type":"ready","streaming":bool,"model":string}`
 *   - `{"type":"interim","text":string}`  (streaming models only)
 *   - `{"type":"final","text":string}`
 *   - `{"type":"error","message":string}`
 *
 * Capture happens in the browser; the daemon reuses the CLI transcription
 * pipeline so provider credentials never leave the server.
 */
export function createVoiceWsConnectionHandler(
  boundWorkspace: string,
  deps: VoiceWsDeps = {},
): (ws: WebSocket, req: IncomingMessage) => void {
  const loadContext = deps.loadContext ?? loadDaemonVoiceContext;
  const openStream = deps.openStream ?? defaultOpenStream;
  const transcribe = deps.transcribe ?? defaultTranscribe;
  // Shared across all connections from this daemon (factory closure).
  let activeSessions = 0;

  return (ws: WebSocket) => {
    if (activeSessions >= MAX_CONCURRENT_VOICE_SESSIONS) {
      writeStderrLine(
        `qwen serve: voice websocket rejected; activeSessions=${activeSessions}`,
      );
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
    writeStderrLine(
      `qwen serve: voice websocket accepted; activeSessions=${activeSessions}`,
    );
    let released = false;
    const releaseSlot = () => {
      if (!released) {
        released = true;
        activeSessions--;
        writeStderrLine(
          `qwen serve: voice websocket slot released; activeSessions=${activeSessions}`,
        );
      }
    };

    let state: 'idle' | 'active' | 'finalizing' | 'closed' = 'idle';
    let ctx: DaemonVoiceContext | undefined;
    let session: VoiceStreamSession | undefined;
    let sessionPromise: Promise<VoiceStreamSession> | undefined;
    const pcmChunks: Uint8Array[] = [];
    let bufferedBytes = 0;
    let queuedBytes = 0;
    let pendingOperations = 0;
    // Serialize message handling so async start/push/finalize never interleave.
    let chain: Promise<void> = Promise.resolve();

    const hardTimer = setTimeout(() => {
      if (state !== 'closed') fail('Voice session exceeded the time limit.');
    }, MAX_CONNECTION_MS);
    hardTimer.unref?.();

    // Read `state` through a helper so an async error path (e.g. a failed
    // `ensureStarted`) that flips it to 'closed' isn't flow-narrowed away by
    // an earlier guard.
    const isClosed = (): boolean => state === 'closed';

    const releaseSlotWhenIdle = (): void => {
      if (state === 'closed' && pendingOperations === 0) releaseSlot();
    };

    const sendJson = (obj: unknown): void => {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(JSON.stringify(obj));
        } catch {
          // socket already going away — nothing to do
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
      writeStderrLine(`qwen serve: voice websocket failed: ${message}`);
      sendJson({ type: 'error', message });
      cleanup();
      try {
        ws.close(1011, 'voice error');
      } catch {
        // ignore
      }
    }

    async function ensureStarted(): Promise<void> {
      if (ctx) return;
      try {
        ctx = loadContext(boundWorkspace);
      } catch (error) {
        debugLogger.debug(
          `[voice-ws] load context error: ${errMessage(error)}`,
        );
        throw new Error(GENERIC_TRANSCRIPTION_ERROR);
      }
      sendJson({
        type: 'ready',
        streaming: ctx.streaming,
        model: ctx.voiceModel,
      });
      if (ctx.streaming) {
        const callbacks: VoiceStreamCallbacks = {
          onInterim: (text) => sendJson({ type: 'interim', text }),
          onError: (error) => {
            debugLogger.debug(
              `[voice-ws] upstream error: ${errMessage(error)}`,
            );
            fail(GENERIC_TRANSCRIPTION_ERROR);
          },
        };
        const opening = openStream(ctx, callbacks);
        sessionPromise = opening;
        const opened = await opening;
        if (state === 'closed') {
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
      if (isClosed()) return;
      let transcript = '';
      if (ctx!.streaming) {
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
        transcript = await transcribe(ctx!, Buffer.concat(pcmChunks));
      }
      sendJson({ type: 'final', text: transcript });
      writeStderrLine('qwen serve: voice websocket finalized successfully');
      cleanup();
      try {
        ws.close(1000, 'done');
      } catch {
        // ignore
      }
    }

    async function handleMessage(
      data: Buffer,
      isBinary: boolean,
    ): Promise<void> {
      if (state === 'closed' || state === 'finalizing') return;
      if (isBinary) {
        await ensureStarted();
        if (isClosed()) return;
        if (ctx!.streaming) {
          const active =
            session ?? (sessionPromise ? await sessionPromise : undefined);
          active?.pushAudio(data);
        } else {
          bufferedBytes += data.byteLength;
          if (bufferedBytes > MAX_BATCH_AUDIO_BYTES) {
            throw new Error(
              'Recording is too long for transcription (max ~5 minutes).',
            );
          }
          pcmChunks.push(data);
        }
        return;
      }
      const control = parseControl(data.toString('utf8'));
      if (!control) return;
      switch (control.type) {
        case 'start':
          writeStderrLine('qwen serve: voice websocket start received');
          await ensureStarted();
          return;
        case 'stop':
          writeStderrLine('qwen serve: voice websocket stop received');
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
          writeStderrLine('qwen serve: voice websocket abort received');
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
          debugLogger.debug(`[voice-ws] ${errMessage(error)}`);
          fail(errMessage(error));
          releaseSlotWhenIdle();
        });
    });
    ws.on('close', () => {
      if (state !== 'closed') cleanup();
      releaseSlotWhenIdle();
    });
    ws.on('error', (error: Error) => {
      debugLogger.debug(`[voice-ws] socket error: ${error.message}`);
      if (state !== 'closed') cleanup();
      releaseSlotWhenIdle();
    });
  };
}
