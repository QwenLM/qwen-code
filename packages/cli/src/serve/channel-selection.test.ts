import { describe, expect, it } from 'vitest';
import {
  channelSelectionNames,
  isAllChannelSelectionName,
  normalizeServeChannelSelection,
  normalizeStoredServeChannelNames,
} from './channel-selection.js';

describe('normalizeServeChannelSelection', () => {
  it('returns undefined when no channel flag is provided', () => {
    expect(normalizeServeChannelSelection(undefined)).toBeUndefined();
    expect(normalizeServeChannelSelection([])).toBeUndefined();
  });

  it('trims and de-duplicates repeated channel names', () => {
    expect(
      normalizeServeChannelSelection([' telegram ', 'feishu', 'telegram']),
    ).toEqual({
      mode: 'names',
      names: ['telegram', 'feishu'],
    });
  });

  it('parses trimmed all as a dedicated selection mode', () => {
    expect(normalizeServeChannelSelection([' all '])).toEqual({ mode: 'all' });
  });

  it('rejects empty channel values', () => {
    expect(() => normalizeServeChannelSelection(['telegram', ' '])).toThrow(
      '--channel requires a non-empty channel name.',
    );
  });

  it('rejects all mixed with explicit channel names', () => {
    expect(() => normalizeServeChannelSelection(['all', 'telegram'])).toThrow(
      '--channel all cannot be combined with channel names.',
    );
  });

  it.each(['\u001b[31m', '\u009b31m', '\u202eabc', '\u2028', '\ufe0f'])(
    'rejects unsafe channel name %j with a single-line diagnostic',
    (name) => {
      expect(() => normalizeServeChannelSelection([name])).toThrow(
        '--channel channel name',
      );
      try {
        normalizeServeChannelSelection([name]);
      } catch (error) {
        expect(String(error)).not.toContain(name);
        expect(String(error)).not.toContain('\u001b');
      }
    },
  );

  it('uses the caller label without rewriting the error text', () => {
    expect(() =>
      normalizeServeChannelSelection(['all', 'telegram'], {
        label: 'serve.channels',
      }),
    ).toThrow('serve.channels all cannot be combined with channel names.');
  });

  it('drops unsafe stored names while preserving valid names', () => {
    expect(
      normalizeStoredServeChannelNames([' ', '--insecure', ' telegram ']),
    ).toEqual({ names: ['telegram'], rejected: [' ', '--insecure'] });
  });
});

describe('isAllChannelSelectionName', () => {
  it('recognizes the trimmed all sentinel only', () => {
    expect(isAllChannelSelectionName(' all ')).toBe(true);
    expect(isAllChannelSelectionName('allx')).toBe(false);
  });
});

describe('channelSelectionNames', () => {
  it('returns the pidfile and worker channel names for a selection', () => {
    const names = ['telegram', 'feishu'];

    expect(channelSelectionNames({ mode: 'all' })).toEqual(['all']);
    expect(channelSelectionNames({ mode: 'names', names })).toEqual(names);
    expect(channelSelectionNames({ mode: 'names', names })).not.toBe(names);
  });
});
