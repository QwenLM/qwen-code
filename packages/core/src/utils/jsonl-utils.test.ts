/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  _recoverObjectsFromLine,
  _resetEnsuredDirsCacheForTest,
  countLines,
  exists,
  parseLineTolerant,
  read,
  readLines,
  readLinesWithIntegrity,
  write,
  writeLine,
  writeLineSync,
} from './jsonl-utils.js';

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-utils-test-'));
});

afterAll(() => {
  fs.rmSync(tmpRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
});

afterEach(() => {
  _resetEnsuredDirsCacheForTest();
});

const tmpPath = (prefix: string) =>
  path.join(tmpRoot, `${prefix}-${Math.random().toString(36).slice(2)}.jsonl`);

function tmpFile(content: string): string {
  const p = tmpPath('t');
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

async function waitForStreamClosed(
  getStream: () => fs.ReadStream | undefined,
): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!getStream()?.closed && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(getStream()?.closed).toBe(true);
}

/** Spies on fs.createReadStream, passing through and keeping the last stream. */
function spyOnReadStreams() {
  const originalCreateReadStream = fs.createReadStream.bind(fs);
  const captured: { stream?: fs.ReadStream } = {};
  const spy = vi
    .spyOn(fs, 'createReadStream')
    .mockImplementation((...args: Parameters<typeof fs.createReadStream>) => {
      captured.stream = originalCreateReadStream(...args);
      return captured.stream;
    });
  return { spy, captured };
}

async function withCapturedReadStream<T>(
  content: string,
  operation: (file: string) => Promise<T>,
): Promise<T> {
  const file = tmpFile(content);
  const { spy, captured } = spyOnReadStreams();
  try {
    const result = await operation(file);
    expect(captured.stream).toBeDefined();
    await waitForStreamClosed(() => captured.stream);
    return result;
  } finally {
    spy.mockRestore();
  }
}

describe('_recoverObjectsFromLine', () => {
  it('returns single object for a well-formed JSON line', () => {
    expect(_recoverObjectsFromLine<{ a: number }>('{"a":1}')).toEqual([
      { a: 1 },
    ]);
  });

  it('splits two concatenated objects with no separator', () => {
    expect(
      _recoverObjectsFromLine<{ a: number } | { b: number }>('{"a":1}{"b":2}'),
    ).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('does not split on `}{` that appears inside a string value', () => {
    const line = '{"text":"close-then-open: }{ here"}';
    expect(_recoverObjectsFromLine<{ text: string }>(line)).toEqual([
      { text: 'close-then-open: }{ here' },
    ]);
  });

  it('handles escaped quotes inside strings', () => {
    const line = '{"q":"he said \\"hi\\"","n":1}{"q":"x"}';
    expect(_recoverObjectsFromLine<{ q: string; n?: number }>(line)).toEqual([
      { q: 'he said "hi"', n: 1 },
      { q: 'x' },
    ]);
  });

  it('recovers objects around an unbalanced fragment', () => {
    // Middle `{"oops":}` fails JSON.parse, surrounding objects still parse.
    expect(
      _recoverObjectsFromLine<{ a?: number; b?: number }>(
        '{"a":1}{"oops":}{"b":2}',
      ),
    ).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('returns empty array when nothing balanced can be parsed', () => {
    expect(_recoverObjectsFromLine('not json at all')).toEqual([]);
    expect(_recoverObjectsFromLine('{"unterminated":')).toEqual([]);
  });
});

describe('parseLineTolerant', () => {
  const parse = (line: string) => parseLineTolerant(line, '/tmp/x.jsonl');

  it('returns the parsed object for a well-formed line', () => {
    expect(parse('{"a":1}')).toEqual([{ a: 1 }]);
  });

  it('recovers both records from a `}{`-glued line', () => {
    expect(parse('{"uuid":"a"}{"uuid":"b"}')).toEqual([
      { uuid: 'a' },
      { uuid: 'b' },
    ]);
  });

  it('returns [] when nothing balanced can be recovered', () => {
    expect(parse('not-json')).toEqual([]);
  });

  it('filters non-object JSON values (e.g. bare `null`) instead of forwarding them', () => {
    // Unfiltered, `record.type` callers crash on the scalar and outer catches
    // zero out whole counts.
    expect(parse('null')).toEqual([]);
    expect(parse('42')).toEqual([]);
    expect(parse('"a string"')).toEqual([]);
  });

  it('filters bare JSON arrays (typeof [] === "object" trap)', () => {
    // Docstring promises only objects; arrays pass `typeof === 'object'` and
    // would force callers to add `Array.isArray` guards before `record.type`.
    expect(parse('[1,2,3]')).toEqual([]);
    expect(parse('[]')).toEqual([]);
  });
});

describe('read() / readLines() with malformed lines', () => {
  const readIntegrity = (content: string, count: number) =>
    readLinesWithIntegrity<{ i: number }>(tmpFile(content), count);

  it('reads a clean file unchanged', async () => {
    const file = tmpFile('{"a":1}\n{"a":2}\n{"a":3}\n');
    expect(await read<{ a: number }>(file)).toEqual([
      { a: 1 },
      { a: 2 },
      { a: 3 },
    ]);
  });

  it('recovers concatenated records without losing later lines', async () => {
    // The #3606 corruption shape: two records glued onto one physical line,
    // with valid records before and after.
    const file = tmpFile(
      '{"uuid":"a","i":1}\n{"uuid":"b","i":2}{"uuid":"c","i":3}\n{"uuid":"d","i":4}\n',
    );
    const out = await read<{ uuid: string; i: number }>(file);
    expect(out.map((r) => r.uuid)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('skips a fully-garbage line and keeps reading', async () => {
    const file = tmpFile('{"a":1}\nnot-json-at-all\n{"a":3}\n');
    expect(await read<{ a: number }>(file)).toEqual([{ a: 1 }, { a: 3 }]);
  });

  it('returns [] for a missing file', async () => {
    expect(await read(path.join(tmpRoot, 'does-not-exist.jsonl'))).toEqual([]);
  });

  it('can rethrow non-ENOENT read errors for user-visible callers', async () => {
    const file = tmpFile('{"a":1}\n');
    const error = Object.assign(new Error('permission denied'), {
      code: 'EACCES',
    });
    const spy = vi.spyOn(fs, 'createReadStream').mockImplementationOnce(() => {
      throw error;
    });

    try {
      await expect(read(file, { throwOnNonEnoentError: true })).rejects.toThrow(
        'permission denied',
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('still returns [] for missing files when rethrowing read errors', async () => {
    await expect(
      read(path.join(tmpRoot, 'does-not-exist.jsonl'), {
        throwOnNonEnoentError: true,
      }),
    ).resolves.toEqual([]);
  });

  it('readLines respects the limit when objects come from recovery', async () => {
    // Two clean lines, then a glued pair. Asking for 3 should yield 3.
    const file = tmpFile('{"i":1}\n{"i":2}\n{"i":3}{"i":4}\n{"i":5}\n');
    expect((await readLines<{ i: number }>(file, 3)).map((r) => r.i)).toEqual([
      1, 2, 3,
    ]);
  });

  it('readLines recovers when the malformed line is within the first N', async () => {
    const file = tmpFile('{"i":1}{"i":2}\n{"i":3}\n');
    expect((await readLines<{ i: number }>(file, 5)).map((r) => r.i)).toEqual([
      1, 2, 3,
    ]);
  });

  it('reports complete recovery for glued object records', async () => {
    await expect(
      readIntegrity('{"i":1}{"i":2}\n{"i":3}\n', 5),
    ).resolves.toEqual({
      records: [{ i: 1 }, { i: 2 }, { i: 3 }],
      complete: true,
    });
  });

  it.each([
    ['a truncated record', '{"i":1}{"i":\n{"i":3}\n'],
    ['trailing garbage', '{"i":1}garbage\n{"i":3}\n'],
    ['an invalid middle fragment', '{"i":1}{"invalid":}{"i":2}\n{"i":3}\n'],
    ['a non-object value', '{"i":1}\nnull\n{"i":3}\n'],
  ])('reports incomplete recovery for %s', async (_name, content) => {
    await expect(readIntegrity(content, 5)).resolves.toMatchObject({
      complete: false,
    });
  });

  it('measures completeness against a line budget, not a record budget', async () => {
    // Line 1 alone satisfies a 2-record budget; the corrupt line 2 must still
    // be scanned because the budget counts physical lines.
    await expect(
      readIntegrity('{"i":1}{"i":2}\n{"i":\n', 2),
    ).resolves.toMatchObject({ complete: false });
  });

  it('returns every record recovered from the scanned lines', async () => {
    await expect(
      readIntegrity('{"i":1}{"i":2}\n{"i":3}\n', 1),
    ).resolves.toEqual({ records: [{ i: 1 }, { i: 2 }], complete: true });
  });

  it('keeps the plain reader on a record budget after zero-record lines', async () => {
    const file = tmpFile('{"i":\nnull\n{"i":1}\n{"i":2}\n');

    await expect(readLines<{ i: number }>(file, 2)).resolves.toEqual([
      { i: 1 },
      { i: 2 },
    ]);
  });

  it('skips blank lines', async () => {
    const file = tmpFile('{"a":1}\n\n{"a":2}\n');
    expect(await read<{ a: number }>(file)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('drops scalar / array lines so callers do not see non-object records', async () => {
    // Beyond #3681 Item 1, read()/readLines() skip well-formed non-object
    // JSON; pre-#3692 `null` / `42` / `"s"` / `[1,2]` surfaced as elements.
    const file = tmpFile('{"a":1}\nnull\n42\n"a string"\n[1,2,3]\n{"a":2}\n');
    expect(await read<{ a: number }>(file)).toEqual([{ a: 1 }, { a: 2 }]);
    expect(await readLines<{ a: number }>(file, 10)).toEqual([
      { a: 1 },
      { a: 2 },
    ]);
  });
});

describe('reader resource cleanup', () => {
  it('propagates the caller abort reason from readLines', async () => {
    const file = tmpFile(
      Array.from({ length: 1_000 }, (_, index) => `{"i":${index}}`).join('\n'),
    );
    const controller = new AbortController();
    const reason = new Error('jsonl scan cancelled');
    const { spy } = spyOnReadStreams();
    try {
      const readPromise = readLines<{ i: number }>(file, 1_000, {
        signal: controller.signal,
      });
      expect(spy).toHaveBeenCalledWith(file, { signal: controller.signal });

      controller.abort(reason);

      await expect(readPromise).rejects.toBe(reason);
    } finally {
      spy.mockRestore();
    }
  });

  it('observes cancellation while readLines is closing its stream', async () => {
    const file = tmpFile('{"i":1}\n{"i":2}\n');
    const controller = new AbortController();
    const reason = new Error('cancelled during stream cleanup');
    const { spy, captured } = spyOnReadStreams();
    try {
      const readPromise = readLines<{ i: number }>(file, 1, {
        signal: controller.signal,
      });
      expect(captured.stream).toBeDefined();
      captured.stream!.once('close', () => controller.abort(reason));

      await expect(readPromise).rejects.toBe(reason);
    } finally {
      spy.mockRestore();
    }
  });

  it('closes the file stream after readLines stops at the requested limit', async () => {
    const result = await withCapturedReadStream(
      '{"i":1}\n{"i":2}\n{"i":3}\n',
      (file) => readLines<{ i: number }>(file, 1),
    );

    expect(result).toEqual([{ i: 1 }]);
  });

  it('closes the file stream after an integrity-aware read', async () => {
    const result = await withCapturedReadStream(
      '{"i":1}{"i":2}\n{"i":3}\n',
      (file) => readLinesWithIntegrity<{ i: number }>(file, 1),
    );

    expect(result).toEqual({ records: [{ i: 1 }, { i: 2 }], complete: true });
  });

  it('closes the file stream after read consumes all lines', async () => {
    const result = await withCapturedReadStream('{"i":1}\n{"i":2}\n', (file) =>
      read<{ i: number }>(file),
    );

    expect(result).toEqual([{ i: 1 }, { i: 2 }]);
  });

  it('closes the file stream after countLines consumes all lines', async () => {
    const result = await withCapturedReadStream(
      '{"i":1}\n\n{"i":2}\n',
      countLines,
    );

    expect(result).toBe(2);
  });
});

// PR #4333: real-fs roundtrip smoke tests for the three write paths. Callers
// (chatRecordingService, sessionService) mock these entirely, so flush:true or
// atomicWriteFileSync wiring regressions would otherwise go undetected.
describe('writeLine / writeLineSync / write', () => {
  it('writeLine round-trips through read() with flush:true appended records', async () => {
    const file = tmpPath('wl');
    await writeLine(file, { kind: 'a', n: 1 });
    await writeLine(file, { kind: 'b', n: 2 });
    await writeLine(file, { kind: 'c', n: 3 });

    const records = await read(file);
    expect(records).toEqual([
      { kind: 'a', n: 1 },
      { kind: 'b', n: 2 },
      { kind: 'c', n: 3 },
    ]);
    // No `}{` glue: each line is its own well-formed record.
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).toBe(
      '{"kind":"a","n":1}\n{"kind":"b","n":2}\n{"kind":"c","n":3}\n',
    );
  });

  it('writeLineSync appends well-formed records with trailing newlines', () => {
    const file = tmpPath('wls');
    writeLineSync(file, { sync: true, i: 0 });
    writeLineSync(file, { sync: true, i: 1 });

    expect(fs.readFileSync(file, 'utf8')).toBe(
      '{"sync":true,"i":0}\n{"sync":true,"i":1}\n',
    );
  });

  it('write() full-file replaces existing content via atomic write', async () => {
    const file = tmpPath('wf');
    await writeLine(file, { v: 1 });
    await writeLine(file, { v: 2 });
    expect((await read(file)).length).toBe(2);

    // Replace the entire file via the sync write() helper.
    write(file, [{ v: 10 }, { v: 20 }, { v: 30 }]);

    expect(await read(file)).toEqual([{ v: 10 }, { v: 20 }, { v: 30 }]);
    // No tmp residue from atomicWriteFileSync.
    const dirEntries = fs
      .readdirSync(tmpRoot)
      .filter((f) => f.startsWith(path.basename(file)));
    expect(dirEntries).toEqual([path.basename(file)]);
  });

  // The other write() tests target the pre-created tmpRoot, so only the
  // parent-dirs case exercises the mkdirSync branch; dropping it would make
  // write() fail with ENOENT only for a brand-new subdirectory.
  it('write() with an empty array leaves a genuinely empty file', async () => {
    const file = tmpPath('we');
    await writeLine(file, { v: 1 });
    expect(exists(file)).toBe(true);

    // Clearing the file must not leave a stray newline behind: a 1-byte file
    // makes exists() (size > 0) disagree with read() (no records).
    write(file, []);

    expect(fs.readFileSync(file, 'utf8')).toBe('');
    expect(fs.statSync(file).size).toBe(0);
    expect(await read(file)).toEqual([]);
    expect(exists(file)).toBe(false);
  });

  it('write() creates parent dirs when missing', () => {
    const nested = path.join(tmpRoot, 'a', 'b', 'c', 'file.jsonl');
    write(nested, [{ x: 1 }]);
    expect(fs.readFileSync(nested, 'utf-8')).toBe('{"x":1}\n');
  });
});
