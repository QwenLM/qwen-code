/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Model,
  ModelConfig,
  ReasoningEffortLevel,
} from '../../provider/model/model.js';
import type {
  ModelListOptions,
  ModelResolver,
} from '../../provider/model/modelResolver.js';
import { QODER_PROVIDER_ID } from '../../provider/modelProvider.js';
import { runLogger } from '../../utils/runLogger.js';
import type { QoderClient } from './client/qoderClient.js';
import type {
  QoderModelCatalogEntry,
  QoderModelReasoningConfig,
} from './model-catalog.js';

const CATALOG_TTL_MS = 60_000;

const REASONING_EFFORTS: readonly ReasoningEffortLevel[] = [
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/** Map one gateway catalog entry onto the host `Model` DTO. */
export function toQoderModel(entry: QoderModelCatalogEntry): Model {
  const contextWindows = entry.contextWindows.map((tokens) => ({ tokens }));
  const maxContextTokens =
    entry.contextWindows.length > 0
      ? Math.max(...entry.contextWindows)
      : (entry.maxInputTokens ?? entry.defaultContextWindow ?? 0);
  const defaultModelConfig = buildDefaultModelConfig(entry);

  return {
    source: QODER_PROVIDER_ID,
    key: entry.key,
    displayName: entry.displayName,
    enabled: entry.enabled,
    isDefault: entry.isDefault,
    capabilities: {
      tools: true,
      vision: entry.isVision,
      reasoning: {
        supported: entry.isReasoning,
        supportedEfforts: mapEfforts(entry),
      },
      contextWindows,
    },
    limits: {
      maxContextTokens,
      ...(entry.maxOutputTokens !== undefined
        ? { maxOutputTokens: entry.maxOutputTokens }
        : {}),
    },
    ...(defaultModelConfig ? { defaultModelConfig } : {}),
  };
}

/**
 * Qoder catalog resolver backed by the shared client.
 *
 * The catalog is written back into `models` so the existing
 * `CustomModelSelector` keeps working with its synchronous lookups; the
 * resolver owns fetching, TTL caching, and the bootstrap fallback.
 */
export function createQoderModelResolver(
  client: QoderClient,
  models: Model[],
): ModelResolver {
  let loadedAt = 0;
  let loading: Promise<Model[]> | undefined;

  function load(force = false): Promise<Model[]> {
    const fresh =
      loadedAt !== 0 && Date.now() - loadedAt < CATALOG_TTL_MS;
    if (!force && fresh) {
      return Promise.resolve([...models]);
    }
    // Stale-while-revalidate: keep /model instant on a known catalog and
    // refresh it in the background; only a cold cache awaits the fetch.
    if (!force && models.length > 0) {
      void refresh();
      return Promise.resolve([...models]);
    }
    return refresh();
  }

  function refresh(): Promise<Model[]> {
    loading ??= (async () => {
      if (!(await hasConnectedAccount(client))) {
        // No account: keep the catalog empty so /model and the session gate
        // both see an unusable account.
        writeModels(models, []);
        loadedAt = Date.now();
        return [];
      }
      try {
        const entries = await client.api.models.list();
        // Only the account's real catalog is listed; no synthetic entries.
        const next = entries.map(toQoderModel);
        writeModels(models, next);
        runLogger.debug(`[qoder-models] catalog loaded: ${next.length} models`);
      } catch (error) {
        runLogger.warn(
          `[qoder-models] catalog unavailable: ${error}`,
        );
        // Keep the last good catalog, otherwise stay empty: a fallback entry
        // here would make the gate consider the account usable.
        if (models.length === 0) {
          writeModels(models, []);
        }
      }
      loadedAt = Date.now();
      return [...models];
    })().finally(() => {
      loading = undefined;
    });
    return loading;
  }

  return {
    listModels(options?: ModelListOptions): Promise<Model[]> {
      return load(options?.skipCache ?? false);
    },
    async getModel(key: string): Promise<Model | undefined> {
      const list = await load();
      return list.find((model) => model.key === key);
    },
  };
}

function writeModels(target: Model[], next: readonly Model[]): void {
  target.splice(0, target.length, ...next);
}

async function hasConnectedAccount(client: QoderClient): Promise<boolean> {
  try {
    const status = await client.api.auth.getStatus();
    return (
      status.state === 'authenticated' || status.state === 'refresh_required'
    );
  } catch {
    return false;
  }
}

function buildDefaultModelConfig(
  entry: QoderModelCatalogEntry,
): ModelConfig | undefined {
  const effort = entry.reasoning?.defaultEffort;
  const reasoning =
    effort && isReasoningEffortLevel(effort) ? { effort } : undefined;
  const context =
    entry.defaultContextWindow !== undefined
      ? { contextWindow: entry.defaultContextWindow }
      : undefined;
  if (!reasoning && !context) {
    return undefined;
  }
  return {
    ...(reasoning ? { reasoning } : {}),
    ...(context ? { context } : {}),
  };
}

function mapEfforts(
  entry: QoderModelCatalogEntry,
): readonly ReasoningEffortLevel[] {
  if (!entry.isReasoning) {
    return [];
  }
  const advertised = (entry.reasoning?.efforts ?? []).filter(
    isReasoningEffortLevel,
  );
  const levels: readonly ReasoningEffortLevel[] =
    advertised.length > 0
      ? advertised
      : (['low', 'medium', 'high'] as const);
  return canDisableWithoutDuplicate(entry.reasoning, levels)
    ? ['none', ...levels]
    : levels;
}

function canDisableWithoutDuplicate(
  reasoning: QoderModelReasoningConfig | undefined,
  levels: readonly ReasoningEffortLevel[],
): boolean {
  return reasoning?.canDisable === true && !levels.includes('none');
}

function isReasoningEffortLevel(
  value: string,
): value is ReasoningEffortLevel {
  return (REASONING_EFFORTS as readonly string[]).includes(value);
}
