/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  decodeTranscriptLine,
  encodeTranscriptEntry,
} from './transcript-entry-codec.js';

describe('encodeTranscriptEntry', () => {
  it('encodes a metadata entry with a trailing newline', () => {
    const entry = {
      type: 'last-prompt' as const,
      sessionId: 's1',
      lastPrompt: 'hello',
    };
    const encoded = encodeTranscriptEntry(entry);
    expect(encoded.bytes.toString('utf8')).toBe(
      '{"type":"last-prompt","sessionId":"s1","lastPrompt":"hello"}\n',
    );
  });
});

describe('decodeTranscriptLine', () => {
  it('decodes a known entry', () => {
    const line = '{"type":"tag","sessionId":"s1","tag":"todo"}';
    const decoded = decodeTranscriptLine(line);
    expect(decoded.kind).toBe('entry');
    if (decoded.kind === 'entry') {
      expect(decoded.entry).toEqual({
        type: 'tag',
        sessionId: 's1',
        tag: 'todo',
      });
    }
  });

  it('normalizes missing chain fields on message entries', () => {
    const line =
      '{"type":"user","uuid":"u1","timestamp":"2026-01-01T00:00:00.000Z","message":{}}';
    const decoded = decodeTranscriptLine(line);
    expect(decoded.kind).toBe('entry');
    if (decoded.kind === 'entry') {
      expect(decoded.entry).toMatchObject({
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        isSidechain: false,
      });
    }
  });

  it('flags unknown entry types', () => {
    const line = '{"type":"unknown-type","x":1}';
    const decoded = decodeTranscriptLine(line);
    expect(decoded.kind).toBe('unknown');
  });

  it('flags malformed JSON', () => {
    const line = '{not json';
    const decoded = decodeTranscriptLine(line);
    expect(decoded.kind).toBe('malformed');
  });
});
