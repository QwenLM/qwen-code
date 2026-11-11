/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '../../protocol/transcript/entry.js';
import { EntryScanner, scanTranscriptBuffer, type ScannedTranscriptLine } from './scanner.js';
import {
  beginResumeRead,
  type ResumeReadAttempt,
  ResumeReadError,
} from './resume-read-budget.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, open: vi.fn(actual.open) };
});

const tempDirs: string[] = [];
const attempts: ResumeReadAttempt[] = [];

afterEach(() => {
  for (const attempt of attempts.splice(0)) attempt.finish();
  vi.restoreAllMocks();
});

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function createFile(content: Buffer | string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'transcript-scanner-'));
  tempDirs.push(root);
  const filePath = path.join(root, 'session.jsonl');
  await fs.writeFile(filePath, content);
  return filePath;
}

describe('EntryScanner', () => {
  it('reads metadata without retaining large message bodies', async () => {
    const filePath = await createFile(
      '\uFEFF' +
        JSON.stringify({
          type: 'user',
          uuid: 'large-user',
          timestamp: '2026-10-10T00:00:00Z',
          message: { role: 'user', content: '中'.repeat(1024 * 1024) },
        }) +
        '\n' +
        JSON.stringify({
          type: 'worktree-state',
          sessionId: 'session-1',
          worktreeSession: null,
        }),
    );
    const result = await new EntryScanner({ chunkBytes: 4096 }).scan(filePath, {
      kind: 'metadata',
    });
    expect(
      result.lines.map((line) =>
        line.decoded.kind === 'entry'
          ? line.decoded.entry.type
          : line.decoded.kind,
      ),
    ).toEqual(['worktree-state']);
    expect(result.lines[0]?.line).toBe(2);
    expect(result.bytesRead).toBe((await fs.stat(filePath)).size);
  });

  it('preserves metadata with noncanonical field order and nested type fields', async () => {
    const state = {
      originalCwd: '/workspace/project',
      worktreePath: '/workspace/worktree',
      worktreeName: 'legacy',
      sessionId: 'session-1',
      lifecycle: 'owner',
    };
    const filePath = await createFile(
      JSON.stringify({
        ignored: { type: 'user', padding: 'x'.repeat(8192) },
        sessionId: 'session-1',
        worktreeSession: state,
        type: 'worktree-state',
      }),
    );
    const result = await new EntryScanner({ chunkBytes: 7 }).scan(filePath, {
      kind: 'metadata',
    });
    expect(result.lines[0]?.decoded).toMatchObject({
      kind: 'entry',
      entry: { type: 'worktree-state', worktreeSession: state },
    });
  });

  it('reports exact byte locations for valid, malformed and unknown lines', async () => {
    const first: Entry = {
      type: 'custom-title',
      sessionId: 'session-1',
      customTitle: '中文',
    };
    const firstLine = JSON.stringify(first);
    const malformed = '{';
    const unknown = '{"type":"future-entry","value":1}';
    const filePath = await createFile(
      `\uFEFF${firstLine}\n${malformed}\n\n${unknown}`,
    );

    const result = await new EntryScanner({ chunkBytes: 7 }).scan(filePath);

    expect(result.lines).toHaveLength(3);
    expect(result.lines.map((line) => line.decoded.kind)).toEqual([
      'entry',
      'malformed',
      'unknown',
    ]);
    expect(result.lines[0]).toMatchObject({
      order: 0,
      byteOffset: 0,
      byteLength: Buffer.byteLength(`\uFEFF${firstLine}`),
      line: 1,
    });
    expect(result.lines[1]).toMatchObject({
      order: 1,
      byteOffset: Buffer.byteLength(`\uFEFF${firstLine}\n`),
      line: 2,
    });
    expect(result.lines[2]).toMatchObject({ order: 2, line: 4 });
    expect(result.bytesRead).toBe(result.snapshot.size);
  });

  it('decodes a valid entry above 2 MiB and records a non-dropping diagnostic', async () => {
    const largeEntry: Entry = {
      type: 'summary',
      leafUuid: 'leaf-1',
      summary: '中'.repeat(1024 * 1024),
    };
    const filePath = await createFile(JSON.stringify(largeEntry));

    const result = await new EntryScanner({ chunkBytes: 4096 }).scan(filePath);

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]?.decoded).toMatchObject({
      kind: 'entry',
      entry: largeEntry,
    });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        kind: 'large-entry',
        byteLength: Buffer.byteLength(JSON.stringify(largeEntry)),
      }),
    ]);
  });

  it('limits range scans to the file snapshot', async () => {
    const first: Entry = {
      type: 'custom-title',
      sessionId: 'session-1',
      customTitle: 'first',
    };
    const second: Entry = {
      type: 'custom-title',
      sessionId: 'session-1',
      customTitle: 'second',
    };
    const firstRecord = `${JSON.stringify(first)}\n`;
    const filePath = await createFile(
      `${firstRecord}${JSON.stringify(second)}\n`,
    );

    const result = await new EntryScanner().scan(filePath, {
      kind: 'range',
      startOffset: 0,
      endOffset: Buffer.byteLength(firstRecord),
    });

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]?.decoded).toMatchObject({
      kind: 'entry',
      entry: first,
    });
  });

  it('loads only compact-tail messages plus session metadata for large transcripts', async () => {
    const metadata: Entry = {
      type: 'custom-title',
      sessionId: 'session-1',
      customTitle: 'retained title',
    };
    const olderActiveLeaf = {
      type: 'active-leaf',
      sessionId: 'session-1',
      leafUuid: 'older-user',
      explicit: true,
      rewound: true,
      timestamp: 1_754_299_999_999,
    } as Entry;
    const activeLeaf = {
      type: 'active-leaf',
      sessionId: 'session-1',
      leafUuid: 'stale-user',
      explicit: false,
      timestamp: 1_754_300_000_000,
    } as Entry;
    const relocated = {
      type: 'relocated',
      sessionId: 'session-1',
      relocatedCwd: '/workspace/worktree',
    } as Entry;
    const worktreeState = {
      type: 'worktree-state',
      sessionId: 'session-1',
      worktreeSession: {
        originalCwd: '/workspace',
        preEnterOriginalCwd: '/workspace',
        worktreePath: '/workspace/worktree',
        worktreeName: 'feature',
        worktreeBranch: 'worktree-feature',
        sessionId: 'session-1',
      },
    } as Entry;
    const staleMessage = {
      type: 'user',
      uuid: 'stale-user',
      parentUuid: null,
      isSidechain: false,
      timestamp: '2026-07-15T00:00:00.000Z',
      cwd: '/workspace',
      sessionId: 'session-1',
      userType: 'external',
      version: '1.0.0',
      message: { role: 'user', content: 'x'.repeat(6 * 1024 * 1024) },
    } as Entry;
    const boundary = {
      type: 'system',
      uuid: 'compact-boundary',
      parentUuid: null,
      logicalParentUuid: 'stale-user',
      isSidechain: false,
      timestamp: '2026-07-15T00:01:00.000Z',
      cwd: '/workspace',
      sessionId: 'session-1',
      userType: 'external',
      version: '1.0.0',
      subtype: 'compact_boundary',
      content: 'summary',
      level: 'info',
      isCompactSummary: true,
      requiresActiveLeafCommit: true,
    } as Entry;
    const currentMessage = {
      ...staleMessage,
      uuid: 'current-user',
      parentUuid: 'compact-boundary',
      message: { blocks: 'current' },
    } as Entry;
    const committedActiveLeaf = {
      type: 'active-leaf',
      sessionId: 'session-1',
      leafUuid: 'current-user',
      explicit: false,
      compactBoundaryUuid: 'compact-boundary',
      timestamp: 1_754_300_000_001,
    } as Entry;
    const filePath = await createFile(
      [
        metadata,
        olderActiveLeaf,
        activeLeaf,
        relocated,
        worktreeState,
        staleMessage,
        boundary,
        currentMessage,
        committedActiveLeaf,
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n') + '\n',
    );

    const result = await new EntryScanner().scan(filePath, {
      kind: 'compact-tail',
    });

    expect(result.snapshot.size).toBeGreaterThan(5 * 1024 * 1024);
    expect(
      result.lines.map((line) =>
        line.decoded.kind === 'entry'
          ? line.decoded.entry.type
          : line.decoded.kind,
      ),
    ).toEqual([
      'custom-title',
      'active-leaf',
      'relocated',
      'worktree-state',
      'system',
      'user',
      'active-leaf',
    ]);
    expect(
      result.lines.flatMap((line) =>
        line.decoded.kind === 'entry' &&
        line.decoded.entry.type === 'active-leaf'
          ? [line.decoded.entry.leafUuid]
          : [],
      ),
    ).toEqual(['stale-user', 'current-user']);
    expect(
      result.lines.some(
        (line) =>
          line.decoded.kind === 'entry' &&
          'uuid' in line.decoded.entry &&
          line.decoded.entry.uuid === 'stale-user',
      ),
    ).toBe(false);
  });

  it('falls back to the full scan when a compact boundary was not committed', async () => {
    const staleMessage = {
      type: 'user',
      uuid: 'stale-user',
      parentUuid: null,
      isSidechain: false,
      timestamp: '2026-07-15T00:00:00.000Z',
      cwd: '/workspace',
      sessionId: 'session-1',
      userType: 'external',
      version: '1.0.0',
      message: { role: 'user', content: 'x'.repeat(6 * 1024 * 1024) },
    } as Entry;
    const activeLeaf = {
      type: 'active-leaf',
      sessionId: 'session-1',
      leafUuid: 'stale-user',
      explicit: false,
      timestamp: 1_754_300_000_000,
    } as Entry;
    const interruptedBoundary = {
      type: 'system',
      uuid: 'interrupted-boundary',
      parentUuid: null,
      logicalParentUuid: 'stale-user',
      isSidechain: false,
      timestamp: '2026-07-15T00:01:00.000Z',
      cwd: '/workspace',
      sessionId: 'session-1',
      userType: 'external',
      version: '1.0.0',
      subtype: 'compact_boundary',
      content: 'summary',
      level: 'info',
      isCompactSummary: true,
      requiresActiveLeafCommit: true,
    } as Entry;
    const filePath = await createFile(
      [staleMessage, activeLeaf, interruptedBoundary]
        .map((entry) => JSON.stringify(entry))
        .join('\n') + '\n',
    );

    const result = await new EntryScanner().scan(filePath, {
      kind: 'compact-tail',
    });

    expect(
      result.lines.some(
        (line) =>
          line.decoded.kind === 'entry' &&
          'uuid' in line.decoded.entry &&
          line.decoded.entry.uuid === 'stale-user',
      ),
    ).toBe(true);
  });

  it('does not prune a compact boundary with a preserved segment', async () => {
    const stale = {
      type: 'user',
      uuid: 'preserved-user',
      parentUuid: null,
      isSidechain: false,
      timestamp: '2026-07-15T00:00:00.000Z',
      cwd: '/workspace',
      sessionId: 'session-1',
      userType: 'external',
      version: '1.0.0',
      message: { role: 'user', content: 'x'.repeat(6 * 1024 * 1024) },
    } as Entry;
    const boundary = {
      type: 'system',
      uuid: 'preserved-boundary',
      parentUuid: null,
      isSidechain: false,
      timestamp: '2026-07-15T00:01:00.000Z',
      cwd: '/workspace',
      sessionId: 'session-1',
      userType: 'external',
      version: '1.0.0',
      subtype: 'compact_boundary',
      content: 'summary',
      level: 'info',
      isCompactSummary: true,
      compactMetadata: {
        trigger: 'auto',
        preTokens: 100,
        preservedSegment: {
          headUuid: 'preserved-user',
          anchorUuid: 'preserved-user',
          tailUuid: 'preserved-user',
        },
      },
    } as Entry;
    const filePath = await createFile(
      `${JSON.stringify(stale)}\n${JSON.stringify(boundary)}\n`,
    );

    const result = await new EntryScanner().scan(filePath, {
      kind: 'compact-tail',
    });

    expect(
      result.lines.some(
        (line) =>
          line.decoded.kind === 'entry' &&
          'uuid' in line.decoded.entry &&
          line.decoded.entry.uuid === 'preserved-user',
      ),
    ).toBe(true);
  });
});

async function resumeAttempt(
  options: Parameters<typeof beginResumeRead>[0] = {},
): Promise<ResumeReadAttempt> {
  const attempt = await beginResumeRead(options);
  attempts.push(attempt);
  return attempt;
}

function shortReadHandle(
  content: Buffer,
  maxBytes = 3,
  zeroAt = content.length,
) {
  const snapshot = {
    device: 1,
    inode: 2,
    size: content.length,
    modifiedTimeMs: 3,
    changedTimeMs: 4,
  };
  const read = vi.fn(
    async (
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ) => {
      buffer.fill(0x0a);
      const bytesRead = Math.max(
        0,
        Math.min(length, maxBytes, zeroAt - position),
      );
      content.copy(buffer, offset, position, position + bytesRead);
      return { buffer, bytesRead };
    },
  );
  const close = vi.fn(async () => undefined);
  const handle = {
    stat: vi.fn(async () => ({
      dev: snapshot.device,
      ino: snapshot.inode,
      size: snapshot.size,
      mtimeMs: snapshot.modifiedTimeMs,
      ctimeMs: snapshot.changedTimeMs,
    })),
    read,
    close,
  } as unknown as FileHandle;
  return { handle, snapshot, read, close };
}

describe('EntryScanner bounded consume', () => {
  it('matches codec, BOM, blank, CRLF and final-record semantics across positive short reads', async () => {
    const content = Buffer.from(
      '\uFEFF{"customTitle":"中文","type":"custom-title","sessionId":"s"}\r\n \t\r\n' +
        '{\n{"type":"future-entry","value":[1,2]}\n{"type":"custom-title"}\n' +
        '{"type":"user","uuid":"u","timestamp":"t","message":{"role":"user","content":"last"}}',
    );
    const filePath = await createFile(content);
    const expected = scanTranscriptBuffer(filePath, content);
    const fake = shortReadHandle(content);
    const attempt = await resumeAttempt();
    const lines: ScannedTranscriptLine[] = [];
    const snapshot = await attempt.run(() =>
      new EntryScanner({ chunkBytes: 31 }).consume(
        filePath,
        (line) => {
          lines.push(line);
        },
        { attempt, handle: fake.handle },
      ),
    );
    expect(snapshot).toEqual(fake.snapshot);
    expect(lines).toEqual(expected.lines);
    expect(attempt.stats.bytesRead).toBe(content.length);
    expect(attempt.stats.retainedEntries).toBe(0);
    expect(fake.close).not.toHaveBeenCalled();
  });

  it('ordinary full and metadata scans advance by actual short reads without decoding stale buffer bytes', async () => {
    const content = Buffer.from(
      '\uFEFF{"type":"custom-title","sessionId":"s","customTitle":"中文"}\r\n\n' +
        '{\n{"type":"future-entry"}\n' +
        '{"padding":{"type":"user"},"type":"summary","leafUuid":"u","summary":"last"}',
    );
    const filePath = '/fixture/session.jsonl';
    const expected = scanTranscriptBuffer(filePath, content);
    for (const kind of ['full', 'metadata'] as const) {
      const fake = shortReadHandle(content, 1);
      vi.mocked(fs.open).mockResolvedValueOnce(fake.handle);
      const result = await new EntryScanner({ chunkBytes: 31 }).scan(filePath, { kind });
      const selected = kind === 'full'
        ? expected.lines
        : expected.lines.filter((line) => line.decoded.kind === 'entry');
      expect(result.lines).toEqual(selected.map((line, order) => ({ ...line, order })));
      expect(result.bytesRead).toBe(content.length);
      expect(fake.close).toHaveBeenCalled();
    }
  });

  it('selects absolute byte intervals on the same descriptor without reading beyond their ends', async () => {
    const first = '{"type":"summary","leafUuid":"u","summary":"first"}\n';
    const second = '{"type":"summary","leafUuid":"v","summary":"中文"}\r\n';
    const content = Buffer.from(first + second + '{"type":"future-entry"}');
    const fake = shortReadHandle(content, 2);
    const attempt = await resumeAttempt();
    const lines: ScannedTranscriptLine[] = [];
    const startOffset = Buffer.byteLength(first);
    const endOffset = startOffset + Buffer.byteLength(second);
    await attempt.run(() =>
      new EntryScanner({ chunkBytes: 19 }).consume(
        '/fixture/session.jsonl',
        (line) => {
          lines.push(line);
        },
        {
          attempt,
          handle: fake.handle,
          snapshot: fake.snapshot,
          startOffset,
          endOffset,
        },
      ),
    );
    expect(lines).toEqual([
      expect.objectContaining({
        byteOffset: startOffset,
        byteLength: Buffer.byteLength(second) - 1,
        order: 0,
        decoded: {
          kind: 'entry',
          entry: { type: 'summary', leafUuid: 'v', summary: '中文' },
        },
      }),
    ]);
    expect(attempt.stats.bytesRead).toBe(endOffset - startOffset);
    expect(
      fake.read.mock.calls.every(
        ([, , length, position]) =>
          position >= startOffset && position + length <= endOffset,
      ),
    ).toBe(true);
    expect(fake.handle.stat).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'rejects premature zero reads instead of accepting a prefix (range=%s)',
    async (range) => {
      const content = Buffer.from(
        '{"type":"future-entry"}\n{"type":"future-entry"}',
      );
      const fake = shortReadHandle(content, 5, content.length - 2);
      const attempt = await resumeAttempt();
      await expect(
        attempt.run(() =>
          new EntryScanner().consume(
            '/fixture/session.jsonl',
            () => undefined,
            {
              attempt,
              handle: fake.handle,
              ...(range
                ? { startOffset: 1, endOffset: content.length - 1 }
                : {}),
            },
          ),
        ),
      ).rejects.toMatchObject({ reason: 'snapshot' });
      expect(fake.close).not.toHaveBeenCalled();
    },
  );

  it.each(['\n', ''])(
    'rejects oversized lines before copying or decoding their next segment (ending=%j)',
    async (ending) => {
      const content = Buffer.from(
        '{"type":"future-entry","value":"too long"}' + ending,
      );
      const fake = shortReadHandle(content, 4);
      const attempt = await resumeAttempt({ limits: { maxLineBytes: 8 } });
      const visitor = vi.fn();
      await expect(
        attempt.run(() =>
          new EntryScanner({ chunkBytes: 4 }).consume(
            '/fixture/session.jsonl',
            visitor,
            { attempt, handle: fake.handle },
          ),
        ),
      ).rejects.toMatchObject({ reason: 'budget' });
      expect(visitor).not.toHaveBeenCalled();
      expect(attempt.stats.bytesRead).toBeLessThan(content.length);
    },
  );

  it('accepts a line at its byte budget including CR and BOM but excluding LF', async () => {
    const content = Buffer.from('\uFEFF{"type":"future-entry"}\r\n');
    const filePath = await createFile(content);
    const attempt = await resumeAttempt({
      limits: { maxLineBytes: content.length - 1 },
    });
    const visitor = vi.fn();
    await attempt.run(() =>
      new EntryScanner({ chunkBytes: 2 }).consume(filePath, visitor, {
        attempt,
      }),
    );
    expect(visitor).toHaveBeenCalledWith(
      expect.objectContaining({ byteLength: content.length - 1 }),
      undefined, // Unknown records have no retained-entry count.
    );
  });

  it.each([
    '{"type":"future-entry","items":[1,2,3]}',
    '{"type":"custom-title","items":[1,2,3]}',
    '{"type":"user","uuid":"u","timestamp":"t","message":{}}',
  ])(
    'validates decoded unknown, invalid and normalized entry subitems before delivery (%s)',
    async (content) => {
      const filePath = await createFile(content);
      const attempt = await resumeAttempt({
        limits: { maxNestedItemsPerEntry: 4 },
      });
      const visitor = vi.fn();
      await expect(
        attempt.run(() =>
          new EntryScanner().consume(filePath, visitor, { attempt }),
        ),
      ).rejects.toMatchObject({ reason: 'budget' });
      expect(visitor).not.toHaveBeenCalled();
    },
  );

  it('does not charge discarded decoded bodies to cumulative residency', async () => {
    const content = Array.from(
      { length: 20 },
      () => '{"type":"future-entry","value":[1,2]}',
    ).join('\n');
    const filePath = await createFile(content);
    const attempt = await resumeAttempt({
      limits: { maxRetainedBytes: 1, maxRetainedEntries: 1, maxNestedItems: 1 },
    });
    let count = 0;
    await attempt.run(() =>
      new EntryScanner({ chunkBytes: 7 }).consume(
        filePath,
        () => {
          count++;
        },
        { attempt },
      ),
    );
    expect(count).toBe(20);
    expect(attempt.stats).toMatchObject({
      retainedBytes: 0,
      retainedEntries: 0,
      nestedItems: 0,
    });
  });

  it('awaits each visitor and stops before publishing later lines on cancellation', async () => {
    const content = Buffer.from(
      '{"type":"future-entry"}\n{"type":"future-entry"}',
    );
    const fake = shortReadHandle(content, content.length);
    const abort = new AbortController();
    const attempt = await resumeAttempt({ signal: abort.signal });
    const seen: number[] = [];
    await expect(
      attempt.run(() =>
        new EntryScanner().consume(
          '/fixture/session.jsonl',
          async (line) => {
            await Promise.resolve();
            seen.push(line.order);
            abort.abort();
          },
          { attempt, handle: fake.handle },
        ),
      ),
    ).rejects.toMatchObject({ reason: 'cancelled' });
    expect(seen).toEqual([0]);
  });

  it('lets an event-loop cancellation run while processing a chunk with many small records', async () => {
    const filePath = await createFile(
      '{"type":"future-entry"}\n'.repeat(10_000),
    );
    const abort = new AbortController();
    const attempt = await resumeAttempt({ signal: abort.signal });
    let count = 0;
    const visitor = () => {
      count++;
      if (count === 1) setImmediate(() => abort.abort());
    };
    await expect(
      attempt.run(() =>
        new EntryScanner({ chunkBytes: 1024 ** 2 }).consume(filePath, visitor, {
          attempt,
        }),
      ),
    ).rejects.toMatchObject({ reason: 'cancelled' });
    expect(count).toBeLessThan(10_000);
  });

  it('joins bounded multi-segment records across short reads and resets the next line correctly', async () => {
    const entries = [
      { type: 'summary', leafUuid: 'a', summary: '中'.repeat(30_000) },
      { type: 'summary', leafUuid: 'b', summary: 'short' },
    ];
    const content = Buffer.from(
      entries.map((entry) => JSON.stringify(entry)).join('\n'),
    );
    const fake = shortReadHandle(content, 97);
    const attempt = await resumeAttempt();
    const seen: unknown[] = [];
    await attempt.run(() =>
      new EntryScanner({ chunkBytes: 128 }).consume(
        '/fixture/session.jsonl',
        (line) => {
          seen.push(line.decoded);
        },
        { attempt, handle: fake.handle },
      ),
    );
    expect(seen).toEqual(entries.map((entry) => ({ kind: 'entry', entry })));
    expect(attempt.stats.bytesRead).toBe(content.length);
  });

  it('一字节短读的分段对象受单行字节预算约束，不随读取次数增长', async () => {
    const entry = { type: 'summary', leafUuid: 'u', summary: 'x'.repeat(70_000) };
    const content = Buffer.from(JSON.stringify(entry));
    const fake = shortReadHandle(content, 1);
    const attempt = await resumeAttempt({ limits: { maxLineBytes: content.length } });
    const concat = vi.spyOn(Buffer, 'concat');
    const seen: unknown[] = [];
    await attempt.run(() =>
      new EntryScanner().consume('/fixture/session.jsonl', (line) => {
        seen.push(line.decoded);
      }, { attempt, handle: fake.handle }),
    );
    expect(seen).toEqual([{ kind: 'entry', entry }]);
    expect(attempt.stats.bytesRead).toBe(content.length);
    expect(concat.mock.calls.every(([segments]) => segments.length < 16)).toBe(true);
  });

  it('preserves read I/O errors rather than treating them as snapshot invalidation', async () => {
    const fake = shortReadHandle(Buffer.from('{"type":"future-entry"}'));
    const failure = Object.assign(new Error('read failed'), { code: 'EIO' });
    fake.read.mockRejectedValueOnce(failure);
    const attempt = await resumeAttempt();
    await expect(
      attempt.run(() =>
        new EntryScanner().consume('/fixture/session.jsonl', () => undefined, {
          attempt,
          handle: fake.handle,
        }),
      ),
    ).rejects.toBe(failure);
    expect(fake.close).not.toHaveBeenCalled();
  });

  it('uses the initial EOF even when a visitor appends another record', async () => {
    const content = '{"type":"future-entry"}\n';
    const filePath = await createFile(content);
    const attempt = await resumeAttempt();
    let count = 0;
    const snapshot = await attempt.run(() =>
      new EntryScanner({ chunkBytes: 2 }).consume(
        filePath,
        async () => {
          count++;
          await fs.appendFile(filePath, content);
        },
        { attempt },
      ),
    );
    expect(count).toBe(1);
    expect(snapshot.size).toBe(Buffer.byteLength(content));
  });

  it('closes only owned descriptors on failure and preserves ordinary I/O errors', async () => {
    const filePath = await createFile('{"type":"future-entry"}');
    const handle = await fs.open(filePath, 'r');
    const close = vi.spyOn(handle, 'close');
    const open = vi.mocked(fs.open).mockResolvedValueOnce(handle);
    const attempt = await resumeAttempt();
    const failure = new Error('visitor failure');
    await expect(
      attempt.run(() =>
        new EntryScanner().consume(
          filePath,
          async () => {
            throw failure;
          },
          { attempt },
        ),
      ),
    ).rejects.toBe(failure);
    expect(open).toHaveBeenCalledWith(filePath, 'r');
    expect(close).toHaveBeenCalled();
    expect(failure).not.toBeInstanceOf(ResumeReadError);
  });

  it('consumes empty ranges without reopening or closing an external descriptor', async () => {
    const content = Buffer.from('{"type":"future-entry"}');
    const fake = shortReadHandle(content);
    const attempt = await resumeAttempt();
    const visitor = vi.fn();
    await attempt.run(() =>
      new EntryScanner().consume('/fixture/session.jsonl', visitor, {
        attempt,
        handle: fake.handle,
        snapshot: fake.snapshot,
        startOffset: content.length,
        endOffset: content.length,
      }),
    );
    expect(visitor).not.toHaveBeenCalled();
    expect(fake.read).not.toHaveBeenCalled();
    expect(fake.close).not.toHaveBeenCalled();
  });
});
