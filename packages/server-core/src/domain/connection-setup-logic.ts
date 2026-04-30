/**
 * Connection Setup Logic
 *
 * Pure functions extracted from ipc.ts for testability.
 * No dependency on ipcMain, sessionManager, credential manager, or file I/O.
 */

import type { ModelDefinition } from '@craft-agent/shared/config/models'
import {
  type LlmConnection,
  getDefaultModelsForConnection,
  getDefaultModelForConnection,
} from '@craft-agent/shared/config'

// ============================================================
// Error Parsing
// ============================================================

/**
 * Parse an error message from a connection test into a user-friendly string.
 */
export function parseTestConnectionError(msg: string): string {
  const lower = msg.toLowerCase()

  if (lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('fetch failed')) {
    return 'Cannot connect to API server. Check the URL and ensure the server is running.'
  }
  if (lower.includes('no api key found for')) {
    return 'Provider mismatch during setup. Select a provider preset in Craft Agents Backend API Key mode, or use Anthropic API Key mode for arbitrary compatible endpoints.'
  }
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('authentication')) {
    return 'Invalid API key'
  }
  if (lower.includes('404') && lower.includes('model')) {
    return 'Model not found. Check the model name and try again.'
  }
  if (lower.includes('404')) {
    return 'API endpoint not found. Check the URL.'
  }
  if (lower.includes('429') || lower.includes('rate limit')) {
    return 'Rate limit exceeded. Please try again.'
  }
  if (lower.includes('403')) {
    return 'API key does not have permission to access this resource'
  }

  return msg.slice(0, 300)
}

/**
 * Guard against ambiguous Pi custom endpoint tests where no provider routing is selected.
 */
export function validateSetupTestInput(params: {
  provider: 'anthropic' | 'pi' | 'qwen'
  baseUrl?: string
  piAuthProvider?: string
}): { valid: true } | { valid: false; error: string } {
  const hasCustomEndpoint = !!params.baseUrl?.trim()
  if (params.provider === 'pi' && hasCustomEndpoint && !params.piAuthProvider) {
    return {
      valid: false,
      error: 'Custom endpoint in Craft Agents Backend mode requires selecting a provider preset. For arbitrary Anthropic-compatible endpoints, use Anthropic API Key mode.',
    }
  }

  return { valid: true }
}

/**
 * Returns true when a URL points to local loopback.
 * Used to permit keyless setup tests for local model runtimes (e.g. Ollama).
 */
export function isLoopbackBaseUrl(baseUrl?: string): boolean {
  if (!baseUrl?.trim()) return false
  try {
    const hostname = new URL(baseUrl.trim()).hostname
    const normalizedHostname = hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname
    return normalizedHostname === 'localhost' || normalizedHostname === '127.0.0.1' || normalizedHostname === '::1'
  } catch {
    return false
  }
}

/**
 * Setup tests require API keys for non-local endpoints, but local loopback
 * endpoints may be keyless.
 */
export function setupTestRequiresApiKey(baseUrl?: string): boolean {
  return !isLoopbackBaseUrl(baseUrl)
}

// ============================================================
// Built-in Connection Templates
// ============================================================

/**
 * Built-in connection templates for the onboarding flow.
 * Each template defines the default configuration for a known connection slug.
 */
export const BUILT_IN_CONNECTION_TEMPLATES: Record<string, {
  name: string | ((hasCustomEndpoint: boolean) => string)
  providerType: LlmConnection['providerType'] | ((hasCustomEndpoint: boolean) => LlmConnection['providerType'])
  authType: LlmConnection['authType'] | ((hasCustomEndpoint: boolean) => LlmConnection['authType'])
  piAuthProvider?: string
}> = {
  'anthropic-api': {
    name: (h) => h ? 'Custom Anthropic-Compatible' : 'Anthropic (API Key)',
    providerType: (h) => h ? 'pi_compat' : 'anthropic',
    authType: (h) => h ? 'api_key_with_endpoint' : 'api_key',
  },
  'claude-max': {
    name: 'Claude Max',
    providerType: 'anthropic',
    authType: 'oauth',
  },
  'chatgpt-plus': {
    name: 'ChatGPT Plus',
    providerType: 'pi',
    authType: 'oauth',
    piAuthProvider: 'openai-codex',
  },
  'github-copilot': {
    name: 'GitHub Copilot',
    providerType: 'pi',
    authType: 'oauth',
    piAuthProvider: 'github-copilot',
  },
  'pi-api-key': {
    name: 'Craft Agents Backend (API Key)',
    providerType: 'pi',
    authType: 'api_key',
    // piAuthProvider set dynamically from setup.piAuthProvider
  },
  'qwen-code': {
    name: 'Qwen Code',
    providerType: 'qwen',
    authType: 'none',
  },
}

// ============================================================
// Pi Auth Provider Display Names
// ============================================================

const PI_AUTH_PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'openai-codex': 'OpenAI',
  google: 'Google AI Studio',
  openrouter: 'OpenRouter',
  'azure-openai-responses': 'Azure OpenAI',
  'amazon-bedrock': 'Amazon Bedrock',
  groq: 'Groq',
  mistral: 'Mistral',
  xai: 'xAI',
  cerebras: 'Cerebras',
  zai: 'z.ai',
  huggingface: 'Hugging Face',
  minimax: 'Minimax',
  'minimax-cn': 'Minimax CN',
  'kimi-coding': 'Kimi (Coding)',
  'vercel-ai-gateway': 'Vercel AI Gateway',
}

/** Get a human-readable display name for a Pi auth provider key */
export function piAuthProviderDisplayName(piAuthProvider: string): string | null {
  return PI_AUTH_PROVIDER_DISPLAY_NAMES[piAuthProvider] ?? null
}

// ============================================================
// Connection Creation
// ============================================================

/**
 * Create an LLM connection configuration from a connection slug.
 * Uses built-in templates for known slugs, throws for unknown slugs
 * (custom connections are created through the settings UI).
 */
export function createBuiltInConnection(slug: string, baseUrl?: string | null): LlmConnection {
  // Try exact match first, then strip numeric suffix for derived slugs (e.g. 'anthropic-api-2' → 'anthropic-api')
  const baseSlug = slug.replace(/-\d+$/, '')
  const template = BUILT_IN_CONNECTION_TEMPLATES[slug] ?? BUILT_IN_CONNECTION_TEMPLATES[baseSlug]
  if (!template) {
    throw new Error(`Unknown built-in connection slug: ${slug}. Custom connections should be created through settings.`)
  }

  const hasCustomEndpoint = !!baseUrl
  const providerType = typeof template.providerType === 'function'
    ? template.providerType(hasCustomEndpoint)
    : template.providerType
  const authType = typeof template.authType === 'function'
    ? template.authType(hasCustomEndpoint)
    : template.authType
  let name = typeof template.name === 'function'
    ? template.name(hasCustomEndpoint)
    : template.name

  // Append suffix number to name for derived connections (e.g. 'anthropic-api-2' → 'Anthropic (API Key) 2')
  const suffixMatch = slug.match(/-(\d+)$/)
  if (suffixMatch && !BUILT_IN_CONNECTION_TEMPLATES[slug]) {
    name = `${name} ${suffixMatch[1]}`
  }

  const connection: LlmConnection = {
    slug,
    name,
    providerType,
    authType,
    modelSelectionMode: providerType === 'pi' ? 'automaticallySyncedFromProvider' : undefined,
    piAuthProvider: template.piAuthProvider,
    createdAt: Date.now(),
  }

  if (providerType !== 'qwen') {
    connection.models = getDefaultModelsForConnection(providerType, template.piAuthProvider)
    connection.defaultModel = getDefaultModelForConnection(providerType, template.piAuthProvider)
  }

  return connection
}

// ============================================================
// Model Validation
// ============================================================

/**
 * Validate that the default model exists in the provided model list.
 * Handles both string and ModelDefinition model entries.
 *
 * This was extracted from inline logic in the setupLlmConnection IPC handler
 * to fix a bug where Array.includes() compared strings against ModelDefinition
 * objects, always returning false for Pi connections.
 */
export function validateModelList(
  models: Array<ModelDefinition | string>,
  defaultModel: string | undefined,
): { valid: boolean; error?: string; resolvedDefaultModel?: string } {
  if (!models || models.length === 0) {
    return { valid: true }
  }

  const modelIds = models.map(m => typeof m === 'string' ? m : m.id)

  if (defaultModel && !modelIds.includes(defaultModel)) {
    return {
      valid: false,
      error: `Default model "${defaultModel}" is not in the provided model list.`,
    }
  }

  if (!defaultModel) {
    const firstModel = models[0]
    const firstModelId = typeof firstModel === 'string' ? firstModel : firstModel!.id
    return {
      valid: true,
      resolvedDefaultModel: firstModelId,
    }
  }

  return { valid: true }
}
