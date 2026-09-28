/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The auxiliary-model settings (`visionModel`, `imageModel`, `advisorModel`,
 * `fastModel`, `compactionModel`) persist a selector in the form
 * `authType:<modelId>\0<baseUrl>`, where the NUL-separated suffix pins the
 * provider endpoint. A provider baseUrl can embed userinfo
 * (`https://user:sk-...@host/v1`), which is a credential. This module owns
 * how such a selector is published, displayed, and persisted so the suffix
 * never leaks it; egress surfaces call these helpers instead of hand-rolling
 * their own `split('\0')`.
 */

import { sanitizeProviderBaseUrl } from './acpModelUtils.js';

/** Settings keys that persist an `authType:id\0baseUrl` aux-model selector. */
export const AUX_MODEL_SELECTOR_SETTING_KEYS: ReadonlySet<string> = new Set([
  'visionModel',
  'imageModel',
  'advisorModel',
  'fastModel',
  'compactionModel',
]);

export function isAuxModelSelectorSettingKey(key: string): boolean {
  return AUX_MODEL_SELECTOR_SETTING_KEYS.has(key);
}

/**
 * Fail-closed publishability decision for a selector's baseUrl suffix:
 * http(s) URLs are publishable once userinfo, query, and hash are stripped;
 * an already-clean URL returns verbatim so republishing never rewrites a
 * clean persisted value. Anything else (scheme-less, non-http(s),
 * unparseable) is not publishable, and the caller must drop the suffix
 * rather than emit it.
 */
function publishableSelectorBaseUrl(baseUrl: string): string | undefined {
  if (!/^https?:\/\//i.test(baseUrl.trim())) return undefined;
  try {
    const url = new URL(baseUrl);
    if (!url.username && !url.password && !url.search && !url.hash) {
      return baseUrl;
    }
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return undefined;
  }
}

/**
 * Wire form of an aux-model selector that is safe to publish to external
 * surfaces (daemon API payloads, ACP status, change broadcasts): userinfo,
 * query, and hash are stripped from the baseUrl suffix, and an unpublishable
 * suffix is dropped outright. Values without a credential-bearing suffix
 * pass through unchanged.
 */
export function publicAuxModelSelectorValue(value: string): string {
  const nul = value.indexOf('\0');
  if (nul < 0) return value;
  const selector = value.slice(0, nul);
  const baseUrl = value.slice(nul + 1);
  if (!baseUrl) return value;
  const publishable = publishableSelectorBaseUrl(baseUrl);
  if (!publishable) return selector;
  return publishable === baseUrl ? value : `${selector}\0${publishable}`;
}

/**
 * Human display form of an aux-model selector for TUI surfaces
 * (`/model --vision` readback, `/settings` rows, `/system` info):
 * `selector (baseUrl)` with the publishable baseUrl, or just the selector
 * when the suffix is absent or unpublishable. Values that don't parse as a
 * selector keep the legacy NUL-escaped rendering.
 */
export function formatAuxModelSelectorForDisplay(setting: string): string {
  const nul = setting.indexOf('\0');
  if (nul < 0) return setting;
  const selector = setting.slice(0, nul);
  if (!selector) {
    // Fail closed: a malformed value with no selector must not echo the
    // credential-bearing suffix either. Route it through the same scrubbing
    // rule the wire path uses, then keep the NUL escaped so no raw NUL byte
    // reaches the terminal. An unpublishable suffix is dropped, exactly as
    // `publicAuxModelSelectorValue` drops it on the wire.
    return publicAuxModelSelectorValue(setting).replace(/\0/g, '\\0');
  }
  const baseUrl = setting.slice(nul + 1);
  if (!baseUrl) return selector;
  const publishable = publishableSelectorBaseUrl(baseUrl);
  return publishable ? `${selector} (${publishable})` : selector;
}

/**
 * Write-path credential strip for picker-persisted selectors: userinfo is
 * removed from an http(s) baseUrl so the selector written to settings.json
 * (potentially the committable workspace-scope file) carries no credential.
 * Clean URLs and scheme-less endpoints are persisted byte-identical. An
 * http(s) endpoint that `new URL()` rejects fails closed through
 * `sanitizeProviderBaseUrl`, which strips the authority userinfo textually —
 * never verbatim, because the persisted file is the one surface the publish
 * path cannot scrub after the fact.
 */
export function stripAuxSelectorBaseUrlCredential(baseUrl: string): string {
  if (!/^https?:\/\//i.test(baseUrl.trim())) return baseUrl;
  try {
    const url = new URL(baseUrl);
    if (!url.username && !url.password) return baseUrl;
    url.username = '';
    url.password = '';
    return url.href;
  } catch {
    return sanitizeProviderBaseUrl(baseUrl);
  }
}
