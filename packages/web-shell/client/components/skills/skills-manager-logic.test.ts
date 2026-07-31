import { describe, expect, it } from 'vitest';
import type { DaemonWorkspaceSkillStatus } from '@qwen-code/webui/daemon-react-sdk';
import { filterSkills, preserveSkillSelection } from './skills-manager-logic';

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
});
