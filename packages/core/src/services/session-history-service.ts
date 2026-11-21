/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { Part } from '@google/genai';
import type { ChatRecord } from './chatRecordingService.js';
import { isSessionContextPart } from './session-notes-state.js';
import {
  InvalidSessionTranscriptCursorError,
  SessionTranscriptSnapshotUnavailableError,
  SessionTranscriptPageTooLargeError,
  type SessionTranscriptReader,
} from './session-transcript-reader.js';
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
  start?: number;
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

const RECORDED_MEDIA_OMITTED = '[Recorded media omitted]';

function redactRecordedJson(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(
      text,
      (_key, value: unknown, context?: { source?: string }) =>
        typeof value === 'number' && context?.source
          ? (
              JSON as typeof JSON & { rawJSON(source: string): unknown }
            ).rawJSON(context.source)
          : value,
    );
    // Keep numeric spellings and precision when redacting a JSON transcript.
    const redacted = JSON.stringify(parsed, redactRecordedMediaValue).replace(
      /"(?:\\.|[^"\\])*"/gu,
      (literal) => {
        const decoded = JSON.parse(literal) as string;
        const value = redactRecordedMediaText(decoded);
        return value === decoded ? literal : JSON.stringify(value);
      },
    );
    return redacted === JSON.stringify(parsed) ? text : redacted;
  } catch (error) {
    // A redaction resource failure must not expose valid JSON as plain text.
    if (!(error instanceof SyntaxError)) return RECORDED_MEDIA_OMITTED;
    return undefined;
  }
}

function redactEmbeddedRecordedJson(text: string): string {
  const starts = /\{(?=\s*["}])|\[(?=\s*[{"[\]tfn0-9-])|"/gu;
  const chunks: string[] = [];
  let copied = 0;
  // A malformed enclosing fragment can force retries from inner openings.
  // Bound that overlapping work and omit the value instead of leaking it.
  let remaining = 4 * text.length;
  for (let start = starts.exec(text); start; start = starts.exec(text)) {
    const isString = start[0] === '"';
    let inString = isString;
    let hasEscape = false;
    let depth = isString ? 0 : 1;
    let end: number | undefined;
    for (let i = start.index + 1; i < text.length; i++) {
      if (--remaining < 0) return RECORDED_MEDIA_OMITTED;
      const char = text[i];
      if (inString) {
        if (char === '\\') {
          hasEscape = true;
          i++;
        } else if (char === '"') {
          if (isString) {
            end = i + 1;
            break;
          }
          inString = false;
        }
      } else if (char === '"') {
        inString = true;
      } else if (char === '{' || char === '[') {
        depth++;
      } else if ((char === '}' || char === ']') && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    if (end === undefined || (isString && !hasEscape)) continue;

    const fragment = text.slice(start.index, end);
    // This quote can instead be the first JSON key or array item in prose.
    if (isString && /[{[]\s*"$/u.test(fragment)) continue;
    const redacted = redactRecordedJson(fragment);
    if (redacted === undefined) continue;
    if (redacted !== fragment) {
      chunks.push(text.slice(copied, start.index), redacted);
      copied = end;
    }
    // An unchanged scalar may have ended at the start of an encoded value.
    starts.lastIndex = isString && redacted === fragment ? end - 1 : end;
  }
  return chunks.length ? chunks.join('') + text.slice(copied) : text;
}

function redactRecordedMediaText(text: string): string {
  if (/^\s*[{["]/u.test(text)) {
    const redacted = redactRecordedJson(text);
    if (redacted !== undefined) return redacted;
  }

  const jsonRedacted = redactEmbeddedRecordedJson(text);
  let standalone = false;
  const redacted = jsonRedacted.replace(
    /data:(?:[^=,:"'<>]|=(?:[ \t\r\n]*"[^"\\]*(?:\\[\s\S][^"\\]*)*"|(?![ \t\r\n]*")))*;base64,[^"'<>)\]}]*/giu,
    (_match, offset: number) => {
      standalone ||= offset === 0;
      return RECORDED_MEDIA_OMITTED;
    },
  );
  // Raw media (for example SVG) can contain quotes, spaces and nested markup;
  // its boundary inside ordinary text cannot be inferred safely.
  if (
    standalone ||
    /^data:(?:[^,]*;base64,|(?:image|audio|video)\/[^,]*,)/iu.test(redacted) ||
    /data:(?:image|audio|video)\/[^,:]*,/iu.test(redacted)
  )
    return RECORDED_MEDIA_OMITTED;
  return redacted;
}

function redactRecordedMediaValue(key: string, entry: unknown): unknown {
  if (
    [
      'thoughtSignature',
      'encrypted_content',
      'reasoning_details',
      'providerMetadata',
    ].includes(key)
  )
    return undefined;
  if (/^(?:inline|file)[_-]?data$/iu.test(key)) return RECORDED_MEDIA_OMITTED;
  if (key === 'b64_json' || key === 'bytesBase64Encoded')
    return RECORDED_MEDIA_OMITTED;
  if (
    entry &&
    typeof entry === 'object' &&
    'type' in entry &&
    [
      'image',
      'audio',
      'video',
      'image_url',
      'video_url',
      'input_audio',
    ].includes(String(entry.type))
  )
    return RECORDED_MEDIA_OMITTED;
  if (
    entry &&
    typeof entry === 'object' &&
    ('data' in entry || 'source' in entry) &&
    (Object.keys(entry).some((name) =>
      /^(?:mime|media)[_-]?type$/iu.test(name),
    ) ||
      ('type' in entry && entry.type === 'base64'))
  )
    return RECORDED_MEDIA_OMITTED;
  if (typeof entry === 'string') return redactRecordedMediaText(entry);
  return entry;
}

function historyJson(value: unknown): string {
  return redactRecordedMediaText(
    JSON.stringify(value, redactRecordedMediaValue),
  );
}

function historyPartText(part: Part): string {
  if (typeof part.text === 'string') return redactRecordedMediaText(part.text);
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
  if (
    record.type === 'system' ||
    record.subtype === 'realtime_message' ||
    (record.type === 'user' && record.provenance === 'system')
  )
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
    private readonly getReader: () => SessionTranscriptReader,
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
    const reader = this.getReader();
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
      if (start > 0) entry = { ...entry, start };
      let low = 0;
      let high = Math.min(entry.text.length - start, preview ? 240 : 16 * 1024);
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
            partial: true,
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
      const page = await reader
        .readContextHistory(this.sessionId, { recordId: match[1] }, signal)
        .catch((error: unknown) => {
          if (error instanceof SessionTranscriptPageTooLargeError) {
            throw new Error(
              'This recorded entry is too large for history retrieval. Use its original file or artifact if available; list and search can continue past it.',
              { cause: error },
            );
          }
          if (
            error instanceof InvalidSessionTranscriptCursorError ||
            error instanceof SessionTranscriptSnapshotUnavailableError
          ) {
            throw new Error(
              'This reference is not available on the current session branch.',
              { cause: error },
            );
          }
          throw error;
        });
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

    const saved =
      request.cursor !== undefined
        ? this.cursors.get(request.cursor)
        : undefined;
    if (request.cursor !== undefined && !saved)
      throw new Error('History cursor expired. Start a new list or search.');
    if (request.action === 'list' && request.query !== undefined)
      throw new Error('Use search to filter history with a literal query.');
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
    const page = await reader
      .readContextHistory(
        this.sessionId,
        { snapshot: saved?.snapshot, offset, limit: 100 },
        signal,
      )
      .catch((error: unknown) => {
        if (
          error instanceof InvalidSessionTranscriptCursorError ||
          error instanceof SessionTranscriptSnapshotUnavailableError
        ) {
          throw new Error(
            'History cursor expired. Start a new list or search.',
            {
              cause: error,
            },
          );
        }
        throw error;
      });
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
        const preview = clip(
          entry,
          request.action === 'search'
            ? Math.max(0, entry.text.indexOf(query!) - 40)
            : 0,
          true,
        );
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
            offset: (page.startOffset ?? offset) + i,
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
      notice: page.omittedOversizedRecords
        ? 'Oversized recorded entries were omitted. Results are incomplete; use the original file or artifact if available.'
        : page.gaps.length > 0
          ? 'The recorded branch has gaps. Results are incomplete; original artifacts may be unavailable.'
          : 'Recorded content only; original tool output may already be truncated and artifacts may be unavailable.',
    });
  }
}
