/**
 * @license
 * Copyright 2026 Alibaba Group Holding Limited
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 * Adapted to TypeScript from qwen-omni-realtime-agent; modified for Qwen Live.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { MemoryConfig, MemoryConnection, MemoryLogger } from './config.js';
import {
  complete,
  completionFailureDetails,
  resolveCompletionConnection,
} from './completion.js';
import { OBSERVER_PROMPT } from './prompts.js';
import { formatTimestamp } from './recorder.js';
import { indexText } from './tokenize.js';

export { OBSERVER_PROMPT } from './prompts.js';
export type MemoryVisualSource = 'screen' | 'camera';
export interface MemoryVisualFrame {
  image: string;
  source: MemoryVisualSource;
}

export function cleanObservation(
  text: unknown,
  maxChars = 400,
  log: MemoryLogger = () => {},
): string {
  if (typeof text !== 'string' || !text.trim()) return '';
  const raw = text
    .trim()
    .replace(/```[a-zA-Z]*/gu, ' ')
    .replace(/\*{1,3}|_{2,}|^#{1,6}\s*|^[-*+]\s+/gmu, '');
  let first =
    raw
      .split('\n')
      .map((line) => line.trim().replace(/\s+/gu, ' '))
      .find(Boolean) ?? '';
  first = first
    .replace(
      /^(?:好的|嗯+|收到(?:了)?|以下是|这一帧|这张(?:图|画面)?|更准确的?(?:单句)?描述|okay|ok|sure)[\s，,：:。.、]*/u,
      '',
    )
    .trim();
  if (!first) return '';
  const end = /[。！？!?]/u.exec(first);
  first =
    end?.index !== undefined ? first.slice(0, end.index + 1) : `${first}。`;
  if ([...first].length > maxChars) {
    log('memory.observer.truncated', {
      chars: [...first].length,
      limit: maxChars,
    });
    let window = [...first].slice(0, Math.max(0, maxChars - 1)).join('');
    const pivot = Math.max(
      window.lastIndexOf('，'),
      window.lastIndexOf('、'),
      window.lastIndexOf(','),
    );
    if (pivot > (window.length * 3) / 4) window = window.slice(0, pivot);
    first = `${window.replace(/[，、,]+$/u, '')}。`;
  }
  if ([...first].length < 6) {
    log('memory.observer.empty_reply');
    return '';
  }
  return first;
}

export interface ObserverClientOptions {
  config: MemoryConfig['observer'];
  connection: MemoryConnection;
  log?: MemoryLogger;
  fetch?: typeof fetch;
  transport?: (
    prompt: string,
    frame: MemoryVisualFrame,
    signal?: AbortSignal,
  ) => Promise<string>;
}

export class ObserverClient {
  private readonly connection: MemoryConnection;
  constructor(private readonly options: ObserverClientOptions) {
    this.connection = resolveCompletionConnection(
      options.connection,
      options.config,
    );
  }
  get available(): boolean {
    return Boolean(
      this.options.transport ||
        (this.connection.apiKey && this.connection.baseUrl),
    );
  }
  async observe(
    frame: MemoryVisualFrame,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    if (!this.available || !frame.image || signal?.aborted) return undefined;
    const started = Date.now();
    try {
      const reply = this.options.transport
        ? await this.options.transport(OBSERVER_PROMPT, frame, signal)
        : await complete(
            this.connection,
            {
              model: this.options.config.model,
              temperature: this.options.config.temperature,
              max_tokens: this.options.config.maxTokens,
              enable_thinking: false,
              messages: [
                {
                  role: 'system',
                  content:
                    OBSERVER_PROMPT +
                    (frame.source === 'screen'
                      ? '\n\n当前输入源是用户的屏幕截图，不是摄像头。只记录屏幕中可见的事实，并说明这是屏幕内容；不要将屏幕中的人物或环境当作用户现实中的人物或环境。'
                      : ''),
                },
                {
                  role: 'user',
                  content: [
                    {
                      type: 'image_url',
                      image_url: {
                        url: `data:image/jpeg;base64,${frame.image}`,
                      },
                    },
                    { type: 'text', text: '记录这一帧。' },
                  ],
                },
              ],
            },
            this.options.config.timeoutMs,
            signal,
            this.options.fetch,
          );
      if (signal?.aborted) return undefined;
      const content = cleanObservation(
        reply,
        this.options.config.maxContentChars,
        this.options.log,
      );
      this.options.log?.(
        content ? 'memory.observer.latency' : 'memory.observer.empty_reply',
        { ms: Date.now() - started },
      );
      return content || undefined;
    } catch (error) {
      this.options.log?.(
        'memory.observer.failed',
        completionFailureDetails(error),
      );
      return undefined;
    }
  }
}

export function recordObservation(
  database: DatabaseSync,
  content: string,
  sessionId: string,
  now = new Date(),
  log: MemoryLogger = () => {},
): number | undefined {
  const text = content.trim().replace(/\s+/gu, ' ');
  if (!text) return undefined;
  const existing = database
    .prepare('SELECT id FROM stm_env WHERE content = ?')
    .get(text);
  database.exec('BEGIN IMMEDIATE');
  try {
    database
      .prepare(
        'INSERT INTO stm_env(content, created_at, created_ts, src_session, active, expired_at) VALUES(?, ?, ?, ?, 1, NULL) ON CONFLICT(content) DO UPDATE SET created_at = excluded.created_at, created_ts = excluded.created_ts, src_session = excluded.src_session, active = 1, expired_at = NULL',
      )
      .run(
        text,
        formatTimestamp(now).slice(0, 10),
        Math.floor(now.getTime() / 1000),
        sessionId,
      );
    const row = database
      .prepare('SELECT id FROM stm_env WHERE content = ?')
      .get(text);
    if (!row) throw new Error('Memory observation row missing');
    const id = Number(row['id']);
    database.prepare('DELETE FROM env_fts WHERE env_id = ?').run(id);
    database
      .prepare('INSERT INTO env_fts(index_text, env_id) VALUES(?, ?)')
      .run(indexText(text), id);
    database.exec('COMMIT');
    log(existing ? 'memory.observer.refreshed' : 'memory.observer.recorded', {
      chars: text.length,
    });
    return id;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
