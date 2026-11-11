/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

const DISCOVERY_TIMEOUT_MS = 5_000;
const DISCOVERY_MAX_BYTES = 1024 * 1024;
const MAX_MODEL_ID_LENGTH = 256;
const UNSAFE_MODEL_ID_CHARS = /[,\p{C}\p{Zl}\p{Zp}]/u;

export interface DiscoverProviderModelsOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
}

/**
 * `GET {baseUrl}/models` with the provider key. Returns `null` whenever the
 * endpoint cannot be trusted or reached; the wizard keeps its seeded list.
 */
export async function discoverProviderModels(
  options: DiscoverProviderModelsOptions,
): Promise<string[] | null> {
  const baseUrl = options.baseUrl.trim().replace(/\/+$/, '');
  const apiKey = options.apiKey.trim();
  if (!baseUrl || !apiKey) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  const detach = linkAbortSignal(options.signal, controller);
  try {
    const response = await (options.fetchImpl ?? fetch)(
      `${baseUrl}/models`,
      {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        signal: controller.signal,
      },
    );
    if (!response.ok) return null;
    const body = await response.text();
    if (body.length > DISCOVERY_MAX_BYTES) return null;
    const models = readModels(JSON.parse(body));
    return models
      ? orderModels(models).map((model) => model.id)
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    detach?.();
  }
}

interface DiscoveredModel {
  readonly id: string;
  readonly created?: number;
}

function readModels(value: unknown): DiscoveredModel[] | null {
  if (!isRecord(value) || !Array.isArray(value['data'])) return null;
  const models: DiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const item of value['data']) {
    if (!isRecord(item)) return null;
    const id = readString(item['id']);
    if (id === undefined) return null;
    const trimmed = id.trim();
    if (
      trimmed &&
      trimmed.length <= MAX_MODEL_ID_LENGTH &&
      !UNSAFE_MODEL_ID_CHARS.test(trimmed) &&
      !seen.has(trimmed)
    ) {
      seen.add(trimmed);
      const created = item['created'];
      const creationTime =
        typeof created === 'number' &&
        Number.isFinite(created) &&
        created >= 0
          ? created
          : undefined;
      models.push({
        id: trimmed,
        ...(creationTime === undefined ? {} : { created: creationTime }),
      });
    }
  }
  return models.length > 0 ? models : null;
}

/** 与上游一致：全部条目都有 created 时按新到旧排序，否则保留服务端顺序。 */
function orderModels(models: DiscoveredModel[]): DiscoveredModel[] {
  if (!models.every((model) => model.created !== undefined)) return models;
  return [...models].sort(
    (left, right) => (right.created ?? 0) - (left.created ?? 0),
  );
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function linkAbortSignal(
  caller: AbortSignal | undefined,
  controller: AbortController,
): (() => void) | undefined {
  if (!caller) return undefined;
  if (caller.aborted) {
    controller.abort(caller.reason);
    return undefined;
  }
  const abort = () => controller.abort(caller.reason);
  caller.addEventListener('abort', abort, { once: true });
  return () => caller.removeEventListener('abort', abort);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
