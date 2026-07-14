/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  CHANNEL_MEMORY_ID_RE,
  MAX_CHANNEL_MEMORY_ENTRIES,
  MAX_CHANNEL_MEMORY_ENTRY_CODE_POINTS,
  createChannelMemoryEntry,
  normalizeChannelMemoryText,
  parseChannelMemoryDocument,
  parseLegacyChannelMemory,
  renderChannelMemoryRecall,
  serializeChannelMemoryDocument,
} from './channel-memory-document.js';

describe('channel memory document', () => {
  it('normalizes channel memory text', () => {
    expect(normalizeChannelMemoryText('  USE\u00a0staging  ')).toBe(
      'use staging',
    );
  });

  it('rejects unsupported document versions', () => {
    expect(() =>
      parseChannelMemoryDocument('{"version":2,"entries":[]}'),
    ).toThrow('Unsupported channel memory version');
  });

  it('rejects entries with invalid ids', () => {
    expect(() =>
      parseChannelMemoryDocument(
        JSON.stringify({
          version: 1,
          entries: [
            { id: 'bad', text: 'x' },
            { id: 'm-123456789abc', text: 'y' },
          ],
        }),
      ),
    ).toThrow('Invalid channel memory entry');
  });

  it('validates the complete version-1 document shape', () => {
    const document = parseChannelMemoryDocument(
      JSON.stringify({
        version: 1,
        migration: { legacySha256: 'a'.repeat(64) },
        entries: [
          {
            id: 'm-123456789abc',
            text: 'Use staging',
            createdAt: '2026-07-14T00:00:00.000Z',
            updatedAt: '2026-07-14T00:01:00.000Z',
            createdBy: 'alice',
          },
        ],
      }),
    );

    expect(document).toEqual({
      version: 1,
      migration: { legacySha256: 'a'.repeat(64) },
      entries: [
        {
          id: 'm-123456789abc',
          text: 'Use staging',
          createdAt: '2026-07-14T00:00:00.000Z',
          updatedAt: '2026-07-14T00:01:00.000Z',
          createdBy: 'alice',
        },
      ],
    });
    expect(CHANNEL_MEMORY_ID_RE.test(document.entries[0].id)).toBe(true);
  });

  it.each([
    ['missing entries', { version: 1 }],
    ['entries is not an array', { version: 1, entries: {} }],
    [
      'empty text',
      { version: 1, entries: [{ id: 'm-123456789abc', text: ' ' }] },
    ],
    [
      'oversized text',
      {
        version: 1,
        entries: [
          {
            id: 'm-123456789abc',
            text: 'x'.repeat(MAX_CHANNEL_MEMORY_ENTRY_CODE_POINTS + 1),
          },
        ],
      },
    ],
    [
      'duplicate ids',
      {
        version: 1,
        entries: [
          { id: 'm-123456789abc', text: 'x' },
          { id: 'm-123456789abc', text: 'y' },
        ],
      },
    ],
    [
      'invalid optional fields',
      {
        version: 1,
        migration: { legacySha256: 'A'.repeat(64) },
        entries: [
          {
            id: 'm-123456789abc',
            text: 'x',
            createdAt: null,
          },
        ],
      },
    ],
  ])('rejects %s', (_name, value) => {
    expect(() => parseChannelMemoryDocument(JSON.stringify(value))).toThrow(
      'Invalid channel memory',
    );
  });

  it('rejects duplicate JSON object keys', () => {
    expect(() =>
      parseChannelMemoryDocument('{"version":1,"entries":[],"entries":[]}'),
    ).toThrow('Invalid channel memory document');
  });

  it('rejects documents exceeding the entry limit', () => {
    const entries = Array.from(
      { length: MAX_CHANNEL_MEMORY_ENTRIES + 1 },
      (_, index) => ({
        id: `m-${index.toString(16).padStart(12, '0')}`,
        text: 'x',
      }),
    );
    expect(() =>
      parseChannelMemoryDocument(JSON.stringify({ version: 1, entries })),
    ).toThrow('maximum number of entries');
  });

  it('counts astral Unicode text by code point', () => {
    const astralCharacter = '\u{1f600}';
    const acceptedText = astralCharacter.repeat(
      MAX_CHANNEL_MEMORY_ENTRY_CODE_POINTS,
    );

    expect(
      parseChannelMemoryDocument(
        JSON.stringify({
          version: 1,
          entries: [{ id: 'm-123456789abc', text: acceptedText }],
        }),
      ).entries[0].text,
    ).toBe(acceptedText);
    expect(() =>
      parseChannelMemoryDocument(
        JSON.stringify({
          version: 1,
          entries: [
            {
              id: 'm-123456789abc',
              text: astralCharacter.repeat(
                MAX_CHANNEL_MEMORY_ENTRY_CODE_POINTS + 1,
              ),
            },
          ],
        }),
      ),
    ).toThrow('Invalid channel memory entry');
  });

  it('converts legacy lines with stable ids and a migration hash', () => {
    const raw = Buffer.from('Use staging\n\n use   STAGING \nRun tests\n');
    const first = parseLegacyChannelMemory(raw);
    const second = parseLegacyChannelMemory(raw);

    expect(first).toEqual(second);
    expect(first.entries).toHaveLength(2);
    expect(first.entries.map((entry) => entry.text)).toEqual([
      'Use staging',
      'Run tests',
    ]);
    expect(first.entries[0].id).toBe('m-5c1888e97dc2');
    expect(
      first.entries.every((entry) => CHANNEL_MEMORY_ID_RE.test(entry.id)),
    ).toBe(true);
    expect(first.entries.every((entry) => !('createdAt' in entry))).toBe(true);
    expect(first.migration?.legacySha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('preserves surrounding whitespace in legacy entry text', () => {
    const document = parseLegacyChannelMemory(
      Buffer.from('  Keep surrounding whitespace  \n'),
    );

    expect(document.entries[0].text).toBe('  Keep surrounding whitespace  ');
  });

  it('creates a timestamped channel memory entry', () => {
    expect(
      createChannelMemoryEntry({
        text: ' Use staging ',
        createdBy: 'alice',
        now: '2026-07-14T00:00:00.000Z',
        randomHex: 'abcdef012345',
      }),
    ).toEqual({
      id: 'm-abcdef012345',
      text: 'Use staging',
      createdAt: '2026-07-14T00:00:00.000Z',
      updatedAt: '2026-07-14T00:00:00.000Z',
      createdBy: 'alice',
    });
  });

  it('rejects random values that cannot form a channel memory id', () => {
    expect(() =>
      createChannelMemoryEntry({
        text: 'Use staging',
        now: '2026-07-14T00:00:00.000Z',
        randomHex: 'ABCDEF012345',
      }),
    ).toThrow('randomHex');
  });

  it('renders recall text without entry metadata', () => {
    expect(
      renderChannelMemoryRecall([
        {
          id: 'm-abcdef012345',
          text: 'Use staging',
          createdBy: 'alice',
        },
        { id: 'm-123456789abc', text: 'Run tests', updatedAt: 'now' },
      ]),
    ).toBe('Use staging\nRun tests\n');
    expect(renderChannelMemoryRecall([])).toBe('');
  });

  it('serializes a document as stable pretty JSON', () => {
    expect(serializeChannelMemoryDocument({ version: 1, entries: [] })).toBe(
      '{\n  "version": 1,\n  "entries": []\n}\n',
    );
  });
});
