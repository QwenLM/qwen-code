/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { SettingScope } from './settings.js';
import {
  computeWorkspaceSkillListUpdates,
  lookupSkillDisablement,
  resolveSkillSettings,
  skillMatchesSettingName,
  skillSettingKeys,
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

  it('lets a qualified opt-in lift a legacy bare defaultDisabled entry', () => {
    const result = resolveSkillSettings(
      fakeSettings({
        merged: {
          defaultDisabled: ['pdf'],
          enabled: ['demo:pdf'],
        },
      }),
    );

    expect(result.disablements.has('pdf')).toBe(false);
    expect(result.disabledNames.has('pdf')).toBe(false);
  });

  it('lets a bare opt-in lift a qualified defaultDisabled entry', () => {
    const result = resolveSkillSettings(
      fakeSettings({
        merged: {
          defaultDisabled: ['demo:pdf'],
          enabled: ['pdf'],
        },
      }),
    );

    expect(result.disablements.has('demo:pdf')).toBe(false);
    expect(result.disabledNames.has('demo:pdf')).toBe(false);
  });

  it('does not let one extension opt in on behalf of another', () => {
    const result = resolveSkillSettings(
      fakeSettings({
        merged: {
          defaultDisabled: ['other:pdf'],
          enabled: ['demo:pdf'],
        },
      }),
    );

    expect(result.disablements.get('other:pdf')).toEqual({
      reason: 'default',
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

  it('preserves workspace declarations that duplicate higher-scope entries', () => {
    const result = computeWorkspaceSkillListUpdates(
      ['locked', 'orphan', 'review'],
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

    expect(result.disabled).toEqual(['locked', 'orphan']);
    expect(result.disabledChanged).toBe(true);
  });

  it('reports no change when nothing toggled and lists already match', () => {
    const result = computeWorkspaceSkillListUpdates(
      ['orphan'],
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

describe('skill setting name matching (#9408 collision renames)', () => {
  it('matches a legacy bare entry against a collision-qualified skill', () => {
    const skill = { name: 'rust:pdf', extensionName: 'rust' };
    expect(skillSettingKeys(skill)).toEqual(['rust:pdf', 'pdf']);
    expect(skillMatchesSettingName(skill, new Set(['pdf']))).toBe(true);
    expect(
      lookupSkillDisablement(skill, new Map([['pdf', { reason: 'hard' }]])),
    ).toEqual({ reason: 'hard' });
  });

  it('keeps unqualified skills single-keyed', () => {
    expect(skillSettingKeys({ name: 'pdf' })).toEqual(['pdf']);
    expect(
      skillMatchesSettingName({ name: 'pdf' }, new Set(['rust:pdf'])),
    ).toBe(false);
  });

  it('prefers the precise qualified entry over the legacy bare one', () => {
    const skill = { name: 'rust:pdf', extensionName: 'rust' };
    expect(
      lookupSkillDisablement(
        skill,
        new Map([
          ['rust:pdf', { reason: 'hard', lockedScope: 'user' }],
          ['pdf', { reason: 'default' }],
        ]),
      ),
    ).toEqual({ reason: 'hard', lockedScope: 'user' });
  });

  it('does not let another extension own the prefix', () => {
    expect(
      skillSettingKeys({ name: 'other:pdf', extensionName: 'rust' }),
    ).toEqual(['other:pdf']);
  });
});
