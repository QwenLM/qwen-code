/**
 * Centralized Model Registry
 *
 * Single source of truth for all model definitions across the application.
 * All model metadata, capabilities, and costs are defined here.
 *
 * When adding a new model or provider:
 * 1. Add the model(s) to MODEL_REGISTRY
 * 2. The convenience exports (ANTHROPIC_MODELS, OPENAI_MODELS) auto-update
 * 3. Update llm-connections.ts if adding a new built-in connection
 */
// Bedrock-native → bare Anthropic ID reverse mapping.
// Duplicated from llm-connections.ts to avoid circular imports (llm-connections imports models).
// Must stay in sync with BEDROCK_MODEL_MAP in llm-connections.ts.
const BEDROCK_TO_BARE: Record<string, string> = {
  // US inference profile IDs (primary)
  'us.anthropic.claude-opus-4-7-v1': 'claude-opus-4-7',
  'us.anthropic.claude-sonnet-4-6': 'claude-sonnet-4-6',
  'us.anthropic.claude-haiku-4-5-20251001-v1:0': 'claude-haiku-4-5-20251001',
  'us.anthropic.claude-opus-4-6-v1': 'claude-opus-4-6',
  'us.anthropic.claude-opus-4-5-20251101-v1:0': 'claude-opus-4-5-20251101',
  'us.anthropic.claude-sonnet-4-5-20250929-v1:0': 'claude-sonnet-4-5-20250929',
  // EU inference profile IDs
  'eu.anthropic.claude-opus-4-7-v1': 'claude-opus-4-7',
  'eu.anthropic.claude-sonnet-4-6': 'claude-sonnet-4-6',
  'eu.anthropic.claude-haiku-4-5-20251001-v1:0': 'claude-haiku-4-5-20251001',
  'eu.anthropic.claude-opus-4-6-v1': 'claude-opus-4-6',
  'eu.anthropic.claude-opus-4-5-20251101-v1:0': 'claude-opus-4-5-20251101',
  'eu.anthropic.claude-sonnet-4-5-20250929-v1:0': 'claude-sonnet-4-5-20250929',
  // Global inference profile IDs
  'global.anthropic.claude-opus-4-7-v1': 'claude-opus-4-7',
  'global.anthropic.claude-sonnet-4-6': 'claude-sonnet-4-6',
  'global.anthropic.claude-haiku-4-5-20251001-v1:0': 'claude-haiku-4-5-20251001',
  'global.anthropic.claude-opus-4-6-v1': 'claude-opus-4-6',
  // Base IDs (no region prefix)
  'anthropic.claude-opus-4-7-v1': 'claude-opus-4-7',
  'anthropic.claude-sonnet-4-6': 'claude-sonnet-4-6',
  'anthropic.claude-haiku-4-5-20251001-v1:0': 'claude-haiku-4-5-20251001',
  'anthropic.claude-opus-4-6-v1': 'claude-opus-4-6',
  'anthropic.claude-opus-4-5-20251101-v1:0': 'claude-opus-4-5-20251101',
  'anthropic.claude-sonnet-4-5-20250929-v1:0': 'claude-sonnet-4-5-20250929',
};
function bedrockToBarId(modelId: string): string {
  return BEDROCK_TO_BARE[modelId] ?? modelId;
}

// ============================================
// TYPES
// ============================================

/**
 * Provider identifier for AI backends.
 */
export type ModelProvider = 'anthropic' | 'pi' | 'qwen';

/**
 * Full model definition with capabilities and costs.
 * Used throughout the application for model selection and display.
 */
export interface ModelDefinition {
  /** Model identifier (e.g., 'claude-sonnet-4-6', 'gpt-5.3-codex') */
  id: string;
  /** Human-readable name (e.g., 'Sonnet 4.6', 'Codex') */
  name: string;
  /** Short display name for compact UI (e.g., 'Sonnet', 'Codex') */
  shortName: string;
  /** Brief description of the model's strengths */
  description: string;
  /** Translation key for the description (for built-in static models only).
   *  UI should resolve: t(descriptionKey) if set, otherwise fall back to description. */
  descriptionKey?: string;
  /** Provider that offers this model */
  provider: ModelProvider;
  /** Maximum context window in tokens, when the provider reports it */
  contextWindow?: number;
  /** Whether this model supports thinking/reasoning effort. Defaults to true when undefined. */
  supportsThinking?: boolean;
}

// ============================================
// MODEL REGISTRY (Single Source of Truth)
// ============================================

/**
 * All available models across all providers.
 * This is the authoritative list - all other model arrays derive from this.
 */
export const MODEL_REGISTRY: ModelDefinition[] = [
  // ----------------------------------------
  // Anthropic Claude Models
  // ----------------------------------------
  {
    id: 'claude-opus-4-7',
    name: 'Opus 4.7',
    shortName: 'Opus',
    description: 'Most capable for complex work',
    descriptionKey: 'model.opusDesc',
    provider: 'anthropic',
    contextWindow: 1_000_000,
  },
  // TODO(opus-4.6-sunset): remove this entry when Opus 4.6 is deprecated by
  // Anthropic or we stop offering it. Also drop the related 4.6 pieces in
  // llm-connections.ts PI_PREFERRED_DEFAULTS and the restoreOpus46ToAnthropicConnections
  // migration in storage.ts (grep for TODO(opus-4.6-sunset) to find them all).
  {
    id: 'claude-opus-4-6',
    name: 'Opus 4.6',
    // shortName intentionally collides with 4.7. 4.7 is listed first, so
    // findModelIdByShortName('Opus') keeps returning 4.7 — zero behavior
    // change for callers that reference "Opus" abstractly.
    shortName: 'Opus',
    description: 'Previous Opus release',
    descriptionKey: 'model.opusDesc',
    provider: 'anthropic',
    contextWindow: 200_000,
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Sonnet 4.6',
    shortName: 'Sonnet',
    description: 'Best for everyday tasks',
    descriptionKey: 'model.sonnetDesc',
    provider: 'anthropic',
    contextWindow: 200_000,
  },
  {
    id: 'claude-haiku-4-5-20251001',
    name: 'Haiku 4.5',
    shortName: 'Haiku',
    description: 'Fastest for quick answers',
    descriptionKey: 'model.haikuDesc',
    provider: 'anthropic',
    contextWindow: 200_000,
  },

  // ----------------------------------------
  // Pi Models
  // No hardcoded entries — models are discovered dynamically:
  //   - Pi: getModels(provider) from @mariozechner/pi-ai SDK
  // See ModelRefreshService in apps/electron/src/main/model-fetchers/
  // ----------------------------------------
];

// ============================================
// PROVIDER-FILTERED EXPORTS
// ============================================

/**
 * Get models filtered by provider.
 */
export function getModelsByProvider(provider: ModelProvider): ModelDefinition[] {
  return MODEL_REGISTRY.filter(m => m.provider === provider);
}

/** All Anthropic Claude models */
export const ANTHROPIC_MODELS = getModelsByProvider('anthropic');


/**
 * Legacy compatibility export.
 * Used by existing code that imports MODELS (expects Claude models only).
 * @deprecated Use ANTHROPIC_MODELS or MODEL_REGISTRY instead
 */
export const MODELS = ANTHROPIC_MODELS;

// ============================================
// MODEL ID HELPERS (Derived from Registry)
// ============================================

/** Get the first model ID matching a short name, or undefined if not found */
function findModelIdByShortName(shortName: string): string | undefined {
  return MODEL_REGISTRY.find(m => m.shortName === shortName)?.id;
}

/** Get the first model ID matching a short name (throws if not found) */
export function getModelIdByShortName(shortName: string): string {
  const id = findModelIdByShortName(shortName);
  if (!id) throw new Error(`Model not found: ${shortName}`);
  return id;
}

// ============================================
// CONNECTION DEFAULTS
// Used ONLY when writing defaults to LLM connection config (not as runtime fallbacks).
// ============================================

/** Default model for Anthropic connections (used when creating/backfilling connections) */
export const DEFAULT_MODEL = getModelIdByShortName('Opus');


// ============================================
// UTILITY MODELS
// ============================================

/**
 * Get the default summarization model ID (Haiku).
 * Used as fallback when no connection context is available
 * (e.g., url-validator, mcp/validation, summarize.ts without modelOverride).
 *
 * For connection-aware summarization model resolution, use
 * getSummarizationModel(connection) from llm-connections.ts instead.
 */
export function getDefaultSummarizationModel(): string {
  return findModelIdByShortName('Haiku') ?? DEFAULT_MODEL;
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Get a model by ID from the registry.
 * Also handles Bedrock-native IDs (e.g. "anthropic.claude-opus-4-7-v1")
 * by reverse-mapping to the bare Anthropic ID for lookup.
 */
export function getModelById(modelId: string): ModelDefinition | undefined {
  return MODEL_REGISTRY.find(m => m.id === modelId)
    ?? MODEL_REGISTRY.find(m => m.id === bedrockToBarId(modelId));
}

/**
 * Get display name for a model ID (full name with version).
 */
export function getModelDisplayName(modelId: string): string {
  const model = getModelById(modelId);
  if (model) return model.name;
  // Fallback: normalize Bedrock-native IDs, then strip prefix and date suffix
  // e.g., "claude-opus-4-5-20251101" → "Opus 4.5"
  const normalized = bedrockToBarId(modelId);
  const stripped = normalized
    .replace('claude-', '')
    .replace(/-\d{8}$/, '');  // Remove date suffix
  // Split on dashes, capitalize first part, join version parts with dots
  const parts = stripped.split('-');
  const first = parts[0];
  if (!first) return modelId;
  const name = first.charAt(0).toUpperCase() + first.slice(1);
  const version = parts.slice(1).join('.');
  return version ? `${name} ${version}` : name;
}

/**
 * Get short display name for a model ID (without version number).
 */
export function getModelShortName(modelId: string): string {
  const model = getModelById(modelId);
  if (model) return model.shortName;
  // For provider-prefixed IDs (e.g. "openai/gpt-5"), show just the model part
  if (modelId.includes('/')) {
    return modelId.split('/').pop() || modelId;
  }
  // Fallback: normalize Bedrock-native IDs, then humanize (same logic as getModelDisplayName)
  const normalized = bedrockToBarId(modelId);
  const stripped = normalized.replace('claude-', '').replace(/-\d{8}$/, '');
  const parts = stripped.split('-');
  const first = parts[0];
  if (!first) return modelId;
  const name = first.charAt(0).toUpperCase() + first.slice(1);
  const version = parts.slice(1).join('.');
  return version ? `${name} ${version}` : name;
}

/**
 * Get known context window size for a model ID.
 */
export function getModelContextWindow(modelId: string): number | undefined {
  return getModelById(modelId)?.contextWindow;
}

/**
 * Check if model is an Opus model (for cache TTL decisions).
 */
export function isOpusModel(modelId: string): boolean {
  return modelId.includes('opus');
}

/**
 * Check if a model ID refers to a Claude model.
 * Handles direct Anthropic IDs (e.g. "claude-sonnet-4-6"),
 * provider-prefixed IDs (e.g. "anthropic/claude-sonnet-4" via OpenRouter),
 * and Bedrock-native IDs (e.g. "anthropic.claude-opus-4-7-v1").
 */
export function isClaudeModel(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return lower.startsWith('claude-') || lower.includes('/claude') || lower.includes('.claude');
}


/**
 * Get the provider for a model ID.
 */
export function getModelProvider(modelId: string): ModelProvider | undefined {
  return getModelById(modelId)?.provider;
}
