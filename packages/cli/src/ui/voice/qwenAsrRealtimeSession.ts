/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type {
  VoiceStreamCallbacks,
  VoiceStreamConfig,
  VoiceStreamSession,
} from './voiceStreamSession.js';

interface SocketLike {
  readyState: number;
  OPEN: number;
  send: (data: string | Uint8Array) => void;
  close: () => void;
  on: (event: string, cb: (...args: unknown[]) => void) => void;
}

export interface QwenRealtimeDeps {
  createWebSocket?: (
    url: string,
    options: { headers: Record<string, string> },
  ) => SocketLike;
}

const CONNECT_TIMEOUT_MS = 8000;

export function deriveQwenRealtimeUrl(baseUrl: string, model: string): string {
  const host = new URL(baseUrl).host;
  return `wss://${host}/api-ws/v1/realtime?model=${encodeURIComponent(model)}`;
}

function appendTranscript(existing: string, next: string): string {
  const text = next.trim();
  if (!text) return existing;
  return existing ? `${existing} ${text}` : text;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function openQwenAsrRealtimeStream(
  config: VoiceStreamConfig,
  callbacks: VoiceStreamCallbacks = {},
  deps: QwenRealtimeDeps = {},
): Promise<VoiceStreamSession> {
  const createWebSocket =
    deps.createWebSocket ??
    ((url, options) =>
      new WebSocket(url, {
        headers: options.headers,
      }) as unknown as SocketLike);

  return new Promise<VoiceStreamSession>((resolve, reject) => {
    const ws = createWebSocket(
      deriveQwenRealtimeUrl(config.baseUrl, config.model),
      {
        headers: config.apiKey
          ? { Authorization: `Bearer ${config.apiKey}` }
          : {},
      },
    );
    let opened = false;
    let openSettled = false;
    let committed = '';
    let finishPromise: Promise<string> | null = null;
    let finishResolve: ((text: string) => void) | null = null;
    let finishReject: ((error: unknown) => void) | null = null;

    const sendJson = (body: Record<string, unknown>) => {
      ws.send(JSON.stringify({ event_id: randomUUID(), ...body }));
    };

    const close = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };

    const fail = (error: unknown) => {
      const normalized = toError(error);
      close();
      if (finishReject) {
        finishReject(normalized);
        return;
      }
      if (!openSettled) {
        openSettled = true;
        reject(normalized);
      }
    };

    const connectTimer = setTimeout(() => {
      if (!opened) fail(new Error('Qwen ASR realtime connection timed out.'));
    }, CONNECT_TIMEOUT_MS);

    const sendSessionUpdate = () => {
      sendJson({
        type: 'session.update',
        session: {
          input_audio_format: 'pcm',
          sample_rate: 16000,
          input_audio_transcription: {
            ...(config.language ? { language: config.language } : {}),
            ...(config.keytermsContext
              ? { corpus_text: config.keytermsContext }
              : {}),
          },
          turn_detection: null,
        },
      });
    };

    ws.on('message', (...args: unknown[]) => {
      const data = args[0];
      const isBinary = args[1] === true;
      if (isBinary) return;
      let msg: {
        type?: string;
        text?: unknown;
        stash?: unknown;
        transcript?: unknown;
        error?: { code?: string; message?: string; param?: string };
      };
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }

      switch (msg.type) {
        case 'session.created':
          sendSessionUpdate();
          break;
        case 'session.updated':
          opened = true;
          openSettled = true;
          clearTimeout(connectTimer);
          resolve({
            pushAudio: (pcm) => {
              if (ws.readyState !== ws.OPEN || pcm.length === 0) return;
              sendJson({
                type: 'input_audio_buffer.append',
                audio: Buffer.from(pcm).toString('base64'),
              });
            },
            finish: () => {
              if (finishPromise) return finishPromise;
              finishPromise = new Promise<string>((res, rej) => {
                finishResolve = res;
                finishReject = rej;
                try {
                  sendJson({ type: 'input_audio_buffer.commit' });
                  sendJson({ type: 'session.finish' });
                } catch (error) {
                  rej(error);
                }
              });
              return finishPromise;
            },
            abort: close,
          });
          break;
        case 'conversation.item.input_audio_transcription.text': {
          const text = typeof msg.text === 'string' ? msg.text : '';
          const stash = typeof msg.stash === 'string' ? msg.stash : '';
          const preview = `${text}${stash}`.trim();
          callbacks.onInterim?.([committed, preview].filter(Boolean).join(' '));
          break;
        }
        case 'conversation.item.input_audio_transcription.completed':
          if (typeof msg.transcript === 'string') {
            committed = appendTranscript(committed, msg.transcript);
            callbacks.onInterim?.(committed);
          }
          break;
        case 'conversation.item.input_audio_transcription.failed':
          fail(
            new Error(
              msg.error?.message ??
                msg.error?.code ??
                'Qwen ASR realtime transcription failed.',
            ),
          );
          break;
        case 'session.finished':
          finishResolve?.(committed.trim());
          close();
          break;
        case 'error':
          fail(
            new Error(
              msg.error?.message ??
                msg.error?.code ??
                'Qwen ASR realtime request failed.',
            ),
          );
          break;
        default:
          break;
      }
    });

    ws.on('error', fail);
    ws.on('close', () => {
      clearTimeout(connectTimer);
      if (!openSettled) {
        openSettled = true;
        reject(new Error('Qwen ASR realtime connection closed.'));
        return;
      }
      finishResolve?.(committed.trim());
    });
  });
}
