/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readTranscriptSessionCatalogMetadata,
  SESSION_CATALOG_MAX_READ_BYTES,
} from './session-catalog.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-catalog-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function writeEntries(
  sessionId: string,
  entries: readonly unknown[],
): Promise<{ filePath: string; size: number }> {
  const filePath = path.join(tempDir, `${sessionId}.jsonl`);
  const content = `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
  await fs.writeFile(filePath, content, 'utf8');
  return { filePath, size: Buffer.byteLength(content) };
}

describe('transcript session catalog', () => {
  it('extracts existing metadata without adding a catalog entry type', async () => {
    const sessionId = 'session-small';
    const { filePath, size } = await writeEntries(sessionId, [
      {
        type: 'user',
        uuid: 'user-1',
        parentUuid: null,
        isSidechain: false,
        timestamp: '2026-09-03T00:00:00.000Z',
        cwd: '/workspace/demo',
        sessionId,
        userType: 'external',
        version: '1.0.0',
        gitBranch: 'feature/catalog',
        message: { role: 'user', content: 'first prompt' },
      },
      { type: 'ai-title', sessionId, aiTitle: 'Generated title' },
      { type: 'last-prompt', sessionId, lastPrompt: 'latest prompt' },
      {
        type: 'workspace-directories',
        sessionId,
        directories: ['/workspace/demo'],
      },
    ]);

    const metadata = await readTranscriptSessionCatalogMetadata(
      filePath,
      sessionId,
      size,
    );

    expect(metadata).toMatchObject({
      displayName: 'Generated title',
      firstUserMessage: 'first prompt',
      aiTitle: 'Generated title',
      lastPrompt: 'latest prompt',
      gitBranch: 'feature/catalog',
      cwd: '/workspace/demo',
      directories: ['/workspace/demo'],
      resumability: 'yes',
      bytesRead: size,
    });
  });

  it('filters a complete command-only transcript within the fixed budget', async () => {
    const sessionId = 'session-command-only';
    const { filePath, size } = await writeEntries(sessionId, [
      {
        type: 'user',
        uuid: 'user-1',
        parentUuid: null,
        isSidechain: false,
        timestamp: '2026-09-03T00:00:00.000Z',
        cwd: '/workspace/demo',
        sessionId,
        userType: 'external',
        version: '1.0.0',
        message: {
          role: 'user',
          content:
            '<command-name>/resume</command-name>\n<command-message>resume</command-message>\n<command-args></command-args>',
        },
      },
    ]);

    const metadata = await readTranscriptSessionCatalogMetadata(
      filePath,
      sessionId,
      size,
    );

    expect(metadata.resumability).toBe('no');
  });

  it('extracts a giant first prompt while reading at most the head and tail', async () => {
    const sessionId = 'session-large';
    const { filePath, size } = await writeEntries(sessionId, [
      {
        type: 'user',
        uuid: 'user-1',
        parentUuid: null,
        isSidechain: false,
        timestamp: '2026-09-03T00:00:00.000Z',
        cwd: '/workspace/demo',
        sessionId,
        userType: 'external',
        version: '1.0.0',
        message: {
          role: 'user',
          content: `large prompt marker ${'x'.repeat(
            SESSION_CATALOG_MAX_READ_BYTES * 2,
          )}`,
        },
      },
      {
        type: 'user',
        uuid: 'user-2',
        parentUuid: 'user-1',
        isSidechain: false,
        timestamp: '2026-09-03T00:01:00.000Z',
        cwd: '/workspace/demo',
        sessionId,
        userType: 'external',
        version: '1.0.0',
        message: { role: 'user', content: 'later prompt' },
      },
    ]);

    const metadata = await readTranscriptSessionCatalogMetadata(
      filePath,
      sessionId,
      size,
    );

    expect(metadata.resumability).toBe('yes');
    expect(metadata.displayName).toMatch(/^large prompt marker/);
    expect(metadata.bytesRead).toBe(SESSION_CATALOG_MAX_READ_BYTES);
  });

  it('keeps a large legacy transcript when bounded metadata is inconclusive', async () => {
    const sessionId = 'session-unknown';
    const { filePath, size } = await writeEntries(sessionId, [
      {
        type: 'file-history-snapshot',
        messageId: 'message-1',
        snapshot: { files: { '/tmp/file': 'x'.repeat(300_000) } },
        isSnapshotUpdate: false,
      },
    ]);

    const metadata = await readTranscriptSessionCatalogMetadata(
      filePath,
      sessionId,
      size,
    );

    expect(metadata.resumability).toBe('unknown');
    expect(metadata.bytesRead).toBe(SESSION_CATALOG_MAX_READ_BYTES);
  });
});
