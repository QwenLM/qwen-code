/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ApprovalMode,
  APPROVAL_MODES,
  createDebugLogger,
  ModelsConfig,
  tokenLimit,
} from '@qwen-code/qwen-code-core';
import type { AuthType } from '@qwen-code/qwen-code-core';
import type {
  ServeWorkspaceProviderCurrent,
  ServeWorkspaceProviderModel,
  ServeWorkspaceProviderStatus,
  ServeWorkspaceProvidersStatus,
} from '@qwen-code/acp-bridge/status';
import { STATUS_SCHEMA_VERSION } from '@qwen-code/acp-bridge/status';
import { loadSettings } from '../config/settings.js';
import type { Settings } from '../config/settings.js';
import {
  getAuthTypeFromEnv,
  resolveCliGenerationConfig,
} from '../utils/modelConfigUtils.js';
import type { CliGenerationConfigInputs } from '../utils/modelConfigUtils.js';
import {
  buildAcpModelOptions,
  getCurrentAcpModelId,
  parseAcpBaseModelId,
  sanitizeProviderBaseUrl,
} from '../utils/acpModelUtils.js';
import { snapshotProcessEnv } from './env-snapshot.js';

const debugLogger = createDebugLogger('WORKSPACE_PROVIDERS_STATUS');

export type WorkspaceProvidersStatusProvider = (
  workspaceCwd: string,
  acpChannelLive: boolean,
) => Promise<ServeWorkspaceProvidersStatus>;

export interface WorkspaceProvidersStatusProviderOptions {
  argv?: Partial<CliGenerationConfigInputs['argv']>;
  env?: Record<string, string | undefined>;
  workspaceTrusted?: boolean;
}

export function createWorkspaceProvidersStatusProvider(
  options: WorkspaceProvidersStatusProviderOptions = {},
): WorkspaceProvidersStatusProvider {
  return async (workspaceCwd, acpChannelLive) =>
    buildWorkspaceProvidersStatus(workspaceCwd, acpChannelLive, options);
}

function buildWorkspaceProvidersStatus(
  workspaceCwd: string,
  acpChannelLive: boolean,
  options: WorkspaceProvidersStatusProviderOptions,
): ServeWorkspaceProvidersStatus {
  try {
    const loaded = loadSettings(
      workspaceCwd,
      options.env
        ? {
            skipLoadEnvironment: true,
            skipWorkspaceSettings: options.workspaceTrusted === false,
            workspaceTrusted: options.workspaceTrusted,
          }
        : {
            consumeCorruptionEnvVars: true,
            skipLoadEnvironment: options.workspaceTrusted === false,
            skipWorkspaceSettings: options.workspaceTrusted === false,
            workspaceTrusted: options.workspaceTrusted,
          },
    );
    const settings = loaded.merged;
    const env = options.env ?? snapshotProcessEnv();
    const selectedAuthType =
      settings.security?.auth?.selectedType ?? getAuthTypeFromEnv(env);
    const argv: CliGenerationConfigInputs['argv'] = {
      model: options.argv?.model,
      openaiApiKey: options.argv?.openaiApiKey,
      openaiBaseUrl: options.argv?.openaiBaseUrl,
      openaiLogging: options.argv?.openaiLogging,
      openaiLoggingDir: options.argv?.openaiLoggingDir,
    };
    const resolvedCliConfig = resolveCliGenerationConfig({
      argv,
      settings,
      selectedAuthType,
      env,
    });
    const modelsConfig = new ModelsConfig({
      initialAuthType: selectedAuthType,
      modelProvidersConfig: settings.modelProviders,
      providerProtocolConfig: settings.providerProtocol,
      generationConfig: resolvedCliConfig.generationConfig,
      generationConfigSources: resolvedCliConfig.sources,
    });
    const currentAuth = selectedAuthType;
    const currentModelId = (
      resolvedCliConfig.model ||
      modelsConfig.getModel() ||
      ''
    ).trim();
    const hasCurrentModel = currentModelId.length > 0;
    const modelCameFromSettings =
      !argv.model && settings.model?.name?.trim() === currentModelId;
    const currentBaseUrl =
      modelCameFromSettings && settings.model?.baseUrl !== undefined
        ? settings.model.baseUrl || undefined
        : resolvedCliConfig.sources['baseUrl']
          ? resolvedCliConfig.baseUrl || undefined
          : undefined;
    const currentRegistryBaseUrl =
      modelCameFromSettings && currentAuth
        ? settings.model?.baseUrl !== undefined
          ? settings.model.baseUrl || null
          : (modelsConfig.getResolvedModel(currentAuth, currentModelId)
              ?.registryBaseUrl ?? null)
        : undefined;
    const modelOptions = buildAcpModelOptions(
      modelsConfig.getAllConfiguredModels(),
    );
    const currentAcpModelId = hasCurrentModel
      ? getCurrentAcpModelId(
          modelOptions,
          currentModelId,
          currentAuth,
          currentRegistryBaseUrl,
        )
      : undefined;
    const fastModelId =
      typeof settings.fastModel === 'string' && settings.fastModel.length > 0
        ? settings.fastModel
        : undefined;
    const visionModelId =
      typeof settings.visionModel === 'string' &&
      settings.visionModel.length > 0
        ? settings.visionModel
        : undefined;
    const approvalMode = resolveApprovalMode(settings);
    const providers = new Map<string, ServeWorkspaceProviderStatus>();
    for (const option of modelOptions) {
      const { model, effectiveModelId, modelId } = option;
      if (model.isRuntimeModel) continue;
      const authType = String(model.authType);
      let provider = providers.get(authType);
      if (!provider) {
        provider = {
          kind: 'model_provider',
          status: 'ok',
          authType,
          current: false,
          models: [],
        };
        providers.set(authType, provider);
      }

      const isCurrent =
        currentAuth === model.authType && currentAcpModelId === modelId;
      const providerModel: ServeWorkspaceProviderModel = {
        modelId,
        baseModelId: parseAcpBaseModelId(effectiveModelId),
        name: model.label,
        ...(model.description !== undefined
          ? { description: model.description }
          : {}),
        contextLimit: model.contextWindowSize ?? tokenLimit(effectiveModelId),
        ...(model.modalities !== undefined
          ? { modalities: model.modalities }
          : {}),
        ...(model.baseUrl !== undefined
          ? { baseUrl: sanitizeProviderBaseUrl(model.baseUrl) }
          : {}),
        ...(model.envKey !== undefined ? { envKey: model.envKey } : {}),
        isCurrent,
        isRuntime: false,
      };
      provider.models.push(providerModel);
      if (isCurrent) provider.current = true;
    }

    const current = buildCurrent(
      currentAuth,
      currentAcpModelId,
      currentBaseUrl,
      fastModelId,
      visionModelId,
    );

    return {
      v: STATUS_SCHEMA_VERSION,
      workspaceCwd,
      initialized: true,
      acpChannelLive,
      ...(current ? { current } : {}),
      approvalMode,
      providers: [...providers.values()],
      ...(resolvedCliConfig.warnings.length > 0
        ? {
            errors: resolvedCliConfig.warnings.map((warning) => ({
              kind: 'providers',
              status: 'warning' as const,
              error: sanitizeProviderWarning(warning),
            })),
          }
        : {}),
    };
  } catch (error) {
    return {
      v: STATUS_SCHEMA_VERSION,
      workspaceCwd,
      initialized: false,
      acpChannelLive,
      providers: [],
      errors: [
        {
          kind: 'providers',
          status: 'error',
          error: sanitizeProviderWarning(
            error instanceof Error ? error.message : String(error),
          ),
        },
      ],
    };
  }
}

function resolveApprovalMode(settings: Settings): ApprovalMode {
  const value = settings.tools?.approvalMode;
  if (typeof value !== 'string') return ApprovalMode.AUTO;

  const normalized = value.trim().toLowerCase().replaceAll('_', '-');
  const mode = normalized === 'autoedit' ? ApprovalMode.AUTO_EDIT : normalized;
  if ((APPROVAL_MODES as readonly string[]).includes(mode)) {
    return mode as ApprovalMode;
  }

  if (value.trim().length > 0) {
    debugLogger.warn(
      `[workspace-providers-status] unrecognized approvalMode "${value}", falling back to auto`,
    );
  }
  return ApprovalMode.AUTO;
}

const URL_START_PATTERN = /\b[A-Za-z][A-Za-z\d+.-]*:\/\//g;

/**
 * What a host label is made of.
 *
 * Unicode rather than `[A-Za-z\d]`: an internationalized host reaches this code
 * un-punycoded when it comes from a config file a person typed, and an
 * ASCII-only class does not recognise it. Not recognising a host is what leaks a
 * credential, so `münchen.de` had to be a host here for the same reason
 * `example.com` does.
 */
const HOST_CHAR = String.raw`[\p{L}\p{N}\p{M}]`;
const LABEL_CHAR = String.raw`[\p{L}\p{N}\p{M}-]`;

/**
 * A host with nothing after it to mark where it ends, so its own shape is the
 * only evidence that it is one.
 *
 * Four shapes, because a single pattern for all of them would be wrong at the
 * edges. A bracketed IPv6 literal. A dotted name, whose first label may be a
 * single character (`a.example`). A bare label — intranet proxies, container
 * names like `ollama`, and k8s service names have no dot — required to be at
 * least two characters, which is what keeps a one-letter fragment of a password
 * from passing for a host. Or a single character carrying a port, since `:8443`
 * is structural evidence of an authority in the same way a path is, and without
 * it `@h:8443` fell through every shape and the `@` was taken from later prose.
 *
 * What follows the host is required only to be something a host cannot continue
 * into, rather than a fixed list of delimiters. Enumerating them meant a URL
 * ending a sentence was not recognised, since `.`, `,` and `)` were not on the
 * list — and the consequence of not recognising a host is a credential leak, so
 * the list being incomplete was not a cosmetic problem. A trailing dot is
 * allowed to belong to the sentence rather than the name.
 */
const UNDELIMITED_HOST =
  String.raw`(?:\[[0-9A-Fa-f:.]+\]` +
  String.raw`|${HOST_CHAR}(?:${LABEL_CHAR}*\.)+${LABEL_CHAR}+` +
  String.raw`|${HOST_CHAR}${LABEL_CHAR}+` +
  String.raw`|${HOST_CHAR}:\d+)` +
  String.raw`(?::\d+)?(?!${LABEL_CHAR})`;

/**
 * A host followed by a path, query or fragment, which may be a single label.
 *
 * The two-character floor above exists only because a bare label at the end of
 * a span has nothing to distinguish it from a word — but a label followed by
 * `/`, `?` or `#` is not a word, it is an authority with a path. That evidence
 * is structural rather than a length, so it can admit `@h/v1` without also
 * admitting the `s` in `p@s s@host.example`, whose only delimiter is a space.
 *
 * Raising the floor instead would have traded one leak for another: at three
 * characters, a two-character host leaks, and so on up.
 */
const DELIMITED_HOST = String.raw`(?:\[[0-9A-Fa-f:.]+\]|${HOST_CHAR}${LABEL_CHAR}*(?:\.${LABEL_CHAR}+)*)(?::\d+)?[/?#]`;

/** A host addressable after a userinfo, delimited or not. */
const HOST_AFTER_USERINFO = String.raw`(?:${UNDELIMITED_HOST}|${DELIMITED_HOST})`;

/**
 * How a port ends, and so what tells `:8443` from a password beginning `123`.
 *
 * A real port is only digits, so what follows a port is never a letter — which
 * is the whole distinction. Written as an explicit closing set rather than
 * "any non-digit", because a negated class also admits `_`, `=` and `%`, all
 * legal in a password: `:123%abc secret@host` was read as a port and its
 * password left in the message.
 *
 * Quotes and brackets are deliberately absent for the same reason, even though
 * `"https://api.example:8443"` puts one right after a port. That case is handled
 * where the evidence is unambiguous — a *balanced* delimiter, in
 * `findUrlSegmentEnd` — because `"` alone is as legal in a password as `%` is.
 */
const PORT_END = String.raw`[,.;:!?)\]}]`;

/**
 * Digits after a colon that are a port rather than the start of a password.
 *
 * Three shapes qualify, and each is a different kind of evidence: the digits end
 * the span, a sentence closes on them (`:8443, contact`), or a further space
 * follows before any `@`, which is prose rather than a one-space password.
 *
 * The sentence-closing shape needs the same "and no userinfo follows" test the
 * space shape makes, because `PORT_END` on its own does not tell `:8443. See
 * admin@x` from `:123. secret@host.example/v1`. Without it the latter read as a
 * port, so no credential prefix was found at all and `findUrlEnd` cut at the
 * first space — inside the password — putting `user:123. secret@` in the
 * `/status` payload. `CREDENTIAL_FALLBACK_PATTERN` cannot cover this one: its
 * host is a single character by construction, and the host here is
 * `host.example`.
 *
 * The test is scoped to the rest of the span rather than to the token, since the
 * `@` that resolves the ambiguity is in the word after the space.
 */
const PORT_DIGITS = String.raw`\d+(?:$|${PORT_END}(?![^\s]*\s[^@\s]*@)|\s(?:[^@\s]*\s))`;

/**
 * A `user:password@` prefix, where the password may contain spaces.
 *
 * Two decisions are encoded here, and each is load-bearing on its own.
 *
 * Whether there is a userinfo at all: a colon must appear before any
 * whitespace, and the negative lookahead rejects digits that read as a port
 * rather than the start of a password. `:8443 ` alone is not enough to tell
 * the two apart — a password may also begin with digits and a space
 * (`user:123 secret@host`) — so the digits count as a port when they end the
 * span, when a sentence closes on them (`:8443, contact`), or when a further
 * space follows before the `@`, which is prose rather than a one-space password.
 *
 * Which `@` ends the userinfo: neither greediness setting is right, because a
 * greedy tail runs past the host into an `@` in trailing prose while a lazy one
 * stops at an `@` inside the password. So the `@` is chosen structurally — it
 * must be followed by something addressable as a host.
 *
 * The username may be empty. `https://:password@host` is a legal URL, and one
 * that appears in configs where only a token is needed, so requiring a character
 * before the colon left its password unstripped.
 *
 * Three shapes are knowingly left as they are, because nothing in them says
 * which reading is right: `p@ss word@host.example`, where the password's tail is
 * a valid host; `123 secret word@host`, where a second space before the `@` is
 * the same evidence that tells a port from a password; and `:8443 support@x.com`,
 * where a port is followed by exactly one word ending in `@`, which is
 * indistinguishable from a one-space password. All three are pinned by test so
 * that changing any rule has to choose deliberately.
 *
 * An unbalanced closer is a fourth: `:8443(ECONNREFUSED) — contact a@b.com` has
 * no opening paren before the URL, so nothing distinguishes it from a password
 * beginning `123(`. Wrapped in a balanced pair it is handled; bare it is not.
 *
 * This grammar decides only how much of the message is URL; the slice is then
 * handed to `sanitizeProviderBaseUrl` in `utils/acpModelUtils.ts`, which locates
 * the userinfo within it. The two must agree on where an authority ends, and
 * neither can see the other — see that function's comment for the host rewrite
 * that a disagreement produces.
 */
const CREDENTIAL_PREFIX_PATTERN = new RegExp(
  // `\x60` is the backtick, spelled as an escape because a literal one cannot
  // appear in the template and `\`` is not a valid escape under the `u` flag.
  String.raw`^[^\s/?#'"\x60<>]*:(?!${PORT_DIGITS})[^/?#]*?@(?=${HOST_AFTER_USERINFO})`,
  'u',
);

/**
 * A bare one-character host, admitted only by the fallback.
 *
 * `UNDELIMITED_HOST` requires two characters of a bare label, because at the end
 * of a span a single letter is indistinguishable from a fragment of a password —
 * the `s` in `p@s s@host.example`. That floor is right for the primary pattern,
 * where a wrong guess rewrites a host. It is wrong for the fallback, where the
 * alternative is not "leave the host alone" but "leave the password in", because
 * the fallback only runs once the first-space cut is known to land inside a
 * credential.
 */
const FALLBACK_HOST = String.raw`${HOST_CHAR}(?!${LABEL_CHAR})`;

/**
 * A `user:password@` prefix recognised on weaker evidence, used only when
 * `CREDENTIAL_PREFIX_PATTERN` has already declined.
 *
 * It differs in exactly one place: the `@` may be followed by a *one-character*
 * bare host. The port lookahead is kept verbatim, because that is what tells a
 * userinfo from `:8443 — contact admin@example.com`, where there is no credential
 * to strip and cutting at the email's `@` would rewrite the host.
 *
 * Widening the host rule is safe here in a way it is not in the primary pattern,
 * because the two are consulted in different states. There, a one-character
 * "host" that is really a password fragment rewrites a host that was fine. Here,
 * the primary pattern has already declined, so `findUrlEnd`'s other branch is
 * about to cut at the first space — which, when a colon-then-`@` is present, is
 * *inside* the password by construction. The slice then reaching
 * `sanitizeProviderBaseUrl` has no `@` at all, so nothing is stripped and the
 * credential is re-appended verbatim as prose. Between rewriting a host and
 * emitting a password, the choice is not close.
 *
 * That asymmetry is the general point, and it is why this is a second pattern
 * rather than a third alternative in `HOST_AFTER_USERINFO`: a sanitizer should
 * resolve an ambiguity it cannot settle by removing more, not less, but only
 * where the cost of guessing wrong is a less informative message rather than a
 * different host.
 */
const CREDENTIAL_FALLBACK_PATTERN = new RegExp(
  String.raw`^[^\s/?#'"\x60<>]*:(?!${PORT_DIGITS})[^/?#]*?@(?=${FALLBACK_HOST})`,
  'u',
);

/**
 * Strips credentials from every URL in a free-text warning or error message.
 *
 * Each URL is handed to `sanitizeProviderBaseUrl`, which scopes credential
 * detection to the authority. Splitting the message into spans first rather than
 * matching URLs with one global regex is what lets a password containing a space
 * or a quote — legal in userinfo, but excluded by any `[^\s'"]`-style URL
 * pattern — still be found.
 */
function sanitizeProviderWarning(warning: string): string {
  let result = '';
  let index = 0;
  let next = findNextUrlStart(warning, index);

  while (next) {
    result += warning.slice(index, next.index);

    const segmentEnd = findUrlSegmentEnd(
      warning,
      next.index,
      next.marker,
      warning.slice(0, next.index),
    );
    const segment = warning.slice(next.index, segmentEnd);
    const urlEnd = findUrlEnd(segment, next.marker.length);
    result +=
      sanitizeProviderBaseUrl(segment.slice(0, urlEnd)) + segment.slice(urlEnd);

    index = segmentEnd;
    next = findNextUrlStart(warning, index);
  }

  return result + warning.slice(index);
}

/**
 * Where the URL ends inside a span that may continue into prose.
 *
 * A span runs to the next URL or end of line, so it can carry trailing text.
 * Handing that text to `sanitizeProviderBaseUrl` would let an `@` in it — an
 * email address, say — be read as the end of a userinfo, since a pathless URL
 * has no delimiter to bound the authority. So the URL ends at the first space,
 * except that a recognised `user:password@` prefix is consumed first: a
 * password may legally contain spaces, and finding those is the whole reason
 * the message is split into spans rather than matched with a URL regex.
 *
 * Consuming that prefix is also what keeps the host intact. Were the whole span
 * handed over, `sanitizeProviderBaseUrl` would strip at the last `@` in the
 * authority it computes and rewrite the host from the prose — turning
 * `https://user:pass@host.com — contact admin@example.com` into
 * `https://example.com`.
 *
 * When the prefix is *not* recognised, cutting at the first space is the unsafe
 * direction, and that is the route every leak this function has had takes: the
 * grammar declines a `user:…@` that is really there, the cut lands inside the
 * password, the slice handed to `sanitizeProviderBaseUrl` contains no `@` at all,
 * and the credential is re-appended verbatim as prose.
 *
 * `CREDENTIAL_FALLBACK_PATTERN` closes that route for one spelling — a bare
 * one-character host — and not for the shapes where a port and a password are
 * genuinely indistinguishable, which stay as `CREDENTIAL_PREFIX_PATTERN`
 * documents them.
 */
function findUrlEnd(segment: string, markerLength: number): number {
  const body = segment.slice(markerLength);
  const credentials = CREDENTIAL_PREFIX_PATTERN.exec(body);
  if (!credentials) {
    const fallback = CREDENTIAL_FALLBACK_PATTERN.exec(body);
    if (fallback) return markerLength + fallback[0].length;
  }
  const from = credentials
    ? markerLength + credentials[0].length
    : markerLength;
  const space = segment.slice(from).search(/\s/);
  return space === -1 ? segment.length : from + space;
}

function findNextUrlStart(
  value: string,
  from: number,
): { index: number; marker: string } | undefined {
  URL_START_PATTERN.lastIndex = from;
  const match = URL_START_PATTERN.exec(value);
  return match ? { index: match.index, marker: match[0] } : undefined;
}

/**
 * A quote that opened immediately before a URL, and so closes it.
 *
 * `"https://api.example:8443"` puts the closing quote right after the port,
 * where the port heuristic expects a sentence character or a space and so reads
 * the digits as the start of a password — matching the `@` in the prose beyond
 * and deleting the real host. The closer is the evidence that the URL ended.
 *
 * Only a *balanced* delimiter counts, which is what makes this safe: adding
 * these characters to `PORT_END` instead would let a password beginning `123"`
 * read as a port, and `:123"abc secret@host` would keep its password. Here the
 * same character is inert unless the matching opener sits before the URL.
 *
 * Balance alone is still not enough, because the same character is legal in a
 * password: in `"https://user:pa"ss@host.example/v1"` the first closer sits
 * inside the credential, and cutting there leaves no `@` in the span, so nothing
 * is stripped and the password survives in full. Which is why a closer must
 * carry two signals, in `findUrlSegmentEnd` — it must be the *last* one within
 * the span, and a port must sit immediately before it. Either test alone leaks:
 * without the port, `:8443"abc secret@host` cuts at the closer inside the
 * password; without `lastIndexOf`, a closer in the password ends the span
 * whenever no later one exists on the line.
 */
const URL_QUOTE_PAIRS = new Map([
  ['"', '"'],
  ["'", "'"],
  ['`', '`'],
  ['<', '>'],
  ['(', ')'],
  ['[', ']'],
]);

/**
 * A port sitting at the end of what the closer would cut.
 *
 * This is the second half of the evidence, and it is what keeps a closer that
 * happens to fall inside a password from ending the span: the reason a balanced
 * delimiter matters at all is that the port heuristic cannot see past it, so the
 * closer only carries information when a port is what precedes it.
 */
const PORT_AT_END = /:\d+$/;

function findUrlSegmentEnd(
  value: string,
  start: number,
  marker: string,
  before: string,
): number {
  const afterMarker = start + marker.length;
  const carriageReturn = value.indexOf('\r', afterMarker);
  const lineFeed = value.indexOf('\n', afterMarker);
  let lineEnd = value.length;
  if (carriageReturn !== -1) lineEnd = Math.min(lineEnd, carriageReturn);
  if (lineFeed !== -1) lineEnd = Math.min(lineEnd, lineFeed);

  const nextUrl = findNextUrlStart(value, afterMarker);
  const bound = Math.min(lineEnd, nextUrl?.index ?? value.length);

  const closer = URL_QUOTE_PAIRS.get(before.slice(-1));
  if (closer !== undefined) {
    const closed = value.lastIndexOf(closer, bound - 1);
    if (closed >= afterMarker) {
      const upTo = value.slice(afterMarker, closed);
      if (PORT_AT_END.test(upTo) && !upTo.includes('@')) return closed;
    }
  }

  return bound;
}

function buildCurrent(
  authType: AuthType | undefined,
  modelId: string | undefined,
  baseUrl: string | undefined,
  fastModelId: string | undefined,
  visionModelId: string | undefined,
): ServeWorkspaceProviderCurrent | undefined {
  if (!authType && !modelId && !baseUrl && !fastModelId && !visionModelId)
    return undefined;
  return {
    ...(authType ? { authType: String(authType) } : {}),
    ...(modelId ? { modelId } : {}),
    ...(baseUrl ? { baseUrl: sanitizeProviderBaseUrl(baseUrl) } : {}),
    ...(fastModelId ? { fastModelId } : {}),
    ...(visionModelId ? { visionModelId } : {}),
  };
}
