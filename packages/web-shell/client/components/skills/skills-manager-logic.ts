import type {
  DaemonWorkspaceActions,
  DaemonWorkspaceSkillStatus,
} from '@qwen-code/webui/daemon-react-sdk';

type SkillsStatus = Awaited<
  ReturnType<DaemonWorkspaceActions['loadSkillsStatus']>
>;

export type SkillLevelFilter = 'all' | DaemonWorkspaceSkillStatus['level'];
export type SkillStatusFilter = 'all' | 'enabled' | 'disabled';
export type SkillMutationActivation = NonNullable<
  Awaited<
    ReturnType<DaemonWorkspaceActions['installWorkspaceSkill']>
  >['activation']
>;

export function skillMutationActivationPresentation(
  activation: SkillMutationActivation | undefined,
): { messageKey: string; error: boolean } {
  switch (activation) {
    case 'applied':
      return { messageKey: 'skills.activation.applied', error: false };
    case 'reconciling':
      return { messageKey: 'skills.activation.reconciling', error: false };
    case 'deferred':
      return { messageKey: 'skills.activation.deferred', error: false };
    case 'partial':
      return { messageKey: 'skills.activation.partial', error: true };
    default:
      return { messageKey: 'skills.runtimeNotConfirmed', error: true };
  }
}

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

export function isSkillInConfigInventory(
  skillName: string,
  configuredSkills: readonly DaemonWorkspaceSkillStatus[],
): boolean {
  const normalizedName = skillName.trim().toLowerCase();
  return configuredSkills.some(
    (skill) => skill.name.trim().toLowerCase() === normalizedName,
  );
}

export function isSkillsRuntimeCurrent(
  status: SkillsStatus | undefined,
): boolean {
  const epoch = status?.coordinatorRuntimeEpoch;
  return (
    status?.runtimeState === 'ready' &&
    epoch !== undefined &&
    status.capabilityRuntimeEpoch === epoch &&
    status.runtimeCatalogEpoch === epoch &&
    status.runtimeCatalogInitialized === true &&
    status.runtimeCatalogSource === 'live'
  );
}

export function mergeSkillsInventory(
  configuredSkills: readonly DaemonWorkspaceSkillStatus[],
  runtimeStatus: SkillsStatus | undefined,
): DaemonWorkspaceSkillStatus[] {
  if (!isSkillsRuntimeCurrent(runtimeStatus)) return [...configuredSkills];

  const runtimeSkills = runtimeStatus?.runtimeSkills ?? [];
  const runtimeByName = new Map(
    runtimeSkills.map((skill) => [skill.name.toLowerCase(), skill]),
  );
  const merged = configuredSkills.map((configured) => {
    const runtime = runtimeByName.get(configured.name.toLowerCase());
    if (!runtime) return configured;
    runtimeByName.delete(configured.name.toLowerCase());
    return {
      ...runtime,
      ...configured,
      installedPath: configured.installedPath ?? runtime.installedPath,
    };
  });
  return [...merged, ...runtimeByName.values()];
}

export function isSkillRuntimeConfirmed(
  status: SkillsStatus | undefined,
  skillName: string,
  enabled: boolean,
): boolean {
  if (!isSkillsRuntimeCurrent(status)) return false;
  const skill = status?.runtimeSkills?.find(
    (candidate) => candidate.name === skillName,
  );
  return skill !== undefined && (skill.status !== 'disabled') === enabled;
}
