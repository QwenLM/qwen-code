/**
 * Centralized model registry.
 *
 * Qwen Code reports the live model list through ACP at session startup. The
 * static registry below provides a stable fallback for first-run UI, tests, and
 * utility calls before ACP metadata is available.
 */

export type ModelProvider = 'qwen';

export interface ModelDefinition {
  id: string;
  name: string;
  shortName: string;
  description: string;
  descriptionKey?: string;
  provider: ModelProvider;
  contextWindow?: number;
  supportsThinking?: boolean;
}

export const DEFAULT_MODEL = 'qwen3-coder';

export const MODEL_REGISTRY: ModelDefinition[] = [
  {
    id: DEFAULT_MODEL,
    name: 'Qwen3 Coder',
    shortName: 'Qwen',
    description: 'Default Qwen Code model',
    provider: 'qwen',
    contextWindow: 1_000_000,
  },
];

export function getModelsByProvider(provider: ModelProvider): ModelDefinition[] {
  return MODEL_REGISTRY.filter((model) => model.provider === provider);
}

export const QWEN_MODELS = getModelsByProvider('qwen');

/** Compatibility export for older imports. */
export const MODELS = QWEN_MODELS;

export function getDefaultSummarizationModel(): string {
  return DEFAULT_MODEL;
}

export function getModelById(modelId: string): ModelDefinition | undefined {
  return MODEL_REGISTRY.find((model) => model.id === modelId);
}

function humanizeModelId(modelId: string): string {
  const id = modelId.includes('/') ? modelId.split('/').pop() || modelId : modelId;
  return id
    .replace(/^qwen[-_]?/i, 'Qwen ')
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => {
      if (/^qwen/i.test(part)) return part.replace(/^qwen/i, 'Qwen');
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(' ');
}

export function getModelDisplayName(modelId: string): string {
  return getModelById(modelId)?.name ?? humanizeModelId(modelId);
}

export function getModelShortName(modelId: string): string {
  return getModelById(modelId)?.shortName ?? humanizeModelId(modelId);
}

export function getModelContextWindow(modelId: string): number | undefined {
  return getModelById(modelId)?.contextWindow;
}

export function isOpusModel(_modelId: string): boolean {
  return false;
}

export function isQwenModel(modelId: string): boolean {
  return modelId.toLowerCase().includes('qwen');
}

export function getModelProvider(modelId: string): ModelProvider | undefined {
  return getModelById(modelId)?.provider ?? (isQwenModel(modelId) ? 'qwen' : undefined);
}
