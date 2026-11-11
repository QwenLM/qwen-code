/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Effort options advertised by the server for a reasoning model. */
export interface QoderModelReasoningConfig {
  /** Effort levels in server order. */
  readonly efforts: readonly string[];
  /** Server default effort, when one is marked. */
  readonly defaultEffort?: string;
  /** Whether the server advertises an explicit disable option. */
  readonly canDisable: boolean;
}

/**
 * One qcode model as advertised by the gateway. This is the catalog view, not
 * the host's `Model` DTO: capabilities and context tiers are mapped by the
 * provider adapter when the catalog is registered.
 */
export interface QoderModelCatalogEntry {
  readonly key: string;
  readonly displayName: string;
  /** Server-declared availability; disabled entries are retained. */
  readonly enabled: boolean;
  readonly isDefault: boolean;
  readonly isVision: boolean;
  readonly isReasoning: boolean;
  /** Selectable context tiers in ascending order; empty when not advertised. */
  readonly contextWindows: readonly number[];
  readonly defaultContextWindow?: number;
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
  readonly reasoning?: QoderModelReasoningConfig;
}

export class QoderModelCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QoderModelCatalogError';
  }
}

/**
 * Map the `/api/v3/model/list?categories=qcode` response body onto the
 * catalog view. Unknown entries are dropped rather than failing the catalog;
 * disabled entries are retained with `enabled: false`.
 */
export function mapQoderModelCatalog(
  body: unknown,
): QoderModelCatalogEntry[] {
  if (!isRecord(body) || !Array.isArray(body['qcode'])) {
    throw new QoderModelCatalogError(
      'Qoder model list returned an invalid response.',
    );
  }
  return body['qcode']
    .map((entry) => toCatalogEntry(entry))
    .filter((entry): entry is QoderModelCatalogEntry => entry !== undefined);
}

function toCatalogEntry(value: unknown): QoderModelCatalogEntry | undefined {
  if (!isRecord(value)) return undefined;
  const key = readString(value['key']);
  if (!key) return undefined;

  const context = resolveContextWindows(value);
  const maxInputTokens = positiveInteger(value['max_input_tokens']);
  const maxOutputTokens = positiveInteger(value['max_output_tokens']);
  const reasoning = resolveReasoning(value['thinking_config']);
  return {
    key,
    displayName: readString(value['display_name']) ?? key,
    enabled: asOptionalBool(value['enable']) !== false,
    isDefault: value['is_default'] === true,
    isVision: value['is_vl'] === true,
    isReasoning: value['is_reasoning'] === true,
    contextWindows: context.windows,
    ...(context.defaultWindow !== undefined
      ? { defaultContextWindow: context.defaultWindow }
      : {}),
    ...(maxInputTokens !== undefined ? { maxInputTokens } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(reasoning ? { reasoning } : {}),
  };
}

function resolveReasoning(
  value: unknown,
): QoderModelReasoningConfig | undefined {
  if (!isRecord(value)) return undefined;
  const enabled = isRecord(value['enabled']) ? value['enabled'] : undefined;
  const effortsRecord =
    enabled && isRecord(enabled['efforts']) ? enabled['efforts'] : undefined;
  const efforts: string[] = [];
  let defaultEffort: string | undefined;

  if (effortsRecord) {
    for (const [level, config] of Object.entries(effortsRecord)) {
      if (!level.trim()) continue;
      efforts.push(level);
      if (
        defaultEffort === undefined &&
        isRecord(config) &&
        config['is_default'] === true
      ) {
        defaultEffort = level;
      }
    }
  }

  const canDisable = isRecord(value['disabled']);
  if (efforts.length === 0 && !canDisable) {
    return undefined;
  }
  return {
    efforts,
    ...(defaultEffort !== undefined ? { defaultEffort } : {}),
    canDisable,
  };
}

function resolveContextWindows(value: Record<string, unknown>): {
  windows: number[];
  defaultWindow?: number;
} {
  const windows = new Set<number>();
  let defaultWindow = positiveInteger(value['default_context_window']);

  const contextConfig = value['context_config'];
  if (isRecord(contextConfig)) {
    for (const tier of Object.values(contextConfig)) {
      if (!isRecord(tier)) continue;
      const tokens = positiveInteger(tier['token_count']);
      if (tokens === undefined) continue;
      windows.add(tokens);
      if (defaultWindow === undefined && tier['is_default'] === true) {
        defaultWindow = tokens;
      }
    }
  }

  return {
    windows: [...windows].sort((a, b) => a - b),
    ...(defaultWindow !== undefined ? { defaultWindow } : {}),
  };
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

/** Optional boolean: boolean, 1/'1', or 0/'0'; other values are unspecified. */
function asOptionalBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  return undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
