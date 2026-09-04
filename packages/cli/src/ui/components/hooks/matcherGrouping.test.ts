/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  HookEventName,
  HooksConfigSource,
  HookType,
} from '@qwen-code/qwen-code-core';
import type { HookEventDisplayInfo } from './types.js';
import {
  addConfigToMatcherGroup,
  getAllConfigs,
  normalizeMatcher,
} from './matcherGrouping.js';

function emptyHookInfo(): HookEventDisplayInfo {
  return {
    event: HookEventName.PreToolUse,
    shortDescription: '',
    description: '',
    exitCodes: [],
    matcherGroups: [],
  };
}

describe('normalizeMatcher', () => {
  it('returns "*" when matcher is undefined', () => {
    expect(normalizeMatcher(undefined)).toBe('*');
  });

  it('returns "*" when matcher is empty string', () => {
    expect(normalizeMatcher('')).toBe('*');
  });

  it('returns "*" when matcher is only whitespace', () => {
    expect(normalizeMatcher('   ')).toBe('*');
  });

  it('returns the trimmed matcher when set', () => {
    expect(normalizeMatcher(' Bash ')).toBe('Bash');
  });

  it('preserves regex-style matchers', () => {
    expect(normalizeMatcher('Edit|Write')).toBe('Edit|Write');
  });
});

describe('addConfigToMatcherGroup', () => {
  it('creates a new group for an unseen matcher', () => {
    const info = emptyHookInfo();

    addConfigToMatcherGroup(info, 'Bash', undefined, {
      config: { type: HookType.Command, command: '/x.sh' },
      source: HooksConfigSource.User,
      sourceDisplay: 'User Settings',
      enabled: true,
    });

    expect(info.matcherGroups).toHaveLength(1);
    expect(info.matcherGroups[0].matcher).toBe('Bash');
    expect(info.matcherGroups[0].configs).toHaveLength(1);
    expect(getAllConfigs(info)).toHaveLength(1);
  });

  it('reuses the existing group for the same matcher', () => {
    const info = emptyHookInfo();

    addConfigToMatcherGroup(info, 'Bash', undefined, {
      config: { type: HookType.Command, command: '/a.sh' },
      source: HooksConfigSource.User,
      sourceDisplay: 'User Settings',
      enabled: true,
    });
    addConfigToMatcherGroup(info, 'Bash', undefined, {
      config: { type: HookType.Command, command: '/b.sh' },
      source: HooksConfigSource.Project,
      sourceDisplay: 'Local Settings',
      enabled: true,
    });

    expect(info.matcherGroups).toHaveLength(1);
    expect(info.matcherGroups[0].configs).toHaveLength(2);
    expect(getAllConfigs(info)).toHaveLength(2);
  });

  it('buckets undefined / empty matchers into "*"', () => {
    const info = emptyHookInfo();

    addConfigToMatcherGroup(info, undefined, undefined, {
      config: { type: HookType.Command, command: '/a.sh' },
      source: HooksConfigSource.User,
      sourceDisplay: 'User Settings',
      enabled: true,
    });
    addConfigToMatcherGroup(info, '', undefined, {
      config: { type: HookType.Command, command: '/b.sh' },
      source: HooksConfigSource.User,
      sourceDisplay: 'User Settings',
      enabled: true,
    });

    expect(info.matcherGroups).toHaveLength(1);
    expect(info.matcherGroups[0].matcher).toBe('*');
    expect(info.matcherGroups[0].configs).toHaveLength(2);
  });

  it('writes the normalized matcher onto the stored config', () => {
    const info = emptyHookInfo();

    addConfigToMatcherGroup(info, undefined, undefined, {
      config: { type: HookType.Command, command: '/x.sh' },
      source: HooksConfigSource.User,
      sourceDisplay: 'User Settings',
      enabled: true,
    });

    expect(getAllConfigs(info)[0].matcher).toBe('*');
    expect(info.matcherGroups[0].configs[0].matcher).toBe('*');
  });

  it('promotes group.sequential to true when any handler is sequential', () => {
    const info = emptyHookInfo();

    addConfigToMatcherGroup(info, 'Bash', false, {
      config: { type: HookType.Command, command: '/a.sh' },
      source: HooksConfigSource.User,
      sourceDisplay: 'User Settings',
      enabled: true,
    });
    addConfigToMatcherGroup(info, 'Bash', true, {
      config: { type: HookType.Command, command: '/b.sh' },
      source: HooksConfigSource.User,
      sourceDisplay: 'User Settings',
      enabled: true,
    });

    expect(info.matcherGroups[0].sequential).toBe(true);
  });

  it('normalizes missing sequential to a false boolean, not undefined', () => {
    const info = emptyHookInfo();

    addConfigToMatcherGroup(info, 'Bash', undefined, {
      config: { type: HookType.Command, command: '/a.sh' },
      source: HooksConfigSource.User,
      sourceDisplay: 'User Settings',
      enabled: true,
    });
    addConfigToMatcherGroup(info, 'Bash', false, {
      config: { type: HookType.Command, command: '/b.sh' },
      source: HooksConfigSource.User,
      sourceDisplay: 'User Settings',
      enabled: true,
    });

    expect(info.matcherGroups[0].sequential).toBe(false);
    expect(info.matcherGroups[0].sequential).not.toBe(undefined);
    const flat = getAllConfigs(info);
    expect(flat[0].sequential).toBe(false);
    expect(flat[1].sequential).toBe(false);
  });

  it('preserves insertion order across matchers', () => {
    const info = emptyHookInfo();

    addConfigToMatcherGroup(info, 'Bash', undefined, {
      config: { type: HookType.Command, command: '/a.sh' },
      source: HooksConfigSource.User,
      sourceDisplay: 'User Settings',
      enabled: true,
    });
    addConfigToMatcherGroup(info, 'Edit|Write', undefined, {
      config: { type: HookType.Command, command: '/b.sh' },
      source: HooksConfigSource.User,
      sourceDisplay: 'User Settings',
      enabled: true,
    });
    addConfigToMatcherGroup(info, undefined, undefined, {
      config: { type: HookType.Command, command: '/c.sh' },
      source: HooksConfigSource.User,
      sourceDisplay: 'User Settings',
      enabled: true,
    });

    expect(info.matcherGroups.map((g) => g.matcher)).toEqual([
      'Bash',
      'Edit|Write',
      '*',
    ]);
  });

  it('keeps non-matcher events in original handler order', () => {
    const info = emptyHookInfo();

    addConfigToMatcherGroup(
      info,
      'A',
      undefined,
      {
        config: { type: HookType.Command, command: '/first.sh' },
        source: HooksConfigSource.User,
        sourceDisplay: 'User Settings',
        enabled: true,
      },
      false,
    );
    addConfigToMatcherGroup(
      info,
      'B',
      undefined,
      {
        config: { type: HookType.Command, command: '/second.sh' },
        source: HooksConfigSource.User,
        sourceDisplay: 'User Settings',
        enabled: true,
      },
      false,
    );
    addConfigToMatcherGroup(
      info,
      'A',
      undefined,
      {
        config: { type: HookType.Command, command: '/third.sh' },
        source: HooksConfigSource.User,
        sourceDisplay: 'User Settings',
        enabled: true,
      },
      false,
    );

    expect(info.matcherGroups).toHaveLength(1);
    expect(info.matcherGroups[0].matcher).toBe('*');
    expect(
      getAllConfigs(info).map((config) =>
        config.config.type === HookType.Command ? config.config.command : '',
      ),
    ).toEqual(['/first.sh', '/second.sh', '/third.sh']);
  });
});
