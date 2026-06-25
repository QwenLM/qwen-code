import { describe, expect, it } from 'vitest';
import { nextSettingIdx, type FlatRow } from './SettingsMessage';
import type { DaemonSettingDescriptor } from '@qwen-code/webui/daemon-react-sdk';

function setting(key: string): DaemonSettingDescriptor {
  return {
    key,
    type: 'boolean',
    label: key,
    category: 'test',
    requiresRestart: false,
    default: false,
    values: { effective: false },
  };
}

/** 'h' → category header row, 's' → setting row. */
function rowsOf(spec: string): FlatRow[] {
  return [...spec].map((ch, i) =>
    ch === 'h'
      ? { type: 'header', category: `cat-${i}` }
      : { type: 'setting', setting: setting(`setting-${i}`) },
  );
}

describe('nextSettingIdx', () => {
  it('moves to the next setting going down', () => {
    expect(nextSettingIdx(rowsOf('hsss'), 1, 1)).toBe(2);
  });

  it('moves to the previous setting going up', () => {
    expect(nextSettingIdx(rowsOf('hsss'), 2, -1)).toBe(1);
  });

  it('wraps from the last setting to the first on ArrowDown', () => {
    // Wrapping passes over the leading header at index 0.
    expect(nextSettingIdx(rowsOf('hsss'), 3, 1)).toBe(1);
  });

  it('wraps from the first setting to the last on ArrowUp', () => {
    expect(nextSettingIdx(rowsOf('hsss'), 1, -1)).toBe(3);
  });

  it('skips category headers in the middle of the list', () => {
    expect(nextSettingIdx(rowsOf('hshs'), 1, 1)).toBe(3);
    expect(nextSettingIdx(rowsOf('hshs'), 3, -1)).toBe(1);
  });

  it('stays put on a single-setting list in both directions', () => {
    expect(nextSettingIdx(rowsOf('hs'), 1, 1)).toBe(1);
    expect(nextSettingIdx(rowsOf('hs'), 1, -1)).toBe(1);
  });

  it('returns current when rows is empty', () => {
    expect(nextSettingIdx([], 0, 1)).toBe(0);
    expect(nextSettingIdx([], 5, -1)).toBe(5);
  });

  it('returns current when there are no setting rows at all', () => {
    expect(nextSettingIdx(rowsOf('hh'), 0, 1)).toBe(0);
  });

  it('finds the last setting when entering from past the end (selection normalization)', () => {
    // Mirrors the normalization call nextSettingIdx(rows, rows.length, -1).
    const rows = rowsOf('hssh');
    expect(nextSettingIdx(rows, rows.length, -1)).toBe(2);
  });

  it('finds the first setting when entering from before the start (selection normalization)', () => {
    // Mirrors the normalization call nextSettingIdx(rows, selectedIdx - 1, 1)
    // with selectedIdx = 0.
    expect(nextSettingIdx(rowsOf('hsss'), -1, 1)).toBe(1);
  });
});
