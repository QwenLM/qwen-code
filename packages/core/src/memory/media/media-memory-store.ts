/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import { atomicWriteFile } from '../../utils/atomicFileWrite.js';
import { tagUntrustedMediaText } from '../../utils/media/media-security.js';
import type { Modality } from '../../utils/media/types.js';
import { getMediaRecordPath, getMediaMemoryRoot } from './media-paths.js';
import { rebuildMediaIndex } from './media-indexer.js';

/**
 * P2 · Media memory store (store/index skeleton).
 *
 * One record per file, keyed by content hash, persisted as markdown with
 * frontmatter (mirroring the text memory format). Multiple understandings of the
 * same file accumulate (增厚): each `put` appends a timestamped section and
 * merges links, rather than overwriting. Understanding bodies are untrusted
 * content and are tagged as such on write.
 *
 * "Store + index + recall" is A-class. What derived artifacts to store and how
 * to build links are B-class (see media-links.ts).
 */

export interface MediaUnderstanding {
  hash: string;
  modality: Modality;
  /** Source path at the time of this understanding. */
  path: string;
  /** One-line summary that goes into MEDIA_INDEX.md. */
  summary: string;
  /** Detailed note (untrusted media-derived content). */
  body: string;
  /** Which reader produced this (provenance). */
  readerId: string;
  cost?: string;
  params?: Record<string, unknown>;
  /** Related file hashes (Q6: scaffold auto-built). */
  links?: string[];
  /** Q12: trust domain of the source, for cross-project recall filtering. */
  sourceScope?: string;
  /** ISO timestamp; defaults to now. */
  timestamp?: string;
}

export interface StoredMediaRecord {
  hash: string;
  modality: string;
  path: string;
  summary: string;
  links: string[];
  sourceScope?: string;
  updatedAt: string;
  body: string;
}

export interface MediaMemory {
  put(u: MediaUnderstanding): Promise<void>;
  get(hash: string): Promise<StoredMediaRecord | undefined>;
  list(): Promise<StoredMediaRecord[]>;
  linkOf(hash: string): Promise<string[]>;
}

/** Collapse control chars / newlines so one field can't break the frontmatter. */
function frontmatterField(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function serializeRecord(rec: StoredMediaRecord): string {
  const links = rec.links.length > 0 ? rec.links.join(', ') : '';
  const lines = [
    '---',
    `hash: ${rec.hash}`,
    `modality: ${frontmatterField(rec.modality)}`,
    `path: ${frontmatterField(rec.path)}`,
    `summary: ${frontmatterField(rec.summary)}`,
    `links: ${frontmatterField(links)}`,
    ...(rec.sourceScope
      ? [`sourceScope: ${frontmatterField(rec.sourceScope)}`]
      : []),
    `updatedAt: ${rec.updatedAt}`,
    '---',
    '',
    rec.body.trimEnd(),
    '',
  ];
  return lines.join('\n');
}

function parseRecord(text: string): StoredMediaRecord | undefined {
  const normalized = text.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return undefined;
  const [, fm, body] = match;
  const field = (key: string): string => {
    const m = fm.match(new RegExp(`^${key}:[^\\S\\n]*(.*)$`, 'm'));
    return m ? m[1].trim() : '';
  };
  const hash = field('hash');
  if (!hash) return undefined;
  const linksRaw = field('links');
  return {
    hash,
    modality: field('modality'),
    path: field('path'),
    summary: field('summary'),
    links: linksRaw
      ? linksRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
    sourceScope: field('sourceScope') || undefined,
    updatedAt: field('updatedAt'),
    body: body.trim(),
  };
}

class FileMediaMemory implements MediaMemory {
  async get(hash: string): Promise<StoredMediaRecord | undefined> {
    try {
      const text = await fs.readFile(getMediaRecordPath(hash), 'utf8');
      return parseRecord(text);
    } catch {
      return undefined;
    }
  }

  async put(u: MediaUnderstanding): Promise<void> {
    await fs.mkdir(getMediaMemoryRoot(), { recursive: true });
    const now = u.timestamp ?? new Date().toISOString();
    const existing = await this.get(u.hash);

    const mergedLinks = Array.from(
      new Set([...(existing?.links ?? []), ...(u.links ?? [])]),
    ).filter((h) => h !== u.hash);

    const section = [
      `## ${now} — reader ${frontmatterField(u.readerId)}${u.cost ? ` (${frontmatterField(u.cost)})` : ''}`,
      '',
      tagUntrustedMediaText(u.body.trim()),
      '',
    ].join('\n');

    const body = existing?.body ? `${existing.body}\n\n${section}` : section;

    const record: StoredMediaRecord = {
      hash: u.hash,
      modality: u.modality,
      path: u.path,
      summary: u.summary,
      links: mergedLinks,
      sourceScope: u.sourceScope ?? existing?.sourceScope,
      updatedAt: now,
      body,
    };

    await atomicWriteFile(getMediaRecordPath(u.hash), serializeRecord(record), {
      encoding: 'utf8',
    });
    await rebuildMediaIndex(await this.list());
  }

  async list(): Promise<StoredMediaRecord[]> {
    let files: string[];
    try {
      files = await fs.readdir(getMediaMemoryRoot());
    } catch {
      return [];
    }
    const records: StoredMediaRecord[] = [];
    for (const file of files) {
      if (!file.endsWith('.md') || file === 'MEDIA_INDEX.md') continue;
      try {
        const text = await fs.readFile(
          `${getMediaMemoryRoot()}/${file}`,
          'utf8',
        );
        const rec = parseRecord(text);
        if (rec) records.push(rec);
      } catch {
        // Skip unreadable records.
      }
    }
    return records;
  }

  async linkOf(hash: string): Promise<string[]> {
    const rec = await this.get(hash);
    return rec?.links ?? [];
  }
}

let singleton: MediaMemory | undefined;

export function getMediaMemory(): MediaMemory {
  if (!singleton) singleton = new FileMediaMemory();
  return singleton;
}

export { parseRecord as parseMediaRecord };
