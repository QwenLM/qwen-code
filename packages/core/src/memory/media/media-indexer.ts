/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import { atomicWriteFile } from '../../utils/atomicFileWrite.js';
import type { StoredMediaRecord } from './media-memory-store.js';
import { getMediaIndexPath, getMediaMemoryRoot } from './media-paths.js';

/**
 * P2 · Media index (independent MEDIA_INDEX.md). Fully regenerated from the
 * record files (never appended incrementally), mirroring the text memory
 * indexer. Index fields are defanged because media summaries derive from
 * untrusted content.
 */

const MAX_INDEX_LINES = 200;
const MAX_INDEX_FIELD_CHARS = 120;

/** Defang a field for a single-line markdown index entry. */
function sanitizeField(value: string): string {
  const cleaned = value
    .split(/\s+/)
    .join(' ')
    .split('`')
    .join("'")
    .split('](')
    .join('] (')
    .trim();
  if (cleaned.length <= MAX_INDEX_FIELD_CHARS) return cleaned;
  return `${cleaned.slice(0, MAX_INDEX_FIELD_CHARS - 1).trimEnd()}…`;
}

function recordLine(rec: StoredMediaRecord): string {
  const label = sanitizeField(`${rec.modality}: ${rec.summary}`) || rec.hash;
  const target = encodeURIComponent(`${rec.hash}.md`);
  const where = sanitizeField(rec.path);
  const when = sanitizeField(rec.updatedAt);
  return `- [${label}](${target}) — ${where} — ${when}`;
}

/** Rebuild MEDIA_INDEX.md from the given records. */
export async function rebuildMediaIndex(
  records: StoredMediaRecord[],
): Promise<string> {
  const sorted = [...records].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
  let lines = sorted.map(recordLine);
  let truncated = false;
  if (lines.length > MAX_INDEX_LINES) {
    lines = lines.slice(0, MAX_INDEX_LINES);
    truncated = true;
  }
  const header = '# Media understanding index\n';
  let content = `${header}\n${lines.join('\n')}\n`;
  if (truncated) {
    content += `\n> NOTE: MEDIA_INDEX.md truncated to ${MAX_INDEX_LINES} most-recent entries.\n`;
  }
  await fs.mkdir(getMediaMemoryRoot(), { recursive: true });
  await atomicWriteFile(getMediaIndexPath(), content, { encoding: 'utf8' });
  return content;
}

/** Read the raw index text, or null when it does not exist. */
export async function readMediaIndex(): Promise<string | null> {
  try {
    return await fs.readFile(getMediaIndexPath(), 'utf8');
  } catch {
    return null;
  }
}
