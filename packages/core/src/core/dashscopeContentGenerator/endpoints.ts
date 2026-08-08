/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const DEFAULT_DASHSCOPE_NATIVE_BASE_URL =
  'https://dashscope-intl.aliyuncs.com/api/v1';

export const DASHSCOPE_NATIVE_GENERATION_PATH =
  'services/aigc/multimodal-generation/generation';

const COMPAT_MODE_SUFFIX = '/compatible-mode/v1';

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47 /* / */) end--;
  return value.slice(0, end);
}

function resolvePathname(url: string): string | undefined {
  try {
    return new URL(url).pathname;
  } catch {
    return undefined;
  }
}

/**
 * Resolves a user-supplied base URL (bare host, `/api/v1`, a pasted
 * `/compatible-mode/v1` compat URL, or a full generation endpoint) into the
 * native DashScope multimodal-generation endpoint.
 */
export function resolveDashScopeGenerationEndpoint(
  baseUrl: string | undefined,
): string {
  const trimmed = (baseUrl ?? '').trim();
  let base = stripTrailingSlashes(
    trimmed.length > 0 ? trimmed : DEFAULT_DASHSCOPE_NATIVE_BASE_URL,
  );

  if (base.endsWith('/generation')) {
    return base;
  }

  // A pasted compat URL may already be rooted at /api/v1
  // (`https://host/api/v1/compatible-mode/v1`), so drop the compat suffix and
  // let the /api/v1 detection below decide whether one needs appending.
  if (base.endsWith(COMPAT_MODE_SUFFIX)) {
    base = stripTrailingSlashes(base.slice(0, -COMPAT_MODE_SUFFIX.length));
  }

  const pathname = resolvePathname(base);
  const hasApiV1 =
    pathname !== undefined
      ? pathname.includes('/api/v1')
      : base.includes('/api/v1');

  const withApiV1 = hasApiV1 ? base : `${base}/api/v1`;
  return `${withApiV1}/${DASHSCOPE_NATIVE_GENERATION_PATH}`;
}
