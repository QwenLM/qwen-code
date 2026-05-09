export interface QwenMemorySettings {
  enableManagedAutoMemory: boolean;
  enableManagedAutoDream: boolean;
  enableAutoSkill: boolean;
}

export interface QwenMemoryPaths {
  userMemoryFile: string;
  projectMemoryFile: string;
  autoMemoryDir: string;
}

export type QwenMemoryPathTarget = 'user' | 'project' | 'auto';

export const DEFAULT_QWEN_MEMORY_SETTINGS: QwenMemorySettings = {
  enableManagedAutoMemory: true,
  enableManagedAutoDream: false,
  enableAutoSkill: false,
};

type JsonRecord = Record<string, unknown>;

export function normalizeQwenMemorySettings(
  value: unknown,
): QwenMemorySettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_QWEN_MEMORY_SETTINGS };
  }

  const memoryRecord = value as JsonRecord;
  return {
    enableManagedAutoMemory:
      typeof memoryRecord.enableManagedAutoMemory === 'boolean'
        ? memoryRecord.enableManagedAutoMemory
        : DEFAULT_QWEN_MEMORY_SETTINGS.enableManagedAutoMemory,
    enableManagedAutoDream:
      typeof memoryRecord.enableManagedAutoDream === 'boolean'
        ? memoryRecord.enableManagedAutoDream
        : DEFAULT_QWEN_MEMORY_SETTINGS.enableManagedAutoDream,
    enableAutoSkill:
      typeof memoryRecord.enableAutoSkill === 'boolean'
        ? memoryRecord.enableAutoSkill
        : DEFAULT_QWEN_MEMORY_SETTINGS.enableAutoSkill,
  };
}
