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
import { RUNTIME_SNAPSHOT_PREFIX } from '@qwen-code/qwen-code-core/utils/runtimeModelPrefix.js';
import { z } from 'zod';

export const ACP_ROUTE_ID_PREFIX = 'qwen-route:v1:';

/**
 * The one message for the discontinued Qwen OAuth free tier. It is a
 * translation key, not a free string — the same key is shipped in en/ca/de/fr/
 * ja/pt/ru/zh/zh-TW — so it must stay byte-identical to what the callers passed
 * to `t()` before the extraction.
 */
export const DISCONTINUED_QWEN_OAUTH_MESSAGE =
  'Qwen OAuth free tier was discontinued on 2026-04-15. Please select a model from another provider or run /auth to switch.';

/**
 * The rule that blocks the discontinued tier, in one place. Callers used to
 * hand-roll it — three copies inside `packages/cli`, each parsing the selection
 * differently and each re-inlining the `$runtime|` prefix core already exports.
 * A bare literal there drifts silently: no compile error, no failing test, and
 * every legitimate cached-token OAuth selection starts receiving the
 * discontinued error.
 *
 * The typed `/model` path has NO runtime carve-out, and that is deliberate and
 * pinned by `modelCommand.test.ts`'s "rejects a wrapped runtime Qwen OAuth
 * snapshot selection": the parser keys off the trailing `(...)`, so
 * `$runtime|qwen-oauth|<id>(qwen-oauth)` parses to `authType: QWEN_OAUTH` and is
 * refused here, one step earlier than the availability lookup that would have
 * refused it anyway. Narrowing this to the pickers' predicate would change that
 * error message, which is a behaviour change this extraction does not make.
 */
export function isDiscontinuedQwenOAuthSelection(
  authType: AuthType | undefined,
): boolean {
  return authType === AuthType.QWEN_OAUTH;
}

/**
 * The picker shape: `/model` has already parsed the ACP id, but the dialogs
 * hold a selection key, either `authType::modelId` or a `$runtime|…` snapshot
 * id. Equivalent to the parsed-id predicate above for every key the pickers
 * produce; kept separate rather than moving the key parser in here, which would
 * drag the UI's selection-key encoding into this module.
 */
export function isDiscontinuedQwenOAuthSelectionKey(
  selectionKey: string,
): boolean {
  if (selectionKey.startsWith(RUNTIME_SNAPSHOT_PREFIX)) return false;
  return selectionKey.startsWith(`${AuthType.QWEN_OAUTH}::`);
}

export function publicProviderBaseUrl(baseUrl: string): string | undefined {
  if (!/^https?:\/\//i.test(baseUrl.trim())) return undefined;
  try {
    const url = new URL(baseUrl);
    // Clearing the four fields below does not touch `pathname`, so a second
    // authority folded into the path survives all of them and `url.href`
    // re-emits it verbatim: `https://gw/v1/https://user:sk@other/v1` reads
    // empty on username, password, search and hash while the credential is
    // still in the returned string. Enumerating the join characters does not
    // converge — a plain `/` needs no folding at all, and `;` and `{` behave
    // differently only by accident of percent-encoding — so reject the shape
    // rather than list it. A legitimate provider endpoint never carries a
    // second scheme in its path.
    if (/:\/\//.test(url.pathname)) return undefined;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return undefined;
  }
}

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

export function resolveAcpFastModelSelector(
  input: string,
  models: readonly AvailableModel[],
): string | null {
  const option = buildAcpModelOptions(models).find(
    (candidate) => candidate.modelId === input.trim(),
  );
  if (!option || option.model.isRuntimeModel || option.model.visionOnly) {
    return null;
  }
  const { model } = option;
  const selector = `${model.authType}:${model.id}`;
  return model.authType === AuthType.QWEN_OAUTH
    ? selector
    : `${selector}\0${model.registryBaseUrl ?? ''}`;
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
    if (authorityAtIndex >= authorityStart) {
      return stripAt(authorityAtIndex);
    }

    const fallbackAt = findUnescapedUserInfoFallbackAt(
      baseUrl,
      authorityStart,
      authorityEnd,
    );
    return fallbackAt === -1 ? baseUrl : stripAt(fallbackAt);
  }
}

function findUnescapedUserInfoFallbackAt(
  baseUrl: string,
  authorityStart: number,
  authorityEnd: number,
): number {
  const at = baseUrl.lastIndexOf('@');
  if (at < authorityStart || authorityEnd >= at) {
    return -1;
  }

  const colon = baseUrl.indexOf(':', authorityStart);
  if (colon === -1 || colon > authorityEnd) {
    return -1;
  }

  const portCandidate = baseUrl.slice(colon + 1, authorityEnd);
  return /^\d+$/.test(portCandidate) ? -1 : at;
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
