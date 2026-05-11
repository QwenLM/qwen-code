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
  parseLineTolerant,
  read,
  readLines,
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

function tmpFile(content: string): string {
  const p = path.join(
    tmpRoot,
    `t-${Math.random().toString(36).slice(2)}.jsonl`,
  );
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

async function withCapturedReadStream<T>(
  operation: () => Promise<T>,
): Promise<T> {
  let capturedStream: fs.ReadStream | undefined;
  const originalCreateReadStream = fs.createReadStream.bind(fs);
  const spy = vi
    .spyOn(fs, 'createReadStream')
    .mockImplementation((...args: Parameters<typeof fs.createReadStream>) => {
      const stream = originalCreateReadStream(...args);
      capturedStream = stream;
      return stream;
    });

  try {
    const result = await operation();
    expect(capturedStream).toBeDefined();
    await waitForStreamClosed(() => capturedStream);
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
  it('returns the parsed object for a well-formed line', () => {
    expect(parseLineTolerant<{ a: number }>('{"a":1}', '/tmp/x.jsonl')).toEqual(
      [{ a: 1 }],
    );
  });

  it('recovers both records from a `}{`-glued line', () => {
    expect(
      parseLineTolerant<{ uuid: string }>(
        '{"uuid":"a"}{"uuid":"b"}',
        '/tmp/x.jsonl',
      ),
    ).toEqual([{ uuid: 'a' }, { uuid: 'b' }]);
  });

  it('returns [] when nothing balanced can be recovered', () => {
    expect(parseLineTolerant('not-json', '/tmp/x.jsonl')).toEqual([]);
  });

  it('filters non-object JSON values (e.g. bare `null`) instead of forwarding them', () => {
    // Without the filter, callers that do `record.type` would crash on the
    // returned scalar; integration sites then propagate to outer catches and
    // zero out whole counts.
    expect(parseLineTolerant('null', '/tmp/x.jsonl')).toEqual([]);
    expect(parseLineTolerant('42', '/tmp/x.jsonl')).toEqual([]);
    expect(parseLineTolerant('"a string"', '/tmp/x.jsonl')).toEqual([]);
  });

  it('filters bare JSON arrays (typeof [] === "object" trap)', () => {
    // Docstring promises only objects flow through. Arrays would otherwise
    // slip past the `typeof === 'object'` check and force callers to add
    // their own `Array.isArray` guards before `record.type`.
    expect(parseLineTolerant('[1,2,3]', '/tmp/x.jsonl')).toEqual([]);
    expect(parseLineTolerant('[]', '/tmp/x.jsonl')).toEqual([]);
  });
});

describe('read() / readLines() with malformed lines', () => {
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

  it('skips blank lines', async () => {
    const file = tmpFile('{"a":1}\n\n{"a":2}\n');
    expect(await read<{ a: number }>(file)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('drops scalar / array lines so callers do not see non-object records', async () => {
    // Locks in the broader semantic change beyond #3681 Item 1: read() and
    // readLines() now silently skip well-formed JSON that is not an object.
    // Pre-#3692 these would have round-tripped through `JSON.parse(line)`
    // and surfaced as `null` / `42` / `"s"` / `[1,2]` array elements.
    const file = tmpFile('{"a":1}\nnull\n42\n"a string"\n[1,2,3]\n{"a":2}\n');
    expect(await read<{ a: number }>(file)).toEqual([{ a: 1 }, { a: 2 }]);
    expect(await readLines<{ a: number }>(file, 10)).toEqual([
      { a: 1 },
      { a: 2 },
    ]);
  });
});

describe('reader resource cleanup', () => {
  it('closes the file stream after readLines stops at the requested limit', async () => {
    const file = tmpFile('{"i":1}\n{"i":2}\n{"i":3}\n');

    const result = await withCapturedReadStream(() =>
      readLines<{ i: number }>(file, 1),
    );

    expect(result).toEqual([{ i: 1 }]);
  });

  it('closes the file stream after read consumes all lines', async () => {
    const file = tmpFile('{"i":1}\n{"i":2}\n');

    const result = await withCapturedReadStream(() =>
      read<{ i: number }>(file),
    );

    expect(result).toEqual([{ i: 1 }, { i: 2 }]);
  });

  it('closes the file stream after countLines consumes all lines', async () => {
    const file = tmpFile('{"i":1}\n\n{"i":2}\n');

    const result = await withCapturedReadStream(() => countLines(file));

    expect(result).toBe(2);
  });
});
