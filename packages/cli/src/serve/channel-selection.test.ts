import { describe, expect, it } from 'vitest';
import {
  channelSelectionNames,
  normalizeServeChannelSelection,
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
});

describe('channelSelectionNames', () => {
  it('returns the pidfile and worker channel names for a selection', () => {
    const names = ['telegram', 'feishu'];

    expect(channelSelectionNames({ mode: 'all' })).toEqual(['all']);
    expect(channelSelectionNames({ mode: 'names', names })).toEqual(names);
    expect(channelSelectionNames({ mode: 'names', names })).not.toBe(names);
  });
});
