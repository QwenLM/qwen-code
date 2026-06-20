/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

// Streaming ASR over the DashScope realtime "task" WebSocket protocol
// (paraformer-realtime / fun-asr-realtime). Audio is pushed as raw binary PCM
// (s16le, 16 kHz, mono) and transcripts arrive as `result-generated` events;
// `payload.output.sentence.sentence_end` marks a finalized sentence.

export interface VoiceStreamConfig {
  /** HTTPS base URL of the configured provider; its host derives the wss URL. */
  baseUrl: string;
  apiKey?: string;
  /** A realtime model id, e.g. paraformer-realtime-v2 / fun-asr-realtime. */
  model: string;
  /** Optional BCP-47-ish language code (paraformer language_hints). */
  language?: string;
}

export interface VoiceStreamCallbacks {
  /** The full running transcript (committed sentences + current partial). */
  onInterim?: (text: string) => void;
}

export interface VoiceStreamSession {
  pushAudio: (pcm: Uint8Array) => void;
  /** Flush, wait for the final result, and return the full transcript. */
  finish: () => Promise<string>;
  abort: () => void;
}

interface SocketLike {
  readyState: number;
  OPEN: number;
  send: (data: string | Uint8Array) => void;
  close: () => void;
  on: (event: string, cb: (...args: unknown[]) => void) => void;
}

export interface VoiceStreamDeps {
  createWebSocket?: (
    url: string,
    options: { headers: Record<string, string> },
  ) => SocketLike;
}

const CONNECT_TIMEOUT_MS = 8000;

export function deriveStreamUrl(baseUrl: string): string {
  const host = new URL(baseUrl).host;
  return `wss://${host}/api-ws/v1/inference`;
}

export function openVoiceStream(
  config: VoiceStreamConfig,
  callbacks: VoiceStreamCallbacks = {},
  deps: VoiceStreamDeps = {},
): Promise<VoiceStreamSession> {
  const createWebSocket =
    deps.createWebSocket ??
    ((url, options) =>
      new WebSocket(url, {
        headers: options.headers,
      }) as unknown as SocketLike);

  return new Promise<VoiceStreamSession>((resolve, reject) => {
    const ws = createWebSocket(deriveStreamUrl(config.baseUrl), {
      headers: config.apiKey
        ? { Authorization: `bearer ${config.apiKey}` }
        : {},
    });
    const taskId = randomUUID();
    let started = false;
    let settled = false;
    let committed = '';
    let finishResolve: ((text: string) => void) | null = null;
    let finishReject: ((error: unknown) => void) | null = null;

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      if (finishReject) {
        finishReject(error);
      } else {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };

    const connectTimer = setTimeout(() => {
      if (!started) fail(new Error('Voice stream connection timed out.'));
    }, CONNECT_TIMEOUT_MS);

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
          payload: {
            task_group: 'audio',
            task: 'asr',
            function: 'recognition',
            model: config.model,
            parameters: {
              format: 'pcm',
              sample_rate: 16000,
              ...(config.language ? { language_hints: [config.language] } : {}),
            },
            input: {},
          },
        }),
      );
    });

    ws.on('message', (...args: unknown[]) => {
      const data = args[0];
      const isBinary = args[1] === true;
      if (isBinary) return;
      let msg: {
        header?: {
          event?: string;
          error_code?: string;
          error_message?: string;
        };
        payload?: {
          output?: {
            sentence?: {
              text?: unknown;
              sentence_end?: boolean;
              heartbeat?: boolean;
            };
          };
        };
      };
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      const event = msg.header?.event;
      if (event === 'task-started') {
        started = true;
        clearTimeout(connectTimer);
        resolve({
          pushAudio: (pcm) => {
            if (ws.readyState === ws.OPEN && pcm.length > 0) ws.send(pcm);
          },
          finish: () =>
            new Promise<string>((res, rej) => {
              finishResolve = res;
              finishReject = rej;
              try {
                ws.send(
                  JSON.stringify({
                    header: {
                      action: 'finish-task',
                      task_id: taskId,
                      streaming: 'duplex',
                    },
                    payload: { input: {} },
                  }),
                );
              } catch (error) {
                rej(error);
              }
            }),
          abort: () => {
            try {
              ws.close();
            } catch {
              /* ignore */
            }
          },
        });
      } else if (event === 'result-generated') {
        const sentence = msg.payload?.output?.sentence;
        if (
          sentence &&
          !sentence.heartbeat &&
          typeof sentence.text === 'string'
        ) {
          if (sentence.sentence_end) {
            committed = committed
              ? `${committed} ${sentence.text}`
              : sentence.text;
            callbacks.onInterim?.(committed);
          } else {
            const running = committed
              ? `${committed} ${sentence.text}`
              : sentence.text;
            callbacks.onInterim?.(running);
          }
        }
      } else if (event === 'task-finished') {
        settled = true;
        clearTimeout(connectTimer);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        finishResolve?.(committed.trim());
      } else if (event === 'task-failed') {
        clearTimeout(connectTimer);
        fail(
          new Error(
            `Voice stream failed (${msg.header?.error_code ?? 'error'}): ${
              msg.header?.error_message ?? 'unknown'
            }`,
          ),
        );
      }
    });

    ws.on('error', (...args: unknown[]) => {
      clearTimeout(connectTimer);
      const error = args[0];
      fail(error instanceof Error ? error : new Error(String(error)));
    });

    ws.on('close', () => {
      clearTimeout(connectTimer);
      if (settled) return;
      if (started && finishResolve) {
        settled = true;
        finishResolve(committed.trim());
      } else if (!started) {
        fail(new Error('Voice stream closed before it started.'));
      }
    });
  });
}
