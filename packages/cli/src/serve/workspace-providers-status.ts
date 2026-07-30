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
 * A host with nothing after it to mark where it ends, so its own shape is the
 * only evidence that it is one.
 *
 * Three shapes, because a single pattern for all of them would be wrong at the
 * edges. A bracketed IPv6 literal. A dotted name, whose first label may be a
 * single character (`a.example`). Or a bare label — intranet proxies, container
 * names like `ollama`, and k8s service names have no dot — required to be at
 * least two characters, which is what keeps a one-letter fragment of a password
 * from passing for a host.
 *
 * What follows the host is required only to be something a host cannot continue
 * into, rather than a fixed list of delimiters. Enumerating them meant a URL
 * ending a sentence was not recognised, since `.`, `,` and `)` were not on the
 * list — and the consequence of not recognising a host is a credential leak, so
 * the list being incomplete was not a cosmetic problem. A trailing dot is
 * allowed to belong to the sentence rather than the name.
 */
const UNDELIMITED_HOST = String.raw`(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z\d](?:[A-Za-z\d-]*\.)+[A-Za-z\d-]+|[A-Za-z\d][A-Za-z\d-]+)(?::\d+)?(?![A-Za-z\d-])`;

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
const DELIMITED_HOST = String.raw`(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z\d][A-Za-z\d-]*(?:\.[A-Za-z\d-]+)*)(?::\d+)?[/?#]`;

/** A host addressable after a userinfo, delimited or not. */
const HOST_AFTER_USERINFO = String.raw`(?:${UNDELIMITED_HOST}|${DELIMITED_HOST})`;

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
 * span, when a non-space follows them (sentence punctuation: `:8443, contact`),
 * or when a further space follows before the `@`, which is prose rather than a
 * one-space password.
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
 * Two shapes are knowingly left unstripped, because nothing in them says which
 * reading is right: `p@ss word@host.example`, where the password's tail is a
 * valid host, and `123 secret word@host`, where a second space before the `@` is
 * the same evidence that tells a port from a password. Both are pinned by test
 * so that widening either rule has to choose deliberately.
 */
const CREDENTIAL_PREFIX_PATTERN = new RegExp(
  String.raw`^[^\s/?#'"\`<>]*:(?!\d+(?:$|[^\s\d]|\s(?:[^@\s]*\s)))[^/?#]*?@(?=${HOST_AFTER_USERINFO})`,
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

    const segmentEnd = findUrlSegmentEnd(warning, next.index, next.marker);
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
 */
function findUrlEnd(segment: string, markerLength: number): number {
  const credentials = CREDENTIAL_PREFIX_PATTERN.exec(
    segment.slice(markerLength),
  );
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

function findUrlSegmentEnd(
  value: string,
  start: number,
  marker: string,
): number {
  const afterMarker = start + marker.length;
  const carriageReturn = value.indexOf('\r', afterMarker);
  const lineFeed = value.indexOf('\n', afterMarker);
  let lineEnd = value.length;
  if (carriageReturn !== -1) lineEnd = Math.min(lineEnd, carriageReturn);
  if (lineFeed !== -1) lineEnd = Math.min(lineEnd, lineFeed);

  const nextUrl = findNextUrlStart(value, afterMarker);

  return Math.min(lineEnd, nextUrl?.index ?? value.length);
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
