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
 * how such a selector is published and displayed so the suffix never leaks
 * it; egress surfaces call these helpers instead of hand-rolling their own
 * `split('\0')`.
 *
 * The persisted value is deliberately not rewritten. That suffix is the
 * routing key: `modelRegistry` copies the configured `baseUrl` verbatim, and
 * every consumer compares it with `===` — vision and image route resolution,
 * `advisor-model.ts`, provider-entry pin clearing, and both dialogs'
 * current-row lookup. Scrubbing it on write makes a pin resolve to nothing
 * for exactly the credential-bearing endpoints this module exists to protect.
 * Keeping the stored form registry-exact is also what the primary-model path
 * already does (`model.baseUrl` is persisted verbatim at the same scope) and
 * what every aux key did before this change, so it adds no exposure. Whether
 * a credential-bearing endpoint may be pinned into the committable
 * workspace-scope file at all is one class-wide decision covering
 * `model.baseUrl` and all five aux keys (#12856), not something to settle by
 * silently rewriting one of them.
 */

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
 * A control character in the suffix — a second NUL in practice — makes the
 * parsed `URL` fields this module inspects useless: WHATWG percent-encodes the
 * NUL into the pathname, so `username`, `password`, `search` and `hash` all
 * read empty while the credential text after it is still in the string. Every
 * "already clean" shortcut here compares parsed fields but returns the
 * UNPARSED input, so such a suffix would be served and rendered verbatim.
 * Fail closed on the text instead.
 */
function hasControlCharacter(baseUrl: string): boolean {
  // `\p{Cc}` (C0 + DEL + C1) matches the repo's existing control-character
  // check in `standalone-session-service.ts` and needs no lint suppression.
  return /\p{Cc}/u.test(baseUrl);
}

/**
 * Fail-closed publishability decision for a selector's baseUrl suffix:
 * http(s) URLs are publishable once userinfo, query, and hash are stripped;
 * an already-clean URL returns verbatim so republishing never rewrites a
 * clean persisted value. Anything else (scheme-less, non-http(s),
 * unparseable, or carrying a control character) is not publishable, and the
 * caller must drop the suffix rather than emit it.
 */
function publishableSelectorBaseUrl(baseUrl: string): string | undefined {
  if (hasControlCharacter(baseUrl)) return undefined;
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
 *
 * Accepts `unknown` because the persisted setting is not type-validated on
 * load — a workspace-scope `settings.json` can carry `fastModel: 42`. A
 * non-string is not a selector, so it keeps the legacy `String(value)`
 * rendering rather than throwing inside the scrub.
 */
export function publicAuxModelSelectorValue(value: unknown): string {
  if (typeof value !== 'string') return String(value ?? '');
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
 *
 * Accepts `unknown` for the same reason as `publicAuxModelSelectorValue`: the
 * display callers gate on truthiness only, and `getExtendedSystemInfo` has no
 * enclosing try, so a non-string setting must render rather than reject.
 */
export function formatAuxModelSelectorForDisplay(setting: unknown): string {
  if (typeof setting !== 'string') return String(setting ?? '');
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
 * Row value for an inline number/string `/settings` row. Shared by the ink
 * SettingsDialog and the OpenTUI settings dialog so the credential-scrub rule
 * has one owner: aux-model selectors persist as `authType:id\0baseUrl` and
 * that suffix can embed userinfo, so those rows render the scrubbed display
 * form; every other row keeps the legacy `String(value)` rendering.
 */
export function formatSettingRowValue(key: string, value: unknown): string {
  return typeof value === 'string' && isAuxModelSelectorSettingKey(key)
    ? formatAuxModelSelectorForDisplay(value)
    : String(value);
}
