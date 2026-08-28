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
  skillSettingEntriesMatch,
  skillSettingEntriesMatchAny,
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

  it('a bare toggle does not consume a qualified entry another skill owns (#9408 R3-1)', () => {
    // `pdf` (user) and `demo:pdf` (extension) are two distinct loaded skills
    // once collision qualification renames the extension copy. Re-enabling the
    // user copy must leave the extension's persisted disable in place.
    expect(
      updateWorkspaceSkillSettingLists(
        { disabled: ['demo:pdf'], enabled: [] },
        'pdf',
        true,
        false,
        undefined,
      ),
    ).toEqual({ disabled: ['demo:pdf'], enabled: [] });
  });

  it('a qualified toggle still lifts its own legacy bare disable (#9408)', () => {
    // Toggling the extension copy reaches the pre-rename bare spelling it once
    // persisted, so the dual-spelling lift survives.
    expect(
      updateWorkspaceSkillSettingLists(
        { disabled: ['pdf'], enabled: [] },
        'demo:pdf',
        true,
        false,
        'demo',
      ),
    ).toEqual({ disabled: [], enabled: [] });
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

// ── Truth matrix: skillSettingEntriesMatch ──
// Every name source × collision state × entry spelling × operation.
describe('skillSettingEntriesMatch truth matrix', () => {
  it.each([
    // ── Identical spellings always match ──
    ['rust:pdf', 'rust:pdf', true, 'identical qualified spellings'],
    ['pdf', 'pdf', true, 'identical bare spellings'],
    [
      '  Rust:PDF  ',
      '  rust:pdf  ',
      true,
      'identical qualified with whitespace (normalized)',
    ],
    ['PDF', 'pdf', true, 'case-insensitive bare match'],

    // ── Qualified ↔ bare dual-spelling match ──
    ['rust:pdf', 'pdf', true, 'qualified matches its own bare suffix'],
    ['pdf', 'rust:pdf', true, 'bare matches its own qualified prefix'],
    ['demo:chat', 'chat', true, 'qualified matches bare suffix'],
    ['chat', 'demo:chat', true, 'bare matches qualified prefix'],

    // ── Multiple colons: only first colon separates owner ──
    [
      'a:b:c',
      'b:c',
      true,
      'qualified with multiple colons matches bare suffix',
    ],
    [
      'b:c',
      'a:b:c',
      true,
      'bare suffix matches qualified with multiple colons',
    ],

    // ── Cross-extension: different owners do NOT match ──
    [
      'other:pdf',
      'pdf',
      true,
      'qualified matches its bare suffix regardless of owner',
    ],
    [
      'pdf',
      'other:pdf',
      true,
      'bare matches qualified suffix regardless of owner',
    ],
    ['rust:pdf', 'other:pdf', false, 'different qualified names do not match'],

    // ── Suffixed names (collision result) ──
    ['rust:pdf1', 'pdf1', true, 'suffixed qualified matches suffixed bare'],
    ['pdf1', 'rust:pdf1', true, 'suffixed bare matches suffixed qualified'],

    // ── No match: unrelated names ──
    ['rust:pdf', 'rust:chat', false, 'different skills under same owner'],
    ['rust:pdf', 'other:pdf', false, 'different owners, same skill name'],
    ['pdf', 'chat', false, 'unrelated bare names'],

    // ── Empty / edge ──
    ['', '', true, 'empty strings match'],
    ['', 'pdf', false, 'empty does not match bare'],
    ['pdf', '', false, 'bare does not match empty'],
    [':pdf', 'pdf', true, 'colon-only owner matches bare suffix'],
    ['pdf', ':pdf', true, 'bare matches colon-only owner suffix'],
  ])('matches (a=$0, b=$1)', (a, b, expected) => {
    expect(skillSettingEntriesMatch(a, b)).toBe(expected);
  });
});

// ── Truth matrix: skillSettingEntriesMatchAny ──
describe('skillSettingEntriesMatchAny truth matrix', () => {
  it.each([
    // ── Direct match ──
    [['pdf'], 'pdf', true, 'single bare entry matches bare name'],
    [
      ['rust:pdf'],
      'rust:pdf',
      true,
      'single qualified entry matches qualified name',
    ],

    // ── Dual-spelling match ──
    [['pdf'], 'rust:pdf', true, 'bare entry matches qualified name'],
    [['rust:pdf'], 'pdf', true, 'qualified entry matches bare name'],

    // ── No match ──
    [[], 'pdf', false, 'empty entries do not match anything'],
    [['chat'], 'pdf', false, 'unrelated entry does not match'],

    // ── Multiple entries ──
    [
      ['other:pdf', 'pdf'],
      'rust:pdf',
      true,
      'bare entry in list matches qualified name',
    ],
    [
      ['other:pdf', 'chat'],
      'pdf',
      true,
      'qualified entry in list matches bare suffix',
    ],
    [
      ['demo:chat', 'other:pdf'],
      'chat',
      true,
      'qualified entry in list matches bare name',
    ],

    // ── Cross-extension guard (qualified name always includes bare suffix) ──
    [
      ['other:pdf'],
      'pdf',
      true,
      'other-extension qualified entry matches bare suffix',
    ],

    // ── Suffixed ──
    [
      ['rust:pdf1'],
      'pdf1',
      true,
      'suffixed qualified entry matches suffixed bare name',
    ],
    [
      ['pdf1'],
      'rust:pdf1',
      true,
      'suffixed bare entry matches suffixed qualified name',
    ],
  ])('matches (entries=$0, skillName=$1)', (entries, skillName, expected) => {
    expect(skillSettingEntriesMatchAny(entries, skillName)).toBe(expected);
  });
});

// ── Truth matrix: resolveSkillSettings adversarial cells ──
// Every name source × collision state × entry spelling × operation.
describe('resolveSkillSettings truth matrix', () => {
  it.each([
    // ── De-renames: qualified opt-in lifts bare defaultDisabled ──
    {
      settings: { defaultDisabled: ['pdf'], enabled: ['rust:pdf'] },
      expectDisabledNames: new Set(),
      expectHasDisablement: false,
      label: 'qualified opt-in lifts legacy bare defaultDisable',
    },
    {
      settings: { defaultDisabled: ['rust:pdf'], enabled: ['pdf'] },
      expectDisabledNames: new Set(),
      expectHasDisablement: false,
      label: 'bare opt-in lifts qualified defaultDisable',
    },

    // ── Manufactured-name collisions: entries that look qualified but are not real skills ──
    {
      settings: { defaultDisabled: ['pdf'], enabled: ['fake:pdf'] },
      expectDisabledNames: new Set(),
      expectHasDisablement: false,
      label: 'fake owner prefix lifts defaultDisable via suffix match',
    },
    {
      settings: { defaultDisabled: ['other:pdf'], enabled: ['demo:pdf'] },
      expectDisabledNames: new Set(['other:pdf']),
      expectHasDisablement: true,
      label:
        'cross-extension opt-in does not lift different-owner defaultDisable',
    },

    // ── Entry-deletion side effects: no opt-in preserves the defaultDisable ──
    {
      settings: { defaultDisabled: ['pdf'] },
      expectDisabledNames: new Set(['pdf']),
      expectHasDisablement: true,
      label: 'no opt-in preserves defaultDisable',
    },

    // ── Case-insensitive matching ──
    {
      settings: { defaultDisabled: ['PDF'], enabled: ['rust:PDF'] },
      expectDisabledNames: new Set(),
      expectHasDisablement: false,
      label: 'case-insensitive opt-in lifts case-insensitive defaultDisable',
    },

    // ── Empty lists ──
    {
      settings: { defaultDisabled: [], enabled: [] },
      expectDisabledNames: new Set(),
      expectHasDisablement: false,
      label: 'empty lists produce no disablements',
    },
  ])(
    'handles $label',
    ({ settings, expectDisabledNames, expectHasDisablement }) => {
      const result = resolveSkillSettings(
        fakeSettings({
          merged: { ...settings },
        }),
      );
      expect(result.disabledNames).toEqual(expectDisabledNames);
      if (expectHasDisablement) {
        expect(result.disablements.size).toBeGreaterThan(0);
      } else {
        expect(result.disablements.size).toBe(0);
      }
    },
  );
});

// ── Truth matrix: computeWorkspaceSkillListUpdates ──
// Every toggle operation × name spelling × collision state.
describe('computeWorkspaceSkillListUpdates truth matrix', () => {
  it.each([
    // ── De-renames in toggles: qualified name toggle removes matching bare disablement ──
    {
      seed: { workspaceDisabled: ['pdf'], workspaceEnabled: [] },
      toggles: [
        {
          name: 'rust:pdf',
          wasEnabled: false,
          isEnabled: true,
          defaultDisabled: false,
        },
      ],
      expected: {
        disabled: [],
        enabled: [],
        disabledChanged: true,
        enabledChanged: false,
      },
      label:
        'enabling a qualified skill via toggle removes matching bare disablement, no opt-in added',
    },
    {
      seed: { workspaceDisabled: [], workspaceEnabled: [] },
      toggles: [
        {
          name: 'rust:pdf',
          wasEnabled: false,
          isEnabled: true,
          defaultDisabled: true,
        },
      ],
      expected: {
        disabled: [],
        enabled: ['rust:pdf'],
        disabledChanged: false,
        enabledChanged: true,
      },
      label:
        'enabling a default-disabled qualified skill records explicit opt-in',
    },

    // ── Suffixed names as targets ──
    {
      seed: { workspaceDisabled: ['rust:pdf1'], workspaceEnabled: [] },
      toggles: [
        {
          name: 'rust:pdf1',
          wasEnabled: false,
          isEnabled: true,
          defaultDisabled: false,
        },
      ],
      expected: {
        disabled: [],
        enabled: [],
        disabledChanged: true,
        enabledChanged: false,
      },
      label:
        'enabling a suffixed qualified skill removes its disablement, no opt-in added',
    },

    // ── Bare name toggle with qualified disablement ──
    {
      seed: { workspaceDisabled: ['rust:pdf'], workspaceEnabled: [] },
      toggles: [
        {
          name: 'pdf',
          wasEnabled: false,
          isEnabled: true,
          defaultDisabled: false,
        },
      ],
      expected: {
        disabled: ['rust:pdf'],
        enabled: [],
        disabledChanged: false,
        enabledChanged: false,
      },
      label:
        'bare toggle leaves a qualified disablement another skill owns (R3-1)',
    },

    // ── Disabling a skill that was never enabled ──
    {
      seed: { workspaceDisabled: [], workspaceEnabled: [] },
      toggles: [
        {
          name: 'rust:pdf',
          wasEnabled: false,
          isEnabled: false,
          defaultDisabled: false,
        },
      ],
      expected: {
        disabled: [],
        enabled: [],
        disabledChanged: false,
        enabledChanged: false,
      },
      label: 'no-op toggle produces no change',
    },

    // ── hadExplicitEnable: enabling a skill that was already explicitly enabled ──
    {
      seed: { workspaceDisabled: [], workspaceEnabled: ['rust:pdf'] },
      toggles: [
        {
          name: 'pdf',
          wasEnabled: true,
          isEnabled: true,
          defaultDisabled: false,
        },
      ],
      expected: {
        disabled: [],
        enabled: ['rust:pdf'],
        disabledChanged: false,
        enabledChanged: false,
      },
      label: 're-enabling an already-explicitly-enabled skill is a no-op',
    },
    {
      seed: { workspaceDisabled: [], workspaceEnabled: ['rust:pdf'] },
      toggles: [
        {
          name: 'pdf',
          wasEnabled: false,
          isEnabled: true,
          defaultDisabled: false,
        },
      ],
      expected: {
        disabled: [],
        enabled: ['rust:pdf'],
        disabledChanged: false,
        enabledChanged: false,
      },
      label:
        'enabling a bare skill does not consume a qualified opt-in another skill owns (R3-1)',
    },

    // ── Orphaned entries preserved ──
    {
      seed: { workspaceDisabled: ['orphan', 'rust:pdf'], workspaceEnabled: [] },
      toggles: [
        {
          name: 'pdf',
          wasEnabled: false,
          isEnabled: true,
          defaultDisabled: false,
        },
      ],
      expected: {
        disabled: ['orphan', 'rust:pdf'],
        enabled: [],
        disabledChanged: false,
        enabledChanged: false,
      },
      label:
        'bare toggle preserves orphaned and other-owned qualified disablements (R3-1)',
    },

    // ── Multiple toggles ──
    {
      seed: { workspaceDisabled: ['pdf'], workspaceEnabled: [] },
      toggles: [
        {
          name: 'rust:pdf',
          wasEnabled: false,
          isEnabled: true,
          defaultDisabled: false,
        },
        {
          name: 'pdf',
          wasEnabled: true,
          isEnabled: false,
          defaultDisabled: false,
        },
      ],
      expected: {
        disabled: ['pdf'],
        enabled: [],
        disabledChanged: false,
        enabledChanged: false,
      },
      label:
        'toggle qualified removes its disablement, bare toggle re-adds bare disablement',
    },
  ])('handles $label', ({ seed, toggles, expected }) => {
    const result = computeWorkspaceSkillListUpdates(
      seed.workspaceDisabled,
      seed.workspaceEnabled,
      toggles,
    );
    expect(result.disabled).toEqual(expected.disabled);
    expect(result.enabled).toEqual(expected.enabled);
    expect(result.disabledChanged).toBe(expected.disabledChanged);
    expect(result.enabledChanged).toBe(expected.enabledChanged);
  });
});
