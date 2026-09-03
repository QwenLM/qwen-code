/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import type { Config, SkillConfig } from '@qwen-code/qwen-code-core';
import { SettingScope, type LoadedSettings } from '../../../config/settings.js';
import { renderWithProviders } from '../../../test-utils/render.js';
import {
  buildHigherDisabled,
  skillItemValue,
  skillRowLabel,
  SkillsManagerDialog,
} from './SkillsManagerDialog.js';

/**
 * The row the dialog renders for a skill the extension authored as `pdf` and
 * which registers as `demo:pdf`.
 */
const prefixed = { name: 'demo:pdf', authoredName: 'pdf' };

function fakeSettings(
  byScope: Partial<Record<SettingScope, unknown>>,
  defaultsByScope: Partial<Record<SettingScope, unknown>> = {},
  enabledByScope: Partial<Record<SettingScope, unknown>> = {},
  isTrusted = true,
): LoadedSettings {
  return {
    isTrusted,
    forScope: (scope: SettingScope) => ({
      settings: {
        skills: {
          disabled: byScope[scope],
          defaultDisabled: defaultsByScope[scope],
          enabled: enabledByScope[scope],
        },
      },
    }),
  } as unknown as LoadedSettings;
}

describe('buildHigherDisabled', () => {
  it('locks a prefixed skill on the legacy bare entry', () => {
    // `user: { disabled: ['pdf'] }` predates the prefix. The row must still
    // render as locked, or the dialog offers a toggle that does nothing.
    expect(
      buildHigherDisabled(
        fakeSettings({ [SettingScope.User]: ['pdf'] }),
      ).lockedIn(prefixed),
    ).toBe('User');
  });

  it('locks a prefixed skill on the registry-name entry', () => {
    expect(
      buildHigherDisabled(
        fakeSettings({ [SettingScope.System]: ['demo:pdf'] }),
      ).lockedIn(prefixed),
    ).toBe('System');
  });

  it('names the highest-precedence scope holding the same entry', () => {
    const higher = buildHigherDisabled(
      fakeSettings({
        [SettingScope.SystemDefaults]: ['pdf'],
        [SettingScope.User]: ['pdf'],
        [SettingScope.System]: ['pdf'],
      }),
    );

    expect(higher.lockedIn(prefixed)).toBe('System');
  });

  it('blames the registry-name entry first when scopes hold one spelling each', () => {
    // Which label a tie between the two spellings reports follows the
    // lookup's documented registry-first order, not scope precedence. Both
    // entries lock the row, so only the name the user is pointed at differs.
    const registryHeld = buildHigherDisabled(
      fakeSettings({
        [SettingScope.User]: ['pdf'],
        [SettingScope.System]: ['demo:pdf'],
      }),
    );
    const legacyHeld = buildHigherDisabled(
      fakeSettings({
        [SettingScope.User]: ['demo:pdf'],
        [SettingScope.System]: ['pdf'],
      }),
    );

    expect(registryHeld.lockedIn(prefixed)).toBe('System');
    expect(legacyHeld.lockedIn(prefixed)).toBe('User');
  });

  it('does not lock on another extension skill sharing the authored name', () => {
    const higher = buildHigherDisabled(
      fakeSettings({ [SettingScope.User]: ['other:pdf'] }),
    );

    expect(higher.lockedIn(prefixed)).toBeNull();
    expect(higher.lockedIn({ name: 'review' })).toBeNull();
  });

  it('locks on a bare workspace defaultDisabled entry the toggle cannot cancel, naming the entry', () => {
    const higher = buildHigherDisabled(
      fakeSettings({}, { [SettingScope.Workspace]: ['pdf'] }),
    );

    expect(higher.lockedIn(prefixed)).toBe(
      "skills.defaultDisabled 'pdf' (Workspace)",
    );
  });

  it('does not lock on a registry-spelling defaultDisabled entry the qualified grant cancels', () => {
    const higher = buildHigherDisabled(
      fakeSettings({}, { [SettingScope.Workspace]: ['demo:pdf'] }),
    );

    expect(higher.lockedIn(prefixed)).toBeNull();
  });

  it('locks on a bare workspace hard entry, naming the entry', () => {
    const higher = buildHigherDisabled(
      fakeSettings({ [SettingScope.Workspace]: ['pdf'] }),
    );

    expect(higher.lockedIn(prefixed)).toBe("skills.disabled 'pdf' (Workspace)");
  });

  it('does not lock on an exact-spelling workspace hard entry the toggle removes', () => {
    const higher = buildHigherDisabled(
      fakeSettings({ [SettingScope.Workspace]: ['demo:pdf'] }),
    );

    expect(higher.lockedIn(prefixed)).toBeNull();
  });

  it('does not lock on workspace entries while the workspace is untrusted', () => {
    // The merge drops an untrusted workspace wholesale, so its stale entries
    // disable nothing — locking on them would dim rows for live skills.
    const higher = buildHigherDisabled(
      fakeSettings({ [SettingScope.Workspace]: ['pdf'] }, {}, {}, false),
    );

    expect(higher.lockedIn(prefixed)).toBeNull();
  });

  it('does not lock when an identical-spelling grant cancels the defaultDisabled entry', () => {
    // resolveSkillSettings cancels entry-vs-entry on identical spelling; the
    // skill stays live and the toggle that could change state must survive.
    const cancelled = buildHigherDisabled(
      fakeSettings(
        {},
        { [SettingScope.Workspace]: ['pdf'] },
        { [SettingScope.Workspace]: ['pdf'] },
      ),
    );

    expect(cancelled.lockedIn(prefixed)).toBeNull();
    // A registry-spelling grant does not cancel an authored-spelling entry.
    const notCancelled = buildHigherDisabled(
      fakeSettings(
        {},
        { [SettingScope.Workspace]: ['pdf'] },
        { [SettingScope.Workspace]: ['demo:pdf'] },
      ),
    );

    expect(notCancelled.lockedIn(prefixed)).toBe(
      "skills.defaultDisabled 'pdf' (Workspace)",
    );
  });

  it('names the scope holding a higher-scope defaultDisabled entry', () => {
    const higher = buildHigherDisabled(
      fakeSettings({}, { [SettingScope.User]: ['pdf'] }),
    );

    expect(higher.lockedIn(prefixed)).toBe(
      "skills.defaultDisabled 'pdf' (User)",
    );
  });

  it('tolerates a malformed list from the settings file', () => {
    expect(
      buildHigherDisabled(
        fakeSettings({ [SettingScope.User]: 'all' }),
      ).lockedIn(prefixed),
    ).toBeNull();
  });
});

/**
 * `handlePick`'s lock guard does not receive a `SkillConfig` — it receives the
 * MultiSelect row value, which is built separately. Pinning that value's shape
 * is the only thing standing between the guard and a silently narrower match:
 * the type system lets a row value without `authoredName` through
 * `lockedIn({ name, authoredName? })`, and the guard then reads a skill that a
 * legacy bare entry blocks as pickable — the exact bail this guard exists for.
 */
describe('skillItemValue — the shape the pick guard reads', () => {
  /** What `listSkills()` returns for a skill `demo` authors as `pdf`. */
  const prefixedSkill: SkillConfig = {
    name: 'demo:pdf',
    description: 'Read PDFs',
    level: 'extension',
    authoredName: 'pdf',
  } as SkillConfig;
  /** A skill with one spelling: `authoredName` is absent, not empty. */
  const plainSkill: SkillConfig = {
    name: 'review',
    description: 'Review code',
    level: 'user',
  } as SkillConfig;

  it('carries the authored spelling of a prefixed skill', () => {
    expect(skillItemValue(prefixedSkill)).toStrictEqual({
      name: 'demo:pdf',
      description: 'Read PDFs',
      level: 'extension',
      authoredName: 'pdf',
    });
  });

  it('agrees with the row classification under both spellings', () => {
    // The row list and the guard consult the same `lockedIn`; if the row value
    // lost a spelling they would disagree and the dialog would persist, close,
    // and prefill `/demo:pdf` for a skill the config already blocks.
    const legacyEntry = buildHigherDisabled(
      fakeSettings({ [SettingScope.User]: ['pdf'] }),
    );
    const registryEntry = buildHigherDisabled(
      fakeSettings({ [SettingScope.System]: ['demo:pdf'] }),
    );

    expect(legacyEntry.lockedIn(skillItemValue(prefixedSkill))).toBe('User');
    expect(registryEntry.lockedIn(skillItemValue(prefixedSkill))).toBe(
      'System',
    );
    // And it must not invent a block: an entry naming a different extension's
    // skill leaves the row pickable under either spelling.
    expect(
      buildHigherDisabled(
        fakeSettings({ [SettingScope.User]: ['other:pdf'] }),
      ).lockedIn(skillItemValue(prefixedSkill)),
    ).toBeNull();
  });

  it('stays a single-spelling value for a skill with one spelling', () => {
    const value = skillItemValue(plainSkill);

    expect(value.authoredName).toBeUndefined();
    expect(
      buildHigherDisabled(
        fakeSettings({ [SettingScope.User]: ['review'] }),
      ).lockedIn(value),
    ).toBe('User');
  });
});

/**
 * The row text is what Goal A is made of: a user scanning the dialog has to
 * see whose skill each row is.
 */
describe('skillRowLabel', () => {
  it('names the owning extension for an extension row', () => {
    const label = skillRowLabel({
      name: 'rust:functions',
      description: 'Rust review',
      level: 'extension',
      extensionName: 'rust',
      extensionDisplayName: 'Rust',
    } as SkillConfig);

    expect(label).toContain('(Extension: Rust)');
    expect(label).not.toContain('(Extension)');
  });

  it('falls back to the extension id when the row has no display name', () => {
    expect(
      skillRowLabel({
        name: 'rust:functions',
        description: 'Rust review',
        level: 'extension',
        extensionName: 'rust',
      } as SkillConfig),
    ).toContain('(Extension: rust)');
  });

  it('keeps the level word on a non-extension row', () => {
    // There the level is already the whole answer to "where did this come
    // from", so naming an owner would be noise.
    expect(
      skillRowLabel({
        name: 'review',
        description: 'Review code',
        level: 'user',
      } as SkillConfig),
    ).toContain('(User)');
  });
});

/**
 * The locked section is where naming the owner pays for itself: the user
 * cannot toggle these rows, so their next action is editing a settings scope
 * for one specific extension. Rendered, not unit-tested, because the branch
 * only exists in the JSX — the helpers above never see it.
 */
describe('the locked section names the owner', () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => cleanup?.());

  it('prints the owning extension on a row the dialog cannot toggle', async () => {
    // The only skill present, and it is locked at user scope: the MultiSelect
    // renders no rows, so `(Extension: Rust)` can only come from the locked
    // row.
    const rustSkill = {
      name: 'rust:functions',
      description: 'Review Rust function signatures',
      level: 'extension',
      authoredName: 'functions',
      extensionName: 'rust',
      extensionDisplayName: 'Rust',
    } as SkillConfig;
    const config = {
      getSkillManager: () => ({ listSkills: async () => [rustSkill] }),
      isSkillEnabled: () => true,
    } as unknown as Config;

    const { lastFrame, cleanup: unmount } = renderWithProviders(
      <SkillsManagerDialog
        settings={fakeSettings({ [SettingScope.User]: ['rust:functions'] })}
        config={config}
        addItem={vi.fn()}
        onClose={vi.fn()}
        reloadCommands={vi.fn()}
        setInputBuffer={vi.fn()}
      />,
    );
    cleanup = unmount;

    await waitFor(() => expect(lastFrame()).toContain('[locked: User]'));
    expect(lastFrame()).toContain('(Extension: Rust)');
  });
});
