import { describe, expect, it } from 'vitest';
import { plugin } from './index.js';

function validate(overrides: Record<string, unknown>): string | undefined {
  return plugin.management?.validateConfig?.({
    token: 'test-token',
    ...overrides,
  });
}

describe('github plugin validateConfig', () => {
  it('accepts a minimal token config', () => {
    expect(validate({})).toBeUndefined();
  });

  it('requires a token or local gh authentication', () => {
    expect(validate({ token: '' })).toContain(
      'requires a token or local GitHub CLI authentication',
    );
    expect(validate({ token: '', useLocalGh: true })).toBeUndefined();
  });

  it('rejects a non-boolean deliverToBoundSessions', () => {
    expect(validate({ deliverToBoundSessions: 'yes' })).toContain(
      'deliverToBoundSessions must be a boolean',
    );
  });

  it('rejects a non-array prWatchEvents', () => {
    expect(
      validate({ deliverToBoundSessions: true, prWatchEvents: 'ci_failure' }),
    ).toContain('prWatchEvents');
  });

  it('rejects unknown watch events', () => {
    expect(
      validate({
        deliverToBoundSessions: true,
        prWatchEvents: ['ci_failure', 'pushed'],
      }),
    ).toContain('pushed');
  });

  it('requires deliverToBoundSessions for watch events', () => {
    expect(validate({ prWatchEvents: ['ci_failure'] })).toContain(
      'requires deliverToBoundSessions',
    );
  });

  it('accepts the full watch vocabulary, case-insensitively', () => {
    expect(
      validate({
        deliverToBoundSessions: true,
        prWatchEvents: [
          'CI_FAILURE',
          ' merge_conflict ',
          'head_change',
          'state_change',
        ],
      }),
    ).toBeUndefined();
  });

  it('accepts an empty watch list without delivery', () => {
    expect(validate({ prWatchEvents: [] })).toBeUndefined();
  });
});
