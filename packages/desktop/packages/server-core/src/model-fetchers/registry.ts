/**
 * Model Fetcher Registry
 *
 * Type-safe map from FetchableProvider → ModelFetcher.
 * TypeScript enforces that every FetchableProvider key is present.
 * Adding a new LlmProviderType without registering a fetcher → compile error.
 */

import type { ModelFetcherMap } from '@craft-agent/shared/config'
import { QwenModelFetcher } from './qwen'

// Shared instances — fetchers are stateless
const qwenFetcher = new QwenModelFetcher()

/**
 * Every FetchableProvider MUST have a fetcher entry.
 * If you add a new LlmProviderType (e.g., 'gemini') and don't exclude it
 * from FetchableProvider, this object will fail to compile until you add it here.
 */
export const MODEL_FETCHERS: ModelFetcherMap = {
  qwen: qwenFetcher,
}
