import { describe, expect, it } from 'vitest';
import {
  CHANNEL_OUTPUT_MODE_FIELD,
  DEFAULT_CHANNEL_OUTPUT_MODE,
  parseChannelOutputMode,
} from './output-mode.js';

describe('channel output mode', () => {
  it('defaults only opted-in adapters to per turn', () => {
    expect(DEFAULT_CHANNEL_OUTPUT_MODE).toBe('per_turn');
    expect(parseChannelOutputMode('bot', undefined, true)).toBe('per_turn');
    expect(parseChannelOutputMode('bot', undefined, false)).toBeUndefined();
  });

  it('publishes the three modes with the runtime default', () => {
    expect(CHANNEL_OUTPUT_MODE_FIELD.default).toBe('per_turn');
    expect(CHANNEL_OUTPUT_MODE_FIELD.options.map(({ value }) => value)).toEqual(
      ['per_task', 'per_response', 'per_turn'],
    );
  });

  it.each(['per_task', 'per_response', 'per_turn'])(
    'accepts %s only on an opted-in adapter',
    (mode) => {
      expect(parseChannelOutputMode('bot', mode, true)).toBe(mode);
      expect(() => parseChannelOutputMode('bot', mode, false)).toThrow(
        'Channel "bot" does not support outputMode.',
      );
    },
  );

  it.each([
    'final_only',
    'process_and_result',
    'all',
    '',
    null,
    false,
    1,
    '$OUTPUT_MODE',
  ])('rejects invalid or unpublished mode %j', (mode) => {
    expect(() => parseChannelOutputMode('bot', mode, true)).toThrow(
      'Channel "bot" outputMode must be "per_task", "per_response", or "per_turn".',
    );
  });
});
