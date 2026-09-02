/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { SettingScope } from './settings.js';
import {
  computeWorkspaceSkillListUpdates,
  resolveSkillSettings,
  updateWorkspaceSkillSettingLists,
} from './skill-settings.js';

function fakeSettings({
  merged,
  system = {},
  systemDefaults = {},
  user = {},
  workspace = {},
}: {
  merged: Record<string, unknown>;
  system?: Record<string, unknown>;
  systemDefaults?: Record<string, unknown>;
  user?: Record<string, unknown>;
  workspace?: Record<string, unknown>;
}) {
  const byScope = {
    [SettingScope.System]: system,
    [SettingScope.SystemDefaults]: systemDefaults,
    [SettingScope.User]: user,
    [SettingScope.Workspace]: workspace,
  };
  return {
    merged: { skills: merged },
    forScope: (scope: SettingScope) => ({
      settings: { skills: byScope[scope] },
    }),
  } as never;
}

describe('resolveSkillSettings', () => {
  it('lets a workspace opt-in override a user default case-insensitively', () => {
    const result = resolveSkillSettings(
      fakeSettings({
        merged: {
          defaultDisabled: [' Review ', 'plan'],
          enabled: ['REVIEW'],
        },
        user: { defaultDisabled: [' Review ', 'plan'] },
        workspace: { enabled: ['REVIEW'] },
      }),
    );

    expect(result.disabledNames).toEqual(new Set(['plan']));
    expect(result.enabledNames).toEqual(new Set(['review']));
    expect(result.disablements.get('plan')).toEqual({ reason: 'default' });
    expect(result.disablements.has('review')).toBe(false);
  });

  it('keeps hard disables authoritative and reports their lock scope', () => {
    const result = resolveSkillSettings(
      fakeSettings({
        merged: {
          disabled: ['review'],
          defaultDisabled: ['review'],
          enabled: ['REVIEW'],
        },
        user: { disabled: ['Review'] },
      }),
    );

    expect(result.disabledNames).toEqual(new Set(['review']));
    expect(result.disablements.get('review')).toEqual({
      reason: 'hard',
      lockedScope: 'user',
    });
  });

  it('ignores malformed and empty list entries', () => {
    const result = resolveSkillSettings(
      fakeSettings({
        merged: {
          disabled: 'all',
          defaultDisabled: [null, 42, '  ', 'Valid'],
          enabled: false,
        },
      }),
    );

    expect(result.disabledNames).toEqual(new Set(['valid']));
  });
});

describe('updateWorkspaceSkillSettingLists', () => {
  it('persists a canonical opt-in for a default-disabled skill', () => {
    expect(
      updateWorkspaceSkillSettingLists(
        { disabled: ['orphan'], enabled: [] },
        'Review',
        true,
        true,
      ),
    ).toEqual({ disabled: ['orphan'], enabled: ['Review'] });
  });

  it('keeps unrelated entries and canonicalizes matching entries', () => {
    expect(
      updateWorkspaceSkillSettingLists(
        {
          disabled: ['orphan', ' REVIEW ', 'review'],
          enabled: ['other', 'ReViEw'],
        },
        'review',
        false,
        true,
      ),
    ).toEqual({ disabled: ['orphan', 'review'], enabled: ['other'] });
  });

  it('does not add a redundant opt-in for an ordinary skill', () => {
    expect(
      updateWorkspaceSkillSettingLists(
        { disabled: ['review'], enabled: [] },
        'review',
        true,
        false,
      ),
    ).toEqual({ disabled: [], enabled: [] });
  });

  it('does not reorder an already canonical hard disable', () => {
    expect(
      updateWorkspaceSkillSettingLists(
        { disabled: ['review', 'orphan'], enabled: [] },
        'review',
        false,
        false,
      ),
    ).toEqual({ disabled: ['review', 'orphan'], enabled: [] });
  });
});

describe('computeWorkspaceSkillListUpdates', () => {
  it('preserves orphaned workspace disables the picker does not manage', () => {
    // 'orphan' is not a loaded skill (different branch, uninstalled extension,
    // deleted skills dir), so it must survive untouched even though only
    // 'review' is toggled.
    const result = computeWorkspaceSkillListUpdates(
      ['orphan', 'review'],
      new Set<string>(),
      [],
      [
        {
          name: 'review',
          wasEnabled: false,
          isEnabled: true,
          defaultDisabled: false,
        },
      ],
    );

    expect(result.disabled).toEqual(['orphan']);
    expect(result.disabledChanged).toBe(true);
    expect(result.enabledChanged).toBe(false);
  });

  it('drops locked higher-scope entries so they are not re-emitted', () => {
    // 'locked' is disabled at a higher scope; the picker must not re-emit it at
    // workspace scope. Toggling 'review' on provides a genuine change so the
    // write path is exercised while 'orphan' is still preserved.
    const result = computeWorkspaceSkillListUpdates(
      ['locked', 'orphan', 'review'],
      new Set(['locked']),
      [],
      [
        {
          name: 'review',
          wasEnabled: false,
          isEnabled: true,
          defaultDisabled: false,
        },
      ],
    );

    expect(result.disabled).toEqual(['orphan']);
    expect(result.disabledChanged).toBe(true);
  });

  it('reports no change when nothing toggled and lists already match', () => {
    const result = computeWorkspaceSkillListUpdates(
      ['orphan'],
      new Set<string>(),
      [],
      [
        {
          name: 'review',
          wasEnabled: true,
          isEnabled: true,
          defaultDisabled: false,
        },
      ],
    );

    expect(result.disabled).toEqual(['orphan']);
    expect(result.disabledChanged).toBe(false);
    expect(result.enabledChanged).toBe(false);
  });

  it('records an explicit opt-in when enabling a default-disabled skill', () => {
    const result = computeWorkspaceSkillListUpdates(
      [],
      new Set<string>(),
      [],
      [
        {
          name: 'Review',
          wasEnabled: false,
          isEnabled: true,
          defaultDisabled: true,
        },
      ],
    );

    expect(result.enabled).toEqual(['Review']);
    expect(result.enabledChanged).toBe(true);
  });
});
