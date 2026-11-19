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
import * as nodeConstants from 'node:constants';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { Storage } from '../config/storage.js';
import {
  resetDebugLoggingState,
  runWithDebugLogSession,
  setDebugLogSession,
} from './debugLogger.js';
import {
  _getFileLockCountForTest,
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

async function withDebugLog(
  sessionId: string,
  fileOutputEnabled: boolean,
  run: (logPath: string) => Promise<void>,
): Promise<void> {
  const previousDebugLogFile = process.env['QWEN_DEBUG_LOG_FILE'];
  process.env['QWEN_DEBUG_LOG_FILE'] = fileOutputEnabled ? '1' : '0';
  Storage.setRuntimeBaseDir(tmpRoot);
  resetDebugLoggingState();
  setDebugLogSession({ getSessionId: () => sessionId });
  try {
    await run(Storage.getDebugLogPath(sessionId));
  } finally {
    setDebugLogSession(null);
    resetDebugLoggingState();
    Storage.setRuntimeBaseDir(null);
    if (previousDebugLogFile === undefined) {
      delete process.env['QWEN_DEBUG_LOG_FILE'];
    } else {
      process.env['QWEN_DEBUG_LOG_FILE'] = previousDebugLogFile;
    }
  }
}

function tailWarnings(logPath: string, filePath?: string): string[] {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(
      (line) =>
        line.includes('Cannot inspect JSONL tail') &&
        (filePath === undefined || line.includes(filePath)),
    );
}

describe('append lock lifetime', () => {
  it('releases locks after writing distinct files', async () => {
    await Promise.all(
      Array.from({ length: 64 }, (_, index) =>
        writeLine(tmpPath('lock-lifetime'), { index }),
      ),
    );
    expect(_getFileLockCountForTest()).toBe(0);
  });

  it('releases locks after serialization and filesystem failures', async () => {
    await expect(writeLine(tmpPath('serialize-failure'), 1n)).rejects.toThrow();
    const parent = tmpPath('not-directory');
    fs.writeFileSync(parent, 'file');
    await expect(
      writeLine(path.join(parent, 'child.jsonl'), {}),
    ).rejects.toThrow();
    expect(_getFileLockCountForTest()).toBe(0);
  });

  it('keeps queued and newly arriving writers serialized', async () => {
    const file = tmpPath('queued-writers');
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const appendFile = fs.promises.appendFile.bind(fs.promises);
    let active = 0;
    let maximumActive = 0;
    const spy = vi
      .spyOn(fs.promises, 'appendFile')
      .mockImplementation(async (...args) => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        try {
          if (String(args[1]).includes('"index":0')) {
            firstStarted();
            await held;
          }
          return await appendFile(...args);
        } finally {
          active--;
        }
      });
    try {
      const first = writeLine(file, { index: 0 });
      await started;
      const second = writeLine(file, { index: 1 });
      const third = writeLine(file, { index: 2 });
      const arriving = first.then(() => writeLine(file, { index: 3 }));
      expect(_getFileLockCountForTest()).toBe(1);
      releaseFirst();
      await Promise.all([first, second, third, arriving]);
      expect(maximumActive).toBe(1);
      expect(await read(file)).toEqual([
        { index: 0 },
        { index: 1 },
        { index: 2 },
        { index: 3 },
      ]);
      expect(_getFileLockCountForTest()).toBe(0);
    } finally {
      releaseFirst();
      spy.mockRestore();
    }
  });

  it('allows a queued write to complete after its predecessor fails', async () => {
    const file = tmpPath('failed-predecessor');
    const failed = writeLine(file, 1n);
    const queued = writeLine(file, { ok: true });
    await expect(failed).rejects.toThrow();
    await queued;
    expect(await read(file)).toEqual([{ ok: true }]);
    expect(_getFileLockCountForTest()).toBe(0);
  });
});

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

  it('does not count blank lines toward the integrity-aware line budget', async () => {
    await expect(
      readIntegrity('\n \n{"i":1}{"i":2}\n\t\n{"i":\n{"i":3}\n', 2),
    ).resolves.toEqual({ records: [{ i: 1 }, { i: 2 }], complete: false });
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
  it.each([
    ['record', readLines],
    ['non-empty line', readLinesWithIntegrity],
  ])(
    'stops after its %s budget without consuming the next large line',
    async (_budget, reader) => {
      const header = '{"i":1}\n';
      const nextLine = JSON.stringify({ text: 'x'.repeat(8 * 1024 * 1024) });
      const file = tmpFile(`${header}${nextLine}\n`);
      const { spy, captured } = spyOnReadStreams();
      try {
        expect(await reader(file, 1)).toEqual(
          reader === readLines
            ? [{ i: 1 }]
            : { records: [{ i: 1 }], complete: true },
        );
        expect(captured.stream).toBeDefined();
        expect(captured.stream!.closed).toBe(true);
        expect(captured.stream!.bytesRead).toBeLessThanOrEqual(
          2 * captured.stream!.readableHighWaterMark,
        );
      } finally {
        spy.mockRestore();
      }
    },
  );

  it.each([
    ['record', readLines],
    ['non-empty line', readLinesWithIntegrity],
  ])(
    'settles its %s budget before the next line is terminated',
    async (_budget, reader) => {
      const stream = new PassThrough();
      const spy = vi
        .spyOn(fs, 'createReadStream')
        .mockReturnValueOnce(stream as unknown as fs.ReadStream);
      let settled = false;
      const pending = reader('controlled.jsonl', 1).then((result) => {
        settled = true;
        return result;
      });
      stream.write('{"i":1}\n{"i":');
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(settled).toBe(true);
        expect(stream.destroyed).toBe(true);
        expect(await pending).toEqual(
          reader === readLines
            ? [{ i: 1 }]
            : { records: [{ i: 1 }], complete: true },
        );
      } finally {
        stream.end('2}\n');
        await pending;
        spy.mockRestore();
      }
    },
  );

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
  describe.each([
    { name: 'writeLine', append: writeLine },
    { name: 'writeLineSync', append: writeLineSync },
  ])('$name', ({ name, append }) => {
    const tailProbeFlags =
      nodeConstants.O_RDONLY | (nodeConstants.O_NONBLOCK ?? 0);
    const denyTailProbe = (error: Error) => {
      if (name === 'writeLine') {
        const open = fs.promises.open.bind(fs.promises);
        return vi
          .spyOn(fs.promises, 'open')
          .mockImplementation(async (...args) => {
            if (args[1] === tailProbeFlags) throw error;
            return open(...args);
          });
      }
      const openSync = fs.openSync.bind(fs);
      return vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
        if (args[1] === tailProbeFlags) throw error;
        return openSync(...args);
      });
    };

    it.each(['EACCES', 'EPERM'])(
      'restores the record boundary after an %s tail-read denial',
      async (code) => {
        const file = tmpFile('{"existing":true}');
        const error = Object.assign(new Error('read denied'), { code });
        const spy = denyTailProbe(error);

        try {
          await append(file, { next: true });
          expect(
            spy.mock.calls.filter(([, flags]) => flags === tailProbeFlags),
          ).toHaveLength(1);
          expect(fs.readFileSync(file, 'utf8')).toBe(
            '{"existing":true}\n{"next":true}\n',
          );
        } finally {
          spy.mockRestore();
        }
      },
    );

    it.each([
      { platform: 'win32', shouldAppend: true },
      { platform: 'linux', shouldAppend: false },
    ] as const)(
      '$platform EBUSY tail-probe handling',
      async ({ platform, shouldAppend }) => {
        const original = '{"existing":true}';
        const file = tmpFile(original);
        const error = Object.assign(new Error('sharing violation'), {
          code: 'EBUSY',
        });
        const platformSpy = vi
          .spyOn(process, 'platform', 'get')
          .mockReturnValue(platform);
        const spy = denyTailProbe(error);

        try {
          const result = Promise.resolve().then(() =>
            append(file, { next: true }),
          );
          if (shouldAppend) {
            await result;
            expect(fs.readFileSync(file, 'utf8')).toBe(
              '{"existing":true}\n{"next":true}\n',
            );
          } else {
            await expect(result).rejects.toBe(error);
            expect(fs.readFileSync(file, 'utf8')).toBe(original);
          }
          expect(
            spy.mock.calls.filter(([, flags]) => flags === tailProbeFlags),
          ).toHaveLength(1);
        } finally {
          spy.mockRestore();
          platformSpy.mockRestore();
        }
      },
    );

    it('restores the record boundary under the Node permission model', async () => {
      const file = tmpFile('{"existing":true}');
      const error = Object.assign(new Error('read denied'), {
        code: 'ERR_ACCESS_DENIED',
        permission: 'FileSystemRead',
      });
      const spy = denyTailProbe(error);

      try {
        await append(file, { next: true });
        expect(
          spy.mock.calls.filter(([, flags]) => flags === tailProbeFlags),
        ).toHaveLength(1);
        expect(fs.readFileSync(file, 'utf8')).toBe(
          '{"existing":true}\n{"next":true}\n',
        );
      } finally {
        spy.mockRestore();
      }
    });

    it('rethrows other probe failures without changing the file', async () => {
      const original = '{"existing":true}';
      const file = tmpFile(original);
      const error = Object.assign(new Error('read failed'), { code: 'EIO' });
      const spy = denyTailProbe(error);

      try {
        await expect(
          Promise.resolve().then(() => append(file, { next: true })),
        ).rejects.toBe(error);
        expect(
          spy.mock.calls.filter(([, flags]) => flags === tailProbeFlags),
        ).toHaveLength(1);
        expect(fs.readFileSync(file, 'utf8')).toBe(original);
      } finally {
        spy.mockRestore();
      }
    });

    it('rethrows a non-read permission denial without changing the file', async () => {
      const original = '{"existing":true}';
      const file = tmpFile(original);
      const error = Object.assign(new Error('write denied'), {
        code: 'ERR_ACCESS_DENIED',
        permission: 'FileSystemWrite',
      });
      const spy = denyTailProbe(error);

      try {
        await expect(
          Promise.resolve().then(() => append(file, { next: true })),
        ).rejects.toBe(error);
        expect(fs.readFileSync(file, 'utf8')).toBe(original);
      } finally {
        spy.mockRestore();
      }
    });

    it.each([
      { name: 'empty', original: '', expected: '\n{"next":true}\n' },
      {
        name: 'newline-terminated',
        original: '{"existing":true}\n',
        expected: '{"existing":true}\n\n{"next":true}\n',
      },
    ])(
      'uses a conservative separator for an unreadable $name file',
      async ({ original, expected }) => {
        const file = tmpFile(original);
        const error = Object.assign(new Error('read denied'), {
          code: 'EACCES',
        });
        const spy = denyTailProbe(error);

        try {
          await append(file, { next: true });
          expect(fs.readFileSync(file, 'utf8')).toBe(expected);
        } finally {
          spy.mockRestore();
        }
      },
    );

    it('warns once for each denied path and keeps new files silent', async () => {
      const sessionId = `jsonl-tail-probe-${name}`;
      await withDebugLog(sessionId, true, async (logPath) => {
        const files = [tmpFile('{"first":'), tmpFile('{"second":')];
        const error = Object.assign(new Error('read denied'), {
          code: 'EACCES',
        });
        const newFile = tmpPath('new-file');
        await append(newFile, { first: true });
        expect(fs.readFileSync(newFile, 'utf8')).toBe('{"first":true}\n');
        const spy = denyTailProbe(error);

        try {
          for (const [index, file] of files.entries()) {
            await append(file, { next: index });
            await vi.waitFor(() => {
              expect(tailWarnings(logPath, file)).toHaveLength(1);
            });
          }
          for (const [index, file] of files.entries()) {
            await append(file, { repeated: index });
          }
          await new Promise<void>((resolve) => setImmediate(resolve));

          expect(tailWarnings(logPath)).toHaveLength(2);
          expect(tailWarnings(logPath, newFile)).toHaveLength(0);
          expect(
            spy.mock.calls.filter(([, flags]) => flags === tailProbeFlags),
          ).toHaveLength(4);
          expect(fs.readFileSync(files[0], 'utf8')).toBe(
            '{"first":\n{"next":0}\n\n{"repeated":0}\n',
          );
          expect(fs.readFileSync(files[1], 'utf8')).toBe(
            '{"second":\n{"next":1}\n\n{"repeated":1}\n',
          );
        } finally {
          spy.mockRestore();
        }
      });
    });

    it('warns once per debug session for the same denied path', async () => {
      const sessionA = `jsonl-tail-log-session-a-${name}`;
      const sessionB = `jsonl-tail-log-session-b-${name}`;
      await withDebugLog(sessionA, true, async (logPathA) => {
        const logPathB = Storage.getDebugLogPath(sessionB);
        const file = tmpFile('{"partial":');
        const error = Object.assign(new Error('read denied'), {
          code: 'EACCES',
        });
        const spy = denyTailProbe(error);
        const appendFor = (sessionId: string, record: unknown) =>
          runWithDebugLogSession({ getSessionId: () => sessionId }, () =>
            append(file, record),
          );
        const settleDebugLogWrites = () =>
          new Promise<void>((resolve) => setImmediate(resolve));

        try {
          await appendFor(sessionA, { write: 'a1' });
          await vi.waitFor(() => {
            expect(tailWarnings(logPathA, file)).toHaveLength(1);
          });
          await appendFor(sessionA, { write: 'a2' });
          await settleDebugLogWrites();
          expect(tailWarnings(logPathA, file)).toHaveLength(1);
          expect(tailWarnings(logPathB, file)).toHaveLength(0);

          await appendFor(sessionB, { write: 'b1' });
          await vi.waitFor(() => {
            expect(tailWarnings(logPathB, file)).toHaveLength(1);
          });
          await appendFor(sessionB, { write: 'b2' });
          await settleDebugLogWrites();

          expect(tailWarnings(logPathA, file)).toHaveLength(1);
          expect(tailWarnings(logPathB, file)).toHaveLength(1);
          expect(fs.readFileSync(file, 'utf8')).toBe(
            '{"partial":\n{"write":"a1"}\n\n{"write":"a2"}\n\n' +
              '{"write":"b1"}\n\n{"write":"b2"}\n',
          );
        } finally {
          spy.mockRestore();
        }
      });
    });

    it('defers dedup until session and file logging are both enabled', async () => {
      const sessionId = `jsonl-tail-log-activation-${name}`;
      await withDebugLog(sessionId, true, async (logPath) => {
        const withoutSession = tmpFile('{"session":');
        const withoutFileOutput = tmpFile('{"output":');
        const error = Object.assign(new Error('read denied'), {
          code: 'EACCES',
        });
        const spy = denyTailProbe(error);

        try {
          setDebugLogSession(null);
          await append(withoutSession, { inactive: true });
          setDebugLogSession({ getSessionId: () => sessionId });
          await append(withoutSession, { active: true });
          await vi.waitFor(() => {
            expect(tailWarnings(logPath, withoutSession)).toHaveLength(1);
          });
          await append(withoutSession, { deduplicated: true });

          process.env['QWEN_DEBUG_LOG_FILE'] = '0';
          await append(withoutFileOutput, { disabled: true });
          process.env['QWEN_DEBUG_LOG_FILE'] = '1';
          await append(withoutFileOutput, { enabled: true });
          await vi.waitFor(() => {
            expect(tailWarnings(logPath, withoutFileOutput)).toHaveLength(1);
          });
          await new Promise<void>((resolve) => setImmediate(resolve));

          expect(tailWarnings(logPath)).toHaveLength(2);
          expect(
            spy.mock.calls.filter(([, flags]) => flags === tailProbeFlags),
          ).toHaveLength(5);
        } finally {
          spy.mockRestore();
        }
      });
    });

    it('warns again for an evicted path after exceeding the cache bound', async () => {
      const sessionId = `jsonl-tail-log-bound-${name}`;
      await withDebugLog(sessionId, true, async (logPath) => {
        const files = Array.from({ length: 129 }, () => tmpFile(''));
        const error = Object.assign(new Error('read denied'), {
          code: 'EACCES',
        });
        const spy = denyTailProbe(error);

        try {
          for (const [index, file] of files.entries()) {
            await append(file, { index });
          }
          await vi.waitFor(() => {
            expect(tailWarnings(logPath)).toHaveLength(files.length);
          });
          await append(files[0], { evicted: true });
          await vi.waitFor(() => {
            expect(tailWarnings(logPath)).toHaveLength(files.length + 1);
          });

          expect(tailWarnings(logPath, files[0])).toHaveLength(2);
          expect(tailWarnings(logPath, files[1])).toHaveLength(1);
          expect(
            spy.mock.calls.filter(([, flags]) => flags === tailProbeFlags),
          ).toHaveLength(files.length + 1);
        } finally {
          spy.mockRestore();
        }
      });
    });

    it.runIf(process.platform !== 'win32')(
      'matches the native append outcome for a real FIFO',
      async () => {
        const fifo = tmpPath('fifo');
        const record = Buffer.from('{"next":true}\n', 'utf8');
        execFileSync('mkfifo', [fifo]);
        const reader = fs.openSync(fifo, tailProbeFlags);
        const drainRecord = () => {
          const received = Buffer.alloc(record.length);
          const bytesRead = fs.readSync(
            reader,
            received,
            0,
            received.length,
            null,
          );
          expect(bytesRead).toBe(record.length);
          expect(received).toEqual(record);
        };
        try {
          let nativeError: NodeJS.ErrnoException | undefined;
          try {
            if (name === 'writeLine') {
              await fs.promises.appendFile(fifo, record, { flush: true });
            } else {
              fs.appendFileSync(fifo, record, { flush: true });
            }
          } catch (error) {
            nativeError = error as NodeJS.ErrnoException;
          }
          drainRecord();

          const result = Promise.resolve().then(() =>
            append(fifo, { next: true }),
          );
          if (nativeError) {
            await expect(result).rejects.toMatchObject({
              code: nativeError.code,
            });
          } else {
            await expect(result).resolves.toBeUndefined();
          }
          drainRecord();
        } finally {
          fs.closeSync(reader);
        }
      },
    );

    it('does not prepend a newline to an existing empty file', async () => {
      const file = tmpFile('');

      await append(file, { empty: true });

      expect(fs.readFileSync(file, 'utf8')).toBe('{"empty":true}\n');
    });
  });

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

  it('writeLine preserves the next record after an interrupted append', async () => {
    const parent = { uuid: 'parent' };
    const file = tmpFile(
      `${JSON.stringify(parent)}\n{"uuid":"partial","sessionId":"sess`,
    );
    const next = { uuid: 'next', parentUuid: 'parent' };

    await writeLine(file, next);
    await writeLine(file, { uuid: 'last', parentUuid: 'next' });

    expect(fs.readFileSync(file, 'utf8')).toBe(
      `${JSON.stringify(parent)}\n{"uuid":"partial","sessionId":"sess\n` +
        '{"uuid":"next","parentUuid":"parent"}\n' +
        '{"uuid":"last","parentUuid":"next"}\n',
    );
    await expect(read(file)).resolves.toEqual([
      parent,
      next,
      { uuid: 'last', parentUuid: 'next' },
    ]);
  });

  it('writeLineSync appends well-formed records with trailing newlines', () => {
    const file = tmpPath('wls');
    writeLineSync(file, { sync: true, i: 0 });
    writeLineSync(file, { sync: true, i: 1 });

    expect(fs.readFileSync(file, 'utf8')).toBe(
      '{"sync":true,"i":0}\n{"sync":true,"i":1}\n',
    );
  });

  it('writeLineSync preserves the next record after an interrupted append', () => {
    const file = tmpFile(
      '{"uuid":"parent"}\n{"uuid":"partial","sessionId":"sess',
    );
    const next = { uuid: 'next', parentUuid: 'parent' };

    writeLineSync(file, next);

    expect(fs.readFileSync(file, 'utf8')).toBe(
      '{"uuid":"parent"}\n{"uuid":"partial","sessionId":"sess\n' +
        '{"uuid":"next","parentUuid":"parent"}\n',
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
