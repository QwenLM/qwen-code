/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Model } from '../../provider/model/model.js';
import type {
  ModelListOptions,
  ModelResolver,
} from '../../provider/model/modelResolver.js';
import { runLogger } from '../../utils/runLogger.js';
import { orderSubscriptionModels, qwenSubscriptionModel } from './models.js';
import type { QwenSubscriptionSession } from './session.js';

const CATALOG_TTL_MS = 60_000;

/**
 * Qwen membership catalog resolver.
 *
 * The catalog is written back into `models` so `CustomModelSelector` keeps
 * working with synchronous lookups; the resolver owns fetching, TTL caching
 * and the credential-cache fallback. A signed-out session clears the catalog
 * so `/model` and the session gate both see an unusable account.
 */
export function createQwenSubscriptionModelResolver(
  session: QwenSubscriptionSession,
  models: Model[],
): ModelResolver {
  let loadedAt = 0;
  let loading: Promise<Model[]> | undefined;

  function load(force = false): Promise<Model[]> {
    if (!force) {
      const fresh = loadedAt !== 0 && Date.now() - loadedAt < CATALOG_TTL_MS;
      if (fresh) return Promise.resolve([...models]);
      if (models.length === 0) {
        // Seed from the last successful catalog without touching the network.
        const cached = session.isSignedIn() ? session.getCachedModels() : [];
        if (cached.length > 0) {
          writeModels(models, toModels(cached));
          void refresh();
          return Promise.resolve([...models]);
        }
      } else {
        // Stale-while-revalidate: keep `/model` instant on a known catalog and
        // refresh in the background; only a cold cache awaits the fetch.
        void refresh();
        return Promise.resolve([...models]);
      }
    }
    return refresh();
  }

  function refresh(): Promise<Model[]> {
    loading ??= (async () => {
      try {
        if (!session.isSignedIn()) {
          writeModels(models, []);
        } else {
          const { models: ids } = await session.getModels();
          writeModels(models, toModels(ids));
        }
      } catch (error) {
        runLogger.warn(
          `[qwen-subscription] catalog unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        // Keep the last good catalog; never invent entries for the gate.
        if (models.length === 0) writeModels(models, []);
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
      if (options?.cachedOnly) {
        return Promise.resolve([...models]);
      }
      return load(options?.skipCache ?? false);
    },
    async getModel(key: string): Promise<Model | undefined> {
      const list = await load();
      return list.find((model) => model.key === key);
    },
  };
}

function toModels(ids: readonly string[]): Model[] {
  return orderSubscriptionModels(ids).map(qwenSubscriptionModel);
}

function writeModels(target: Model[], next: readonly Model[]): void {
  target.splice(0, target.length, ...next);
}
