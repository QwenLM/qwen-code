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
  raiseHeap,
  raiseNpmHeap,
  withoutHeapFlag,
} from './heap.js';

const BANNER =
  'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory';

describe('heapFlagMb / withoutHeapFlag', () => {
  it('reads the heap an options string sets, in any spelling V8 accepts', () => {
    expect(heapFlagMb('--max-old-space-size=6144')).toBe(6144);
    expect(heapFlagMb('--max_old_space_size=1024 --enable-source-maps')).toBe(
      1024,
    );
    expect(heapFlagMb('--max-old-space-size 2048')).toBe(2048);
    expect(heapFlagMb('--enable-source-maps')).toBeUndefined();
    expect(heapFlagMb('--max-old-space-size=')).toBeUndefined();
    expect(heapFlagMb('--max-old-space-size=12abc')).toBeUndefined();
  });

  it('reads the last of several, which is the one V8 applies', () => {
    expect(
      heapFlagMb('--max-old-space-size=1024 --max-old-space-size=8192'),
    ).toBe(8192);
    expect(
      heapFlagMb('--max-old-space-size=8192 -r x --max_old_space_size=512'),
    ).toBe(512);
  });

  it('takes every heap flag and its value out, and leaves the rest', () => {
    expect(
      withoutHeapFlag(
        '--enable-source-maps --max-old-space-size 1024 --max_old_space_size=2 -r x',
      ),
    ).toBe('--enable-source-maps -r x');
  });
});

describe('raiseHeap', () => {
  it('raises a smaller heap to the one asked for, keeping every other option', () => {
    expect(raiseHeap('--require=/p.cjs --max-old-space-size=512', 6144)).toBe(
      '--require=/p.cjs --max-old-space-size=6144',
    );
    expect(raiseHeap('', 6144)).toBe('--max-old-space-size=6144');
  });

  it('leaves options that already set as much or more', () => {
    expect(raiseHeap('--max-old-space-size=6144', 6144)).toBeUndefined();
    expect(raiseHeap('-r x --max_old_space_size=8192', 6144)).toBeUndefined();
  });

  it('raises a larger heap that a later, smaller one overrides', () => {
    expect(
      raiseHeap(
        '--max-old-space-size=8192 -r x --max-old-space-size=512',
        6144,
      ),
    ).toBe('-r x --max-old-space-size=6144');
  });
});

describe('raiseNpmHeap', () => {
  it('escapes each ${VAR} the way npm unescapes it, and nothing else', () => {
    expect(
      raiseNpmHeap(
        '--require=/a/${X}/p.cjs --title=\\${Y} --max-old-space-size=512',
        6144,
      ),
    ).toBe(
      '--require=/a/\\${X}/p.cjs --title=\\\\\\${Y} --max-old-space-size=6144',
    );
    expect(raiseNpmHeap('--require=C:\\p\\x.cjs ${unclosed', 6144)).toBe(
      '--require=C:\\p\\x.cjs ${unclosed --max-old-space-size=6144',
    );
  });

  it('leaves options that already set enough', () => {
    expect(
      raiseNpmHeap('-r ${X} --max-old-space-size=8192', 6144),
    ).toBeUndefined();
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
