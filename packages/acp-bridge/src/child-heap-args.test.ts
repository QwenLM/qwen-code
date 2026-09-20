/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyChildHeapLimit } from './child-heap-args.js';

describe('applyChildHeapLimit', () => {
  it('removes fixed flags from both sources and preserves unrelated Node options', () => {
    const env = {
      NODE_OPTIONS:
        '--max_old_space_size=8192 --require "a \\"quote\\" file.cjs" --max-old-space-size 4096 --conditions=kept',
    };
    expect(
      applyChildHeapLimit(
        [
          '--max-old-space-size',
          '8192',
          '--trace-warnings',
          '--max_old_space_size=4096',
        ],
        env,
        544,
      ),
    ).toEqual(['--trace-warnings', '--max-old-space-size=544', '--expose-gc']);
    expect(env.NODE_OPTIONS).toBe(
      '"--require" "a \\"quote\\" file.cjs" "--conditions=kept"',
    );
  });

  it.each([
    ['--max-old-space-size-percentage=50'],
    ['--max_old_space_size_percentage', '50'],
  ])('rejects percentage flags in argv and NODE_OPTIONS: %j', (...args) => {
    expect(() => applyChildHeapLimit(args, {}, 544)).toThrow('percentage');
    expect(() =>
      applyChildHeapLimit([], { NODE_OPTIONS: args.join(' ') }, 544),
    ).toThrow('percentage');
  });

  it.each(['--require "unfinished', '--require "unfinished\\'])(
    'rejects malformed NODE_OPTIONS without silently changing it: %s',
    (value) => {
      const env = { NODE_OPTIONS: value };
      expect(() => applyChildHeapLimit([], env, 544)).toThrow('NODE_OPTIONS');
      expect(env.NODE_OPTIONS).toBe(value);
    },
  );

  it('rejects a missing split value without swallowing another option', () => {
    expect(() =>
      applyChildHeapLimit(['--max-old-space-size', '--require=x'], {}, 544),
    ).toThrow('Missing value');
  });

  it('actually lowers a Node child limit and retains a preload with spaces', () => {
    const directory = mkdtempSync(join(tmpdir(), 'qwen-heap-args-'));
    try {
      const preload = join(directory, 'preload with spaces.cjs');
      writeFileSync(preload, 'globalThis.heapTestPreloaded = true;');
      const env = {
        ...process.env,
        NODE_OPTIONS: `--max-old-space-size=4096 --require "${preload.replaceAll('\\', '\\\\')}"`,
      };
      const args = applyChildHeapLimit(
        ['--max_old_space_size', '8192'],
        env,
        544,
      );
      const result = JSON.parse(
        execFileSync(
          process.execPath,
          [
            ...args,
            '-e',
            'console.log(JSON.stringify({heap:require("node:v8").getHeapStatistics().heap_size_limit,preloaded:globalThis.heapTestPreloaded,gc:typeof globalThis.gc}))',
          ],
          { env, encoding: 'utf8', timeout: 10_000 },
        ),
      );
      const expectedLimit = Number(
        execFileSync(
          process.execPath,
          [
            '--max-old-space-size=544',
            '-e',
            'console.log(require("node:v8").getHeapStatistics().heap_size_limit)',
          ],
          {
            env: { ...process.env, NODE_OPTIONS: '' },
            encoding: 'utf8',
            timeout: 10_000,
          },
        ),
      );
      expect(result).toEqual({
        heap: expectedLimit,
        preloaded: true,
        gc: 'function',
      });
      expect(expectedLimit).toBeLessThan(1024 * 1024 * 1024);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
