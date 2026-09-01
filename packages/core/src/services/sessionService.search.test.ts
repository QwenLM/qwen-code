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
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { SessionService } from './sessionService.js';
import type { ChatRecord } from './chatRecordingService.js';
import { wrapUserPromptSubmitContext } from '../utils/transcript-records.js';

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

  it('normalizes whitespace runs in the query for both matching and the snippet', async () => {
    const longMessage = `${'lorem '.repeat(1000)}alpha beta${' ipsum'.repeat(1000)}`;
    writeSession(SESSION_A, [userText(SESSION_A, 'a1', longMessage)]);

    // A double-space query still matches the single-space text, and the
    // snippet stays a bounded excerpt instead of the whole message.
    const hits = await service.searchSessionContent('alpha  beta');
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).toContain('alpha beta');
    expect(hits[0].snippet.length).toBeLessThan(200);

    // The other direction: a single-space query matches newline-separated text.
    writeSession(SESSION_B, [userText(SESSION_B, 'b1', 'qdrant\npipeline')]);
    const cross = await service.searchSessionContent('qdrant pipeline');
    expect(cross.map((hit) => hit.sessionId)).toContain(SESSION_B);
  });

  it('keeps the snippet window correct when lowercasing changes string length', async () => {
    // U+0130 folds to two UTF-16 code units, shifting a naive index.
    writeSession(SESSION_A, [
      userText(SESSION_A, 'a1', `${'İ'.repeat(50)} needle`),
    ]);

    const hits = await service.searchSessionContent('needle');
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).toContain('needle');
  });

  it('matches supplementary-plane case pairs in both directions', async () => {
    // Deseret uppercase folds to supplementary-plane lowercase code points;
    // a per-UTF-16-unit fold would leave it unchanged and miss the match.
    writeSession(SESSION_A, [userText(SESSION_A, 'a1', '𐐀𐐯𐑊𐐮𐐻𐐯𐐼')]);

    await expect(
      service.searchSessionContent('𐐀𐐯𐑊𐐮𐐻𐐯𐐼'.toLowerCase()),
    ).resolves.toHaveLength(1);

    writeSession(SESSION_B, [
      userText(SESSION_B, 'b1', '𐐀𐐯𐑊𐐮𐐻𐐯𐐼'.toLowerCase()),
    ]);
    await expect(service.searchSessionContent('𐐀𐐯𐑊𐐮𐐻𐐯𐐼')).resolves.toHaveLength(
      2,
    );
  });

  it('matches Greek text ending in sigma for every sigma query form', async () => {
    // Whole-string lowercasing maps word-final Σ to ς while a per-code-point
    // fold yields σ — without unification, Greek text ending in sigma never
    // matches, not even a byte-identical query.
    writeSession(SESSION_A, [userText(SESSION_A, 'a1', 'ΟΔΥΣΣΕΥΣ')]);
    // Text-side ς (how Greek is normally written) exercises the fold loop's
    // own normalizeSigma: the uppercase fixture folds to σ without it.
    writeSession(SESSION_B, [userText(SESSION_B, 'b1', 'οδυσσευς')]);

    for (const query of ['οδυσσευς', 'οδυσσευσ', 'ΟΔΥΣΣΕΥΣ']) {
      const hits = await service.searchSessionContent(query);
      expect(hits.map((hit) => hit.sessionId)).toEqual(
        expect.arrayContaining([SESSION_A, SESSION_B]),
      );
    }
  });

  it('never splits a surrogate pair at a snippet boundary', async () => {
    writeSession(SESSION_A, [
      userText(SESSION_A, 'a1', `${'🚀'.repeat(25)} needle`),
    ]);

    const hits = await service.searchSessionContent('needle');
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).toContain('needle');
    expect(hits[0].snippet).not.toMatch(
      // Lone lead surrogate, or lone trail surrogate.
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
  });

  it('never ends the snippet window on a lone lead surrogate', async () => {
    // The match sits at the message start so the window end lands inside
    // the astral run, exercising the end-side clamp.
    writeSession(SESSION_A, [
      userText(SESSION_A, 'a1', `needle ${'🚀'.repeat(40)}`),
    ]);

    const hits = await service.searchSessionContent('needle');
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).toContain('needle');
    expect(hits[0].snippet).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
  });

  it('does not match text stripped by the user-prompt display projection', async () => {
    // Legacy payload-less record: the trailing hook-submit-context part is
    // not user-visible, so text inside it must not match.
    writeSession(SESSION_A, [
      recordFor(SESSION_A, {
        uuid: 'a1',
        type: 'user',
        message: {
          role: 'user',
          parts: [
            { text: 'visible prompt' },
            {
              text: wrapUserPromptSubmitContext(
                'secret needle in hook context',
              ),
            },
          ],
        },
      }),
    ]);
    await expect(
      service.searchSessionContent('secret needle'),
    ).resolves.toEqual([]);
    await expect(
      service.searchSessionContent('visible prompt'),
    ).resolves.toHaveLength(1);

    // An authoritative empty displayText must not fall back to model-facing parts.
    writeSession(SESSION_B, [
      recordFor(SESSION_B, {
        uuid: 'b1',
        type: 'user',
        systemPayload: { displayText: '', hookContext: 'ctx' },
        message: { role: 'user', parts: [{ text: 'model-facing needle' }] },
      } as Partial<ChatRecord> & { uuid: string }),
    ]);
    await expect(
      service.searchSessionContent('model-facing needle'),
    ).resolves.toEqual([]);
  });

  it('aborts mid-scan when the signal fires during a large file', async () => {
    const filler = { text: `filler ${'x'.repeat(8192)}` };
    const records: ChatRecord[] = [userText(SESSION_A, 'a1', 'first prompt')];
    for (let i = 0; i < 3000; i++) {
      records.push(
        recordFor(SESSION_A, {
          uuid: `f${i}`,
          type: 'assistant',
          message: { role: 'model', parts: [filler] },
        }),
      );
    }
    records.push(assistantText(SESSION_A, 'last', 'needle at the end'));
    writeSession(SESSION_A, records);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20);
    try {
      await expect(
        service.searchSessionContent('needle', { signal: controller.signal }),
      ).rejects.toThrow();
    } finally {
      clearTimeout(timer);
    }
  });

  it('yields and honors aborts while stat-ing a large chats dir', async () => {
    for (let i = 0; i < 130; i++) {
      const sessionId = `550e8400-e29b-41d4-a716-${String(100000000000 + i).slice(-12)}`;
      writeSession(sessionId, [userText(sessionId, 'u1', 'needle')]);
    }
    const statSpy = vi.spyOn(fs, 'statSync');
    try {
      const controller = new AbortController();
      setImmediate(() => controller.abort());
      await expect(
        service.searchSessionContent('needle', {
          signal: controller.signal,
        }),
      ).rejects.toThrow();
      expect(statSpy.mock.calls.length).toBeLessThan(130);
    } finally {
      statSpy.mockRestore();
    }
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
