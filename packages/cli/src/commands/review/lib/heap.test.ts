/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  heapBannerIn,
  heapFlagMb,
  killedFromOutside,
  withoutHeapFlag,
} from './heap.js';

const BANNER =
  'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory';

describe('heapFlagMb / withoutHeapFlag', () => {
  it('reads the largest heap an options string sets, in any spelling V8 accepts', () => {
    expect(heapFlagMb('--max-old-space-size=6144')).toBe(6144);
    expect(heapFlagMb('--max_old_space_size=1024 --enable-source-maps')).toBe(
      1024,
    );
    expect(heapFlagMb('--max-old-space-size 2048')).toBe(2048);
    expect(
      heapFlagMb('--max-old-space-size=1024 --max-old-space-size=8192'),
    ).toBe(8192);
    expect(heapFlagMb('--enable-source-maps')).toBeUndefined();
    expect(heapFlagMb('--max-old-space-size=')).toBeUndefined();
    expect(heapFlagMb('--max-old-space-size=12abc')).toBeUndefined();
  });

  it('takes every heap flag and its value out, and leaves the rest', () => {
    expect(
      withoutHeapFlag(
        '--enable-source-maps --max-old-space-size 1024 --max_old_space_size=2 -r x',
      ),
    ).toBe('--enable-source-maps -r x');
  });
});

describe('heapBannerIn', () => {
  it('sees the banner where V8 prints it, at the start of a line', () => {
    expect(heapBannerIn(BANNER)).toBe(true);
    expect(heapBannerIn(`<--- JS stacktrace --->\n\n${BANNER}\n`)).toBe(true);
  });

  it('does not take a runner echoing the text for a process that died of it', () => {
    expect(heapBannerIn(`+ ${BANNER}`)).toBe(false);
    expect(heapBannerIn(`expected 'a\\n${BANNER}' to contain 'b'`)).toBe(false);
    expect(heapBannerIn(`    290|       '${BANNER}';`)).toBe(false);
  });
});

describe('killedFromOutside', () => {
  const r = { exitCode: null, timedOut: false };
  it('is a 137, or a SIGKILL with nothing else to explain it', () => {
    expect(killedFromOutside({ ...r, exitCode: 137 })).toBe(true);
    expect(killedFromOutside({ ...r, signal: 'SIGKILL' })).toBe(true);
  });

  it('is not the deadline, a spawn error, another signal, or a bare null', () => {
    expect(killedFromOutside({ ...r, timedOut: true, signal: 'SIGKILL' })).toBe(
      false,
    );
    expect(
      killedFromOutside({ ...r, signal: 'SIGKILL', spawnError: 'ENOBUFS' }),
    ).toBe(false);
    expect(killedFromOutside({ ...r, spawnError: 'ENOENT' })).toBe(false);
    expect(killedFromOutside({ ...r, signal: 'SIGSEGV' })).toBe(false);
    expect(killedFromOutside(r)).toBe(false);
    expect(killedFromOutside({ ...r, exitCode: 1 })).toBe(false);
  });
});
