/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { getDefaultShellPager, getShellPagerEnv } from './shell-pager-env.js';

describe('shellPagerEnv', () => {
  it('defaults to cat on non-Windows platforms', () => {
    expect(getDefaultShellPager('linux')).toBe('cat');
    expect(getDefaultShellPager('darwin')).toBe('cat');
  });

  it('does not default to Unix-only cat on Windows', () => {
    expect(getDefaultShellPager('win32')).toBeUndefined();
    expect(getShellPagerEnv(undefined, { platform: 'win32' })).toEqual({
      PAGER: undefined,
    });
  });

  it('clears inherited git pager values when requested without an effective pager', () => {
    expect(
      getShellPagerEnv(undefined, {
        includeGitPager: true,
        platform: 'win32',
      }),
    ).toEqual({
      PAGER: undefined,
      GIT_PAGER: undefined,
    });
  });

  it('preserves explicit pager configuration on Windows', () => {
    expect(
      getShellPagerEnv('more', { includeGitPager: true, platform: 'win32' }),
    ).toEqual({
      PAGER: 'more',
      GIT_PAGER: 'more',
    });
  });
});
