/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Resume-mode adapter: replays a real qwen-code session JSONL
 * (~/.qwen/projects/<dir>/chats/<id>.jsonl) as neutral StreamEvents so the
 * OpenTUI backend renders real conversations without API credentials.
 *
 * Session line shape: { type: 'user'|'assistant'|'system', message: { role, parts:
 * [{ text?, thought?, functionCall?, functionResponse? }] } }.
 */

import { readFileSync } from 'node:fs';
import type { StreamEvent } from '../model/streamingModel.js';

interface SessionPart {
  text?: string;
  thought?: boolean;
  functionCall?: { id?: string; name?: string; args?: unknown };
  functionResponse?: { id?: string; response?: unknown };
}
interface SessionLine {
  type?: string;
  message?: { role?: string; parts?: SessionPart[] };
}

export function transcriptToEvents(jsonl: string): StreamEvent[] {
  const events: StreamEvent[] = [];
  let toolSeq = 0;
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let o: SessionLine;
    try {
      o = JSON.parse(trimmed) as SessionLine;
    } catch {
      continue;
    }
    const parts = o.message?.parts ?? [];
    if (o.type === 'user') {
      const text = parts
        .filter((p) => p.text && !p.thought)
        .map((p) => p.text as string)
        .join('');
      if (text) events.push({ type: 'user', text });
      continue;
    }
    if (o.type === 'assistant') {
      for (const p of parts) {
        if (p.thought && p.text) {
          events.push({ type: 'thinking', delta: p.text });
        } else if (p.functionCall) {
          events.push({
            type: 'tool-start',
            id: p.functionCall.id ?? `tool-${++toolSeq}`,
            tool: p.functionCall.name ?? 'tool',
            title: p.functionCall.name ?? 'tool',
          });
        } else if (p.functionResponse) {
          events.push({
            type: 'tool-end',
            id: p.functionResponse.id ?? `tool-${toolSeq}`,
            success: true,
            summary: 'ok',
          });
        } else if (p.text) {
          events.push({ type: 'text', delta: p.text });
        }
      }
      // close thought between assistant turns
      events.push({ type: 'thinking-end' });
    }
  }
  events.push({ type: 'done' });
  return events;
}

export function loadTranscriptEvents(path: string): StreamEvent[] {
  return transcriptToEvents(readFileSync(path, 'utf8'));
}
