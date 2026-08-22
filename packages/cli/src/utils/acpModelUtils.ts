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
  const stripPoint = findUserInfoStripPoint(
    baseUrl,
    authorityStart,
    authorityEnd,
  );
  return stripPoint === -1 ? baseUrl : stripAt(stripPoint);
}

/**
 * A URL whose authority looks like `host:port <prose with @>` (e.g.
 * `https://api.example:8443 - contact admin@example.com`) is misparsed by WHATWG
 * as userinfo. The prose '@' would become the strip point and corrupt the
 * message. Veto when the authority has a host-shape before a port colon, a
 * digit port (optionally trailing punctuation), and a later '@' in prose.
 *
 * The host check accepts dotted OR dotless host labels (covers `ollama` as well
 * as `api.example`); IPv6 bracket literals skip past the `]` to find the port
 * colon. #8136 R1-7/R5-1/R5-5/R6-1.
 *
 * KNOWN RESIDUAL: a dotted/dotless USERNAME + digit-prefix password + space
 * (`user:1234 secret@host`, `foo.bar:1234 secret@host`) is locally
 * indistinguishable from `host:port <prose>` here and is also vetoed, leaking
 * the credential. These two classes cannot be separated at this veto without a
 * parser oracle; the leak is a documented tradeoff pending maintainer sign-off.
 * #8136 R1-2/R5-7.
 */
function isLikelyPortProseMisparse(
  baseUrl: string,
  authorityStart: number,
  authorityEnd: number,
): boolean {
  // Locate the port colon, skipping IPv6 bracket literals.
  let colon = baseUrl.indexOf(':', authorityStart);
  if (colon === -1 || colon > authorityEnd) {
    return false;
  }
  if (baseUrl[authorityStart] === '[') {
    const close = baseUrl.indexOf(']', authorityStart);
    if (close === -1 || close >= authorityEnd) {
      return false;
    }
    colon = baseUrl.indexOf(':', close + 1);
    if (colon === -1 || colon > authorityEnd) {
      return false;
    }
  }
  // A real userinfo has its '@' before the colon (`user@host:99999`); an '@'
  // before the colon means userinfo, not a host:port prose shape.
  const at = baseUrl.indexOf('@', authorityStart);
  if (at !== -1 && at < colon) {
    return false;
  }
  const beforeColon = baseUrl.slice(authorityStart, colon);
  // Host-shape: dotted or a single dotless label (not '[' content, which the
  // IPv6 branch already handled).
  if (!/^[A-Za-z0-9._-]+$/.test(beforeColon)) {
    return false;
  }
  const afterColon = baseUrl.slice(colon + 1, authorityEnd);
  // The prose must contain an '@' after the port+whitespace run.
  if (!afterColon.includes('@')) {
    return false;
  }
  const wsInAfter = afterColon.search(/\s/);
  if (wsInAfter === -1) {
    return false; // no whitespace => no prose separator
  }
  const portCandidate = afterColon.slice(0, wsInAfter);
  // Digit port, optionally followed by non-alphanumeric punctuation (one or
  // more chars, e.g. `8443,.` `8443;` em-dash). An empty candidate
  // (`ollama.local: please ...`) is also a prose shape where the ':' is the
  // prose separator, not a port. #8136 R1-7/R6-1/R7-3.
  return portCandidate === '' || /^\d+[^A-Za-z0-9]*$/.test(portCandidate);
}

/** A clean hostname (with optional numeric port) to the end of the authority.
 *  Accepts Unicode host labels (IDN) in addition to ASCII. #8136 R7-10. */
const CLEAN_HOST_AFTER = /^[A-Za-z0-9._\p{L}\p{N}\p{M}]+(:\d+)?$/u;

/**
 * Locate the userinfo terminator '@' to strip, or -1 when stripping would be
 * unsafe. Scans the authority's structure rather than trusting `new URL()`'s
 * userinfo report, because WHATWG misparses prose shapes (host:port + trailing
 * email) as userinfo and misses Windows-domain (`DOMAIN\user:pass@`) ones.
 *
 * - The terminator is the LAST '@' whose following text is a clean hostname to
 *   the end of the authority - so a password containing '@', whitespace, tab,
 *   or Unicode space (`user:p@ss@host`, `user:pass word@host`, or an nbsp
 *   inside the password) still strips at the real terminator.
 * - Prose shapes are vetoed: a host + trailing email whose first '@' is after
 *   whitespace with no ':' before it (`api.example - contact admin@example.com`),
 *   and a dotted host + numeric port + prose email (`api.example:8443 - contact
 *   admin@example.com`).
 * - Whitespace-less prose with an embedded email (`u:p@h,see(admin@example.com)`)
 *   and real credentials with a trailing prose email fall back to the FIRST '@'.
 * - A password containing `/ ? #` pushes the '@' past `authorityEnd` (the parser
 *   throws); fall back to the full-string last '@' when the authority has a ':'
 *   and the run between the last '/' and the candidate has no whitespace.
 */
function findUserInfoStripPoint(
  baseUrl: string,
  authorityStart: number,
  authorityEnd: number,
): number {
  const authority = baseUrl.slice(authorityStart, authorityEnd);
  const firstWs = authority.search(/\s/);
  const firstAt = authority.indexOf('@');

  if (firstAt === -1) {
    // No '@' in the authority. A password containing / ? # pushes the '@' past
    // authorityEnd (new URL() throws). Fall back to the full-string last '@'
    // when the authority has a ':' that is a real userinfo delimiter (not an
    // all-digit port, e.g. `host:99999/path@domain`) and no whitespace in the
    // run between the last '/' and the candidate (prose guard). #8136.
    //
    // KNOWN RESIDUAL: an '@' in the path (e.g. npm scoped
    // `/node_modules/@qwen/pkg`) with a host:port-shaped authority before it
    // is also stripped by this fallback — base has the same behavior (the
    // between-run has no whitespace). #8136 R7-5.
    const fullAt = baseUrl.lastIndexOf('@');
    if (fullAt >= authorityStart) {
      // Locate the userinfo colon, skipping IPv6 bracket literals so `[::1]`'s
      // inner colons are not mistaken for the delimiter. #8136 R6-2.
      let colon = baseUrl.indexOf(':', authorityStart);
      if (baseUrl[authorityStart] === '[') {
        const close = baseUrl.indexOf(']', authorityStart);
        if (close !== -1 && close < authorityEnd) {
          colon = baseUrl.indexOf(':', close + 1);
        }
      }
      if (colon !== -1 && colon < authorityEnd) {
        const afterColon = baseUrl.slice(colon + 1, authorityEnd);
        const afterWs = afterColon.search(/\s/);
        const colonCandidate =
          afterWs === -1 ? afterColon : afterColon.slice(0, afterWs);
        if (/^\d+$/.test(colonCandidate)) {
          return -1; // all-digit port, not userinfo
        }
        const lastSlash = baseUrl.lastIndexOf('/', fullAt);
        const between =
          lastSlash >= authorityStart
            ? baseUrl.slice(lastSlash, fullAt)
            : baseUrl.slice(authorityStart, fullAt);
        if (!/\s/.test(between)) {
          return fullAt;
        }
      }
    }
    return -1;
  }

  // Prose veto: a host + trailing email (`api.example - contact
  // admin@example.com`) has its first '@' AFTER the first whitespace and no
  // ':' before it (no userinfo). A real credential's '@' either precedes whitespace
  // (`user@host`), or has a ':' before it with no whitespace between the colon
  // and '@' (`user:pass word@host` has the colon before the whitespace, so the
  // slice to '@' has whitespace — but the colon still precedes '@', marking it
  // userinfo-shaped). #8136 R3-6.
  const atBeforeWs = firstWs === -1 || firstAt < firstWs;
  // A colon before the first '@' marks userinfo only when it is a real
  // userinfo delimiter, not an IPv6 bracket/port colon. An IPv6 authority
  // (`[::1]:8443`) has no userinfo colon before the first '@' (its colons are
  // inside the brackets or the port colon after `]`). #8136 R1-7.
  const colonBeforeAt =
    baseUrl[authorityStart] !== '[' &&
    authority.slice(0, firstAt).includes(':');
  if (!atBeforeWs && !colonBeforeAt) {
    return -1;
  }
  // Prose veto: a host + numeric port + prose email. #8136 R2-1.
  if (isLikelyPortProseMisparse(baseUrl, authorityStart, authorityEnd)) {
    return -1;
  }

  // Real terminator. If the text right after the FIRST '@' starts with a DOTTED
  // hostname (optionally a port) then whitespace/end, the password has no '@'
  // and the first '@' is the terminator (`user:pass@host.example - contact
  // admin@example.com`). Otherwise the first '@' is inside a password that
  // contains '@' (`user:p@ss word@host`), and the LAST '@' with a clean
  // hostname after it is the terminator. #8136 R3-5.
  const afterFirstAt = authority.slice(firstAt + 1);
  const firstHost = afterFirstAt.match(/^([A-Za-z0-9._-]+)(?::\d+)?(?:\s|$)/);
  if (firstHost !== null && firstHost[1]!.includes('.')) {
    return authorityStart + firstAt;
  }
  // When the first '@' is before the first whitespace, a prose email's '@' may
  // still sit after the whitespace (e.g. `user:pass@ollama - contact
  // admin@example.com`). Without a parser oracle this is indistinguishable from
  // a password containing '@' followed by a real terminator after whitespace
  // (`user:p@ss word@host`), so the loop scans the whole authority and the
  // prose-shape leak is a documented residual. #8136 R5-1/R6-3.
  for (
    let i = authority.lastIndexOf('@');
    i > firstAt;
    i = authority.lastIndexOf('@', i - 1)
  ) {
    if (CLEAN_HOST_AFTER.test(authority.slice(i + 1))) {
      return authorityStart + i;
    }
  }
  // No '@' is followed by a clean hostname: whitespace-less prose with an
  // embedded email (`u:p@h,see(admin@example.com)`) or real credentials with a
  // trailing prose email. Strip up to the FIRST '@' to drop the userinfo while
  // keeping host + prose. #8136 R4-3.
  return authorityStart + firstAt;
}

function findAuthorityEnd(baseUrl: string, authorityStart: number): number {
  const slash = baseUrl.indexOf('/', authorityStart);
  const query = baseUrl.indexOf('?', authorityStart);
  const hash = baseUrl.indexOf('#', authorityStart);
  let end = baseUrl.length;
  if (slash !== -1) end = Math.min(end, slash);
  if (query !== -1) end = Math.min(end, query);
  if (hash !== -1) end = Math.min(end, hash);
  // WHATWG treats '\' as a path separator on special schemes (http/https/ws/
  // wss/ftp/file), so it terminates the authority too - UNLESS it introduces a
  // Windows `domain\user:pass@` credential shape, which is a single userinfo
  // run. URL schemes are case-insensitive, so match case-insensitively. #8136
  // R4-5/R5-14.
  const scheme = baseUrl.match(/^[A-Za-z][A-Za-z\d+.-]*:\/\//)?.[0] ?? '';
  if (/^(https?|wss?|ftp|file):\/\//i.test(scheme)) {
    const backslash = baseUrl.indexOf('\\', authorityStart);
    if (backslash !== -1 && backslash < end) {
      // A Windows `domain\user:pass@` credential is a single userinfo run with
      // NO whitespace between the backslash and the '@'. Bound the scan at the
      // first whitespace so a later prose `a:b@c` is not mistaken for
      // credentials ('/' '?' '#' already bound `end` above). #8136 R5-12.
      const wsAfter = baseUrl.indexOf(' ', backslash + 1);
      const scanLimit = wsAfter === -1 || wsAfter > end ? end : wsAfter;
      const colonAfter = baseUrl.indexOf(':', backslash + 1);
      const atAfter = baseUrl.indexOf('@', backslash + 1);
      const windowsCred =
        colonAfter !== -1 &&
        atAfter !== -1 &&
        colonAfter < atAfter &&
        colonAfter < scanLimit &&
        atAfter < scanLimit &&
        !/\s/.test(baseUrl.slice(backslash + 1, atAfter));
      if (!windowsCred) {
        end = Math.min(end, backslash);
      }
    }
  }
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
