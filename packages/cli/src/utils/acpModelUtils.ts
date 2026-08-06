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

  // The prose guards run first and may veto to -1 (no strip) when the input
  // looks like a pathless host followed by prose rather than credentials. They
  // protect misparsed-prose shapes (port+prose, host+prose) that `new URL()`
  // would otherwise report as userinfo. A veto is not final, though: a pathless
  // URL whose userinfo contains whitespace (e.g. `user name:pass@host`) also
  // trips the prose guard but IS a real credential that `new URL()` confirms,
  // so the parser gets the final say below. #8136.
  const stripPoint = findUserInfoStripPoint(
    baseUrl,
    authorityStart,
    authorityEnd,
  );

  try {
    const parsed = new URL(baseUrl);
    if (parsed.username || parsed.password) {
      const isPathless = authorityEnd === baseUrl.length;
      if (!isPathless) {
        // Bounded authority (has / ? #): `new URL()` parses the host
        // authoritatively, so the LAST '@' within the authority is the real
        // userinfo terminator - even when the password contains '@' or
        // whitespace (e.g. `user:p@ss word@host.example/v1`). #8136.
        const at = baseUrl.lastIndexOf('@', authorityEnd - 1);
        return at >= authorityStart ? stripAt(at) : baseUrl;
      }
      // Pathless URL: WHATWG extends the authority to end-of-string, so a
      // trailing prose email's '@' (e.g. `host - contact admin@example.com`)
      // is also reported as userinfo and `lastIndexOf('@')` would pick it,
      // deleting the real host. The userinfo terminator always precedes the
      // first whitespace (the password ends at '@'); a prose email '@' does
      // not. Scan only up to the first whitespace. A password containing
      // whitespace beyond that point (e.g. `user name:pass@host`) is then
      // indistinguishable from prose and is left as a documented residual.
      const authority = baseUrl.slice(authorityStart, authorityEnd);
      const firstWs = authority.search(/\s/);
      const scanEnd = firstWs === -1 ? authorityEnd : authorityStart + firstWs;
      const at = baseUrl.lastIndexOf('@', scanEnd - 1);
      return at >= authorityStart ? stripAt(at) : baseUrl;
    }
    return baseUrl;
  } catch {
    return stripPoint === -1 ? baseUrl : stripAt(stripPoint);
  }
}

/**
 * A pathless URL with a numeric port followed by prose containing '@' (e.g.
 * `https://api.example:8443 - contact admin@example.com`) is misparsed by WHATWG
 * as userinfo (username=`api.example`, password=`8443 - contact admin`). The
 * prose '@' lands inside the wide authority and would become the strip point,
 * corrupting the message. Veto when the segment between the first ':' and the
 * next whitespace is all digits (a port) AND the candidate '@' is past the
 * colon - a real userinfo like `user@host:99999` has its '@' before the colon.
 * #8136.
 *
 * KNOWN RESIDUAL: a password starting with digits followed by a space (e.g.
 * `user:1234 secret@host`) is also vetoed and leaks in full. These two input
 * classes are locally indistinguishable at this veto; protecting the common
 * pathless-port-with-prose case is the documented tradeoff (see #8136 R1-2).
 */
function isLikelyPathlessPortMisparse(
  baseUrl: string,
  authorityStart: number,
  authorityEnd: number,
): boolean {
  const colon = baseUrl.indexOf(':', authorityStart);
  if (colon === -1 || colon > authorityEnd) {
    return false;
  }
  const at = baseUrl.indexOf('@', authorityStart);
  if (at !== -1 && at < colon) {
    return false;
  }
  const afterColon = baseUrl.slice(colon + 1, authorityEnd);
  const wsInAfter = afterColon.search(/\s/);
  const portCandidate =
    wsInAfter === -1 ? afterColon : afterColon.slice(0, wsInAfter);
  return /^\d+$/.test(portCandidate);
}

/**
 * Locate the userinfo terminator '@' to strip, or -1 when stripping would be
 * unsafe. The try-branch of `sanitizeProviderBaseUrl` overrides this with the
 * authoritative last '@' from `new URL()` when the parser succeeds, so this
 * heuristic only decides (a) whether to veto prose shapes up front, and (b) the
 * strip point when `new URL()` throws. Handles the credential-stripping shapes
 * from #8136:
 *
 * - Pathless URL (no `/ ? #`, authority runs to end): veto port+prose and
 *   host+prose misparses; otherwise the last '@' within the authority is the
 *   terminator (a password's inner '@' precedes it). A real credential whose
 *   userinfo contains whitespace (e.g. `user name:pass@host`) still parses with
 *   `new URL()`, so the try-branch handles it; this path only fires when the
 *   parser throws.
 * - Bounded authority (has `/ ? #`): the last '@' within the authority.
 * - Password containing `/ ? #` makes `new URL()` throw and pushes '@' past
 *   `authorityEnd`; fall back to the full-string last '@' only when there is a
 *   ':' within the authority (a real userinfo delimiter) and the run between the
 *   last '/' and the candidate has no whitespace (prose guard).
 */
function findUserInfoStripPoint(
  baseUrl: string,
  authorityStart: number,
  authorityEnd: number,
): number {
  const authority = baseUrl.slice(authorityStart, authorityEnd);
  const firstWs = authority.search(/\s/);
  const isPathless = authorityEnd === baseUrl.length;
  // Pathless + prose: only veto when the FIRST whitespace-delimited token has
  // neither ':' nor '@' (a bare host followed by prose). A token with ':' or '@'
  // is userinfo-shaped and is left for `new URL()` / the bounded branch to
  // decide, so whitespace inside a username (e.g. `user name:pass@host`) is not
  // falsely vetoed. #8136.
  const beforeWs = firstWs === -1 ? authority : authority.slice(0, firstWs);
  const isPathlessProse =
    isPathless &&
    firstWs !== -1 &&
    !beforeWs.includes(':') &&
    !beforeWs.includes('@');
  if (
    isLikelyPathlessPortMisparse(baseUrl, authorityStart, authorityEnd) ||
    isPathlessProse
  ) {
    return -1;
  }
  // Bounded authority or pathless-without-prose: the last '@' within the
  // authority is the terminator. `new URL()` refines this on the try-branch when
  // it parses successfully; the catch-branch (parser threw) uses it directly.
  const at = baseUrl.lastIndexOf('@', authorityEnd - 1);
  if (at >= authorityStart) {
    return at;
  }
  // Fallback for passwords containing / ? # (new URL() throws, '@' is past
  // `authorityEnd`). Require a ':' within the authority (a real userinfo
  // delimiter) and reject a full-string '@' when the run between the last '/'
  // and it contains whitespace - that is prose, not userinfo. #8136 R3-2.
  const fullAt = baseUrl.lastIndexOf('@');
  if (fullAt < authorityStart) {
    return -1;
  }
  const colon = baseUrl.indexOf(':', authorityStart);
  if (colon === -1 || colon > authorityEnd) {
    return -1;
  }
  const lastSlashBeforeAt = baseUrl.lastIndexOf('/', fullAt);
  const between =
    lastSlashBeforeAt >= authorityStart
      ? baseUrl.slice(lastSlashBeforeAt, fullAt)
      : baseUrl.slice(authorityStart, fullAt);
  if (/\s/.test(between)) {
    return -1;
  }
  return fullAt;
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
