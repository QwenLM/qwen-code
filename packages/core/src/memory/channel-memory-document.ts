/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';

export const CHANNEL_MEMORY_DOCUMENT_VERSION = 1;
export const MAX_CHANNEL_MEMORY_ENTRIES = 500;
export const MAX_CHANNEL_MEMORY_ENTRIES_PER_REQUEST = 10;
export const MAX_CHANNEL_MEMORY_ENTRY_CODE_POINTS = 2_000;
export const CHANNEL_MEMORY_ID_RE = /^m-[a-f0-9]{12}$/u;

export interface ChannelMemoryEntry {
  id: string;
  text: string;
  createdAt?: string;
  updatedAt?: string;
  createdBy?: string;
}

export interface ChannelMemoryDocument {
  version: 1;
  migration?: { legacySha256: string };
  entries: ChannelMemoryEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidDocument(message = 'Invalid channel memory document'): Error {
  return new Error(message);
}

function validateKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  message?: string,
): void {
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw invalidDocument(message);
  }
}

function validateEntry(value: unknown): ChannelMemoryEntry {
  if (!isRecord(value)) {
    throw invalidDocument('Invalid channel memory entry');
  }
  validateKeys(
    value,
    ['id', 'text', 'createdAt', 'updatedAt', 'createdBy'],
    'Invalid channel memory entry',
  );

  const { id, text } = value;
  if (
    typeof id !== 'string' ||
    !CHANNEL_MEMORY_ID_RE.test(id) ||
    typeof text !== 'string' ||
    text.trim().length === 0 ||
    Array.from(text).length > MAX_CHANNEL_MEMORY_ENTRY_CODE_POINTS
  ) {
    throw invalidDocument('Invalid channel memory entry');
  }

  const entry: ChannelMemoryEntry = { id, text };
  for (const key of ['createdAt', 'updatedAt', 'createdBy'] as const) {
    if (key in value) {
      if (typeof value[key] !== 'string') {
        throw invalidDocument('Invalid channel memory entry');
      }
      entry[key] = value[key];
    }
  }
  return entry;
}

function parseDocumentValue(value: unknown): ChannelMemoryDocument {
  if (!isRecord(value)) {
    throw invalidDocument();
  }
  validateKeys(value, ['version', 'migration', 'entries']);
  if (!('version' in value) || typeof value['version'] !== 'number') {
    throw invalidDocument();
  }
  if (value['version'] !== CHANNEL_MEMORY_DOCUMENT_VERSION) {
    throw invalidDocument('Unsupported channel memory version');
  }
  if (!Array.isArray(value['entries'])) {
    throw invalidDocument();
  }
  if (value['entries'].length > MAX_CHANNEL_MEMORY_ENTRIES) {
    throw invalidDocument('Channel memory exceeds maximum number of entries');
  }

  const ids = new Set<string>();
  const entries = value['entries'].map((value) => {
    const entry = validateEntry(value);
    if (ids.has(entry.id)) {
      throw invalidDocument('Invalid channel memory entry');
    }
    ids.add(entry.id);
    return entry;
  });

  let migration: ChannelMemoryDocument['migration'];
  if ('migration' in value) {
    if (
      !isRecord(value['migration']) ||
      typeof value['migration']['legacySha256'] !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(value['migration']['legacySha256'])
    ) {
      throw invalidDocument();
    }
    validateKeys(value['migration'], ['legacySha256']);
    migration = { legacySha256: value['migration']['legacySha256'] };
  }

  return migration
    ? { version: 1, migration, entries }
    : { version: 1, entries };
}

function parseJson(raw: string): unknown {
  return new JsonParser(raw).parse();
}

class JsonParser {
  private index = 0;

  constructor(private readonly input: string) {}

  parse(): unknown {
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.input.length) {
      throw new Error('Unexpected trailing JSON');
    }
    return value;
  }

  private parseValue(): unknown {
    this.skipWhitespace();
    const character = this.input[this.index];
    if (character === '{') {
      return this.parseObject();
    }
    if (character === '[') {
      return this.parseArray();
    }
    if (character === '"') {
      return this.parseString();
    }
    if (character === '-' || /\d/u.test(character ?? '')) {
      return this.parseNumber();
    }
    for (const [literal, value] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (this.input.startsWith(literal, this.index)) {
        this.index += literal.length;
        return value;
      }
    }
    throw new Error('Invalid JSON value');
  }

  private parseObject(): Record<string, unknown> {
    this.index++;
    const object: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    const keys = new Set<string>();
    this.skipWhitespace();
    if (this.input[this.index] === '}') {
      this.index++;
      return object;
    }

    while (true) {
      this.skipWhitespace();
      if (this.input[this.index] !== '"') {
        throw new Error('Invalid JSON object key');
      }
      const key = this.parseString();
      if (keys.has(key)) {
        throw new Error('Duplicate JSON object key');
      }
      keys.add(key);
      this.skipWhitespace();
      if (this.input[this.index] !== ':') {
        throw new Error('Invalid JSON object separator');
      }
      this.index++;
      Object.defineProperty(object, key, {
        configurable: true,
        enumerable: true,
        value: this.parseValue(),
        writable: true,
      });
      this.skipWhitespace();
      if (this.input[this.index] === '}') {
        this.index++;
        return object;
      }
      if (this.input[this.index] !== ',') {
        throw new Error('Invalid JSON object delimiter');
      }
      this.index++;
    }
  }

  private parseArray(): unknown[] {
    this.index++;
    const array: unknown[] = [];
    this.skipWhitespace();
    if (this.input[this.index] === ']') {
      this.index++;
      return array;
    }

    while (true) {
      array.push(this.parseValue());
      this.skipWhitespace();
      if (this.input[this.index] === ']') {
        this.index++;
        return array;
      }
      if (this.input[this.index] !== ',') {
        throw new Error('Invalid JSON array delimiter');
      }
      this.index++;
    }
  }

  private parseString(): string {
    const start = this.index;
    this.index++;
    while (this.index < this.input.length) {
      const character = this.input[this.index];
      if (character === '\\') {
        this.index += 2;
        continue;
      }
      if (character === '"') {
        this.index++;
        const value = JSON.parse(
          this.input.slice(start, this.index),
        ) as unknown;
        if (typeof value !== 'string') {
          throw new Error('Invalid JSON string');
        }
        return value;
      }
      if (character < ' ') {
        throw new Error('Invalid JSON string');
      }
      this.index++;
    }
    throw new Error('Unterminated JSON string');
  }

  private parseNumber(): number {
    const match = this.input
      .slice(this.index)
      .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u);
    if (!match) {
      throw new Error('Invalid JSON number');
    }
    this.index += match[0].length;
    return Number(match[0]);
  }

  private skipWhitespace(): void {
    while (/[ \t\r\n]/u.test(this.input[this.index] ?? '')) {
      this.index++;
    }
  }
}

export function normalizeChannelMemoryText(text: string): string {
  return text.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

export function parseChannelMemoryDocument(raw: string): ChannelMemoryDocument {
  if (typeof raw !== 'string') {
    throw invalidDocument();
  }
  let value: unknown;
  try {
    value = parseJson(raw);
  } catch {
    throw invalidDocument();
  }
  return parseDocumentValue(value);
}

export function parseLegacyChannelMemory(raw: Buffer): ChannelMemoryDocument {
  const entries: ChannelMemoryEntry[] = [];
  const normalizedTexts = new Set<string>();
  const ids = new Set<string>();
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(raw);

  for (const [sourceLineIndex, line] of decoded
    .split(/\r\n|\n|\r/u)
    .entries()) {
    const normalizedText = normalizeChannelMemoryText(line);
    if (!normalizedText || normalizedTexts.has(normalizedText)) {
      continue;
    }
    normalizedTexts.add(normalizedText);

    const digest = createHash('sha256')
      .update(`${normalizedText}\0${sourceLineIndex}`)
      .digest('hex');
    const id = `m-${digest.slice(0, 12)}`;
    if (ids.has(id)) {
      throw new Error('Channel memory legacy ID collision');
    }
    ids.add(id);
    entries.push(validateEntry({ id, text: line }));
    if (entries.length > MAX_CHANNEL_MEMORY_ENTRIES) {
      throw new Error('Channel memory exceeds maximum number of entries');
    }
  }

  return {
    version: 1,
    migration: {
      legacySha256: createHash('sha256').update(raw).digest('hex'),
    },
    entries,
  };
}

export function createChannelMemoryEntry(input: {
  text: string;
  createdBy?: string;
  now: string;
  randomHex: string;
}): ChannelMemoryEntry {
  if (!/^[a-f0-9]{12}$/u.test(input.randomHex)) {
    throw new Error('Invalid randomHex for channel memory entry');
  }
  const text = input.text.trim();
  const entry = validateEntry({ id: `m-${input.randomHex}`, text });
  entry.createdAt = input.now;
  entry.updatedAt = input.now;
  if (input.createdBy !== undefined) {
    entry.createdBy = input.createdBy;
  }
  return entry;
}

export function renderChannelMemoryRecall(
  entries: readonly ChannelMemoryEntry[],
): string {
  return entries.length === 0
    ? ''
    : `${entries.map((entry) => entry.text).join('\n')}\n`;
}

export function serializeChannelMemoryDocument(
  document: ChannelMemoryDocument,
): string {
  return `${JSON.stringify(parseDocumentValue(document), null, 2)}\n`;
}
