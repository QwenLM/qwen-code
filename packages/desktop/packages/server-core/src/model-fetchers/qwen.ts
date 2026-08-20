/**
 * Qwen Model Fetcher
 *
 * Qwen Code exposes its selectable models through ACP session/new.
 */

import type { ModelFetcher, ModelFetchResult, ModelFetcherCredentials } from '@craft-agent/shared/config'
import type { LlmConnection } from '@craft-agent/shared/config'
import { fetchBackendModels } from '@craft-agent/shared/agent/backend'
import { getHostRuntime } from './runtime'

export class QwenModelFetcher implements ModelFetcher {
  /** Qwen models are read on demand/startup from the local Qwen Code CLI. */
  readonly refreshIntervalMs = 0

  async fetchModels(
    connection: LlmConnection,
    credentials: ModelFetcherCredentials,
  ): Promise<ModelFetchResult> {
    return fetchBackendModels({
      connection,
      credentials,
      timeoutMs: 45_000,
      hostRuntime: getHostRuntime(),
    })
  }
}
