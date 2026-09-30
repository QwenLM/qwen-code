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
      PAGER: '',
    });
  });

  it('clears inherited git pager values when requested without an effective pager', () => {
    expect(
      getShellPagerEnv(undefined, {
        includeGitPager: true,
        platform: 'win32',
      }),
    ).toEqual({
      PAGER: '',
      GIT_PAGER: '',
    });
  });

  it('sets both PAGER and GIT_PAGER to cat on non-Windows when pager is unset', () => {
    expect(
      getShellPagerEnv(undefined, {
        includeGitPager: true,
        platform: 'linux',
      }),
    ).toEqual({
      PAGER: 'cat',
      GIT_PAGER: 'cat',
    });
  });

  it('omits GIT_PAGER when git pager output is not requested', () => {
    expect(
      getShellPagerEnv('less', {
        includeGitPager: false,
        platform: 'linux',
      }),
    ).toEqual({
      PAGER: 'less',
    });
  });

  it('uses the default pager without GIT_PAGER when git pager output is not requested', () => {
    expect(
      getShellPagerEnv(undefined, {
        includeGitPager: false,
        platform: 'linux',
      }),
    ).toEqual({
      PAGER: 'cat',
    });
  });

  it('treats an empty pager as an explicit request to disable pager env values', () => {
    expect(
      getShellPagerEnv('', { includeGitPager: true, platform: 'linux' }),
    ).toEqual({
      PAGER: '',
      GIT_PAGER: '',
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
