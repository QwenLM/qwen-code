/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { parseStrace } from '../startup-benchmark/lib.mjs';

const sizes = {
  '/q/cli-entry.js': 10,
  '/q/cli.js': 100,
  '/q/chunk.js': 1000,
  '/npm/npm-cli.js': 5,
};
const fileSize = (file) => sizes[file];

describe('parseStrace', () => {
  const trace = [
    '100 1000.000 execve("/usr/bin/node", ["node", "/q/cli-entry.js"], 0x1 /* 6 vars */) = 0',
    '100 1000.010 openat(AT_FDCWD, "/q/cli-entry.js", O_RDONLY|O_CLOEXEC) = 17',
    '100 1000.020 openat(AT_FDCWD, "/q/cli.js", O_RDONLY|O_CLOEXEC) = 18',
    '100 1000.030 openat(AT_FDCWD, "/q/cli.js", O_RDONLY|O_CLOEXEC) = 18',
    '100 1000.040 openat(AT_FDCWD, "/q/missing.js", O_RDONLY|O_CLOEXEC) = -1 ENOENT (No such file or directory)',
    '100 1000.050 openat(AT_FDCWD, "/q/settings.json", O_RDONLY|O_CLOEXEC) = 19',
    '101 1000.100 execve("/usr/local/bin/node", ["node", "/q/cli.js"], 0x2 /* 7 vars */) = -1 ENOENT (No such file or directory)',
    '101 1000.110 execve("/usr/bin/node", ["node", "/q/cli.js"], 0x2 /* 7 vars */) = 0',
    '101 1000.120 openat(AT_FDCWD, "/q/cli.js", O_RDONLY|O_CLOEXEC) = 17',
    '101 1000.130 openat(AT_FDCWD, "/q/chunk.js", O_RDONLY|O_CLOEXEC) = 18',
    '102 1000.200 execve("/usr/bin/git", ["git", "status"], 0x3 /* 7 vars */) = 0',
    '103 1005.000 execve("/usr/bin/node", ["node", "/npm/npm-cli.js"], 0x4 /* 7 vars */) = 0',
    '103 1005.010 openat(AT_FDCWD, "/npm/npm-cli.js", O_RDONLY|O_CLOEXEC) = 17',
  ].join('\n');

  it('counts Node images and the JavaScript each one opened, once per file', () => {
    expect(parseStrace(trace, Infinity, fileSize)).toEqual({
      nodeProcesses: 3,
      jsBytes: 10 + 100 + 100 + 1000 + 5,
    });
  });

  it('stops at the cutoff', () => {
    expect(parseStrace(trace, 1001_000, fileSize)).toEqual({
      nodeProcesses: 2,
      jsBytes: 10 + 100 + 100 + 1000,
    });
  });
});
