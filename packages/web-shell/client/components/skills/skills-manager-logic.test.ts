import { describe, expect, it } from 'vitest';
import type { DaemonWorkspaceSkillStatus } from '@qwen-code/webui/daemon-react-sdk';
import {
  filterSkills,
  isSkillInConfigInventory,
  isSkillRuntimeConfirmed,
  isSkillsRuntimeCurrent,
  mergeSkillsInventory,
  preserveSkillSelection,
  skillMutationActivationPresentation,
} from './skills-manager-logic';

const skills: DaemonWorkspaceSkillStatus[] = [
  {
    kind: 'skill',
    status: 'ok',
    name: 'frontend-design',
    description: 'Design interfaces',
    level: 'extension',
    modelInvocable: true,
    extensionName: 'design-pack',
  },
  {
    kind: 'skill',
    status: 'ok',
    name: 'review',
    description: 'Review code',
    level: 'user',
    modelInvocable: false,
    argumentHint: '<path>',
  },
];

describe('skills manager logic', () => {
  it('filters skills by title and scope', () => {
    expect(filterSkills(skills, 'FRONTEND')).toEqual([skills[0]]);
    expect(filterSkills(skills, 'design-pack')).toEqual([]);
    expect(filterSkills(skills, '<path>')).toEqual([]);
    expect(filterSkills(skills, '', 'extension')).toEqual([skills[0]]);
    expect(filterSkills(skills, 'design', 'user')).toEqual([]);
  });

  it('filters skills by enabled status', () => {
    const disabledSkills = [
      skills[0],
      { ...skills[1], status: 'disabled' as const },
    ];
    expect(filterSkills(disabledSkills, '', 'all', 'enabled')).toEqual([
      disabledSkills[0],
    ]);
    expect(filterSkills(disabledSkills, '', 'all', 'disabled')).toEqual([
      disabledSkills[1],
    ]);
    expect(filterSkills(disabledSkills, '', 'user', 'disabled')).toEqual([
      disabledSkills[1],
    ]);
    expect(filterSkills(disabledSkills, '', 'extension', 'disabled')).toEqual(
      [],
    );
  });

  it('preserves only a selection that still exists', () => {
    expect(preserveSkillSelection('review', skills)).toBe('review');
    expect(preserveSkillSelection('removed', skills)).toBeNull();
  });

  it('only treats Skills present in config inventory as mutable', () => {
    const configuredSkills = skills.slice(1);
    expect(isSkillInConfigInventory('ReViEw', configuredSkills)).toBe(true);
    expect(isSkillInConfigInventory('frontend-design', configuredSkills)).toBe(
      false,
    );
  });

  it('only confirms toggles from the live runtime catalog', () => {
    const currentRuntime = {
      v: 1 as const,
      workspaceCwd: '/ws',
      initialized: true,
      runtimeEpoch: 7,
      source: 'live' as const,
      skills,
      runtimeState: 'ready' as const,
      coordinatorRuntimeEpoch: 7,
      capabilityRuntimeEpoch: 7,
      runtimeCatalogEpoch: 7,
      runtimeCatalogInitialized: true,
      runtimeCatalogSource: 'live' as const,
      runtimeSkills: skills,
    };
    expect(isSkillRuntimeConfirmed(currentRuntime, 'review', true)).toBe(true);
    expect(
      isSkillRuntimeConfirmed(
        {
          ...currentRuntime,
          capabilityRuntimeEpoch: 6,
        },
        'review',
        true,
      ),
    ).toBe(false);
    expect(isSkillRuntimeConfirmed(undefined, 'review', true)).toBe(false);
  });

  it('requires a ready, initialized Catalog from the current epoch', () => {
    const status = {
      v: 1 as const,
      workspaceCwd: '/ws',
      initialized: true,
      source: 'live' as const,
      skills,
      runtimeState: 'ready' as const,
      coordinatorRuntimeEpoch: 9,
      capabilityRuntimeEpoch: 9,
      runtimeCatalogEpoch: 9,
      runtimeCatalogInitialized: true,
      runtimeCatalogSource: 'live' as const,
      runtimeSkills: skills,
    };

    expect(isSkillsRuntimeCurrent(status)).toBe(true);
    expect(isSkillsRuntimeCurrent({ ...status, runtimeCatalogEpoch: 8 })).toBe(
      false,
    );
    expect(
      isSkillsRuntimeCurrent({ ...status, runtimeCatalogInitialized: false }),
    ).toBe(false);
    expect(isSkillsRuntimeCurrent({ ...status, runtimeState: 'stale' })).toBe(
      false,
    );
  });

  it('keeps config activation authoritative when merging a live Catalog', () => {
    const configured = [
      {
        ...skills[1],
        installedPath: '/home/user/.qwen/skills/review/SKILL.md',
      },
    ];
    const currentRuntime = {
      v: 1 as const,
      workspaceCwd: '/ws',
      initialized: true,
      source: 'live' as const,
      skills,
      runtimeState: 'ready' as const,
      coordinatorRuntimeEpoch: 4,
      capabilityRuntimeEpoch: 4,
      runtimeCatalogEpoch: 4,
      runtimeCatalogInitialized: true,
      runtimeCatalogSource: 'live' as const,
      runtimeSkills: [{ ...skills[1], status: 'disabled' as const }, skills[0]],
    };

    expect(
      mergeSkillsInventory(configured, {
        ...currentRuntime,
        runtimeState: 'stale',
      }),
    ).toEqual(configured);
    expect(mergeSkillsInventory(configured, currentRuntime)).toEqual([
      {
        ...skills[1],
        installedPath: '/home/user/.qwen/skills/review/SKILL.md',
      },
      skills[0],
    ]);
  });

  it('distinguishes durable skill mutations from runtime activation', () => {
    expect(skillMutationActivationPresentation('applied')).toEqual({
      messageKey: 'skills.activation.applied',
      error: false,
    });
    expect(skillMutationActivationPresentation('reconciling')).toEqual({
      messageKey: 'skills.activation.reconciling',
      error: false,
    });
    expect(skillMutationActivationPresentation('deferred')).toEqual({
      messageKey: 'skills.activation.deferred',
      error: false,
    });
    expect(skillMutationActivationPresentation('partial')).toEqual({
      messageKey: 'skills.activation.partial',
      error: true,
    });
    expect(skillMutationActivationPresentation(undefined)).toEqual({
      messageKey: 'skills.runtimeNotConfirmed',
      error: true,
    });
  });
});
