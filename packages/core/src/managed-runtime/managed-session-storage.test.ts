/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  MANAGED_SESSION_LIMITS,
  type ManagedSessionKey,
} from './managed-session-records.js';
import { scanManagedSessionJournal } from './managed-session-storage.js';

const fixture = JSON.parse(
  await readFile(
    new URL(
      './contracts/managed-session-store-v1.fixtures.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  genesisTransaction: { jsonl: string };
  sessionKey: ManagedSessionKey;
};

const jsonl = fixture.genesisTransaction.jsonl;
const sessionKey = fixture.sessionKey;
const engineLine = jsonl.slice(0, jsonl.indexOf('\n') + 1);
const headerLine = jsonl.slice(jsonl.indexOf('\n') + 1, jsonl.length - 1);
const headerBytes = Buffer.byteLength(headerLine, 'utf8');

/**
 * The genesis log, its header line padded with whitespace between a key
 * and its colon to the given byte length.
 */
function genesisWithHeaderBytes(bytes: number): Buffer {
  const padded = headerLine.replace(
    '"uuid":"header-record"',
    `"uuid"${' '.repeat(bytes - headerBytes)}:"header-record"`,
  );
  expect(Buffer.byteLength(padded, 'utf8')).toBe(bytes);
  return Buffer.from(engineLine + padded + '\n', 'utf8');
}

describe('scanManagedSessionJournal record line caps', () => {
  it('refuses a header line one byte past the declared header cap', () => {
    expect(() =>
      scanManagedSessionJournal(
        genesisWithHeaderBytes(MANAGED_SESSION_LIMITS.maxHeaderBytes + 1),
        sessionKey,
      ),
    ).toThrow(/exceeds 65536 UTF-8 bytes/);
  });

  it('still accepts a header line at the declared cap', () => {
    const scan = scanManagedSessionJournal(
      genesisWithHeaderBytes(MANAGED_SESSION_LIMITS.maxHeaderBytes),
      sessionKey,
    );
    expect(scan.header?.createdBy).toBe('fixture');
  });
});
