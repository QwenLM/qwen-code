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
 * in a human-editable settings.json.
 *
 * Phase-1 key spelling: registry-listed /model entries are keyed by their
 * RESOLVED baseUrl (default-filled, as displayed on the dialog entry);
 * raw/session models are keyed by the session-resolved baseUrl (which may be
 * undefined, yielding a `''` final segment). Known divergence: QWEN_OAUTH
 * resolves to `''` in the resolver path but 'DYNAMIC_QWEN_OAUTH_BASE_URL' in
 * the registry path — hard-coded oauth models are therefore poor probe
 * candidates in phase 1.
 *
 * Another known divergence (phase-1 boundary, see the Draft PR description):
 * under baseUrl environment overrides (e.g. OPENAI_BASE_URL), the resolver
 * composes keys from the RESOLVED baseUrl while the registry/dialog compose
 * keys from the DECLARED value — a record written via one path can be missed
 * by the other. Advisory-only impact (a missed record falls back to the
 * pattern tier); revisit when a re-probe/reset flow lands.
 */
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
  // Write-side hardening: settings.json is human-editable, so `probeResults`
  // may be hand-corrupted into a non-object (e.g. a bare string). Spreading
  // such a value would materialize index keys ("0", "1", ...) and persist
  // them, so treat anything that is not a plain object as empty.
  const base =
    typeof store === 'object' && store !== null && !Array.isArray(store)
      ? store
      : {};
  return { ...base, [buildProbeKey(authType, modelId, baseUrl)]: record };
}
