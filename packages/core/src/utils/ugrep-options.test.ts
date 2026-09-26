/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { scanUgrepOptions } from './ugrep-options.js';

describe('scanUgrepOptions', () => {
  it.each(['--exclude-dir', '--exclude', '--include', '--label'])(
    'consumes a space-form value for %s',
    (option) => {
      expect(
        scanUgrepOptions([option, '--', '--filter=x', 'needle', 'file.txt'])
          .safety,
      ).not.toBe('read-only');
    },
  );

  it('consumes the following argument after an empty attached value', () => {
    expect(
      scanUgrepOptions([
        '--exclude-dir=',
        '--',
        '--save-config=/tmp/ugrep.conf',
        'needle',
        'file.txt',
      ]).safety,
    ).toBe('write');
  });

  it.each(['-@', '--all', '--no-ignore-files'])(
    'does not certify ignore-lifting option %s as read-only',
    (option) => {
      expect(scanUgrepOptions([option, 'needle', '.']).safety).toBe('unknown');
    },
  );
});
