/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export type ParsedInsight =
  | {
      type: 'insight_progress';
      stage: string;
      progress: number;
      detail?: string;
    }
  | { type: 'insight_ready'; path: string }
  | { type: 'insight_error'; error: string };

type InsightSegment =
  | { kind: 'text'; text: string }
  | { kind: 'insight'; data: ParsedInsight };

const INSIGHT_PREFIXES = [
  '"insight_progress":',
  '"insight_ready":',
  '"insight_error":',
];

function getRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function parseInsightJson(json: string): ParsedInsight | null {
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const prog = getRecord(parsed['insight_progress']);
    if (
      prog &&
      typeof prog['stage'] === 'string' &&
      typeof prog['progress'] === 'number'
    ) {
      return {
        type: 'insight_progress',
        stage: prog['stage'] as string,
        progress: prog['progress'] as number,
        detail:
          typeof prog['detail'] === 'string'
            ? (prog['detail'] as string)
            : undefined,
      };
    }
    const ready = getRecord(parsed['insight_ready']);
    if (ready && typeof ready['path'] === 'string') {
      return { type: 'insight_ready', path: ready['path'] as string };
    }
    const insightError = getRecord(parsed['insight_error']);
    if (insightError && typeof insightError['error'] === 'string') {
      return { type: 'insight_error', error: insightError['error'] as string };
    }
  } catch {
    // not valid JSON
  }
  return null;
}

// Balanced-braces JSON extractor. Handles string escapes but not standalone
// arrays — sufficient for the insight protocol's object-only payloads.
function extractJsonObject(text: string, start: number): string | null {
  if (text[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function splitInsightSegments(text: string): InsightSegment[] | null {
  if (!INSIGHT_PREFIXES.some((prefix) => text.includes(prefix))) return null;
  const segments: InsightSegment[] = [];
  let lastIndex = 0;
  let pos = 0;
  let hasInsight = false;

  while (pos < text.length) {
    const braceIdx = text.indexOf('{', pos);
    if (braceIdx === -1) break;

    const afterBrace = text.slice(braceIdx + 1).trimStart();
    const isInsight = INSIGHT_PREFIXES.some((p) => afterBrace.startsWith(p));
    if (!isInsight) {
      pos = braceIdx + 1;
      continue;
    }

    const json = extractJsonObject(text, braceIdx);
    if (!json) {
      pos = braceIdx + 1;
      continue;
    }

    const insight = parseInsightJson(json);
    if (!insight) {
      pos = braceIdx + 1;
      continue;
    }

    hasInsight = true;
    const before = text.slice(lastIndex, braceIdx).trim();
    if (before) {
      segments.push({ kind: 'text', text: before });
    }
    segments.push({ kind: 'insight', data: insight });
    lastIndex = braceIdx + json.length;
    pos = lastIndex;
  }

  if (!hasInsight) return null;

  const after = text.slice(lastIndex).trim();
  if (after) {
    segments.push({ kind: 'text', text: after });
  }

  return segments.length > 0 ? segments : null;
}
