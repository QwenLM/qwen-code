/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '../../test-utils/render.js';
import type { TextBuffer } from '../components/shared/text-buffer.js';
import type { Settings, SettingsFile } from '../../config/settings.js';
import type { SpellcheckSettingsSource } from '../../config/spellcheckSettings.js';
import { resetSpellcheckSettingsWarningsForTesting } from '../../config/spellcheckSettings.js';
import {
  getSpellcheckCheckerForTesting,
  normalizeSpellcheckColor,
  resetSpellcheckCheckerForTesting,
  resetSpellcheckColorWarningForTesting,
  resolveSpellcheckColor,
  splitTextBySpellcheckSpans,
  useSpellcheckHighlights,
} from './useSpellcheckHighlights.js';

describe('normalizeSpellcheckColor', () => {
  it('turns a bare name into the form the renderer paints', () => {
    // `<Text color="red">` renders unstyled; `ansi:red` is the real form.
    expect(normalizeSpellcheckColor('red')).toBe('ansi:red');
    expect(normalizeSpellcheckColor('  redBright ')).toBe('ansi:redBright');
  });

  it('passes through the forms the renderer already understands', () => {
    expect(normalizeSpellcheckColor('#ff0000')).toBe('#ff0000');
    expect(normalizeSpellcheckColor('#F00')).toBe('#f00');
    expect(normalizeSpellcheckColor('rgb(255,0,0)')).toBe('rgb(255,0,0)');
    expect(normalizeSpellcheckColor('ansi256(93)')).toBe('ansi256(93)');
    expect(normalizeSpellcheckColor('ansi:cyan')).toBe('ansi:cyan');
  });

  it('tolerates spacing inside the functional forms', () => {
    expect(normalizeSpellcheckColor('rgb( 255, 0, 0 )')).toBe('rgb(255,0,0)');
    expect(normalizeSpellcheckColor('ansi256( 93 )')).toBe('ansi256(93)');
  });

  it('converts a color name outside the ANSI set to hex', () => {
    expect(normalizeSpellcheckColor('gray')).toBe('#808080');
  });

  it('rejects out-of-range and nonsense values', () => {
    expect(normalizeSpellcheckColor('rgb(300,0,0)')).toBeUndefined();
    expect(normalizeSpellcheckColor('ansi256(999)')).toBeUndefined();
    expect(normalizeSpellcheckColor('ansi:chartreuse')).toBeUndefined();
    expect(normalizeSpellcheckColor('#gg0000')).toBeUndefined();
    expect(normalizeSpellcheckColor('notacolor')).toBeUndefined();
    expect(normalizeSpellcheckColor('')).toBeUndefined();
  });
});

describe('resolveSpellcheckColor', () => {
  beforeEach(() => {
    resetSpellcheckColorWarningForTesting();
  });

  it('uses the configured color when it is one', () => {
    expect(resolveSpellcheckColor('ansi256(93)', 'red')).toBe('ansi256(93)');
  });

  it('falls back to the theme when the configured color is not', () => {
    expect(resolveSpellcheckColor('notacolor', '#e06c75')).toBe('#e06c75');
  });

  it('normalizes the theme fallback too', () => {
    // The ANSI themes hand out bare Ink names, which would render unstyled.
    expect(resolveSpellcheckColor(undefined, 'red')).toBe('ansi:red');
  });

  it('has no color to offer when the theme has none', () => {
    expect(resolveSpellcheckColor(undefined, '')).toBeUndefined();
  });
});

describe('splitTextBySpellcheckSpans', () => {
  it('leaves text alone when nothing on the line is misspelled', () => {
    expect(splitTextBySpellcheckSpans('hello there', 0, undefined, [])).toEqual(
      [{ text: 'hello there', misspelled: false }],
    );
  });

  it('cuts the misspelled range out of the run', () => {
    expect(
      splitTextBySpellcheckSpans('say helo now', 0, undefined, [[4, 8]]),
    ).toEqual([
      { text: 'say ', misspelled: false },
      { text: 'helo', misspelled: true },
      { text: ' now', misspelled: false },
    ]);
  });

  it('handles a misspelling at the very start and end', () => {
    expect(splitTextBySpellcheckSpans('helo', 0, undefined, [[0, 4]])).toEqual([
      { text: 'helo', misspelled: true },
    ]);
  });

  it('offsets by where the run starts in the line', () => {
    // The second visual row of a wrapped line starts at transformed column 6.
    expect(splitTextBySpellcheckSpans('wrold', 6, undefined, [[6, 11]])).toEqual(
      [{ text: 'wrold', misspelled: true }],
    );
  });

  it('follows the map when text is collapsed on the line', () => {
    // "[Img] helo": the placeholder occupies 5 transformed columns that stand
    // for 20 logical ones, so the word's logical span is far to the right.
    const transformedToLogical = [
      0, 0, 0, 0, 0, 20, 21, 22, 23, 24,
    ];
    expect(
      splitTextBySpellcheckSpans(
        '[Img] helo',
        0,
        transformedToLogical,
        [[21, 25]],
      ),
    ).toEqual([
      { text: '[Img] ', misspelled: false },
      { text: 'helo', misspelled: true },
    ]);
  });

  it('measures in code points, not UTF-16 units', () => {
    expect(
      splitTextBySpellcheckSpans('🙂 helo', 0, undefined, [[2, 6]]),
    ).toEqual([
      { text: '🙂 ', misspelled: false },
      { text: 'helo', misspelled: true },
    ]);
  });
});

// --- the hook itself ------------------------------------------------------

function settingsFile(spellcheck?: Settings['spellcheck']): SettingsFile {
  return {
    path: '/settings.json',
    settings: (spellcheck === undefined ? {} : { spellcheck }) as Settings,
    originalSettings: {} as Settings,
  };
}

function settingsSource(
  spellcheck?: Settings['spellcheck'],
): SpellcheckSettingsSource {
  return {
    user: settingsFile(spellcheck),
    project: settingsFile(),
    local: settingsFile(),
    flag: settingsFile(),
  };
}

function fakeBuffer(text: string, cursor: [number, number]): TextBuffer {
  return {
    text,
    lines: text.split('\n'),
    cursor,
  } as unknown as TextBuffer;
}

const spawnFn = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnFn };
});

describe('useSpellcheckHighlights', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    spawnFn.mockClear();
    resetSpellcheckCheckerForTesting();
    resetSpellcheckSettingsWarningsForTesting();
    resetSpellcheckColorWarningForTesting();
  });

  afterEach(() => {
    resetSpellcheckCheckerForTesting();
    vi.useRealTimers();
  });

  it('does nothing at all while the setting is off', async () => {
    const { result } = await renderHook(() =>
      useSpellcheckHighlights({
        buffer: fakeBuffer('helo wrold', [0, 0]),
        active: true,
        settings: settingsSource(),
      }),
    );

    expect(result.current.spansByLine.size).toBe(0);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('does not start a checker while rendering', async () => {
    // Enabling it is not by itself permission to spawn during a render; the
    // process is started from an effect, after the tree is committed.
    await renderHook(() =>
      useSpellcheckHighlights({
        buffer: fakeBuffer('helo wrold', [0, 0]),
        active: true,
        settings: settingsSource({
          enabled: true,
          checker: 'aspell',
        }),
      }),
    );

    // The PATH lookup is async, so nothing can have spawned synchronously.
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('produces no spans until verdicts come back', async () => {
    const { result } = await renderHook(() =>
      useSpellcheckHighlights({
        buffer: fakeBuffer('helo wrold', [0, 0]),
        active: true,
        settings: settingsSource({ enabled: true }),
      }),
    );

    expect(result.current.spansByLine.size).toBe(0);
  });

  it('uses the configured color', async () => {
    const { result } = await renderHook(() =>
      useSpellcheckHighlights({
        buffer: fakeBuffer('helo', [0, 0]),
        active: true,
        settings: settingsSource({ enabled: true, color: 'ansi256(93)' }),
      }),
    );

    expect(result.current.color).toBe('ansi256(93)');
  });

  it('goes quiet when the prompt stops being a place for prose', async () => {
    const { result, rerender } = await renderHook(
      ({ active }: { active: boolean }) =>
        useSpellcheckHighlights({
          buffer: fakeBuffer('helo wrold', [0, 10]),
          active,
          settings: settingsSource({ enabled: true }),
        }),
      { initialProps: { active: true } },
    );

    rerender({ active: false });
    expect(result.current.spansByLine.size).toBe(0);
    expect(result.current.color).toBeUndefined();
  });

  it('cancels its pending request on unmount', async () => {
    const { unmount } = await renderHook(() =>
      useSpellcheckHighlights({
        buffer: fakeBuffer('helo wrold', [0, 0]),
        active: true,
        settings: settingsSource({ enabled: true }),
      }),
    );

    unmount();

    // Nothing left to fire: a pending debounce would reach the checker here.
    vi.advanceTimersByTime(10_000);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('keeps the checker across an unmount', async () => {
    // The prompt is unmounted and remounted as a matter of course — `Composer`
    // only renders it while the input is active, so every slash command takes
    // it away. Tearing the process down with it would kill aspell and throw
    // away every verdict several times a session.
    const view = await renderHook(() =>
      useSpellcheckHighlights({
        buffer: fakeBuffer('helo wrold', [0, 0]),
        active: true,
        settings: settingsSource({ enabled: true }),
      }),
    );
    const before = getSpellcheckCheckerForTesting();
    expect(before).not.toBeNull();

    view.unmount();
    expect(getSpellcheckCheckerForTesting()).toBe(before);

    const remounted = await renderHook(() =>
      useSpellcheckHighlights({
        buffer: fakeBuffer('helo wrold', [0, 0]),
        active: true,
        settings: settingsSource({ enabled: true }),
      }),
    );
    expect(getSpellcheckCheckerForTesting()).toBe(before);
    remounted.unmount();
  });

  it('replaces the checker when the dictionary changes', async () => {
    const { rerender } = await renderHook(
      ({ language }: { language: string }) =>
        useSpellcheckHighlights({
          buffer: fakeBuffer('helo', [0, 0]),
          active: true,
          settings: settingsSource({ enabled: true, language }),
        }),
      { initialProps: { language: 'en_US' } },
    );
    const first = getSpellcheckCheckerForTesting();

    rerender({ language: 'en_GB' });

    // A different dictionary can disagree about the same word, so the verdicts
    // cannot carry over.
    const second = getSpellcheckCheckerForTesting();
    expect(second).not.toBe(first);
    expect(second).not.toBeNull();
  });

  it('drops the checker when the setting is turned off', async () => {
    const { rerender } = await renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useSpellcheckHighlights({
          buffer: fakeBuffer('helo', [0, 0]),
          active: true,
          settings: settingsSource({ enabled }),
        }),
      { initialProps: { enabled: true } },
    );
    expect(getSpellcheckCheckerForTesting()).not.toBeNull();

    rerender({ enabled: false });
    expect(getSpellcheckCheckerForTesting()).toBeNull();
  });
});
