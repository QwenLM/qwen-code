/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeRunEnvironment, parseStrace } from '../startup-benchmark/lib.mjs';

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

describe('makeRunEnvironment', () => {
  const modelServer = { baseUrl: (runId) => `http://127.0.0.1:1/${runId}` };
  let root;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-bench-test-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  const layout = (run) => {
    const qwenDir = path.join(run.env.HOME, '.qwen');
    const dotenv = path.join(qwenDir, '.env');
    return {
      settings: JSON.parse(
        fs.readFileSync(path.join(qwenDir, 'settings.json'), 'utf8'),
      ),
      dotenv: fs.existsSync(dotenv) ? fs.readFileSync(dotenv, 'utf8') : null,
    };
  };

  it('exports the model credentials in the shell by default', () => {
    const run = makeRunEnvironment({ root, modelServer });
    expect(run.env.OPENAI_API_KEY).toBe('bench-key');
    expect(run.env.OPENAI_BASE_URL).toBe(`http://127.0.0.1:1/${run.runId}`);
    const { settings, dotenv } = layout(run);
    expect(settings.env).toBeUndefined();
    expect(dotenv).toBeNull();
  });

  it('puts them in the settings env block for credentials: settings', () => {
    const run = makeRunEnvironment({
      root,
      modelServer,
      credentials: 'settings',
    });
    expect(run.env.OPENAI_API_KEY).toBeUndefined();
    expect(run.env.OPENAI_BASE_URL).toBeUndefined();
    const { settings, dotenv } = layout(run);
    expect(settings.env).toEqual({
      OPENAI_API_KEY: 'bench-key',
      OPENAI_BASE_URL: `http://127.0.0.1:1/${run.runId}`,
    });
    expect(dotenv).toBeNull();
  });

  it('puts them in ~/.qwen/.env for credentials: dotenv', () => {
    const run = makeRunEnvironment({
      root,
      modelServer,
      credentials: 'dotenv',
    });
    expect(run.env.OPENAI_API_KEY).toBeUndefined();
    const { settings, dotenv } = layout(run);
    expect(settings.env).toBeUndefined();
    expect(dotenv).toBe(
      `OPENAI_API_KEY=bench-key\nOPENAI_BASE_URL=http://127.0.0.1:1/${run.runId}\n`,
    );
  });

  it('rejects an unknown credentials source', () => {
    expect(() =>
      makeRunEnvironment({ root, modelServer, credentials: 'vault' }),
    ).toThrow(/credentials must be one of/);
  });
});
