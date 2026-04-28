/**
 * Provider Icons
 *
 * Maps LLM provider types and base URLs to their respective brand icons.
 * Used in AI Settings page and anywhere connection logos are needed.
 */

import awsIcon from '@/assets/provider-icons/aws.svg'
import azureIcon from '@/assets/provider-icons/azure.svg'
import claudeIcon from '@/assets/provider-icons/claude.svg'
import copilotIcon from '@/assets/provider-icons/copilot.svg'
import googleIcon from '@/assets/provider-icons/google.svg'
import huggingfaceIcon from '@/assets/provider-icons/huggingface.svg'
import kimiIcon from '@/assets/provider-icons/kimi.svg'
import minimaxIcon from '@/assets/provider-icons/minimax.svg'
import mistralIcon from '@/assets/provider-icons/mistral.svg'
import ollamaIcon from '@/assets/provider-icons/ollama.svg'
import openaiIcon from '@/assets/provider-icons/openai.svg'
import openrouterIcon from '@/assets/provider-icons/openrouter.svg'
import piIcon from '@/assets/provider-icons/pi.svg'
import vercelIcon from '@/assets/provider-icons/vercel.svg'

import type { LlmProviderType } from '@craft-agent/shared/config/llm-connections'

/**
 * Icon URLs for each provider
 */
export const providerIcons = {
  anthropic: claudeIcon,
  aws: awsIcon,
  azure: azureIcon,
  copilot: copilotIcon,
  google: googleIcon,
  huggingface: huggingfaceIcon,
  kimi: kimiIcon,
  minimax: minimaxIcon,
  mistral: mistralIcon,
  ollama: ollamaIcon,
  openai: openaiIcon,
  openrouter: openrouterIcon,
  pi: piIcon,
  vercel: vercelIcon,
} as const

export type ProviderIconKey = keyof typeof providerIcons

/** Human-readable provider names */
const providerDisplayNames: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openai_compat: 'OpenAI',
  copilot: 'GitHub Copilot',
  deepseek: 'DeepSeek',
  kimi: 'Kimi',
  minimax: 'Minimax',
  ollama: 'Ollama',
  openrouter: 'OpenRouter',
  pi: 'Craft Agents Backend',
  pi_compat: 'Craft Agents Backend',
  qwen: 'Qwen Code',
  vercel: 'Vercel',
}

/** Get a human-readable provider name from provider type and optional base URL */
export function getProviderDisplayName(providerType: string, baseUrl?: string | null): string {
  // Try URL detection first for compat providers
  if (baseUrl) {
    const url = baseUrl.toLowerCase()
    if (url.includes('openrouter.ai')) return 'OpenRouter'
    if (url.includes('ollama')) return 'Ollama'
    if (url.includes('kimi.com')) return 'Kimi'
    if (url.includes('minimax.io') || url.includes('minimaxi.com')) return 'Minimax'
    if (url.includes('v0.dev') || url.includes('vercel')) return 'Vercel'
  }
  return providerDisplayNames[providerType] || providerType
}

/**
 * Detect provider from base URL
 */
function detectProviderFromUrl(baseUrl: string): ProviderIconKey | null {
  const url = baseUrl.toLowerCase()

  if (url.includes('openrouter.ai')) return 'openrouter'
  if (url.includes('ollama')) return 'ollama'
  if (url.includes('api.anthropic.com')) return 'anthropic'
  if (url.includes('api.openai.com')) return 'openai'
  if (url.includes('v0.dev') || url.includes('vercel')) return 'vercel'
  if (url.includes('generativelanguage.googleapis.com') || url.includes('ai.google')) return 'google'
  if (url.includes('kimi.com')) return 'kimi'
  if (url.includes('minimax.io') || url.includes('minimaxi.com')) return 'minimax'
  if (url.includes('mistral.ai')) return 'mistral'
  if (url.includes('bedrock')) return 'aws'
  if (url.includes('huggingface.co')) return 'huggingface'

  return null
}

/**
 * Map Pi SDK auth provider names to icon keys.
 * For Pi connections, we show the actual upstream provider's icon
 * instead of the generic Pi logo.
 */
function piAuthProviderToIcon(piAuthProvider: string): ProviderIconKey | null {
  switch (piAuthProvider) {
    case 'openai':
    case 'openai-codex':
      return 'openai'
    case 'anthropic':
      return 'anthropic'
    case 'github-copilot':
      return 'copilot'
    case 'openrouter':
      return 'openrouter'
    case 'google':
      return 'google'
    case 'kimi-coding':
      return 'kimi'
    case 'minimax':
    case 'minimax-global':
    case 'minimax-cn':
      return 'minimax'
    case 'mistral':
      return 'mistral'
    case 'amazon-bedrock':
      return 'aws'
    case 'azure-openai-responses':
      return 'azure'
    case 'huggingface':
      return 'huggingface'
    case 'vercel-ai-gateway':
      return 'vercel'
    default:
      return null
  }
}

/**
 * Domain map for providers without static SVG icons.
 * Used to generate Google Favicon V2 URLs as fallback.
 */
const PI_AUTH_PROVIDER_DOMAINS: Record<string, string> = {
  groq: 'groq.com',
  xai: 'x.ai',
  cerebras: 'cerebras.ai',
  deepseek: 'deepseek.com',
  zai: 'z.ai',
}

/**
 * Get provider icon URL for a given provider type and optional base URL.
 * Base URL detection takes precedence for compatible providers (openai_compat, pi_compat).
 * For Pi connections, resolves to the upstream provider's icon via piAuthProvider.
 *
 * @param providerType - The LLM provider type
 * @param baseUrl - Optional custom base URL for detection
 * @param piAuthProvider - Optional Pi SDK auth provider (e.g. 'openai-codex', 'github-copilot')
 * @returns Icon URL string or null if no matching icon
 */
export function getProviderIcon(
  providerType: LlmProviderType | string,
  baseUrl?: string | null,
  piAuthProvider?: string | null
): string | null {
  // For compatible providers, try to detect from URL first
  if (baseUrl && (providerType === 'openai_compat' || providerType === 'pi_compat')) {
    const detectedProvider = detectProviderFromUrl(baseUrl)
    if (detectedProvider) {
      return providerIcons[detectedProvider]
    }
  }

  // Map provider type to icon
  switch (providerType) {
    case 'anthropic':
      return providerIcons.anthropic
    case 'openai':
    case 'openai_compat':
      return providerIcons.openai
    case 'copilot':
      return providerIcons.copilot
    case 'pi':
    case 'pi_compat': {
      // Resolve to actual upstream provider icon
      if (piAuthProvider) {
        const iconKey = piAuthProviderToIcon(piAuthProvider)
        if (iconKey) return providerIcons[iconKey]
        // Favicon fallback for providers without static SVGs
        const domain = PI_AUTH_PROVIDER_DOMAINS[piAuthProvider]
        if (domain) {
          return `https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&size=128&url=https://${domain}`
        }
      }
      return null  // Unknown/custom Pi provider — caller shows brain icon
    }
    default:
      // Try URL detection as fallback
      if (baseUrl) {
        const detectedProvider = detectProviderFromUrl(baseUrl)
        if (detectedProvider) {
          return providerIcons[detectedProvider]
        }
      }
      return null
  }
}
