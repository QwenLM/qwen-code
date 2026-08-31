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
import {
  extractFileDiff,
  renderResultDisplay,
  type OpenTuiStreamEvent,
} from './event-adapter.js';

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

export interface TranscribeOptions {
  /** Maps a raw tool name to a display title (e.g. registry displayName). */
  toolTitle?: (name: string) => string | undefined;
}

export interface TranscriptResult {
  events: OpenTuiStreamEvent[];
  prompts: string[];
}

export function transcriptToEvents(
  jsonl: string,
  opts: TranscribeOptions = {},
): OpenTuiStreamEvent[] {
  return transcribeSession(jsonl, opts).events;
}

export function transcribeSession(
  jsonl: string,
  opts: TranscribeOptions = {},
): TranscriptResult {
  const events: OpenTuiStreamEvent[] = [];
  const prompts: string[] = [];
  let toolSeq = 0;
  const pendingIdlessIds: string[] = [];
  for (const line of jsonl.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let o: SessionLine & {
      subtype?: string;
      systemPayload?: { phase?: string; rawCommand?: string };
      toolCallResult?: {
        callId?: string;
        status?: string;
        resultDisplay?: unknown;
      };
    };
    try {
      o = JSON.parse(t) as typeof o;
    } catch {
      continue;
    }
    const parts = o.message?.parts ?? [];
    if (o.type === 'user') {
      if (o.subtype) continue; // skip subtyped user records (goal_runtime etc.)
      const text = parts
        .filter((p) => p.text && !p.thought)
        .map((p) => p.text as string)
        .join('\n');
      if (text) {
        events.push({ type: 'user', text });
        prompts.push(text);
      }
      continue;
    }
    if (o.type === 'system') {
      if (
        o.subtype === 'slash_command' &&
        o.systemPayload?.phase === 'invocation' &&
        o.systemPayload?.rawCommand
      ) {
        const cmd = o.systemPayload.rawCommand;
        events.push({ type: 'user', text: cmd });
        prompts.push(cmd);
      }
      continue;
    }
    if (o.type === 'tool_result') {
      const r = o.toolCallResult ?? {};
      const id = r.callId ?? pendingIdlessIds.shift() ?? `tool-${++toolSeq}`;
      if (r.resultDisplay) {
        // FileDiff results ride as structured payloads (colored diff lines in
        // the tool card); everything else flattens to display text. Bare
        // `String(obj)` would render "[object Object]".
        const diff = extractFileDiff(r.resultDisplay);
        if (diff) {
          events.push({ type: 'tool-result', id, display: '', diff });
        } else {
          events.push({
            type: 'tool-output',
            id,
            delta: renderResultDisplay(r.resultDisplay),
          });
        }
      }
      const status = r.status ?? 'success';
      const ok = status !== 'error' && status !== 'cancelled';
      events.push({
        type: 'tool-end',
        id,
        success: ok,
        summary: ok ? 'ok' : 'error',
      });
      continue;
    }
    if (o.type === 'assistant') {
      let thinkingOpen = false;
      for (const p of parts) {
        if (p.thought && p.text) {
          events.push({ type: 'thinking', delta: p.text });
          thinkingOpen = true;
        } else {
          if (thinkingOpen) {
            events.push({ type: 'thinking-end' });
            thinkingOpen = false;
          }
          if (p.functionCall) {
            const name = p.functionCall.name ?? 'tool';
            let id = p.functionCall.id;
            if (!id) {
              id = `tool-${++toolSeq}`;
              pendingIdlessIds.push(id);
            }
            events.push({
              type: 'tool-start',
              id,
              tool: name,
              title: opts.toolTitle?.(name) ?? name,
            });
          } else if (p.text) {
            events.push({ type: 'text', delta: p.text });
          }
        }
      }
      if (thinkingOpen) events.push({ type: 'thinking-end' });
    }
  }
  events.push({ type: 'done' });
  return { events, prompts };
}

export function loadTranscriptEvents(path: string): OpenTuiStreamEvent[] {
  return transcriptToEvents(readFileSync(path, 'utf8'));
}
