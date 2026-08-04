/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import {
  AuthType,
  type AvailableModel,
  type Config,
} from '@qwen-code/qwen-code-core';
import { z } from 'zod';

export const ACP_ROUTE_ID_PREFIX = 'qwen-route:v1:';

function getRouteEndpointIdentity(baseUrl: string | undefined): string | null {
  if (!baseUrl) return null;
  try {
    const url = new URL(baseUrl);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return sanitizeProviderBaseUrl(baseUrl).split(/[?#]/, 1)[0] ?? null;
  }
}

/**
 * ACP model IDs use `${modelId}(${authType})` when that route is unique.
 * Colliding routes receive an opaque selector from `buildAcpModelOptions`.
 *
 * NOTE: The VSCode webview side mirrors this encoding contract in
 * `packages/vscode-ide-companion/src/webview/utils/discontinuedModel.ts` to
 * detect discontinued Qwen OAuth registry models without changing the wire
 * format. If the encoding here evolves (new authTypes, runtime prefix changes,
 * etc.), update that file too.
 */
function formatAcpModelId(modelId: string, authType: AuthType): string {
  return `${modelId}(${authType})`;
}

interface AcpModelOption {
  model: AvailableModel;
  modelId: string;
  effectiveModelId: string;
}

export function buildAcpModelOptions(
  models: readonly AvailableModel[],
): AcpModelOption[] {
  const candidates = models
    .filter(
      (model) =>
        model.fastOnly !== true &&
        model.voiceOnly !== true &&
        model.imageOnly !== true,
    )
    .map((model) => {
      const effectiveModelId =
        model.isRuntimeModel && model.runtimeSnapshotId
          ? model.runtimeSnapshotId
          : model.id;
      return {
        model,
        effectiveModelId,
        legacyModelId: formatAcpModelId(effectiveModelId, model.authType),
      };
    });
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    counts.set(
      candidate.legacyModelId,
      (counts.get(candidate.legacyModelId) ?? 0) + 1,
    );
  }
  const discriminators = new Set<string>();

  return candidates.map(({ model, effectiveModelId, legacyModelId }) => {
    const discriminator = [
      legacyModelId,
      model.label,
      model.envKey ?? null,
      model.registryBaseUrl === undefined,
      getRouteEndpointIdentity(model.registryBaseUrl ?? model.baseUrl),
    ] as const;
    const discriminatorKey = JSON.stringify(discriminator);
    if (
      counts.get(legacyModelId) !== 1 &&
      discriminators.has(discriminatorKey)
    ) {
      throw new Error(
        `ACP model routes for "${legacyModelId}" need distinct names, envKey values, or public endpoints.`,
      );
    }
    discriminators.add(discriminatorKey);

    return {
      model,
      effectiveModelId,
      modelId:
        counts.get(legacyModelId) === 1
          ? legacyModelId
          : `${ACP_ROUTE_ID_PREFIX}${createHash('sha256')
              .update(discriminatorKey)
              .digest('base64url')
              .slice(0, 16)}`,
    };
  });
}

export function resolveAcpModelOption(
  input: string,
  models: readonly AvailableModel[],
): {
  modelId: string;
  authType: AuthType;
  baseUrl?: string;
  registryBaseUrl?: string | null;
  isRuntime: boolean;
} | null {
  const matched = buildAcpModelOptions(models).find(
    (option) => option.modelId === input.trim(),
  );
  if (!matched) return null;
  return {
    modelId: matched.effectiveModelId,
    authType: matched.model.authType,
    ...(matched.model.registryBaseUrl !== undefined
      ? { baseUrl: matched.model.registryBaseUrl }
      : {}),
    ...(!matched.model.isRuntimeModel
      ? { registryBaseUrl: matched.model.registryBaseUrl ?? null }
      : {}),
    isRuntime: matched.model.isRuntimeModel === true,
  };
}

export function getCurrentAcpModelId(
  options: readonly AcpModelOption[],
  modelId: string,
  authType?: AuthType,
  registryBaseUrl?: string | null,
): string {
  if (!modelId || !authType) return modelId;
  const matching = options.filter(
    (option) =>
      option.effectiveModelId === modelId && option.model.authType === authType,
  );
  if (matching[0]?.model.isRuntimeModel) return matching[0].modelId;
  if (registryBaseUrl !== undefined) {
    const exact = matching.find(
      (option) => (option.model.registryBaseUrl ?? null) === registryBaseUrl,
    );
    return exact?.modelId ?? modelId;
  }
  return matching.length === 1
    ? matching[0]!.modelId
    : formatAcpModelId(modelId, authType);
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
  // Last '@' within the wide authority (up to / ? #). This is the userinfo
  // terminator - any '@' inside the password precedes it, and prose '@' after
  // the wide boundary is excluded.
  const authorityAt = baseUrl
    .slice(authorityStart, authorityEnd)
    .lastIndexOf('@');
  const authorityAtIndex =
    authorityAt === -1 ? -1 : authorityStart + authorityAt;

  // A portless URL followed by prose containing '@' (e.g.
  // "https://api.example:8443 - contact admin@example.com") is misparsed by
  // WHATWG as userinfo (username="api.example", password="8443..."). The
  // prose '@' lands inside the wide authority, so the strip would corrupt
  // the message. Veto when the segment between the first ':' and the next
  // whitespace is all digits - a port, not a password. #8136.
  // KNOWN RESIDUAL: a password that starts with digits followed by a space
  // (e.g. "user:1234 secret@host") is also vetoed and left unchanged, leaking
  // the credential. These two input classes are locally indistinguishable at
  // this veto; protecting the (common) portless-URL-with-prose case is the
  // documented tradeoff. See #8136 review R1-2.
  const portlessMisparse = isLikelyPortlessMisparse(
    baseUrl,
    authorityStart,
    authorityEnd,
  );

  // Unified strip-decision ladder shared by the try and catch branches.
  let stripPoint = -1;
  if (authorityAtIndex >= authorityStart && !portlessMisparse) {
    stripPoint = authorityAtIndex;
  }
  if (stripPoint === -1) {
    stripPoint = findUnescapedUserInfoFallbackAt(
      baseUrl,
      authorityStart,
      authorityEnd,
    );
  }

  try {
    const parsed = new URL(baseUrl);
    if (parsed.username || parsed.password) {
      return stripPoint === -1 ? baseUrl : stripAt(stripPoint);
    }
    return baseUrl;
  } catch {
    return stripPoint === -1 ? baseUrl : stripAt(stripPoint);
  }
}

function isLikelyPortlessMisparse(
  baseUrl: string,
  authorityStart: number,
  authorityEnd: number,
): boolean {
  const colon = baseUrl.indexOf(':', authorityStart);
  if (colon === -1 || colon > authorityEnd) {
    return false;
  }
  // The prose '@' in a portless URL + email lands after the host's ':' port,
  // so only apply the port veto when the strip candidate '@' is past the
  // colon. A real userinfo like "user@host:99999" has its '@' before the colon.
  const at = baseUrl.lastIndexOf('@', authorityEnd - 1);
  if (at !== -1 && at < colon) {
    return false;
  }
  // The segment after the colon up to the first whitespace (or authorityEnd)
  // is the port candidate. All-digits => a port, so this is a portless URL
  // whose prose was misparsed as userinfo.
  const afterColon = baseUrl.slice(colon + 1, authorityEnd);
  const spaceIdx = afterColon.search(/\s/);
  const portCandidate =
    spaceIdx === -1 ? afterColon : afterColon.slice(0, spaceIdx);
  return /^\d+$/.test(portCandidate);
}

function findUnescapedUserInfoFallbackAt(
  baseUrl: string,
  authorityStart: number,
  authorityEnd: number,
): number {
  // Search the whole string for the last '@' (the userinfo terminator can sit
  // past the path when the password itself contains / ? # and made
  // findAuthorityEnd stop early). Bound it loosely: the '@' must be at/after
  // authorityStart, and the portless-URL veto still applies.
  const at = baseUrl.lastIndexOf('@');
  if (at < authorityStart) {
    return -1;
  }
  if (isLikelyPortlessMisparse(baseUrl, authorityStart, authorityEnd)) {
    return -1;
  }
  return at;
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
 * If the string ends with `(...)` and `...` is a valid `AuthType`, returns both;
 * otherwise returns the trimmed input as `modelId` only.
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
    const parsedAuthType = z.nativeEnum(AuthType).safeParse(maybeAuthType);
    if (parsedAuthType.success) {
      return { modelId: maybeModelId, authType: parsedAuthType.data };
    }
  }
  return { modelId: trimmed };
}

/**
 * Whether a bare `modelId` resolves to the SAME provider identity as the active
 * content generator — same auth type, base URL, and credential env key.
 *
 * A per-turn inline `modelOverride` reuses the active provider's endpoint and
 * credentials and only swaps the model id; it cannot rebuild baseUrl/envKey for
 * a different provider. Any consumer that applies a `submit_prompt` result's
 * `modelOverride` must gate on this so an override naming a same-id model owned
 * by a different provider (or a different auth type) is never silently sent to
 * the active endpoint/account — even if a future (or untrusted) slash command
 * produces the override instead of the validated `/model` command. `modelId` is
 * the bare id without any `(authType)` suffix.
 */
export function isInlineModelOverrideAllowed(
  config: Config,
  modelId: string,
): boolean {
  const contentGeneratorConfig = config.getContentGeneratorConfig();
  const authType = contentGeneratorConfig?.authType;
  if (!authType) {
    return false;
  }
  const activeBaseUrl = contentGeneratorConfig.baseUrl;
  const activeEnvKey = contentGeneratorConfig.apiKeyEnvKey;
  return config
    .getAvailableModelsForAuthType(authType)
    .filter((m) => !m.fastOnly && !m.voiceOnly && !m.imageOnly)
    .some(
      (m) =>
        m.id === modelId &&
        (m.baseUrl ?? undefined) === (activeBaseUrl ?? undefined) &&
        (m.envKey ?? undefined) === (activeEnvKey ?? undefined),
    );
}
