/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  prWatchChannelsSignature,
  resolvePrWatchSubscription,
  resolveSessionPrWatchConfig,
  SESSION_PR_WATCH_EVENTS_ENV,
  SESSION_PR_WATCH_WAKE_DORMANT_ENV,
  type HostedGithubChannel,
} from './pr-watch-config.js';

describe('resolveSessionPrWatchConfig', () => {
  it('is off by default: no events, wakeDormant on, no actions', () => {
    const config = resolveSessionPrWatchConfig(undefined, {});
    expect(config.events.size).toBe(0);
    expect(config.explicit).toBe(false);
    expect(config.wakeDormant).toBe(true);
    expect(config.actions).toBeUndefined();
  });

  it('counts an empty setting as an explicit opt-out of the alias', () => {
    // The alias is a migration path, not a default. An operator who writes
    // the key subscribes exactly what it says, including nothing.
    expect(resolveSessionPrWatchConfig({}, {}).explicit).toBe(true);
  });

  it('counts a non-blank events override as explicit', () => {
    const config = resolveSessionPrWatchConfig(undefined, {
      [SESSION_PR_WATCH_EVENTS_ENV]: 'head_change',
    });
    expect(config.explicit).toBe(true);
  });

  it('does not count a blank events override as explicit', () => {
    // Blank means "unset" in templated env files, as it does above; it must
    // not disable the alias.
    const config = resolveSessionPrWatchConfig(undefined, {
      [SESSION_PR_WATCH_EVENTS_ENV]: '   ',
    });
    expect(config.explicit).toBe(false);
  });

  it('reads the subscribed events from settings', () => {
    const config = resolveSessionPrWatchConfig(
      { events: ['head_change', 'ci_failure'] },
      {},
    );
    expect([...config.events].sort()).toEqual(['ci_failure', 'head_change']);
  });

  it('lets the environment override the settings events', () => {
    const config = resolveSessionPrWatchConfig(
      { events: ['head_change'] },
      { [SESSION_PR_WATCH_EVENTS_ENV]: 'state_change' },
    );
    expect([...config.events]).toEqual(['state_change']);
  });

  it('splits a comma-separated environment list and trims each entry', () => {
    const config = resolveSessionPrWatchConfig(undefined, {
      [SESSION_PR_WATCH_EVENTS_ENV]: ' head_change , merge_conflict ',
    });
    expect([...config.events].sort()).toEqual([
      'head_change',
      'merge_conflict',
    ]);
  });

  it('ignores a trailing comma rather than invalidating the list', () => {
    const config = resolveSessionPrWatchConfig(undefined, {
      [SESSION_PR_WATCH_EVENTS_ENV]: 'head_change,',
    });
    expect([...config.events]).toEqual(['head_change']);
  });

  it('falls back to settings when the environment value is blank', () => {
    // Blank means "unset" in templated env files, as it does for the refresh
    // interval; it must not silently turn the watch off.
    const config = resolveSessionPrWatchConfig(
      { events: ['head_change'] },
      { [SESSION_PR_WATCH_EVENTS_ENV]: '   ' },
    );
    expect([...config.events]).toEqual(['head_change']);
  });

  it('drops only the unrecognized transition type', () => {
    const onWarning = vi.fn();
    const config = resolveSessionPrWatchConfig(
      { events: ['head_change', 'not_a_type'] },
      {},
      onWarning,
    );
    // A bad member narrows the watch; emptying the list would silence it
    // while `explicit` still suppresses the deprecated alias.
    expect([...config.events]).toEqual(['head_change']);
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning.mock.calls[0]?.[0]).toContain('not_a_type');
  });

  it('still falls back to off when every member is unrecognized', () => {
    const onWarning = vi.fn();
    const config = resolveSessionPrWatchConfig(
      { events: ['not_a_type', 'also_bad'] },
      {},
      onWarning,
    );
    expect(config.events.size).toBe(0);
    expect(onWarning).toHaveBeenCalledTimes(2);
  });

  it('folds case like the channel alias does', () => {
    const config = resolveSessionPrWatchConfig(
      { events: ['HEAD_CHANGE', ' Ci_Failure '] },
      {},
    );
    expect([...config.events]).toEqual(['head_change', 'ci_failure']);
  });

  it('warns about an unknown sub-key instead of going explicit with nothing', () => {
    const onWarning = vi.fn();
    const config = resolveSessionPrWatchConfig(
      { event: ['head_change'] },
      {},
      onWarning,
    );
    expect(config.events.size).toBe(0);
    expect(config.explicit).toBe(true);
    expect(onWarning.mock.calls[0]?.[0]).toContain(
      'unknown serve.sessionPrWatch.event',
    );
  });

  it('warns and falls back to off when events is not a list', () => {
    const onWarning = vi.fn();
    const config = resolveSessionPrWatchConfig(
      { events: 'head_change' },
      {},
      onWarning,
    );
    expect(config.events.size).toBe(0);
    expect(onWarning).toHaveBeenCalledTimes(1);
  });

  it('reads wakeDormant from settings', () => {
    expect(
      resolveSessionPrWatchConfig({ wakeDormant: false }, {}).wakeDormant,
    ).toBe(false);
  });

  it.each([
    ['0', false],
    ['false', false],
    ['FALSE', false],
    ['1', true],
    ['true', true],
  ])('lets the environment set wakeDormant from %s', (raw, expected) => {
    const config = resolveSessionPrWatchConfig(
      { wakeDormant: !expected },
      { [SESSION_PR_WATCH_WAKE_DORMANT_ENV]: raw },
    );
    expect(config.wakeDormant).toBe(expected);
  });

  it('warns and keeps the default for an unparseable wakeDormant', () => {
    const onWarning = vi.fn();
    const config = resolveSessionPrWatchConfig(
      undefined,
      { [SESSION_PR_WATCH_WAKE_DORMANT_ENV]: 'maybe' },
      onWarning,
    );
    expect(config.wakeDormant).toBe(true);
    expect(onWarning).toHaveBeenCalledTimes(1);
  });

  it('resolves action templates, role prefixes included', () => {
    const config = resolveSessionPrWatchConfig(
      {
        events: ['head_change'],
        actions: {
          head_change: 'Rebase onto the base branch.',
          'review:ci_failure': 'Attribute the failure.',
          default: 'Look at the PR.',
        },
      },
      {},
    );
    expect(config.actions?.get('head_change')).toBe(
      'Rebase onto the base branch.',
    );
    expect(config.actions?.get('review:ci_failure')).toBe(
      'Attribute the failure.',
    );
    expect(config.actions?.get('default')).toBe('Look at the PR.');
  });

  it('leaves actions absent so delivery stays on the legacy single winner', () => {
    const config = resolveSessionPrWatchConfig({ events: ['head_change'] }, {});
    expect(config.actions).toBeUndefined();
  });

  it('refuses an unrecognized action key', () => {
    expect(() =>
      resolveSessionPrWatchConfig({ actions: { bogus_key: 'x' } }, {}),
    ).toThrow(/Unrecognized serve\.sessionPrWatch\.actions key/);
  });

  it('refuses the channel watch: prefix, which the daemon vocabulary lacks', () => {
    expect(() =>
      resolveSessionPrWatchConfig(
        { actions: { 'watch:head_change': 'x' } },
        {},
      ),
    ).toThrow(/Unrecognized/);
  });

  it('refuses an empty template', () => {
    expect(() =>
      resolveSessionPrWatchConfig({ actions: { head_change: '   ' } }, {}),
    ).toThrow(/non-empty instruction template/);
  });

  it('refuses a template over 2000 code points', () => {
    expect(() =>
      resolveSessionPrWatchConfig(
        { actions: { head_change: 'x'.repeat(2001) } },
        {},
      ),
    ).toThrow(/exceeds 2000 code points/);
  });

  it('accepts a template of exactly 2000 code points', () => {
    const config = resolveSessionPrWatchConfig(
      { actions: { head_change: 'x'.repeat(2000) } },
      {},
    );
    expect(config.actions?.get('head_change')).toHaveLength(2000);
  });

  it('counts code points, not UTF-16 units', () => {
    // 1001 astral characters are 1001 code points (accepted) but 2002 UTF-16
    // units (rejected by a `.length` implementation). 1000 would be exactly
    // 2000 units and pass under both metrics, so it witnesses nothing.
    const config = resolveSessionPrWatchConfig(
      { actions: { head_change: '𠮷'.repeat(1001) } },
      {},
    );
    expect(config.actions?.get('head_change')).toBeDefined();
  });

  it('refuses a non-object actions value', () => {
    expect(() =>
      resolveSessionPrWatchConfig({ actions: ['head_change'] }, {}),
    ).toThrow(/must be an object mapping event keys/);
  });
});

function channel(
  overrides: Partial<HostedGithubChannel> = {},
): HostedGithubChannel {
  return {
    name: 'gh',
    host: 'github.com',
    prWatchEvents: ['head_change'],
    deliverToBoundSessions: true,
    ...overrides,
  };
}

const OFF = resolveSessionPrWatchConfig(undefined, {});

describe('resolvePrWatchSubscription', () => {
  it('applies an explicit setting to every host and ignores the alias', () => {
    const explicit = resolveSessionPrWatchConfig(
      { events: ['state_change'], actions: { state_change: 'handle it' } },
      {},
    );
    const sub = resolvePrWatchSubscription(explicit, [channel()]);
    expect([...sub.eventsForHost('github.com')]).toEqual(['state_change']);
    // An explicit setting is daemon-wide, not per host: the alias's host
    // narrowing must not leak into it.
    expect([...sub.eventsForHost('ghe.example.com')]).toEqual(['state_change']);
    expect(
      sub.actionsForEvent('state_change', 'github.com')?.get('state_change'),
    ).toBe('handle it');
    expect(sub.anyEvents).toBe(true);
  });

  it('lets an explicit empty setting opt out of the alias', () => {
    const explicit = resolveSessionPrWatchConfig({}, {});
    const sub = resolvePrWatchSubscription(explicit, [channel()]);
    expect(sub.anyEvents).toBe(false);
    expect(sub.eventsForHost('github.com').size).toBe(0);
  });

  it('keeps an explicit empty actions map role-aware', () => {
    // The drain treats any map as role-aware: `{}` means "no role subscribed"
    // and drops the entry, so it must not collapse to the legacy winner.
    const explicit = resolveSessionPrWatchConfig(
      { events: ['head_change'], actions: {} },
      {},
    );
    const map = resolvePrWatchSubscription(explicit, []).actionsForEvent(
      'head_change',
      'github.com',
    );
    expect(map).toEqual(new Map());
  });

  it('returns the empty actions map for a type the host no longer subscribes', () => {
    // undefined is the legacy single winner. A pending entry for a type that
    // was just unsubscribed must drop, not wake a session with a generic
    // prompt.
    const sub = resolvePrWatchSubscription(OFF, [
      channel({ prWatchEvents: ['head_change'] }),
    ]);
    expect(sub.actionsForEvent('ci_failure', 'github.com')).toEqual(new Map());
    expect(sub.actionsForEvent('head_change', 'github.com')).toBeUndefined();
  });

  it('keys the alias by host and unions the events of one host', () => {
    const sub = resolvePrWatchSubscription(OFF, [
      channel({ prWatchEvents: ['head_change', 'ci_failure'] }),
      channel({ name: 'second', prWatchEvents: ['merge_conflict'] }),
      channel({
        name: 'ghe',
        host: 'ghe.example.com',
        prWatchEvents: ['state_change'],
      }),
    ]);
    expect([...sub.eventsForHost('github.com')].sort()).toEqual([
      'ci_failure',
      'head_change',
      'merge_conflict',
    ]);
    expect([...sub.eventsForHost('ghe.example.com')]).toEqual(['state_change']);
    // A host no channel covers subscribes nothing, so its PRs cost no view.
    expect(sub.eventsForHost('other.example.com').size).toBe(0);
    expect(sub.anyEvents).toBe(true);
  });

  it('strips the watch: prefix and keeps default keys', () => {
    const sub = resolvePrWatchSubscription(OFF, [
      channel({
        prWatchEvents: ['head_change'],
        boundSessionActions: {
          'watch:head_change': 'bare',
          'review:watch:head_change': 'review',
          default: 'fallback',
          'fix:default': 'fix fallback',
          'review:comment': 'not a watch key',
        },
      }),
    ]);
    const actions = sub.actionsForEvent('head_change', 'github.com')!;
    expect([...actions.entries()].sort()).toEqual([
      ['default', 'fallback'],
      ['fix:default', 'fix fallback'],
      ['head_change', 'bare'],
      ['review:head_change', 'review'],
    ]);
  });

  it('keeps a role-aware channel role-aware when no key matches', () => {
    const sub = resolvePrWatchSubscription(OFF, [
      channel({ boundSessionActions: { 'review:comment': 'not watch' } }),
    ]);
    expect(sub.anyEvents).toBe(true);
    const actions = sub.actionsForEvent('head_change', 'github.com');
    // An empty map, not undefined: the single winner would deliver to every
    // binder, while the channel subscribed no role to this type.
    expect(actions).toBeInstanceOf(Map);
    expect(actions!.size).toBe(0);
  });

  it('treats an empty channel action map as the single winner', () => {
    const sub = resolvePrWatchSubscription(OFF, [
      channel({ boundSessionActions: {} }),
    ]);
    expect(sub.actionsForEvent('head_change', 'github.com')).toBeUndefined();
  });

  it('takes a type from the first deliverable channel by name and logs the conflict', () => {
    const logs: string[] = [];
    const sub = resolvePrWatchSubscription(
      OFF,
      [
        channel({
          name: 'zeta',
          boundSessionActions: { 'review:watch:head_change': 'zeta' },
        }),
        channel({
          name: 'alpha',
          boundSessionActions: { 'review:watch:head_change': 'alpha' },
        }),
      ],
      (message) => logs.push(message),
    );
    expect(
      sub
        .actionsForEvent('head_change', 'github.com')
        ?.get('review:head_change'),
    ).toBe('alpha');
    expect(
      logs.some((line) => line.includes('alpha') && line.includes('zeta')),
    ).toBe(true);
  });

  it('skips a role-aware channel that cannot deliver a type', () => {
    // `alpha` subscribes both types but only has a head_change template;
    // `zeta` is the single winner and must take over ci_failure.
    const sub = resolvePrWatchSubscription(OFF, [
      channel({
        name: 'alpha',
        prWatchEvents: ['head_change', 'ci_failure'],
        boundSessionActions: { 'review:watch:head_change': 'review' },
      }),
      channel({ name: 'zeta', prWatchEvents: ['ci_failure'] }),
    ]);
    expect(
      sub
        .actionsForEvent('head_change', 'github.com')
        ?.get('review:head_change'),
    ).toBe('review');
    expect(sub.actionsForEvent('ci_failure', 'github.com')).toBeUndefined();
  });

  it('keeps a role-aware channel without a matching key when nothing delivers', () => {
    // No channel can deliver ci_failure: alpha is role-aware with no key, and
    // there is no single winner. The type stays watched but reaches nobody.
    const sub = resolvePrWatchSubscription(OFF, [
      channel({
        prWatchEvents: ['head_change', 'ci_failure'],
        boundSessionActions: { 'review:watch:head_change': 'review' },
      }),
    ]);
    expect(sub.anyEvents).toBe(true);
    const actions = sub.actionsForEvent('ci_failure', 'github.com');
    expect(actions).toBeInstanceOf(Map);
    expect(actions!.size).toBe(0);
  });

  it('ignores a channel without bound delivery', () => {
    const sub = resolvePrWatchSubscription(OFF, [
      channel({ deliverToBoundSessions: false }),
    ]);
    expect(sub.anyEvents).toBe(false);
    expect(sub.eventsForHost('github.com').size).toBe(0);
  });

  it('keeps the recognized members of an alias list', () => {
    const logs: string[] = [];
    const sub = resolvePrWatchSubscription(
      OFF,
      [channel({ prWatchEvents: ['head_change', 'not_a_type'] })],
      (message) => logs.push(message),
    );
    expect(sub.anyEvents).toBe(true);
    expect([...sub.eventsForHost('github.com')]).toEqual(['head_change']);
    expect(logs.some((line) => line.includes('not_a_type'))).toBe(true);
  });

  it('logs the alias once when it takes effect', () => {
    const logs: string[] = [];
    resolvePrWatchSubscription(OFF, [channel()], (message) =>
      logs.push(message),
    );
    expect(
      logs.filter((line) => line.includes('deprecated channel alias')),
    ).toHaveLength(1);
  });
});

describe('prWatchChannelsSignature', () => {
  it('is stable across order', () => {
    const a = channel({ name: 'a' });
    const b = channel({ name: 'b', host: 'ghe.example.com' });
    expect(prWatchChannelsSignature([a, b])).toBe(
      prWatchChannelsSignature([b, a]),
    );
  });

  it('changes when an action-only edit lands', () => {
    // A base-URL-only signature would miss exactly this edit, freezing the
    // alias until a restart.
    const before = prWatchChannelsSignature([channel()]);
    expect(
      prWatchChannelsSignature([
        channel({ boundSessionActions: { 'review:watch:head_change': 'x' } }),
      ]),
    ).not.toBe(before);
  });

  it('changes when the events or the bound-delivery switch change', () => {
    const base = prWatchChannelsSignature([channel()]);
    expect(
      prWatchChannelsSignature([channel({ prWatchEvents: ['ci_failure'] })]),
    ).not.toBe(base);
    expect(
      prWatchChannelsSignature([channel({ deliverToBoundSessions: false })]),
    ).not.toBe(base);
  });
});
