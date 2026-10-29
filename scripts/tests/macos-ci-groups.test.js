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
