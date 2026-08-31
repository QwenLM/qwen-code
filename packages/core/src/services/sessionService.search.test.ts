/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for SessionService.searchSessionContent. Lives in its own file (no
 * module-level `vi.mock`) because the search streams real bytes from disk
 * via `fs.createReadStream` — same rationale as
 * sessionService.corruption.test.ts.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SessionService } from './sessionService.js';
import type { ChatRecord } from './chatRecordingService.js';

let tmpRoot: string;
let runtimeBaseDir: string;
let cwd: string;
let service: SessionService;

const SESSION_A = '550e8400-e29b-41d4-a716-446655440000';
const SESSION_B = '550e8400-e29b-41d4-a716-446655440001';
const SESSION_C = '550e8400-e29b-41d4-a716-446655440002';

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'session-svc-search-'));
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  runtimeBaseDir = fs.mkdtempSync(path.join(tmpRoot, 'runtime-'));
  cwd = path.join(runtimeBaseDir, 'workspace');
  fs.mkdirSync(cwd, { recursive: true });
  service = new SessionService(cwd, { runtimeBaseDir });
});

function sessionFilePath(sessionId: string): string {
  type Privates = {
    getSessionFilePath: (id: string, state: 'active' | 'archived') => string;
  };
  const filePath = (service as unknown as Privates).getSessionFilePath(
    sessionId,
    'active',
  );
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  return filePath;
}

function recordFor(
  sessionId: string,
  overrides: Partial<ChatRecord> & { uuid: string },
): ChatRecord {
  return {
    parentUuid: null,
    sessionId,
    timestamp: '2026-08-17T00:00:00.000Z',
    type: 'user',
    cwd,
    version: 'test',
    ...overrides,
  };
}

function writeSession(
  sessionId: string,
  records: ChatRecord[],
  mtime?: Date,
): void {
  const filePath = sessionFilePath(sessionId);
  fs.writeFileSync(
    filePath,
    records.map((record) => JSON.stringify(record)).join('\n') + '\n',
    'utf8',
  );
  if (mtime) fs.utimesSync(filePath, mtime, mtime);
}

function userText(sessionId: string, uuid: string, text: string): ChatRecord {
  return recordFor(sessionId, {
    uuid,
    type: 'user',
    message: { role: 'user', parts: [{ text }] },
  });
}

function assistantText(
  sessionId: string,
  uuid: string,
  text: string,
): ChatRecord {
  return recordFor(sessionId, {
    uuid,
    type: 'assistant',
    message: { role: 'model', parts: [{ text }] },
  });
}

describe('SessionService.searchSessionContent', () => {
  it('returns no hits for an empty query or a missing chats dir', async () => {
    await expect(service.searchSessionContent('')).resolves.toEqual([]);
    await expect(service.searchSessionContent('  ')).resolves.toEqual([]);
    await expect(service.searchSessionContent('anything')).resolves.toEqual([]);
  });

  it('matches user message text case-insensitively', async () => {
    writeSession(SESSION_A, [
      userText(SESSION_A, 'a1', 'How do I configure OAuth providers?'),
      assistantText(SESSION_A, 'a2', 'You can configure them in settings.'),
    ]);
    writeSession(SESSION_B, [userText(SESSION_B, 'b1', 'unrelated topic')]);

    const hits = await service.searchSessionContent('OAUTH');
    expect(hits).toHaveLength(1);
    expect(hits[0].sessionId).toBe(SESSION_A);
    expect(hits[0].snippet).toContain('OAuth');
  });

  it('matches assistant message text', async () => {
    writeSession(SESSION_A, [
      userText(SESSION_A, 'a1', 'hi'),
      assistantText(SESSION_A, 'a2', 'The debounce delay is 300ms.'),
    ]);

    const hits = await service.searchSessionContent('debounce delay');
    expect(hits).toHaveLength(1);
    expect(hits[0].sessionId).toBe(SESSION_A);
    expect(hits[0].snippet).toContain('debounce delay');
  });

  it('prefers the user prompt displayText payload when present', async () => {
    writeSession(SESSION_A, [
      recordFor(SESSION_A, {
        uuid: 'a1',
        type: 'user',
        systemPayload: {
          displayText: 'explain the qdrant indexing pipeline',
          hookContext: '',
        },
        message: { role: 'user', parts: [{ text: 'raw expanded prompt' }] },
      } as Partial<ChatRecord> & { uuid: string }),
    ]);

    const hits = await service.searchSessionContent('qdrant');
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).toContain('qdrant indexing pipeline');
  });

  it('skips subtype records and non-message records', async () => {
    writeSession(SESSION_A, [
      userText(SESSION_A, 'a1', 'hello'),
      recordFor(SESSION_A, {
        uuid: 'a2',
        type: 'user',
        subtype: 'slash_command',
        message: { role: 'user', parts: [{ text: 'needle in slash command' }] },
      }),
      recordFor(SESSION_A, {
        uuid: 'a3',
        type: 'system',
        message: { role: 'user', parts: [{ text: 'needle in system' }] },
      }),
    ]);

    await expect(service.searchSessionContent('needle')).resolves.toEqual([]);
  });

  it('does not match sessions belonging to a different project', async () => {
    writeSession(SESSION_A, [
      recordFor(SESSION_A, {
        uuid: 'a1',
        type: 'user',
        cwd: path.join(runtimeBaseDir, 'other-project'),
        message: { role: 'user', parts: [{ text: 'needle' }] },
      }),
    ]);

    await expect(service.searchSessionContent('needle')).resolves.toEqual([]);
  });

  it('orders hits by recency and honors maxResults', async () => {
    writeSession(
      SESSION_A,
      [userText(SESSION_A, 'a1', 'needle')],
      new Date('2026-08-01T00:00:00Z'),
    );
    writeSession(
      SESSION_B,
      [userText(SESSION_B, 'b1', 'needle')],
      new Date('2026-08-03T00:00:00Z'),
    );
    writeSession(
      SESSION_C,
      [userText(SESSION_C, 'c1', 'needle')],
      new Date('2026-08-02T00:00:00Z'),
    );

    const hits = await service.searchSessionContent('needle');
    expect(hits.map((hit) => hit.sessionId)).toEqual([
      SESSION_B,
      SESSION_C,
      SESSION_A,
    ]);

    const limited = await service.searchSessionContent('needle', {
      maxResults: 2,
    });
    expect(limited.map((hit) => hit.sessionId)).toEqual([SESSION_B, SESSION_C]);
  });

  it('honors maxFiles by scanning only the most recent sessions', async () => {
    writeSession(
      SESSION_A,
      [userText(SESSION_A, 'a1', 'needle')],
      new Date('2026-08-01T00:00:00Z'),
    );
    writeSession(
      SESSION_B,
      [userText(SESSION_B, 'b1', 'needle')],
      new Date('2026-08-03T00:00:00Z'),
    );

    const hits = await service.searchSessionContent('needle', { maxFiles: 1 });
    expect(hits.map((hit) => hit.sessionId)).toEqual([SESSION_B]);
  });

  it('ellipsizes the snippet around the match in long messages', async () => {
    const text = `${'lorem '.repeat(40)}needle${' ipsum'.repeat(40)}`;
    writeSession(SESSION_A, [userText(SESSION_A, 'a1', text)]);

    const hits = await service.searchSessionContent('needle');
    expect(hits).toHaveLength(1);
    const snippet = hits[0].snippet;
    expect(snippet).toContain('needle');
    expect(snippet.startsWith('...')).toBe(true);
    expect(snippet.endsWith('...')).toBe(true);
    expect(snippet.length).toBeLessThan(text.length);
  });

  it('collapses whitespace in snippets to a single line', async () => {
    writeSession(SESSION_A, [
      userText(SESSION_A, 'a1', 'line one\n\nneedle   line\ttwo'),
    ]);

    const hits = await service.searchSessionContent('needle');
    expect(hits[0].snippet).toBe('line one needle line two');
  });

  it('stops scanning when the signal aborts', async () => {
    writeSession(SESSION_A, [userText(SESSION_A, 'a1', 'needle')]);
    const controller = new AbortController();
    controller.abort();

    await expect(
      service.searchSessionContent('needle', { signal: controller.signal }),
    ).rejects.toThrow();
  });
});
