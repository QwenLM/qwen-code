import { describe, expect, it } from 'vitest';
import { PR_BINDING_ROLES } from '@qwen-code/channel-base';
import { plugin } from './index.js';
import { PR_NOTIFICATION_REASONS, PR_WATCH_EVENTS } from './GithubAdapter.js';

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

  it('builds the prWatchEvents UI options from the adapter vocabulary (R2-18)', () => {
    const field = plugin.management?.fields.find(
      (candidate) => candidate.key === 'prWatchEvents',
    );
    // The UI option list must equal the exported constant the validator and
    // emit path use, so editing either literal alone goes red here.
    expect(field?.options?.map((option) => option.value)).toEqual([
      ...PR_WATCH_EVENTS,
    ]);
  });

  it('describes and groups every boundSessionActions key for management UIs', () => {
    const field = plugin.management?.fields.find(
      (candidate) => candidate.key === 'boundSessionActions',
    );
    const options = field?.options ?? [];
    const baseCount =
      1 + PR_WATCH_EVENTS.length + PR_NOTIFICATION_REASONS.length;
    expect(options).toHaveLength(baseCount * (1 + PR_BINDING_ROLES.length));
    expect(new Set(options.map((option) => option.value)).size).toBe(
      options.length,
    );
    expect([...new Set(options.map((option) => option.group))]).toEqual([
      'any',
      ...PR_BINDING_ROLES,
    ]);
    const byValue = new Map(options.map((option) => [option.value, option]));
    for (const option of options) {
      expect(option.description).toBeTruthy();
      // Role-qualified keys reuse their base event's description; the role's
      // meaning is carried by the picker group header instead.
      const base = option.value.replace(/^(review|verify|fix):/, '');
      expect(option.description).toBe(byValue.get(base)?.description);
    }
  });
});
