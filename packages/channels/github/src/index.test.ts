import { describe, expect, it } from 'vitest';
import { PR_BINDING_ROLES } from '@qwen-code/channel-base';
import { plugin } from './index.js';
import {
  PR_NOTIFICATION_REASONS,
  PR_WATCH_EVENTS,
  REPO_FILTER_MODES,
} from './GithubAdapter.js';

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

  it('requires deliverToBoundSessions for the watch budget reserve', () => {
    expect(validate({ prWatchBudgetReserve: 300 })).toContain(
      'prWatchBudgetReserve',
    );
    expect(
      validate({ deliverToBoundSessions: true, prWatchBudgetReserve: 300 }),
    ).toBeUndefined();
  });

  it('declares the reserve floor inclusively instead of an exclusive -1', () => {
    // exclusiveMinimum: -1 was the only way to admit 0 before the vocabulary
    // had an inclusive bound, and it also admitted (-1, 0) — the editor took
    // -0.5 and the save failed. Pin the descriptor, not just the validator.
    const reserve = plugin.management?.fields?.find(
      (field) => field.key === 'prWatchBudgetReserve',
    );
    expect(reserve).toBeDefined();
    expect(reserve).toMatchObject({ kind: 'number', minimum: 0 });
    expect(
      (reserve as { exclusiveMinimum?: number }).exclusiveMinimum,
    ).toBeUndefined();
  });

  it('rejects a reserve the getter would silently default', () => {
    // The descriptor declares minimum: 0, so the editor refuses these when
    // they are typed. The adapter check is the backstop for everything else
    // (hand-edited settings.json, a daemon API call, a stored negative re-sent
    // unchanged): a negative must be refused rather than becoming the
    // default 200.
    for (const reserve of [-0.5, -1, 'abc', Number.NaN]) {
      expect(
        validate({
          deliverToBoundSessions: true,
          prWatchBudgetReserve: reserve,
        }),
      ).toContain('must be a non-negative number');
    }
    // 0 disables, and a positive fraction is rounded up by the getter — both
    // stay legal.
    expect(
      validate({ deliverToBoundSessions: true, prWatchBudgetReserve: 0 }),
    ).toBeUndefined();
    expect(
      validate({ deliverToBoundSessions: true, prWatchBudgetReserve: 200.5 }),
    ).toBeUndefined();
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

  it('accepts the default-on prCommentWatch without bound delivery', () => {
    // The editor emits the descriptor default (true) even for channels that
    // never enable bound delivery; it is inert there, not a validation error.
    expect(validate({ prCommentWatch: true })).toBeUndefined();
    expect(validate({ prCommentWatch: false })).toBeUndefined();
    expect(
      validate({ deliverToBoundSessions: true, prCommentWatch: true }),
    ).toBeUndefined();
  });

  it('rejects a non-boolean prCommentWatch', () => {
    expect(validate({ prCommentWatch: 'yes' })).toContain(
      'prCommentWatch must be a boolean',
    );
  });

  it('defaults prCommentWatch to enabled in the management descriptor', () => {
    const field = plugin.management?.fields.find(
      (candidate) => candidate.key === 'prCommentWatch',
    );
    expect(field?.kind).toBe('boolean');
    expect(field?.default).toBe('true');
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

  it('builds the repoFilterMode UI options from the adapter vocabulary', () => {
    const field = plugin.management?.fields.find(
      (candidate) => candidate.key === 'repoFilterMode',
    );
    // The settings store's enum branch requires membership in this option
    // list, and the editor always submits the seeded value: dropping options
    // or a mode would reject every Web Shell save with no other test red.
    expect(field?.options?.map((option) => option.value)).toEqual([
      ...REPO_FILTER_MODES,
    ]);
    expect(field?.default).toBe('off');
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
