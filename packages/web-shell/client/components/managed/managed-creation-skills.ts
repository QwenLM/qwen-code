import type {
  ManagedSessionSkill,
  ManagedSessionSkills,
} from './managed-agent-provider';

export interface ManagedCreationSkillsSource {
  workspaceCwd: string;
  list(signal: AbortSignal): Promise<ManagedSessionSkills['skills']>;
  load(signal: AbortSignal): Promise<ManagedSessionSkill[]>;
}

export function isManagedSessionSkills(
  value: unknown,
): value is ManagedSessionSkill[] {
  return (
    Array.isArray(value) &&
    value.length <= 256 &&
    value.every((skill: unknown) => {
      if (!skill || typeof skill !== 'object' || Array.isArray(skill))
        return false;
      const item = skill as Record<string, unknown>;
      return (
        Object.keys(item).every((key) =>
          [
            'name',
            'description',
            'body',
            'base_directory',
            'model_invocable',
            'user_invocable',
          ].includes(key),
        ) &&
        typeof item['name'] === 'string' &&
        typeof item['description'] === 'string' &&
        typeof item['body'] === 'string' &&
        (item['base_directory'] === undefined ||
          typeof item['base_directory'] === 'string') &&
        (item['model_invocable'] === undefined ||
          typeof item['model_invocable'] === 'boolean') &&
        (item['user_invocable'] === undefined ||
          typeof item['user_invocable'] === 'boolean')
      );
    })
  );
}
