/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  resolveSessionPrWatchConfig,
  SESSION_PR_WATCH_EVENTS_ENV,
  SESSION_PR_WATCH_WAKE_DORMANT_ENV,
} from './pr-watch-config.js';

describe('resolveSessionPrWatchConfig', () => {
  it('is off by default: no events, wakeDormant on, no actions', () => {
    const config = resolveSessionPrWatchConfig(undefined, {});
    expect(config.events.size).toBe(0);
    expect(config.wakeDormant).toBe(true);
    expect(config.actions).toBeUndefined();
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

  it('warns and falls back to off for an unrecognized transition type', () => {
    const onWarning = vi.fn();
    const config = resolveSessionPrWatchConfig(
      { events: ['head_change', 'not_a_type'] },
      {},
      onWarning,
    );
    // The whole list falls back, not just the bad member: a partial
    // subscription the operator did not write is worse than none.
    expect(config.events.size).toBe(0);
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning.mock.calls[0]?.[0]).toContain('not_a_type');
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
    // 1000 astral characters are 2000 UTF-16 units but only 1000 code points.
    const config = resolveSessionPrWatchConfig(
      { actions: { head_change: '𠮷'.repeat(1000) } },
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
