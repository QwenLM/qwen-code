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
  type SkillDisablement,
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
      ),
    ).toEqual({ disabled: ['orphan', 'review'], enabled: ['other'] });
  });

  it('records an explicit opt-in even without a default disable', () => {
    expect(
      updateWorkspaceSkillSettingLists(
        { disabled: ['review'], enabled: [] },
        'review',
        true,
      ),
    ).toEqual({ disabled: [], enabled: ['review'] });
  });

  it('does not reorder an already canonical hard disable', () => {
    expect(
      updateWorkspaceSkillSettingLists(
        { disabled: ['review', 'orphan'], enabled: [] },
        'review',
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
        },
      ],
    );

    expect(result.disabled).toEqual(['orphan']);
    expect(result.disabledChanged).toBe(true);
    expect(result.enabled).toEqual(['review']);
    expect(result.enabledChanged).toBe(true);
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
        },
      ],
    );

    expect(result.enabled).toEqual(['Review']);
    expect(result.enabledChanged).toBe(true);
  });

  it('writes the registry name and clears only that entry', () => {
    const updates = computeWorkspaceSkillListUpdates(
      ['pdf', 'other'],
      [],
      [{ name: 'rust:pdf', wasEnabled: false, isEnabled: true }],
    );
    // `pdf` is a different skill's legacy entry and must survive untouched:
    // enabling one skill can never clear a broader disablement.
    expect(updates.disabled).toEqual(['pdf', 'other']);
    expect(updates.enabled).toEqual(['rust:pdf']);
  });

  it('disabling writes the registry name, not the authored one', () => {
    const updates = computeWorkspaceSkillListUpdates(
      [],
      ['rust:pdf'],
      [{ name: 'rust:pdf', wasEnabled: true, isEnabled: false }],
    );

    expect(updates.disabled).toEqual(['rust:pdf']);
    expect(updates.enabled).toEqual([]);
  });
});

describe('lookupSkillDisablement', () => {
  const hard: SkillDisablement = { reason: 'hard', lockedScope: 'user' };
  const byAuthored = new Map<string, SkillDisablement>([['pdf', hard]]);
  const byRegistry = new Map<string, SkillDisablement>([['rust:pdf', hard]]);
  const prefixed = { name: 'rust:pdf', authoredName: 'pdf' };

  it('finds the entry written under the registry name', () => {
    expect(lookupSkillDisablement(byRegistry, prefixed)).toBe(hard);
  });

  it('finds the legacy entry written under the authored name', () => {
    expect(lookupSkillDisablement(byAuthored, prefixed)).toBe(hard);
  });

  it('prefers the registry-name entry when both spellings are present', () => {
    const entries = new Map<string, SkillDisablement>([
      ['pdf', { reason: 'default' }],
      ['rust:pdf', hard],
    ]);

    expect(lookupSkillDisablement(entries, prefixed)).toBe(hard);
  });

  it('normalizes the skill name it is given', () => {
    expect(
      lookupSkillDisablement(byRegistry, {
        name: ' RUST:Pdf ',
        authoredName: ' PDF ',
      }),
    ).toBe(hard);
  });

  it('finds the registry-name entry for a skill with no authored spelling', () => {
    // Registration omits `authoredName` whenever the two spellings coincide, so
    // the registry name is the only key this lookup can be handed.
    expect(lookupSkillDisablement(byRegistry, { name: 'rust:pdf' })).toBe(hard);
  });

  it('does not match another extension skill that shares the authored name', () => {
    // A restriction on `other:pdf` says nothing about `rust:pdf`: the authored
    // spelling is shared across extensions, the registry identity is not.
    expect(
      lookupSkillDisablement(
        new Map<string, SkillDisablement>([['other:pdf', hard]]),
        { name: 'rust:pdf', authoredName: 'pdf' },
      ),
    ).toBeUndefined();
  });

  it('still matches a skill that has one spelling', () => {
    expect(
      lookupSkillDisablement(
        new Map<string, SkillDisablement>([['review', hard]]),
        { name: 'review' },
      ),
    ).toBe(hard);
    expect(
      lookupSkillDisablement(byAuthored, { name: 'review', authoredName: '' }),
    ).toBeUndefined();
  });
});
