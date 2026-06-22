/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AuthType } from '@qwen-code/qwen-code-core';

/**
 * ACP model IDs are represented as `${modelId}(${authType})` in the ACP protocol.
 *
 * NOTE: The VSCode webview side mirrors this encoding contract in
 * `packages/vscode-ide-companion/src/webview/utils/discontinuedModel.ts` to
 * detect discontinued Qwen OAuth registry models without changing the wire
 * format. If the encoding here evolves (new authTypes, runtime prefix changes,
 * etc.), update that file too.
 */
export function formatAcpModelId(modelId: string, authType: AuthType): string {
  return `${modelId}(${authType})`;
}

export function sanitizeProviderBaseUrl(baseUrl: string): string {
  const scheme = baseUrl.match(/^[A-Za-z][A-Za-z\d+.-]*:\/\//);
  if (!scheme) {
    return baseUrl;
  }

  const authorityStart = scheme[0].length;
  const stripAt = (at: number) =>
    `${baseUrl.slice(0, authorityStart)}${baseUrl.slice(at + 1)}`;
  const authorityEnd = findAuthorityEnd(baseUrl, authorityStart);
  const authorityAt = baseUrl
    .slice(authorityStart, authorityEnd)
    .lastIndexOf('@');
  const authorityAtIndex =
    authorityAt === -1 ? -1 : authorityStart + authorityAt;

  try {
    const parsed = new URL(baseUrl);
    if (parsed.username || parsed.password) {
      return authorityAtIndex >= authorityStart
        ? stripAt(authorityAtIndex)
        : baseUrl;
    }
    return baseUrl;
  } catch {
    const at = baseUrl.lastIndexOf('@');
    if (at < authorityStart) {
      return baseUrl;
    }

    const possibleUserInfo = baseUrl.slice(authorityStart, at);
    if (!possibleUserInfo.includes(':')) {
      return baseUrl;
    }
    return stripAt(at);
  }
}

function findAuthorityEnd(baseUrl: string, authorityStart: number): number {
  const slash = baseUrl.indexOf('/', authorityStart);
  const query = baseUrl.indexOf('?', authorityStart);
  const hash = baseUrl.indexOf('#', authorityStart);
  let end = baseUrl.length;
  if (slash !== -1) end = Math.min(end, slash);
  if (query !== -1) end = Math.min(end, query);
  if (hash !== -1) end = Math.min(end, hash);
  return end;
}

/**
 * Extracts the base model id from an ACP model id string.
 *
 * If the string ends with `(...)`, the suffix is removed; otherwise returns the
 * trimmed input as-is.
 */
export function parseAcpBaseModelId(value: string): string {
  const trimmed = value.trim();
  const closeIdx = trimmed.lastIndexOf(')');
  const openIdx = trimmed.lastIndexOf('(');
  if (openIdx >= 0 && closeIdx === trimmed.length - 1 && openIdx < closeIdx) {
    return trimmed.slice(0, openIdx);
  }
  return trimmed;
}

/**
 * Parses an ACP model option string into `{ modelId, authType? }`.
 *
 * Supports the following formats:
 * - `${modelId}(${authType})` - Standard registry model (e.g., "gpt-4(USE_OPENAI)")
 * - `${snapshotId}(${authType})` - Runtime model snapshot (e.g., "$runtime|USE_OPENAI|gpt-4(USE_OPENAI)")
 *   where snapshotId is in format `$runtime|${authType}|${modelId}`
 * - Plain model ID - Returns as-is with no authType
 *
 * If the string ends with `(...)` and `...` is non-empty, returns both;
 * otherwise (empty parens or no trailing parens) returns the trimmed input as `modelId` only.
 */
export function parseAcpModelOption(input: string): {
  modelId: string;
  authType?: AuthType;
} {
  const trimmed = input.trim();
  const closeIdx = trimmed.lastIndexOf(')');
  const openIdx = trimmed.lastIndexOf('(');
  if (openIdx >= 0 && closeIdx === trimmed.length - 1 && openIdx < closeIdx) {
    const maybeModelId = trimmed.slice(0, openIdx);
    const maybeAuthType = trimmed.slice(openIdx + 1, closeIdx);
    if (maybeAuthType) {
      return { modelId: maybeModelId, authType: maybeAuthType as AuthType };
    }
  }
  return { modelId: trimmed };
}
