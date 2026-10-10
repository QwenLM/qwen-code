/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { Part } from '@google/genai';
import type { ChatRecord } from './chatRecordingService.js';
import { isSessionContextPart } from './session-notes-state.js';
import type { SessionTranscriptReader } from './session-transcript-reader.js';
import { estimateContextTextTokens } from './tokenEstimation.js';

export interface SessionHistoryRequest {
  action: 'list' | 'search' | 'read';
  query?: string;
  role?: 'user' | 'assistant' | 'tool';
  ref?: string;
  start?: number;
  cursor?: string;
  limit?: number;
}

interface HistoryEntry {
  ref: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  truncated?: boolean;
  nextStart?: number;
}

interface HistoryCursor {
  snapshot: string;
  offset: number;
  part: number;
  query?: string;
  role?: SessionHistoryRequest['role'];
  action: 'list' | 'search';
}

function historyJson(value: unknown): string {
  return JSON.stringify(value, (key, entry: unknown) => {
    if (
      [
        'thoughtSignature',
        'encrypted_content',
        'reasoning_details',
        'providerMetadata',
      ].includes(key)
    )
      return undefined;
    if (key === 'inlineData' || key === 'fileData')
      return '[Recorded media omitted]';
    if (
      entry &&
      typeof entry === 'object' &&
      'type' in entry &&
      ['image', 'audio', 'image_url', 'input_audio'].includes(
        String(entry.type),
      )
    )
      return '[Recorded media omitted]';
    if (typeof entry === 'string' && /^data:[^;,]+;base64,/u.test(entry))
      return '[Recorded media omitted]';
    return entry;
  });
}

function historyPartText(part: Part): string {
  if (typeof part.text === 'string') return part.text;
  if (part.functionCall) {
    return `${part.functionCall.name}\n${historyJson(part.functionCall.args ?? {})}`;
  }
  if (part.functionResponse) {
    const response = part.functionResponse;
    return `${response.name}\n${historyJson(response.response ?? {})}${response.parts?.length ? '\n[Media/attachment parts omitted; use the original artifact with the appropriate tool if it is still available.]' : ''}`;
  }
  if (part.inlineData || part.fileData) {
    return '[Recorded media; content is not inlined. The original artifact may no longer be available.]';
  }
  return '';
}

function projectHistory(record: ChatRecord): HistoryEntry[] {
  if (record.type === 'system' || record.subtype === 'realtime_message')
    return [];
  const parts = Array.isArray(record.message?.parts)
    ? record.message.parts
    : [];
  return parts.flatMap((part, index) => {
    if (
      !part ||
      typeof part !== 'object' ||
      part.thought ||
      isSessionContextPart(part)
    )
      return [];
    const text = historyPartText(part);
    if (!text) return [];
    return [
      {
        ref: `${record.uuid}:${index}`,
        role:
          record.type === 'tool_result'
            ? ('tool' as const)
            : record.type === 'assistant'
              ? ('assistant' as const)
              : ('user' as const),
        text,
      },
    ];
  });
}

export class SessionHistoryService {
  private readonly cursors = new Map<string, HistoryCursor>();

  constructor(
    private readonly reader: SessionTranscriptReader,
    private readonly sessionId: string,
    private readonly remainingTokens: () => number,
  ) {}

  async query(
    request: SessionHistoryRequest,
    signal: AbortSignal,
  ): Promise<string> {
    const tokenBudget = Math.min(2048, this.remainingTokens());
    if (tokenBudget < 256) {
      throw new Error(
        'Too little context remains for history retrieval. Save notes and start a new context first.',
      );
    }
    const fits = (value: unknown) => {
      const text = JSON.stringify(value);
      return (
        Buffer.byteLength(text, 'utf8') <= 16 * 1024 &&
        estimateContextTextTokens(text) <= tokenBudget
      );
    };
    const clip = (
      entry: HistoryEntry,
      start: number,
      preview: boolean,
    ): HistoryEntry => {
      let low = 0;
      let high = Math.min(
        entry.text.length - start,
        preview ? 240 : entry.text.length,
      );
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (
          fits({
            entries: [
              {
                ...entry,
                text: entry.text.slice(start, start + middle),
                truncated: true,
                nextStart: start + middle,
              },
            ],
            nextCursor: 'x'.repeat(36),
            notice: 'x'.repeat(160),
          })
        )
          low = middle;
        else high = middle - 1;
      }
      if (low > 0 && /[\uD800-\uDBFF]/u.test(entry.text[start + low - 1]))
        low--;
      const end = start + low;
      return {
        ...entry,
        text: entry.text.slice(start, end),
        ...(end < entry.text.length ? { truncated: true, nextStart: end } : {}),
      };
    };

    if (request.action === 'read') {
      const match = /^([^:]+):(\d+)$/u.exec(request.ref ?? '');
      if (!match)
        throw new Error('Use a history ref returned by list or search.');
      const page = await this.reader.readContextHistory(
        this.sessionId,
        { recordId: match[1] },
        signal,
      );
      const entry = page.records
        .flatMap(projectHistory)
        .find((item) => item.ref === request.ref);
      if (!entry)
        throw new Error(
          'This reference is not available on the current session branch.',
        );
      const start = request.start ?? 0;
      if (
        !Number.isSafeInteger(start) ||
        start < 0 ||
        start > entry.text.length
      )
        throw new Error('Invalid history text offset.');
      return JSON.stringify({
        entries: [clip(entry, start, false)],
        notice:
          'Recorded content only; original tool output may already be truncated and artifacts may be unavailable.',
      });
    }

    const saved = request.cursor ? this.cursors.get(request.cursor) : undefined;
    if (request.cursor && !saved)
      throw new Error('History cursor expired. Start a new list or search.');
    if (
      saved &&
      (saved.action !== request.action ||
        (request.query !== undefined && request.query !== saved.query) ||
        (request.role !== undefined && request.role !== saved.role))
    ) {
      throw new Error(
        'Continue a history cursor with the same action and filters.',
      );
    }
    const query = saved?.query ?? request.query;
    const role = saved?.role ?? request.role;
    if (request.action === 'search' && !query)
      throw new Error('A nonempty literal search query is required.');
    const offset = saved?.offset ?? 0;
    const page = await this.reader.readContextHistory(
      this.sessionId,
      { snapshot: saved?.snapshot, offset, limit: 100 },
      signal,
    );
    const entries: HistoryEntry[] = [];
    const limit = Math.min(request.limit ?? 20, 20);
    let next: HistoryCursor | undefined;
    outer: for (let i = 0; i < page.records.length; i++) {
      const projected = projectHistory(page.records[i]);
      for (
        let part = i === 0 ? (saved?.part ?? 0) : 0;
        part < projected.length;
        part++
      ) {
        signal.throwIfAborted();
        const entry = projected[part];
        if (
          (role && entry.role !== role) ||
          (request.action === 'search' && !entry.text.includes(query!))
        )
          continue;
        const preview = clip(entry, 0, true);
        if (
          entries.length >= limit ||
          !fits({
            entries: [...entries, preview],
            nextCursor: 'x'.repeat(36),
            partial: true,
            notice: 'x'.repeat(160),
          })
        ) {
          next = {
            snapshot: page.snapshot,
            offset: offset + i,
            part,
            action: request.action,
            query,
            role,
          };
          break outer;
        }
        entries.push(preview);
      }
    }
    if (!next && page.nextOffset !== undefined) {
      next = {
        snapshot: page.snapshot,
        offset: page.nextOffset,
        part: 0,
        action: request.action,
        query,
        role,
      };
    }
    let nextCursor: string | undefined;
    if (next) {
      nextCursor = randomUUID();
      this.cursors.set(nextCursor, next);
      if (this.cursors.size > 32)
        this.cursors.delete(this.cursors.keys().next().value!);
    }
    return JSON.stringify({
      entries,
      ...(nextCursor ? { nextCursor, partial: true } : {}),
      notice:
        page.gaps.length > 0
          ? 'The recorded branch has gaps. Results are incomplete; original artifacts may be unavailable.'
          : 'Recorded content only; original tool output may already be truncated and artifacts may be unavailable.',
    });
  }
}
