/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  parseProcessTable,
  sampleProcessTreeRssBytes,
  sumProcessTreeRssBytes,
} from './process-resources.js';

describe('parseProcessTable', () => {
  it('parses pid/ppid/rss triplets and ignores other lines', () => {
    const rows = parseProcessTable(`
  1     0   1024
  2     1   2048
  not a row
  3     1   4096
`);
    expect(rows).toEqual([
      { pid: 1, ppid: 0, rss: 1024 },
      { pid: 2, ppid: 1, rss: 2048 },
      { pid: 3, ppid: 1, rss: 4096 },
    ]);
  });
});

describe('sumProcessTreeRssBytes', () => {
  it('sums the root and every descendant, ignoring unrelated rows', () => {
    const rows = parseProcessTable('1 0 100\n2 1 200\n3 2 300\n4 9 400\n');
    expect(sumProcessTreeRssBytes(rows, 1, 1024)).toBe(
      (100 + 200 + 300) * 1024,
    );
  });

  it('returns undefined when the root is absent', () => {
    expect(
      sumProcessTreeRssBytes(parseProcessTable('2 1 10\n'), 1, 1024),
    ).toBeUndefined();
  });

  it('terminates on a parent cycle', () => {
    expect(
      sumProcessTreeRssBytes(
        [
          { pid: 1, ppid: 2, rss: 10 },
          { pid: 2, ppid: 1, rss: 20 },
        ],
        1,
        1,
      ),
    ).toBe(30);
  });
});

describe('sampleProcessTreeRssBytes', () => {
  it.runIf(process.platform !== 'win32')(
    'samples the current process tree',
    async () => {
      const bytes = await sampleProcessTreeRssBytes(process.pid);
      expect(bytes).toBeGreaterThan(0);
    },
  );
});
