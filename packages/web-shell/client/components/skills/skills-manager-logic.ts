import type { DaemonWorkspaceSkillStatus } from '@qwen-code/webui/daemon-react-sdk';

export type SkillLevelFilter = 'all' | DaemonWorkspaceSkillStatus['level'];
export type SkillStatusFilter = 'all' | 'enabled' | 'disabled';

export function filterSkills(
  skills: readonly DaemonWorkspaceSkillStatus[],
  query: string,
  level: SkillLevelFilter = 'all',
  status: SkillStatusFilter = 'all',
): DaemonWorkspaceSkillStatus[] {
  const normalized = query.trim().toLowerCase();
  return skills.filter((skill) => {
    if (level !== 'all' && skill.level !== level) return false;
    if (status === 'disabled' && skill.status !== 'disabled') return false;
    if (status === 'enabled' && skill.status === 'disabled') return false;
    if (!normalized) return true;
    return skill.name.toLowerCase().includes(normalized);
  });
}

export function preserveSkillSelection(
  name: string | null,
  skills: readonly DaemonWorkspaceSkillStatus[],
): string | null {
  return name && skills.some((skill) => skill.name === name) ? name : null;
}
