/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModalityProbeVerdict } from './probe.js';

/** A persisted probe verdict. `verdict` is `image` or `text_only` — `unknown`
 * results are never persisted (no conclusion, nothing to cache). */
export interface ModalityProbeRecord {
  readonly verdict: Exclude<ModalityProbeVerdict, 'unknown'>;
  readonly probedAt: string;
}

export type ProbeResultStore = Record<string, ModalityProbeRecord>;

/** `|` is an acceptable separator: realistic authType/modelId/baseUrl values
 * never contain it, so the worst case is one wrong advisory verdict that a
 * re-probe overwrites — and `\0` (used by modelRegistryKey) would be hostile
 * in a human-editable settings.json. */
export function buildProbeKey(
  authType: string,
  modelId: string,
  baseUrl: string | undefined,
): string {
  return `${authType}|${modelId}|${baseUrl ?? ''}`;
}

export function readProbeResult(
  store: ProbeResultStore | undefined,
  authType: string,
  modelId: string,
  baseUrl: string | undefined,
): ModalityProbeRecord | undefined {
  return store?.[buildProbeKey(authType, modelId, baseUrl)];
}

/** Read-modify-write of the whole map — the composite keys embed dots
 * (hostnames in baseUrl), `|`, and `:`, which settings' dotted-path
 * addressing would mis-nest, so the caller persists the returned object as
 * the whole `probeResults` settings value. */
export function withProbeResult(
  store: ProbeResultStore | undefined,
  authType: string,
  modelId: string,
  baseUrl: string | undefined,
  record: ModalityProbeRecord,
): ProbeResultStore {
  return { ...store, [buildProbeKey(authType, modelId, baseUrl)]: record };
}
