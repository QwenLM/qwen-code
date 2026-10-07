/**
 * @license
 * Copyright 2026 Alibaba Group Holding Limited
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MemoryLogger } from './config.js';
import {
  LTM_FIELDS,
  LTM_SINGLE_VALUE,
  LTM_TRIM_ORDER,
  type LtmField,
} from './schema.js';

export interface RenderTurn {
  turnIdx: number;
  userText: string;
  userTs: string;
  userEpoch: number;
  asstText: string;
  asstTs: string;
  asstEpoch: number;
  interrupted?: boolean;
}

export interface DialogueSegmentRow {
  id: number;
  session_id: string | null;
  turn_from: number;
  turn_to: number;
  n_turns: number;
  start_ts: string;
  end_ts: string;
  start_epoch: number;
  end_epoch: number;
  body: string;
  cut_reason: string;
  n_chars?: number;
  score?: number;
  similarity?: number;
  from_tail?: boolean;
}

export interface EnvObservationRow {
  id: number;
  content: string;
  created_at: string;
  created_ts: number;
  src_session: string | null;
  active: number;
  observed_at?: string;
  score?: number;
  from_tail?: boolean;
}

export interface RecentItem {
  content: string;
  status: string;
  recorded_at?: string;
  created_at?: string;
}

export const INTERRUPTED_MARKER = '（被用户打断）';
export const MEMORY_SECTIONS = [
  'user_profile',
  'recent',
  'retrieved',
  'personalized_user_memories',
] as const;
export const SOURCE_PREFIXES = {
  dialogue: '[dialogue] ',
  env: '[visual] ',
} as const;

export function charLength(text: string): number {
  return [...text].length;
}

export function renderTurnLines(turn: RenderTurn): string[] {
  const lines = [`   [${turn.userTs}] User: ${turn.userText}`];
  if (turn.asstText) {
    lines.push(
      `   [${turn.asstTs}] Assistant: ${turn.asstText}${turn.interrupted ? INTERRUPTED_MARKER : ''}`,
    );
  }
  return lines;
}

export function renderSegmentBody(turns: readonly RenderTurn[]): string {
  return turns.flatMap(renderTurnLines).join('\n');
}

export function renderSegmentIndexText(turns: readonly RenderTurn[]): string {
  return turns
    .flatMap((turn) => [turn.userText, turn.asstText])
    .filter((part) => part.trim())
    .join(' ');
}

export function renderDialogueResults(
  segments: readonly DialogueSegmentRow[],
): string {
  return segments
    .flatMap((row, index) => [
      `${index + 1}. [${row.start_ts} ~ ${row.end_ts}, ${row.n_turns} turns]`,
      ...(row.body.trimEnd() ? [row.body.trimEnd()] : []),
    ])
    .join('\n');
}

export function formatLocalDate(moment: Date): string {
  const part = (value: number) => String(value).padStart(2, '0');
  return `${moment.getFullYear()}-${part(moment.getMonth() + 1)}-${part(moment.getDate())}`;
}

export function formatLocalTimestamp(moment: Date): string {
  const part = (value: number) => String(value).padStart(2, '0');
  return `${formatLocalDate(moment)} ${part(moment.getHours())}:${part(moment.getMinutes())}:${part(moment.getSeconds())}`;
}

export function renderEnvResults(
  observations: readonly EnvObservationRow[],
): string {
  return observations
    .filter((row) => row.content.trim())
    .map((row, index) => {
      const stamp =
        row.observed_at ||
        formatLocalTimestamp(new Date(row.created_ts * 1000));
      return `${index + 1}. [${stamp}] ${row.content.replace(/\s+/gu, ' ').trim()}`;
    })
    .join('\n');
}

export function renderUserProfile(
  values: Partial<Record<LtmField, string[]>>,
  maxChars = 800,
  log: MemoryLogger = () => {},
): { text: string; trimmed: LtmField[] } {
  const working = new Map(
    LTM_FIELDS.map(([key]) => [
      key,
      (values[key] ?? []).map((value) => value.trim()).filter(Boolean),
    ]),
  );
  const build = () =>
    LTM_FIELDS.flatMap(([key, label]) => {
      const entries = working.get(key) ?? [];
      return entries.length
        ? [
            `- ${label}: ${LTM_SINGLE_VALUE.has(key) ? entries[0] : entries.join('、')}`,
          ]
        : [];
    }).join('\n');
  const trimmed: LtmField[] = [];
  let text = build();
  for (const field of LTM_TRIM_ORDER) {
    if (charLength(text) <= maxChars) break;
    if (working.get(field)?.length) {
      working.set(field, []);
      trimmed.push(field);
      text = build();
    }
  }
  if (trimmed.length) log('memory.preload.ltm_trimmed', { fields: trimmed });
  return { text, trimmed };
}

export function renderRecent(items: readonly RecentItem[]): string {
  return items
    .flatMap((item) => {
      const content = item.content.replace(/\s+/gu, ' ').trim();
      return content
        ? [
            `- [${item.status}][recorded at ${item.recorded_at ?? item.created_at ?? ''}] ${content}`,
          ]
        : [];
    })
    .join('\n');
}

export function renderRetrievedSection(
  body: string,
  source: 'dialogue' | 'env' = 'dialogue',
): string {
  return body
    .split('\n')
    .map((line) =>
      line && !line.startsWith(' ')
        ? `${SOURCE_PREFIXES[source]}${line}`
        : line,
    )
    .join('\n');
}

export function renderRetrievedBlock(
  segments: readonly DialogueSegmentRow[],
  maxChars?: number,
): string {
  const kept = [...segments];
  let rendered = '';
  while (kept.length) {
    rendered = renderRetrievedSection(renderDialogueResults(kept));
    if (maxChars === undefined || charLength(rendered) <= maxChars)
      return rendered;
    if (kept.length === 1) break;
    kept.pop();
  }
  if (!rendered || maxChars === undefined) return rendered;
  const lines: string[] = [];
  let used = 0;
  for (const line of rendered.split('\n')) {
    const cost = charLength(line) + (lines.length ? 1 : 0);
    if (lines.length && used + cost > maxChars) break;
    lines.push(line);
    used += cost;
  }
  return lines.join('\n');
}

export function renderMemoryBlock(
  values: {
    userProfile?: string;
    recent?: string;
    retrieved?: string;
    personalizedUserMemories?: string;
  } = {},
): string {
  const contents = [
    values.userProfile,
    values.recent,
    values.retrieved,
    values.personalizedUserMemories,
  ];
  return MEMORY_SECTIONS.map((section, index) => {
    const content = (contents[index] ?? '').replace(/^\n+|\n+$/gu, '');
    return `<${section}>\n${content ? `${content}\n` : ''}</${section}>`;
  }).join('\n\n');
}
