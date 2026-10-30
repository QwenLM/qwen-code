/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { runMacOsGroup } from '../run-macos-ci-group.js';

describe('macOS CI groups', () => {
  it('includes newly added workspace suites without duplicating heavy groups', () => {
    const spawn = vi
      .fn()
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({
          '@qwen-code/qwen-code': 'vitest run',
          '@qwen-code/qwen-code-core': 'vitest run',
          '@qwen-code/new-package': 'vitest run',
          '@qwen-code/sdk': 'npm run typecheck && vitest run',
          '@qwen-code/no-tests': {},
        }),
      })
      .mockReturnValueOnce({ status: 7 });

    expect(runMacOsGroup('rest', '', spawn)).toBe(7);
    expect(spawn.mock.calls[1][1]).toEqual([
      'run',
      'test:ci',
      '--workspace=@qwen-code/new-package',
      '--workspace=@qwen-code/sdk',
    ]);
  });

  it('shards both heavy groups by workspace path and keeps their heap cap', () => {
    for (const [group, shard] of [
      ['cli', '2/3'],
      ['core', '1/2'],
    ]) {
      const spawn = vi.fn().mockReturnValue({ status: 0 });
      expect(runMacOsGroup(group, shard, spawn)).toBe(0);
      // Without the bare '--', npm consumes --shard itself and every leg
      // re-runs the whole workspace suite — the overrun this split removes.
      expect(spawn.mock.calls[0][1]).toEqual([
        'run',
        'test:ci',
        `--workspace=packages/${group}`,
        '--',
        `--shard=${shard}`,
      ]);
      expect(spawn.mock.calls[0][2].env.NODE_OPTIONS).toBe(
        '--max-old-space-size=3072',
      );
    }
  });

  it('leaves the scripts group on the ambient environment', () => {
    const spawn = vi.fn().mockReturnValue({ status: 0 });
    expect(runMacOsGroup('scripts', '', spawn)).toBe(0);
    expect(spawn.mock.calls[0][2].env).toBe(process.env);
  });

  it('runs helper tests after standalone failure and preserves either failure', () => {
    for (const [standalone, scripts] of [
      [3, 0],
      [0, 5],
      [3, 5],
    ]) {
      const spawn = vi
        .fn()
        .mockReturnValueOnce({ status: standalone })
        .mockReturnValueOnce({ status: scripts });
      expect(runMacOsGroup('scripts', '', spawn)).not.toBe(0);
      expect(spawn.mock.calls.map((call) => call[1])).toEqual([
        ['run', 'test:standalone:runtimes:ci'],
        ['run', 'test:scripts:unit'],
      ]);
    }
  });

  it('fails closed when workspace discovery fails or yields no suites', () => {
    expect(
      runMacOsGroup('rest', '', vi.fn().mockReturnValue({ status: null })),
    ).toBe(1);
    expect(() =>
      runMacOsGroup(
        'rest',
        '',
        vi.fn().mockReturnValue({ status: 0, stdout: '{}' }),
      ),
    ).toThrow('No remaining workspace');
  });
});
