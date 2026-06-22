/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import * as net from 'node:net';
import * as path from 'node:path';
import express from 'express';
import type { Application, NextFunction, Request, Response } from 'express';
import type {
  ApprovalMode,
  Protocol,
  Extension,
  ExtensionInstallMetadata,
  ExtensionSetting,
} from '@qwen-code/qwen-code-core';
import {
  APPROVAL_MODES,
  ALL_PROVIDERS,
  BTW_MAX_INPUT_LENGTH,
  ExtensionUpdateState,
  ExtensionManager,
  checkForExtensionUpdate,
  redactUrlCredentials,
  SettingScope,
  parseInstallSource,
  SessionService,
  shouldShowStep,
  TrustGateError,
  addDaemonRequestAttribute,
  emitDaemonLog,
  hashDaemonWorkspace,
  recordDaemonBridgeError,
  recordDaemonError,
  recordDaemonHttpRequest,
  recordDaemonHttpResponse,
  withDaemonRequestSpan,
} from '@qwen-code/qwen-code-core';
import { writeStderrLine } from '../utils/stdioHelpers.js';
import type { DaemonLogger } from './daemon-logger.js';
import {
  allowOriginCors,
  bearerAuth,
  createMutationGate,
  denyBrowserOriginCors,
  hostAllowlist,
  parseAllowOriginPatterns,
} from './auth.js';
import {
  DeviceFlowRegistry,
  setDeviceFlowRegistry,
  TooManyActiveDeviceFlowsError,
  UnsupportedDeviceFlowProviderError,
  UpstreamDeviceFlowError,
  type DeviceFlowEventSink,
  type DeviceFlowProvider,
  type DeviceFlowProviderId,
  type DeviceFlowPublicView,
} from './auth/device-flow.js';
import { mapDomainErrorToErrorKind } from '@qwen-code/acp-bridge';
import { QwenOAuthDeviceFlowProvider } from './auth/qwen-device-flow-provider.js';
import { createBridgeFileSystemAdapter } from './bridge-file-system-adapter.js';
import { createDaemonStatusProvider } from './daemon-status-provider.js';
import { isServeDebugMode } from './debug-mode.js';
import { SUPPORTED_LANGUAGES } from '../i18n/index.js';
import { loadSettings } from '../config/settings.js';
import { isWorkspaceTrusted } from '../config/trustedFolders.js';
import { isLoopbackBind } from './loopback-binds.js';
import { mountAcpHttp, type AcpHttpHandle } from './acp-http/index.js';
import {
  buildDaemonStatusResponse,
  parseDaemonStatusDetail,
} from './daemon-status.js';
import {
  canonicalizeWorkspace,
  CancelSentinelCollisionError,
  BranchWhilePromptActiveError,
  createAcpSessionBridge,
  InvalidClientIdError,
  InvalidPermissionOptionError,
  InvalidSessionMetadataError,
  InvalidSessionScopeError,
  MAX_WORKSPACE_PATH_LENGTH,
  McpServerNotFoundError,
  McpServerRestartFailedError,
  PermissionForbiddenError,
  PermissionPolicyNotImplementedError,
  PromptQueueFullError,
  RestoreInProgressError,
  SessionBusyError,
  InvalidRewindTargetError,
  SessionLimitExceededError,
  SessionNotFoundError,
  SessionShellClientRequiredError,
  SessionShellDisabledError,
  WorkspaceInitConflictError,
  WorkspaceInitPathEscapeError,
  WorkspaceInitSymlinkError,
  WorkspaceInitRaceError,
  WorkspaceMismatchError,
  type BridgeSessionSummary,
  type AcpSessionBridge,
} from './acp-session-bridge.js';
import {
  getAdvertisedServeFeatures,
  getServeProtocolVersions,
} from './capabilities.js';
import { SubscriberLimitExceededError, type BridgeEvent } from './event-bus.js';
import {
  CAPABILITIES_SCHEMA_VERSION,
  type CapabilitiesEnvelope,
  type ServeAuthProviderCatalog,
  type ServeAuthProviderDescriptor,
  type ServeAuthProviderInstallRequest,
  type ServeAuthProviderInstallResult,
  type ServeOptions,
} from './types.js';
import { getDemoHtml } from './demo.js';
import {
  mountWebShellAssets,
  mountWebShellSpaFallback,
} from './web-shell-static.js';
import { mountWorkspaceMemoryRoutes } from './workspace-memory.js';
import { mountWorkspaceAgentsRoutes } from './workspace-agents.js';
import {
  createWorkspaceFileSystemFactory,
  type WorkspaceFileSystemFactory,
} from './fs/index.js';
import { registerWorkspaceFileReadRoutes } from './routes/workspace-file-read.js';
import { registerWorkspaceFileWriteRoutes } from './routes/workspace-file-write.js';
import {
  createDaemonWorkspaceService,
  type DaemonWorkspaceService,
  type WorkspaceRequestContext,
} from './workspace-service/index.js';
import { registerWorkspaceSettingsRoutes } from './routes/workspace-settings.js';
import { registerA2uiActionRoutes } from './routes/a2ui-action.js';
import {
  createRateLimiter,
  setRateLimiter,
  type RateLimiterInstance,
} from './rate-limit.js';
import {
  STATUS_SCHEMA_VERSION,
  type ServeExtensionCapabilities,
  type ServeExtensionEntry,
  type ServeWorkspaceExtensionsStatus,
} from './status.js';

let activeSseCount = 0;
export function getActiveSseCount(): number {
  return activeSseCount;
}

/**
 * Build a no-op fs-audit emitter that logs a warning every
 * `WARN_EVERY` dropped events. The default factory uses this so a
 * regression that silently strips audit events shows up in operator
 * logs instead of disappearing. `runQwenServe` replaces this with a
 * real per-session emit, so legitimate production traffic never hits
 * the warning.
 */
export function createDefaultFsAuditEmit(): (event: BridgeEvent) => void {
  const WARN_EVERY = 100;
  let droppedCount = 0;
  return (event: BridgeEvent) => {
    droppedCount += 1;
    if (droppedCount === 1 || droppedCount % WARN_EVERY === 0) {
      const data = event.data as
        | { errorKind?: string; pathHash?: string; intent?: string }
        | undefined;
      const ctx: string[] = [];
      if (data?.errorKind) ctx.push(`errorKind=${data.errorKind}`);
      if (data?.intent) ctx.push(`intent=${data.intent}`);
      if (data?.pathHash) ctx.push(`pathHash=${data.pathHash}`);
      const ctxStr = ctx.length > 0 ? ` (${ctx.join(' ')})` : '';
      writeStderrLine(
        `qwen serve: fs audit emit is the default no-op — ${droppedCount} event(s) dropped so far. ` +
          `Latest type=${event.type}${ctxStr}. ` +
          `Inject deps.fsFactory in createServeApp to wire audit into the EventBus.`,
      );
    }
  };
}

/**
 * Shared `WorkspaceFileSystemFactory` construction used by both
 * `runQwenServe` and `createServeApp`'s default bridge wiring.
 * Centralizes the "use the injected factory if provided, otherwise
 * build one with the given trust + audit-emit posture" logic.
 *
 * Trust is intentionally a **required** parameter — the two call
 * sites have different correct defaults:
 *   - `runQwenServe` defaults to `trusted: true`
 *   - `createServeApp` defaults to `trusted: false` (test-safe)
 */
/**
 * Module-scoped once-per-process guard for the `createServeApp`
 * default-trust stderr warning. Without this, tests calling
 * `createServeApp` repeatedly would flood stderr with identical lines.
 */
let warnedDefaultTrust = false;

export function resolveBridgeFsFactory(input: {
  boundWorkspace: string;
  injected?: WorkspaceFileSystemFactory;
  trusted: boolean;
  emit?: (event: BridgeEvent) => void;
}): WorkspaceFileSystemFactory {
  if (input.injected) return input.injected;
  return createWorkspaceFileSystemFactory({
    boundWorkspace: input.boundWorkspace,
    trusted: input.trusted,
    emit: input.emit ?? createDefaultFsAuditEmit(),
  });
}

const DEFAULT_SESSION_PAGE_SIZE = 20;
const MAX_SESSION_PAGE_SIZE = 100;

export interface ListWorkspaceSessionsOptions {
  cursor?: string;
  size?: number;
}

export interface ListWorkspaceSessionsResult {
  sessions: BridgeSessionSummary[];
  nextCursor?: string;
}

export class InvalidCursorError extends Error {
  constructor(cursor: string) {
    super(`Invalid cursor: "${cursor}" is not a valid numeric cursor`);
    this.name = 'InvalidCursorError';
  }
}

export async function listWorkspaceSessionsForResponse(
  bridge: AcpSessionBridge,
  workspaceCwd: string,
  options?: ListWorkspaceSessionsOptions,
): Promise<ListWorkspaceSessionsResult> {
  const rawSize = options?.size;
  const requestedSize =
    typeof rawSize === 'number' && Number.isSafeInteger(rawSize)
      ? rawSize
      : DEFAULT_SESSION_PAGE_SIZE;
  const pageSize = Math.min(Math.max(requestedSize, 1), MAX_SESSION_PAGE_SIZE);

  let numericCursor: number | undefined;
  if (options?.cursor) {
    const parsed = Number(options.cursor);
    if (!Number.isFinite(parsed)) {
      throw new InvalidCursorError(options.cursor);
    }
    numericCursor = parsed;
  }
  const isFirstPage = numericCursor === undefined;

  const sessionService = new SessionService(workspaceCwd);
  const persisted = await sessionService.listSessions({
    cursor: numericCursor,
    size: pageSize,
  });
  const bySessionId = new Map<string, BridgeSessionSummary>();

  for (const item of persisted.items) {
    bySessionId.set(item.sessionId, {
      sessionId: item.sessionId,
      workspaceCwd: item.cwd,
      createdAt: item.startTime,
      updatedAt: new Date(item.mtime).toISOString(),
      displayName: item.customTitle || item.prompt,
      clientCount: 0,
      hasActivePrompt: false,
    });
  }

  const liveSessions = bridge.listWorkspaceSessions(workspaceCwd);
  for (const live of liveSessions) {
    const existing = bySessionId.get(live.sessionId);
    if (existing) {
      bySessionId.set(live.sessionId, {
        ...existing,
        ...live,
        createdAt: existing.createdAt,
        displayName: live.displayName ?? existing.displayName,
        updatedAt: live.updatedAt ?? existing.updatedAt,
        clientCount: live.clientCount,
        hasActivePrompt: live.hasActivePrompt,
      });
    } else if (
      isFirstPage &&
      !(await sessionService.sessionExists(live.sessionId))
    ) {
      bySessionId.set(live.sessionId, {
        ...live,
        createdAt: live.createdAt,
        clientCount: live.clientCount,
        hasActivePrompt: live.hasActivePrompt,
      });
    }
  }

  const sessions = [...bySessionId.values()].sort((a, b) => {
    const aTime = Date.parse(a.updatedAt ?? a.createdAt);
    const bTime = Date.parse(b.updatedAt ?? b.createdAt);
    return bTime - aTime;
  });

  const nextCursor =
    persisted.nextCursor != null ? String(persisted.nextCursor) : undefined;

  return { sessions, nextCursor };
}

function parseSessionPageSizeQuery(raw: unknown): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed)) return undefined;
  if (Number.isSafeInteger(parsed)) return parsed;
  return trimmed.startsWith('-') ? 1 : MAX_SESSION_PAGE_SIZE;
}

const AUTH_PROVIDER_STEPS: ServeAuthProviderDescriptor['steps'] = [
  'protocol',
  'baseUrl',
  'apiKey',
  'models',
  'advancedConfig',
];

function buildAuthProviderDescriptor(
  provider: (typeof ALL_PROVIDERS)[number],
): ServeAuthProviderDescriptor {
  const steps = AUTH_PROVIDER_STEPS.filter((step) =>
    shouldShowStep(provider, step),
  );
  return {
    id: provider.id,
    label: provider.label,
    description: provider.description,
    ...(provider.uiGroup ? { uiGroup: provider.uiGroup } : {}),
    protocol: provider.protocol,
    ...(provider.protocolOptions
      ? { protocolOptions: [...provider.protocolOptions] }
      : {}),
    ...(provider.baseUrl !== undefined ? { baseUrl: provider.baseUrl } : {}),
    ...(typeof provider.envKey === 'string' ? { envKey: provider.envKey } : {}),
    ...(provider.models
      ? {
          models: provider.models.map((model) => ({
            id: model.id,
            ...(model.contextWindowSize !== undefined
              ? { contextWindowSize: model.contextWindowSize }
              : {}),
            ...(model.enableThinking !== undefined
              ? { enableThinking: model.enableThinking }
              : {}),
            ...(model.modalities ? { modalities: model.modalities } : {}),
            ...(model.description ? { description: model.description } : {}),
          })),
        }
      : {}),
    ...(provider.modelsEditable !== undefined
      ? { modelsEditable: provider.modelsEditable }
      : {}),
    ...(provider.apiKeyPlaceholder
      ? { apiKeyPlaceholder: provider.apiKeyPlaceholder }
      : {}),
    ...(typeof provider.documentationUrl === 'string'
      ? { documentationUrl: provider.documentationUrl }
      : {}),
    ...(provider.showAdvancedConfig !== undefined
      ? { showAdvancedConfig: provider.showAdvancedConfig }
      : {}),
    ...(provider.uiLabels ? { uiLabels: provider.uiLabels } : {}),
    steps,
  };
}

function buildAuthProviderCatalog(
  workspaceCwd: string,
): ServeAuthProviderCatalog {
  const providers = ALL_PROVIDERS.map(buildAuthProviderDescriptor);
  const providerIdsByGroup = (group: string) =>
    providers
      .filter((provider) => provider.uiGroup === group)
      .map((provider) => provider.id);
  return {
    v: 1,
    workspaceCwd,
    providers,
    groups: [
      {
        id: 'alibaba',
        label: 'Alibaba ModelStudio',
        description:
          'Official recommended setup: Coding Plan, Token Plan, or Standard API Key',
        providerIds: providerIdsByGroup('alibaba'),
      },
      {
        id: 'third-party',
        label: 'Third-party Providers',
        description: 'Choose a built-in provider and connect with an API key',
        providerIds: providerIdsByGroup('third-party'),
      },
      {
        id: 'custom',
        label: 'Custom Provider',
        description:
          'Manually connect a local server, proxy, or unsupported provider',
        providerIds: providerIdsByGroup('custom'),
      },
    ],
  };
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);
  return result.length > 0 ? [...new Set(result)] : undefined;
}

function parsePositiveBoundedInteger(
  value: unknown,
  max: number,
): number | undefined {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > max
  ) {
    return undefined;
  }
  return value;
}

function parseIPv4MappedHexSuffix(suffix: string): string | undefined {
  const hexParts = suffix.split(':');
  if (hexParts.length !== 2) return undefined;

  const [hiRaw, loRaw] = hexParts;
  if (!/^[0-9a-f]{1,4}$/i.test(hiRaw) || !/^[0-9a-f]{1,4}$/i.test(loRaw)) {
    return undefined;
  }

  const hi = Number.parseInt(hiRaw, 16);
  const lo = Number.parseInt(loRaw, 16);
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function parseIPv6FirstHextet(host: string): number | undefined {
  const first = host.split(':', 1)[0];
  if (!first || !/^[0-9a-f]{1,4}$/i.test(first)) return undefined;
  return Number.parseInt(first, 16);
}

function parseLegacyIPv4Part(value: string, max: number): number | undefined {
  let parsed: number;
  if (/^0x[0-9a-f]+$/i.test(value)) {
    parsed = Number.parseInt(value.slice(2), 16);
  } else if (/^0[0-7]+$/.test(value)) {
    parsed = Number.parseInt(value, 8);
  } else if (/^[0-9]+$/.test(value)) {
    parsed = Number.parseInt(value, 10);
  } else {
    return undefined;
  }
  return parsed <= max ? parsed : undefined;
}

// Match URL parsers that still accept inet_aton-style IPv4 aliases, so blocked
// host checks also catch SSH sources such as git@0177.1:owner/repo.git.
function parseLegacyIPv4Host(host: string): string | undefined {
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4 || parts.some((part) => !part)) {
    return undefined;
  }

  // In legacy one-, two-, and three-part IPv4 forms, the final part carries the
  // remaining bytes rather than a single octet.
  const maxLastPart = [0xffffffff, 0xffffff, 0xffff, 0xff][parts.length - 1];
  if (maxLastPart === undefined) return undefined;

  const parsed = parts.map((part, index) =>
    parseLegacyIPv4Part(part, index === parts.length - 1 ? maxLastPart : 0xff),
  );
  if (parsed.some((part) => part === undefined)) return undefined;

  const values = parsed as number[];
  const numeric =
    values.length === 1
      ? values[0]
      : values.length === 2
        ? values[0] * 0x1000000 + values[1]
        : values.length === 3
          ? values[0] * 0x1000000 + values[1] * 0x10000 + values[2]
          : values[0] * 0x1000000 +
            values[1] * 0x10000 +
            values[2] * 0x100 +
            values[3];

  return [
    Math.floor(numeric / 0x1000000) & 0xff,
    Math.floor(numeric / 0x10000) & 0xff,
    Math.floor(numeric / 0x100) & 0xff,
    numeric & 0xff,
  ].join('.');
}

function isBlockedAuthProviderHost(hostname: string): boolean {
  const stripped = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
  const host = stripped.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  const bareHost =
    host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const blocklistHost = parseLegacyIPv4Host(bareHost) ?? bareHost;
  const ipVersion = net.isIP(blocklistHost);
  if (ipVersion === 4) {
    const parts = blocklistHost.split('.').map((part) => Number(part));
    const [a, b] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b !== undefined && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b !== undefined && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }

  if (ipVersion === 6) {
    if (blocklistHost === '::' || blocklistHost === '::1') return true;
    const firstHextet = parseIPv6FirstHextet(blocklistHost);
    if (
      firstHextet !== undefined &&
      ((firstHextet >= 0xfe80 && firstHextet <= 0xfebf) ||
        (firstHextet & 0xfe00) === 0xfc00)
    ) {
      return true;
    }
    if (blocklistHost.startsWith('::ffff:')) {
      const suffix = blocklistHost.slice('::ffff:'.length);
      if (net.isIP(suffix) === 4) {
        return isBlockedAuthProviderHost(suffix);
      }
      const mappedIPv4 = parseIPv4MappedHexSuffix(suffix);
      return mappedIPv4 ? isBlockedAuthProviderHost(mappedIPv4) : true;
    }
  }

  return false;
}

function parseAuthProviderBaseUrl(
  value: unknown,
  allowPrivateBaseUrl: boolean,
): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  if (!allowPrivateBaseUrl && isBlockedAuthProviderHost(parsed.hostname)) {
    return null;
  }
  return parsed.toString().replace(/\/$/, '');
}

type AuthProviderParseResult =
  | { ok: true; value: ServeAuthProviderInstallRequest }
  | { ok: false; code: string; error: string };

function parseAuthProviderInstallRequest(
  body: Record<string, unknown>,
  options?: { allowPrivateBaseUrl?: boolean },
): AuthProviderParseResult {
  const providerId = body['providerId'];
  const apiKey = body['apiKey'];
  if (
    typeof providerId !== 'string' ||
    providerId.trim().length === 0 ||
    typeof apiKey !== 'string' ||
    apiKey.trim().length === 0
  ) {
    return {
      ok: false,
      code: 'invalid_request',
      error: '`providerId` and `apiKey` are required',
    };
  }
  const protocol = body['protocol'];
  const baseUrl = parseAuthProviderBaseUrl(
    body['baseUrl'],
    options?.allowPrivateBaseUrl === true,
  );
  if (baseUrl === null) {
    return {
      ok: false,
      code: 'invalid_base_url',
      error:
        '`baseUrl` must be an http(s) URL without credentials or blocked private-network host',
    };
  }
  const modelIds = parseStringArray(body['modelIds']);
  const rawAdvanced =
    body['advancedConfig'] && typeof body['advancedConfig'] === 'object'
      ? (body['advancedConfig'] as Record<string, unknown>)
      : undefined;
  const rawMultimodal =
    rawAdvanced?.['multimodal'] && typeof rawAdvanced['multimodal'] === 'object'
      ? (rawAdvanced['multimodal'] as Record<string, unknown>)
      : undefined;
  const contextWindowSize = parsePositiveBoundedInteger(
    rawAdvanced?.['contextWindowSize'],
    10_000_000,
  );
  const maxTokens = parsePositiveBoundedInteger(
    rawAdvanced?.['maxTokens'],
    10_000_000,
  );
  const advancedConfig = rawAdvanced
    ? {
        ...(typeof rawAdvanced['enableThinking'] === 'boolean'
          ? { enableThinking: rawAdvanced['enableThinking'] }
          : {}),
        ...(rawMultimodal
          ? {
              multimodal: {
                ...(typeof rawMultimodal['image'] === 'boolean'
                  ? { image: rawMultimodal['image'] }
                  : {}),
                ...(typeof rawMultimodal['pdf'] === 'boolean'
                  ? { pdf: rawMultimodal['pdf'] }
                  : {}),
                ...(typeof rawMultimodal['audio'] === 'boolean'
                  ? { audio: rawMultimodal['audio'] }
                  : {}),
                ...(typeof rawMultimodal['video'] === 'boolean'
                  ? { video: rawMultimodal['video'] }
                  : {}),
              },
            }
          : {}),
        ...(contextWindowSize !== undefined ? { contextWindowSize } : {}),
        ...(maxTokens !== undefined ? { maxTokens } : {}),
      }
    : undefined;
  return {
    ok: true,
    value: {
      providerId: providerId.trim(),
      ...(typeof protocol === 'string' && protocol.trim()
        ? {
            protocol:
              protocol.trim() as ServeAuthProviderInstallRequest['protocol'],
          }
        : {}),
      ...(baseUrl ? { baseUrl } : {}),
      apiKey,
      ...(modelIds ? { modelIds } : {}),
      ...(advancedConfig ? { advancedConfig } : {}),
    },
  };
}

export interface ServeAppDeps {
  /** Bridge instance; tests inject a fake. Defaults to a fresh real one. */
  bridge?: AcpSessionBridge;
  /**
   * Directory of the built Web Shell SPA (`index.html` + `assets/`). When
   * set (and `opts.serveWebShell !== false`), `createServeApp` mounts the
   * UI at the daemon root before `bearerAuth`. Production `runQwenServe`
   * resolves this via `resolveWebShellDir()` and injects it here; direct
   * embeds / tests opt in by passing a fixture dir, so the default
   * `createServeApp` (no injection) stays API-only and existing route tests
   * are unaffected.
   */
  webShellDir?: string;
  /**
   * Qwen Code version advertised to web/SDK clients. Production passes the
   * resolved CLI package version; tests/direct embeds may omit it.
   */
  qwenCodeVersion?: string;
  /**
   * Pre-canonicalized workspace path. When supplied, `createServeApp`
   * skips its own `canonicalizeWorkspace` call (which would issue a
   * redundant `realpathSync.native` syscall — idempotent, but a hot
   * boot-time stat we can avoid). `runQwenServe` passes this after
   * its own boot-time canonicalize so the value used by
   * `/capabilities`, the `POST /session` cwd fallback, and the
   * bridge are all the SAME canonical form. Callers that haven't
   * canonicalized yet (tests, direct embeds) omit this and
   * `createServeApp` falls back to canonicalizing `opts.workspace ??
   * process.cwd()` itself.
   */
  boundWorkspace?: string;
  /**
   * Workspace filesystem boundary factory. When supplied, file routes
   * pull a per-request `WorkspaceFileSystem` off it; when omitted,
   * `createServeApp` builds a strict default (`trusted: false`,
   * warn-once no-op `emit`) so an upstream refactor that forgets to
   * inject `fsFactory` never silently allows writes against an
   * untrusted workspace.
   */
  fsFactory?: WorkspaceFileSystemFactory;
  /**
   * Device-flow auth registry. Tests inject a fake; production callers
   * omit this and `createServeApp` constructs a default wired to the
   * shipped Qwen provider, the bridge's `publishWorkspaceEvent`,
   * and a stderr audit sink.
   */
  deviceFlowRegistry?: DeviceFlowRegistry;
  /**
   * Extra device-flow providers for tests / future extensions.
   * Production builds register only `QwenOAuthDeviceFlowProvider`;
   * passing extra entries here registers them in addition.
   */
  deviceFlowProviders?: DeviceFlowProvider[];
  /**
   * Installs an LLM auth provider by applying the same provider install plan
   * used by interactive `/auth`. Production `runQwenServe` injects a
   * settings-backed implementation; tests/direct embeds may omit it, in which
   * case the route reports `not_implemented`.
   */
  installAuthProvider?: (
    req: ServeAuthProviderInstallRequest,
  ) => Promise<ServeAuthProviderInstallResult>;
  /**
   * Optional daemon logger. When provided, `sendBridgeError` routes
   * each 5xx error through `daemonLog.error(...)` (which tees to stderr +
   * the daemon log file). When omitted, falls back to existing
   * stderr-only behavior.
   */
  daemonLog?: DaemonLogger;
  workspace?: DaemonWorkspaceService;
  persistDisabledTools?: (
    workspace: string,
    toolName: string,
    enabled: boolean,
  ) => Promise<void>;
  contextFilename?: string;
  persistSetting?: (
    workspace: string,
    scope: import('../config/settings.js').SettingScope,
    key: string,
    value: unknown,
  ) => Promise<void>;
}

function resolveDaemonTelemetryRoute(
  req: Request,
):
  | { route: string; sessionId?: string; permissionRequestId?: string }
  | undefined {
  const path = req.path.replace(/\/$/, '') || '/';
  if (req.method === 'POST' && path === '/session') {
    return { route: 'POST /session' };
  }
  if (req.method === 'POST' && path === '/sessions/delete') {
    return { route: 'POST /sessions/delete' };
  }
  if (req.method === 'GET' && path === '/daemon/status') {
    return { route: 'GET /daemon/status' };
  }
  const sessionAction = path.match(
    /^\/session\/([^/]+)\/(load|resume|prompt|cancel|recap|btw|mid-turn-message|model|shell|detach|rewind|approval-mode|language|a2ui-action)$/,
  );
  const sessionActionId = sessionAction?.[1];
  const sessionActionName = sessionAction?.[2];
  if (sessionActionId && sessionActionName && req.method === 'POST') {
    return {
      route: `POST /session/:id/${sessionActionName}`,
      sessionId: sessionActionId,
    };
  }
  const sessionMetadata = path.match(/^\/session\/([^/]+)\/metadata$/);
  if (sessionMetadata?.[1] && req.method === 'PATCH') {
    return {
      route: 'PATCH /session/:id/metadata',
      sessionId: sessionMetadata[1],
    };
  }
  const sessionPermission = path.match(
    /^\/session\/([^/]+)\/permission\/([^/]+)$/,
  );
  if (
    sessionPermission?.[1] &&
    sessionPermission?.[2] &&
    req.method === 'POST'
  ) {
    const rawRequestId = sessionPermission[2];
    return {
      route: 'POST /session/:id/permission/:requestId',
      sessionId: sessionPermission[1],
      ...(rawRequestId.length <= MAX_CLIENT_ID_LENGTH &&
      CLIENT_ID_RE.test(rawRequestId)
        ? { permissionRequestId: rawRequestId }
        : {}),
    };
  }
  const globalPermission = path.match(/^\/permission\/([^/]+)$/);
  if (globalPermission?.[1] && req.method === 'POST') {
    const rawRequestId = globalPermission[1];
    return {
      route: 'POST /permission/:requestId',
      ...(rawRequestId.length <= MAX_CLIENT_ID_LENGTH &&
      CLIENT_ID_RE.test(rawRequestId)
        ? { permissionRequestId: rawRequestId }
        : {}),
    };
  }
  const deleteSession = path.match(/^\/session\/([^/]+)$/);
  const deleteSessionId = deleteSession?.[1];
  if (deleteSessionId && req.method === 'DELETE') {
    return { route: 'DELETE /session/:id', sessionId: deleteSessionId };
  }
  if (req.method === 'GET' && /^\/workspace\/[^/]+\/sessions$/.test(path)) {
    return { route: 'GET /workspace/:id/sessions' };
  }
  if (req.method === 'POST' && path === '/workspace/init') {
    return { route: 'POST /workspace/init' };
  }
  if (req.method === 'POST' && path === '/workspace/reload') {
    return { route: 'POST /workspace/reload' };
  }
  const mcpRestart = path.match(/^\/workspace\/mcp\/([^/]+)\/restart$/);
  if (mcpRestart?.[1] && req.method === 'POST') {
    return { route: 'POST /workspace/mcp/:server/restart' };
  }
  if (req.method === 'POST' && path === '/workspace/mcp/servers') {
    return { route: 'POST /workspace/mcp/servers' };
  }
  const mcpDelete = path.match(/^\/workspace\/mcp\/servers\/([^/]+)$/);
  if (mcpDelete?.[1] && req.method === 'DELETE') {
    return { route: 'DELETE /workspace/mcp/servers/:name' };
  }
  if (req.method === 'POST' && path === '/workspace/auth/device-flow') {
    return { route: 'POST /workspace/auth/device-flow' };
  }
  const deviceFlowDelete = path.match(
    /^\/workspace\/auth\/device-flow\/([^/]+)$/,
  );
  if (deviceFlowDelete?.[1] && req.method === 'DELETE') {
    return { route: 'DELETE /workspace/auth/device-flow/:id' };
  }
  const toolEnable = path.match(/^\/workspace\/tools\/([^/]+)\/enable$/);
  if (toolEnable?.[1] && req.method === 'POST') {
    return { route: 'POST /workspace/tools/:name/enable' };
  }
  if (path === '/workspace/settings') {
    if (req.method === 'GET') return { route: 'GET /workspace/settings' };
    if (req.method === 'POST') return { route: 'POST /workspace/settings' };
  }
  return undefined;
}

function daemonTelemetryMiddleware(
  boundWorkspace: string,
): (req: Request, res: Response, next: NextFunction) => void {
  const workspaceHash = hashDaemonWorkspace(boundWorkspace);
  return (req, res, next) => {
    const route = resolveDaemonTelemetryRoute(req);
    if (!route) {
      next();
      return;
    }
    const rawClientId = req.get(CLIENT_ID_HEADER);
    const clientId =
      rawClientId !== undefined &&
      rawClientId !== '' &&
      rawClientId.length <= MAX_CLIENT_ID_LENGTH &&
      CLIENT_ID_RE.test(rawClientId)
        ? rawClientId
        : undefined;
    const startMs = Date.now();
    void withDaemonRequestSpan(
      {
        method: req.method,
        route: route.route,
        workspaceHash,
        ...(route.sessionId ? { sessionId: route.sessionId } : {}),
        ...(route.permissionRequestId
          ? { permissionRequestId: route.permissionRequestId }
          : {}),
        ...(clientId ? { clientId } : {}),
      },
      async (span) =>
        await new Promise<void>((resolve, reject) => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            recordDaemonHttpResponse(span, res.statusCode);
            recordDaemonHttpRequest(
              Date.now() - startMs,
              route.route,
              res.statusCode,
            );
            resolve();
          };
          res.once('finish', finish);
          res.once('close', finish);
          try {
            next();
          } catch (error) {
            recordDaemonError(span, error);
            reject(error);
          }
        }),
    ).catch(next);
  };
}

/**
 * Sentinel passed as `AbortController.abort(reason)` when a prompt
 * exceeds its server-configured wallclock. Exported so tests can
 * match on the class identity.
 */
export class PromptDeadlineExceededError extends Error {
  readonly deadlineMs: number;
  constructor(deadlineMs: number) {
    super(`prompt exceeded the ${deadlineMs}ms deadline`);
    this.name = 'PromptDeadlineExceededError';
    this.deadlineMs = deadlineMs;
  }
}

/**
 * Resolve the effective per-prompt wallclock from the server flag +
 * an optional request body override. Returns `undefined` when no
 * deadline applies. The request override may SHORTEN the deadline but
 * never EXTEND it — operators stay the upper bound.
 */
export function resolvePromptDeadlineMs(
  serverMs: number | undefined,
  requestMs: number | undefined,
): number | undefined {
  if (serverMs === undefined || !Number.isFinite(serverMs) || serverMs <= 0) {
    return undefined;
  }
  if (
    requestMs === undefined ||
    !Number.isFinite(requestMs) ||
    requestMs <= 0
  ) {
    return serverMs;
  }
  return Math.min(serverMs, requestMs);
}

// Keep in sync with acp-bridge bridge.ts and SDK DaemonClient.ts.
const DEFAULT_MAX_PENDING_PROMPTS_PER_SESSION = 5;

function advertisedMaxPendingPromptsPerSession(
  value: number | undefined,
): number | null {
  if (value === undefined) return DEFAULT_MAX_PENDING_PROMPTS_PER_SESSION;
  if (value === 0 || value === Number.POSITIVE_INFINITY) return null;
  return value;
}

/**
 * Build the Express app for `qwen serve`. Pure function — no side effects on
 * the network or process; `runQwenServe` does the listen/signal handling.
 *
 * `getPort` is invoked lazily by the host-allowlist middleware so callers
 * binding to port 0 (ephemeral) can supply the actual port after `listen()`
 * resolves. Defaults to `opts.port` for callers (e.g. tests) that pin a port
 * up front.
 *
 * Supported routes:
 *   - `GET  /health`
 *   - `GET  /daemon/status`
 *   - `GET  /capabilities`
 *   - `GET  /workspace/mcp`
 *   - `GET  /workspace/skills`
 *   - `GET  /workspace/providers`
 *   - `GET  /workspace/env`
 *   - `GET  /workspace/preflight`
 *   - `POST /session`
 *   - `POST /session/:id/load`
 *   - `POST /session/:id/resume`
 *   - `GET  /workspace/:id/sessions`
 *   - `GET  /session/:id/context`
 *   - `GET  /session/:id/supported-commands`
 *   - `GET  /session/:id/tasks`
 *   - `POST /session/:id/prompt`
 *   - `POST /session/:id/cancel`
 *   - `POST /session/:id/heartbeat`
 *   - `POST /session/:id/model`
 *   - `GET  /session/:id/events` (SSE)
 *   - `POST /session/:id/permission/:requestId`
 *   - `POST /permission/:requestId`
 *
 * **Workspace validation contract.** `createServeApp` itself does NOT
 * verify that `opts.workspace` exists or is a directory — it
 * canonicalizes via `canonicalizeWorkspace`, which falls back to
 * `path.resolve` on ENOENT so the app boots even against a missing
 * path. `runQwenServe` is the production entry point and DOES
 * perform the `fs.statSync` + `isDirectory()` boot-loud check before
 * calling this function. Tests inject synthetic paths (`/work/bound`
 * etc.) on purpose: they want to exercise the route layer's
 * canonicalization and `workspace_mismatch` translation without
 * needing a real directory on disk. If a future entry point binds
 * `createServeApp` directly to user input, it MUST replicate the
 * `runQwenServe` validation (or call into a shared helper if one is
 * extracted) — otherwise a non-existent `--workspace` would boot
 * a "healthy"-looking daemon whose every spawn fails with cryptic
 * child-process ENOENT.
 */
export function createServeApp(
  opts: ServeOptions,
  getPort: () => number = () => opts.port,
  deps: ServeAppDeps = {},
): Application {
  const app = express();
  // Forward `maxSessions` into the default-constructed bridge so
  // direct callers of `createServeApp` (tests, embeds) get the same
  // cap they configured via `ServeOptions`. Previously the default
  // bridge silently fell back to `DEFAULT_MAX_SESSIONS` (20) and
  // only the `runQwenServe` path piped the option through.
  //
  // The daemon is bound to exactly one workspace. The value advertised
  // on `/capabilities`, used for the `POST /session` cwd fallback,
  // AND passed into the bridge must be the SAME canonical form.
  // `deps.boundWorkspace` is the pre-canonicalized fast-path from
  // `runQwenServe`; when omitted we canonicalize ourselves.
  const boundWorkspace =
    deps.boundWorkspace ??
    canonicalizeWorkspace(opts.workspace ?? process.cwd());
  // Construct `fsFactory` BEFORE the bridge so the bridge can wire it
  // through `BridgeFileSystem` for ACP-side writeTextFile/readTextFile.
  // Default trust is `false` (test-safe). Embeds without `deps.fsFactory`
  // or `deps.bridge` will see agent writes rejected with
  // `untrusted_workspace` — warn once so the asymmetry is visible.
  if (!deps.fsFactory && !deps.bridge && !warnedDefaultTrust) {
    warnedDefaultTrust = true;
    process.stderr.write(
      'qwen serve: createServeApp default fsFactory uses trusted=false ' +
        '— agent ACP writeTextFile calls will reject with untrusted_workspace. ' +
        'Inject deps.fsFactory (with explicit trust) or deps.bridge to override.\n',
    );
  }
  const fsFactory = resolveBridgeFsFactory({
    boundWorkspace,
    injected: deps.fsFactory,
    trusted: false,
  });
  const tokenConfigured =
    typeof opts.token === 'string' && opts.token.length > 0;
  const sessionShellCommandEnabled =
    opts.enableSessionShell === true && tokenConfigured;
  const bridge =
    deps.bridge ??
    createAcpSessionBridge({
      maxSessions: opts.maxSessions,
      maxPendingPromptsPerSession: opts.maxPendingPromptsPerSession,
      eventRingSize: opts.eventRingSize,
      permissionResponseTimeoutMs: opts.permissionResponseTimeoutMs,
      boundWorkspace,
      sessionShellCommandEnabled,
      // Wire the production status provider so direct embeds / tests
      // that don't inject `deps.bridge` get daemon env + preflight cells.
      statusProvider: createDaemonStatusProvider(),
      // Wire the WorkspaceFileSystem adapter so ACP writeTextFile /
      // readTextFile pick up trust / TOCTOU / audit.
      fileSystem: createBridgeFileSystemAdapter(fsFactory),
    });

  // Allow same-origin requests from the demo page. Browsers send an
  // `Origin` header on same-origin POST/fetch calls; `denyBrowserOriginCors`
  // below would reject them. This middleware strips `Origin` when it
  // matches the daemon's own address so the demo page's API calls pass
  // through. Only loopback origins are matched — non-loopback deployments
  // require the operator to front the daemon with a reverse proxy for
  // browser access anyway (per the threat-model docs).
  let cachedStripPort = -1;
  let cachedSelfOrigins: Set<string> = new Set();
  app.use((req: import('express').Request, _res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      const port = getPort();
      if (port !== cachedStripPort) {
        cachedStripPort = port;
        cachedSelfOrigins = new Set([
          `http://127.0.0.1:${port}`,
          `http://localhost:${port}`,
          `http://[::1]:${port}`,
          `http://host.docker.internal:${port}`,
        ]);
      }
      if (cachedSelfOrigins.has(origin)) {
        delete req.headers.origin;
      }
    }
    next();
  });

  // Park the factory on `app.locals` so route handlers can pick it up
  // via `req.app.locals.fsFactory` without re-threading the value
  // through every handler signature.
  (app.locals as { fsFactory?: WorkspaceFileSystemFactory }).fsFactory =
    fsFactory;
  // Surface the bound workspace on `app.locals` so file routes can
  // compute workspace-relative response paths without re-resolving.
  (app.locals as { boundWorkspace?: string }).boundWorkspace = boundWorkspace;

  // Wire the device-flow registry. Default builds a single Qwen
  // provider; tests inject `deps.deviceFlowRegistry` or
  // `deps.deviceFlowProviders` to stub the OAuth client only.
  const deviceFlowProviderMap = new Map<
    DeviceFlowProviderId,
    DeviceFlowProvider
  >();
  for (const provider of deps.deviceFlowProviders ?? []) {
    deviceFlowProviderMap.set(provider.providerId, provider);
  }
  if (!deviceFlowProviderMap.has('qwen-oauth')) {
    deviceFlowProviderMap.set('qwen-oauth', new QwenOAuthDeviceFlowProvider());
  }
  const deviceFlowEventSink: DeviceFlowEventSink = {
    publish(emission, originatorClientId) {
      bridge.publishWorkspaceEvent({
        type: `auth_device_flow_${emission.type}`,
        data: emission.data,
        ...(originatorClientId ? { originatorClientId } : {}),
      });
    },
  };
  const deviceFlowRegistry =
    deps.deviceFlowRegistry ??
    new DeviceFlowRegistry({
      events: deviceFlowEventSink,
      audit: {
        record(line) {
          // Structured stderr breadcrumb; deviceFlowId truncated to first
          // 8 chars so log
          // skimmers can follow a flow without retaining full uuids.
          const id = line.deviceFlowId.slice(0, 8);
          const parts = [
            `[serve] auth.device-flow:`,
            `provider=${line.providerId}`,
            `deviceFlowId=${id}...`,
            line.clientId ? `clientId=${line.clientId}` : 'clientId=-',
            `status=${line.status}`,
          ];
          if (line.errorKind) parts.push(`errorKind=${line.errorKind}`);
          if (line.expiresInMs !== undefined) {
            parts.push(`expiresInMs=${Math.max(0, line.expiresInMs)}`);
          }
          // Include `line.hint` for operator-only breadcrumbs that
          // aren't surfaced over SSE. Bound at 1 KiB.
          if (line.hint) {
            const STDERR_HINT_MAX = 1_024;
            const hint =
              line.hint.length > STDERR_HINT_MAX
                ? `${line.hint.slice(0, STDERR_HINT_MAX)}…[+${line.hint.length - STDERR_HINT_MAX} bytes truncated]`
                : line.hint;
            // Quote the hint so multi-word values stay parseable.
            parts.push(`hint=${JSON.stringify(hint)}`);
          }
          writeStderrLine(parts.join(' '));
        },
      },
      resolveProvider: (providerId) => deviceFlowProviderMap.get(providerId),
    });
  // Park the registry on `app.locals` so request handlers can reach it.
  // Typed accessor prevents a string-key typo from silently detaching
  // `runQwenServe`'s shutdown dispose call.
  setDeviceFlowRegistry(app, deviceFlowRegistry);

  const { daemonLog } = deps;

  const sendBridgeError = (
    res: import('express').Response,
    err: unknown,
    ctx?: BridgeErrorContext,
  ) => sendBridgeErrorImpl(res, err, ctx, daemonLog);
  const sendPermissionVoteError = (
    res: import('express').Response,
    err: unknown,
    ctx: { route: string; sessionId?: string },
  ) => sendPermissionVoteErrorImpl(res, err, ctx, daemonLog);

  const workspace: DaemonWorkspaceService =
    deps.workspace ??
    createDaemonWorkspaceService({
      boundWorkspace,
      contextFilename: deps.contextFilename ?? 'QWEN.md',
      statusProvider: createDaemonStatusProvider(),
      isChannelLive: () => bridge.isChannelLive(),
      persistDisabledTools:
        deps.persistDisabledTools ??
        (async () => {
          throw new Error(
            'setWorkspaceToolEnabled requires persistDisabledTools in ServeAppDeps',
          );
        }),
      queryWorkspaceStatus: (method, idle) =>
        bridge.queryWorkspaceStatus(method, idle),
      invokeWorkspaceCommand: (method, params, invokeOpts) =>
        bridge.invokeWorkspaceCommand(method, params, invokeOpts),
      refreshExtensionsForAllSessions: () =>
        bridge.refreshExtensionsForAllSessions(),
      publishWorkspaceEvent: (event) => bridge.publishWorkspaceEvent(event),
    });
  let extensionInstallQueue: Promise<unknown> = Promise.resolve();
  let extensionInstallQueueDepth = 0;
  const MAX_EXTENSION_INSTALL_QUEUE_DEPTH = 10;
  const enqueueExtensionInstall = async <T>(run: () => Promise<T>) => {
    if (extensionInstallQueueDepth >= MAX_EXTENSION_INSTALL_QUEUE_DEPTH) {
      throw new Error('Extension operation queue is full');
    }
    extensionInstallQueueDepth += 1;
    const next = extensionInstallQueue.then(run, run).finally(() => {
      extensionInstallQueueDepth -= 1;
    });
    extensionInstallQueue = next.catch(() => undefined);
    return next;
  };
  const EXTENSION_MUTATION_TIMEOUT_MS = 120_000;
  const EXTENSION_REFRESH_TIMEOUT_MS = 30_000;
  const isExtensionQueueFullError = (err: unknown): boolean =>
    err instanceof Error && err.message === 'Extension operation queue is full';
  const sendExtensionQueueFull = (res: Response) => {
    res.status(429).json({
      error: 'Extension operation queue is full',
      code: 'extension_queue_full',
    });
  };
  const withExtensionTimeout = async <T>(
    promise: Promise<T>,
    timeoutMs: number,
    operation: string,
  ): Promise<T> =>
    await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`${operation} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        (err: unknown) => {
          clearTimeout(timeout);
          reject(err);
        },
      );
    });
  const createExtensionManager = () =>
    new ExtensionManager({
      workspaceDir: boundWorkspace,
      isWorkspaceTrusted: !!isWorkspaceTrusted(
        loadSettings(boundWorkspace).merged,
      ),
      requestConsent: () => Promise.resolve(),
      requestSetting: async (setting: ExtensionSetting) => {
        throw new Error(
          `Extension setting "${setting.envVar}" requires interactive configuration and is not supported over the daemon install endpoint.`,
        );
      },
      requestChoicePlugin: async () => {
        throw new Error(
          'Marketplace plugin selection is not supported over the daemon install endpoint. Specify a plugin name in the source.',
        );
      },
    });
  const validateExtensionMutationClient = (
    req: Request,
    res: Response,
    route: string,
  ): boolean => {
    const clientId = parseAndValidateWorkspaceClientId(req, res, bridge);
    if (clientId === null) return false;
    if (clientId === undefined) {
      res.status(400).json({
        error: 'Missing X-Qwen-Client-Id header',
        code: 'missing_client_id',
      });
      return false;
    }
    buildWorkspaceCtx(req, route, clientId);
    return true;
  };
  const parseExtensionScope = (
    body: Record<string, unknown>,
    res: Response,
  ): SettingScope | null => {
    const scope = body['scope'];
    if (scope !== 'user' && scope !== 'workspace') {
      res
        .status(400)
        .json({ error: '`scope` must be either "user" or "workspace"' });
      return null;
    }
    return scope === 'user' ? SettingScope.User : SettingScope.Workspace;
  };
  const parseExtensionRegistryUrl = (
    value: string,
    res: Response,
  ): string | null => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      res.status(400).json({ error: '`registry` must be a valid URL' });
      return null;
    }
    if (parsed.protocol !== 'https:') {
      res.status(400).json({ error: '`registry` must use https' });
      return null;
    }
    if (parsed.username || parsed.password) {
      res
        .status(400)
        .json({ error: '`registry` must not include credentials' });
      return null;
    }
    if (isBlockedAuthProviderHost(parsed.hostname)) {
      res.status(400).json({ error: '`registry` host is not allowed' });
      return null;
    }
    return parsed.toString().replace(/\/$/, '');
  };
  const parsePotentialSourceUrl = (source: string): URL | null => {
    if (/^[a-zA-Z]:[\\/]/.test(source)) return null;
    try {
      return new URL(source);
    } catch {
      const sshMatch = /^(?:[^@]+@)?(\[[^\]]+\]|[^:]+):/.exec(source);
      if (!sshMatch?.[1]) return null;
      try {
        return new URL(`ssh://${sshMatch[1]}`);
      } catch {
        return null;
      }
    }
  };
  const validateExtensionSourceHost = (
    source: string,
    res: Response,
  ): boolean => {
    const parsed = parsePotentialSourceUrl(source);
    if (!parsed) return true;
    if (parsed.username || parsed.password) {
      res.status(400).json({ error: '`source` must not include credentials' });
      return false;
    }
    if (isBlockedAuthProviderHost(parsed.hostname)) {
      res.status(400).json({ error: '`source` host is not allowed' });
      return false;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'ssh:') {
      res.status(400).json({ error: '`source` must use https or ssh' });
      return false;
    }
    return true;
  };
  const validateExtensionSourceMetadata = (
    installMetadata: ExtensionInstallMetadata,
  ): boolean => {
    if (installMetadata.type !== 'git') return true;
    const parsed = parsePotentialSourceUrl(installMetadata.source);
    return (
      !!parsed &&
      (parsed.protocol === 'https:' || parsed.protocol === 'ssh:') &&
      !isBlockedAuthProviderHost(parsed.hostname)
    );
  };
  const findLoadedExtension = (
    extensionManager: ExtensionManager,
    extensionName: string,
  ): Extension | undefined => {
    const requested = extensionName.toLowerCase();
    const extensions = extensionManager.getLoadedExtensions();
    const byName = extensions.find(
      (extension) => extension.name.toLowerCase() === requested,
    );
    if (byName) return byName;
    if (!extensionName.includes('://') && !extensionName.includes('@')) {
      return undefined;
    }
    return extensions.find(
      (extension) =>
        extension.installMetadata?.source?.toLowerCase() === requested,
    );
  };
  type ExtensionMutationEvent = {
    status: 'installed' | 'enabled' | 'disabled' | 'updated' | 'uninstalled';
    source?: string;
    name?: string;
    version?: string;
  };
  const runQueuedExtensionMutation = (
    operation: string,
    failureContext: { source?: string; name?: string },
    res: Response,
    run: (
      extensionManager: ExtensionManager,
    ) => Promise<ExtensionMutationEvent>,
  ): void => {
    if (extensionInstallQueueDepth >= MAX_EXTENSION_INSTALL_QUEUE_DEPTH) {
      sendExtensionQueueFull(res);
      return;
    }
    res.status(202).json({ accepted: true });
    void enqueueExtensionInstall(async () => {
      try {
        const extensionManager = createExtensionManager();
        await extensionManager.refreshCache();
        const event = await withExtensionTimeout(
          run(extensionManager),
          EXTENSION_MUTATION_TIMEOUT_MS,
          `extension ${operation}`,
        );
        extensionsStatusCache = undefined;
        try {
          const result = await bridge.refreshExtensionsForAllSessions(event);
          writeStderrLine(
            `qwen serve: extensions ${operation}: refreshed ${result.refreshed} session(s), ${result.failed} failed`,
          );
        } catch (refreshErr) {
          const message = redactUrlCredentials(
            refreshErr instanceof Error
              ? refreshErr.message
              : String(refreshErr),
          );
          try {
            bridge.broadcastExtensionsChanged({
              ...event,
              refreshed: 0,
              failed: 1,
              error: message.slice(0, 500),
            });
          } catch (broadcastErr) {
            writeStderrLine(
              `qwen serve: extensions ${operation}: failed to broadcast refresh failure: ${
                broadcastErr instanceof Error
                  ? redactUrlCredentials(broadcastErr.message)
                  : String(broadcastErr)
              }`,
            );
          }
          writeStderrLine(
            `qwen serve: extensions ${operation}: mutation succeeded but refresh failed: ${message}`,
          );
        }
      } catch (err) {
        const message = redactUrlCredentials(
          err instanceof Error ? err.message : String(err),
        );
        try {
          bridge.broadcastExtensionsChanged({
            status: 'failed',
            ...(failureContext.source
              ? { source: redactUrlCredentials(failureContext.source) }
              : {}),
            ...(failureContext.name ? { name: failureContext.name } : {}),
            refreshed: 0,
            failed: 0,
            error: message.slice(0, 500),
          });
        } catch (broadcastErr) {
          writeStderrLine(
            `qwen serve: extensions ${operation}: failed to broadcast failure: ${
              broadcastErr instanceof Error
                ? redactUrlCredentials(broadcastErr.message)
                : String(broadcastErr)
            }`,
          );
        }
        try {
          writeStderrLine(
            `qwen serve: extensions ${operation}: background task failed: ${message}`,
          );
        } catch {
          // Keep queued background work from surfacing as unhandledRejection.
        }
      }
    }).catch((err) => {
      try {
        writeStderrLine(
          `qwen serve: extensions ${operation}: queued task failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      } catch {
        // Last-resort guard for detached async work.
      }
    });
  };
  let extensionsStatusCache:
    | { expiresAt: number; value: ServeWorkspaceExtensionsStatus }
    | undefined;
  const buildLocalExtensionsStatus =
    async (): Promise<ServeWorkspaceExtensionsStatus> => {
      const now = Date.now();
      if (extensionsStatusCache && extensionsStatusCache.expiresAt > now) {
        return extensionsStatusCache.value;
      }
      const extensionManager = createExtensionManager();
      await extensionManager.refreshCache();
      const entries: ServeExtensionEntry[] = extensionManager
        .getLoadedExtensions()
        .map((ext): ServeExtensionEntry => {
          const capabilities: ServeExtensionCapabilities = {
            mcpServerCount: ext.mcpServers
              ? Object.keys(ext.mcpServers).length
              : 0,
            skillCount: ext.skills?.length ?? 0,
            agentCount: ext.agents?.length ?? 0,
            hookCount: ext.hooks
              ? Object.values(ext.hooks).reduce(
                  (sum, defs) => sum + (defs?.length ?? 0),
                  0,
                )
              : 0,
            commandCount: ext.commands?.length ?? 0,
            contextFileCount: ext.contextFiles.length,
            channelCount: ext.channels ? Object.keys(ext.channels).length : 0,
            hasSettings: (ext.settings?.length ?? 0) > 0,
          };
          return {
            kind: 'extension',
            id: ext.id,
            name: ext.name,
            ...(ext.displayName ? { displayName: ext.displayName } : {}),
            version: ext.version,
            isActive: ext.isActive,
            path: ext.path,
            ...(ext.installMetadata?.source
              ? { source: redactUrlCredentials(ext.installMetadata.source) }
              : {}),
            ...(ext.installMetadata?.type
              ? { installType: ext.installMetadata.type }
              : {}),
            ...(ext.installMetadata?.originSource
              ? { originSource: ext.installMetadata.originSource }
              : {}),
            ...(ext.installMetadata?.ref
              ? { ref: ext.installMetadata.ref }
              : {}),
            ...(ext.installMetadata?.autoUpdate !== undefined
              ? { autoUpdate: ext.installMetadata.autoUpdate }
              : {}),
            updateState: ext.installMetadata ? 'unknown' : 'not updatable',
            capabilities,
            details: {
              mcpServers: ext.mcpServers ? Object.keys(ext.mcpServers) : [],
              commands: ext.commands ?? [],
              skills: ext.skills?.map((skill) => skill.name) ?? [],
              agents: ext.agents?.map((agent) => agent.name) ?? [],
              contextFiles: ext.contextFiles,
              settings:
                ext.resolvedSettings?.map((setting) => setting.name) ?? [],
            },
          };
        });
      const status = {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd: boundWorkspace,
        initialized: true,
        extensions: entries,
      };
      extensionsStatusCache = {
        expiresAt: now + 2_000,
        value: status,
      };
      return status;
    };

  // Order matters: rejection guards (CORS / Host allowlist / bearer auth)
  // run BEFORE the JSON body parser. Otherwise an unauthenticated POST
  // gets a full 10MB `JSON.parse` before the 401 fires — a trivially
  // amplified CPU/memory cost from any wrong-token client.
  //
  // When `--allow-origin` is configured, install the
  // allowlist middleware instead of the deny-wall. The allowlist owns
  // both halves of the policy (matched → CORS headers + pass-through or
  // 204 preflight; unmatched → 403 with the same error envelope as the
  // wall). When `--allow-origin` is empty/undefined, the deny-wall stays
  // installed. Pattern parsing happens in `run-qwen-serve.ts` for validation;
  // here we still keep the wildcard/no-token invariant for embedded
  // callers that construct the app directly.
  if (opts.allowOrigins && opts.allowOrigins.length > 0) {
    const parsedAllowOrigins = parseAllowOriginPatterns(opts.allowOrigins);
    if (parsedAllowOrigins.allowAny && !opts.token) {
      throw new Error(
        `Refusing to start with --allow-origin '*' but no bearer token ` +
          `configured. '*' admits any cross-origin browser to the API; ` +
          `without a token, any local page can drive the daemon. Set a ` +
          `token or list specific origins instead of '*'.`,
      );
    }
    app.use(allowOriginCors(parsedAllowOrigins));
  } else {
    app.use(denyBrowserOriginCors);
  }
  app.use(hostAllowlist(opts.hostname, getPort));

  // --- Demo page: mirrors the `/health` loopback-gating pattern.
  // On loopback binds, registered BEFORE bearerAuth so browsers can
  // reach the page via address-bar navigation (which cannot attach
  // Authorization headers). On non-loopback binds, registered AFTER
  // bearerAuth — an unauthenticated `/demo` on a public interface
  // would leak the full API surface (route enumeration + interactive
  // console), far more than `/health`'s `{"status":"ok"}`.
  // X-Frame-Options: DENY + CSP frame-ancestors 'none' prevent
  // clickjacking — a malicious site embedding the demo in an iframe
  // could trick a user into performing daemon actions via transparent
  // overlay (the iframe's same-origin fetches bypass CORS).
  const demoHandler = (
    _req: import('express').Request,
    res: import('express').Response,
  ) => {
    try {
      res
        .type('html')
        .set('X-Frame-Options', 'DENY')
        .set(
          'Content-Security-Policy',
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
        )
        .send(getDemoHtml(getPort()));
    } catch (err) {
      writeStderrLine(
        `qwen serve: /demo render failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      res.status(500).json({ error: 'Failed to render demo page' });
    }
  };

  // `/health` is exempted from `bearerAuth` ONLY on loopback binds —
  // the canonical liveness-probe case (k8s/Compose probes don't
  // carry the daemon's bearer; round-tripping a 401 just to know
  // the listener is up is waste). On non-loopback binds the
  // exemption becomes a low-severity info leak (attacker can probe
  // arbitrary IP:port to confirm a `qwen serve` is listening), so
  // we register `/health` AFTER `bearerAuth` and let it 401 like
  // every other route. Operators using the loopback default get the
  // probe-friendly behavior; operators exposing the daemon publicly
  // gate `/health` behind their token alongside everything else.
  // CORS deny + Host allowlist still apply to `/health` in both
  // cases.
  // Shared handler so loopback (pre-auth) and non-loopback (post-auth)
  // routes return the same shape. `?deep=1` exposes bridge counters
  // (`sessions`, `pendingPermissions`) for observability — it is
  // INFORMATIONAL only, not a true liveness probe. Counter getters
  // are size accessors that don't perform per-session/channel pings,
  // so a wedged child (stuck on a request, leaked FD, etc.) won't
  // change the response. We retain the try/catch + 503 as a
  // defense-in-depth net for custom bridge impls whose getters MAY
  // throw — but the real bridge's getters never do, so under normal
  // operation the 503 path is unreachable. The docs
  // (`docs/users/qwen-serve.md` + `qwen-serve-protocol.md`) clarify
  // that deep is for counters, not health verification. Default (no
  // query) stays cheap so high-frequency liveness probes don't load
  // the bridge.
  const healthHandler = (
    req: import('express').Request,
    res: import('express').Response,
  ): void => {
    const deepQuery = req.query['deep'];
    const deep = deepQuery === '1' || deepQuery === 'true' || deepQuery === '';
    if (!deep) {
      res.status(200).json({ status: 'ok' });
      return;
    }
    try {
      const lastActivity = bridge.lastActivityAt;
      const now = Date.now();
      res.status(200).json({
        status: 'ok',
        sessions: bridge.sessionCount,
        pendingPermissions: bridge.pendingPermissionCount,
        activePrompts: bridge.activePromptCount,
        connectedClients: getActiveSseCount(),
        channelAlive: bridge.isChannelLive(),
        lastActivityAt:
          lastActivity !== null ? new Date(lastActivity).toISOString() : null,
        idleSinceMs: lastActivity !== null ? now - lastActivity : null,
        ...(rateLimiter ? { rateLimitHits: rateLimiter.getHitCounts() } : {}),
      });
    } catch (err) {
      writeStderrLine(
        `qwen serve: /health deep probe failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      res.status(503).json({ status: 'degraded' });
    }
  };

  const loopback = isLoopbackBind(opts.hostname);
  // `--require-auth` extends the non-loopback "gate /health behind
  // bearer too" rule to loopback.
  const exposeHealthPreAuth = loopback && !opts.requireAuth;
  if (exposeHealthPreAuth) {
    app.get('/health', healthHandler);
    app.get('/demo', demoHandler);
  }

  // Access-log middleware. Registered BEFORE bearerAuth and JSON parser
  // so auth rejections (401) and malformed-body errors (400) are also
  // captured in the daemon log. Excluded:
  //  - GET /health (high-frequency probe, would drown signal)
  //  - Successful SSE streams (GET .../events with 200) — logged inline
  //    at open/close; failed SSE handshakes (4xx) are still recorded.
  if (daemonLog) {
    const SESSION_ID_RE = /\/session\/([^/]+)/;
    app.use((req, res, next) => {
      const { method, path: reqPath } = req;
      if (
        (method === 'GET' && reqPath === '/health') ||
        (method === 'POST' && reqPath.endsWith('/heartbeat'))
      ) {
        return next();
      }
      const startMs = Date.now();
      res.on('finish', () => {
        try {
          const status = res.statusCode;
          if (
            method === 'GET' &&
            reqPath.endsWith('/events') &&
            status === 200
          ) {
            return;
          }
          const durationMs = Date.now() - startMs;
          const sessionMatch = reqPath.match(SESSION_ID_RE);
          const sessionId = sessionMatch?.[1];
          const clientId = req.headers['x-qwen-client-id'] as
            | string
            | undefined;
          const ctx = {
            route: `${method} ${reqPath}`,
            ...(sessionId ? { sessionId } : {}),
            ...(clientId ? { clientId } : {}),
            status,
            durationMs,
          };
          if (status >= 400) {
            daemonLog.warn('request completed', ctx);
          } else {
            daemonLog.info('request completed', ctx);
          }
        } catch {
          // Logging failure must not affect the request.
        }
      });
      next();
    });
  }

  // Serve the Web Shell static assets (/ and /assets) BEFORE bearerAuth. The
  // static shell carries no secrets and a browser cannot attach an
  // Authorization header to a `<script src>` subresource or an address-bar
  // navigation, so gating it would just break the UI — the front-end's own
  // API calls still carry the bearer (getDaemonAuthHeaders) and every API
  // route below stays token-gated. The SPA deep-link fallback is registered
  // LATER (after all API routes, see mountWebShellSpaFallback) so authed
  // routes win over the shell. The assets dir is resolved by the caller
  // (runQwenServe) and injected via deps.webShellDir; `--no-web` sets
  // opts.serveWebShell=false to opt out.
  const webShellDir =
    opts.serveWebShell !== false ? deps.webShellDir : undefined;
  if (webShellDir) {
    mountWebShellAssets(app, webShellDir);
  }

  app.use(bearerAuth(opts.token));

  // Rate limiter: after auth (only count authenticated requests),
  // before body parser (reject early without burning JSON.parse CPU).
  let rateLimiter: RateLimiterInstance | undefined;
  if (opts.rateLimit) {
    const windowMs = opts.rateLimitWindowMs ?? 60_000;
    rateLimiter = createRateLimiter({
      tiers: {
        prompt: { windowMs, max: opts.rateLimitPrompt ?? 10 },
        mutation: { windowMs, max: opts.rateLimitMutation ?? 30 },
        read: { windowMs, max: opts.rateLimitRead ?? 120 },
      },
      hostname: opts.hostname,
      onLimitReached: daemonLog
        ? (tier, key, suppressed) => {
            daemonLog.warn(
              `rate limit hit${suppressed > 0 ? ` (${suppressed} suppressed)` : ''}`,
              { tier, key: key.slice(0, 64) },
            );
          }
        : undefined,
      onError: daemonLog
        ? (err, path) => {
            daemonLog.warn(
              `rate limiter error (fail-open): ${err instanceof Error ? err.message : String(err)}`,
              { path },
            );
          }
        : undefined,
    });
    app.use(rateLimiter.middleware);
  }

  app.use(express.json({ limit: '10mb' }));
  app.use(
    (
      err: unknown,
      _req: import('express').Request,
      res: import('express').Response,
      next: import('express').NextFunction,
    ) => {
      if (sendJsonBodyParserError(res, err)) return;
      next(err);
    },
  );

  if (!exposeHealthPreAuth) {
    // Non-loopback OR loopback with `--require-auth`: register
    // `/health` and `/demo` AFTER `bearerAuth` so probes must carry
    // the token. Otherwise unauthenticated callers can ping any
    // reachable address:port to confirm a daemon exists (and `/demo`
    // leaks the full API surface).
    app.get('/health', healthHandler);
    app.get('/demo', demoHandler);
  }

  // Mutation-route gate factory. Non-strict mode is passthrough;
  // `{ strict: true }` requires a token even on loopback defaults.
  const mutate = createMutationGate({
    tokenConfigured,
    requireAuth: opts.requireAuth === true,
  });

  app.use(daemonTelemetryMiddleware(boundWorkspace));

  function buildWorkspaceCtx(
    req: import('express').Request,
    route: string,
    clientId?: string,
  ): WorkspaceRequestContext {
    return {
      originatorClientId: clientId,
      route,
      workspaceCwd: boundWorkspace,
    };
  }

  const LANGUAGE_CODES = [...SUPPORTED_LANGUAGES.map((l) => l.code), 'auto'];
  const currentServeFeatures = () =>
    getAdvertisedServeFeatures(undefined, {
      requireAuth: opts.requireAuth === true,
      mcpPoolActive: opts.mcpPoolActive !== false,
      allowOriginActive:
        opts.allowOrigins !== undefined && opts.allowOrigins.length > 0,
      ...(opts.promptDeadlineMs !== undefined
        ? { promptDeadlineMs: opts.promptDeadlineMs }
        : {}),
      ...(opts.writerIdleTimeoutMs !== undefined
        ? { writerIdleTimeoutMs: opts.writerIdleTimeoutMs }
        : {}),
      persistSettingAvailable: deps.persistSetting !== undefined,
      sessionShellCommandEnabled,
      rateLimit: opts.rateLimit === true,
      reloadAvailable: deps.workspace !== undefined,
    });
  const acpHandleRef: { current?: AcpHttpHandle } = {};

  app.get('/daemon/status', async (req, res) => {
    const detail = parseDaemonStatusDetail(req.query['detail']);
    if (!detail.ok || !detail.detail) {
      res.status(400).json({
        error: 'detail must be one of: summary, full',
        code: 'invalid_detail',
      });
      return;
    }
    try {
      res.status(200).json(
        await buildDaemonStatusResponse(detail.detail, {
          opts,
          boundWorkspace,
          bridge,
          workspace,
          daemonLog,
          qwenCodeVersion: deps.qwenCodeVersion,
          acpHandle: acpHandleRef.current,
          rateLimiter,
          getRestSseActive: getActiveSseCount,
          features: currentServeFeatures(),
          protocolVersions: getServeProtocolVersions(),
          supportedDeviceFlowProviders: Array.from(
            deviceFlowProviderMap.keys(),
          ),
          deviceFlowRegistry,
          sessionShellCommandEnabled,
        }),
      );
    } catch (err) {
      writeStderrLine(
        `qwen serve: /daemon/status failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      res.status(500).json({
        error: 'Failed to build daemon status',
        code: 'daemon_status_failed',
      });
    }
  });

  app.get('/capabilities', (_req, res) => {
    const envelope: CapabilitiesEnvelope = {
      v: CAPABILITIES_SCHEMA_VERSION,
      protocolVersions: getServeProtocolVersions(),
      ...(deps.qwenCodeVersion
        ? { qwenCodeVersion: deps.qwenCodeVersion }
        : {}),
      mode: opts.mode,
      features: currentServeFeatures(),
      modelServices: [],
      // Surface the bound workspace so clients can detect mismatch
      // pre-flight and omit `cwd` on `POST /session`.
      workspaceCwd: boundWorkspace,
      // Advertise supported transport families so SDK clients can
      // auto-negotiate the best available transport via
      // `negotiateTransport()`. REST is always available; future PRs
      // will add 'acp-http' / 'acp-ws' entries when the corresponding
      // routes are wired.
      transports: ['rest'],
      // Active mediation policy under the `policy` namespace.
      policy: { permission: bridge.permissionPolicy },
      limits: {
        maxPendingPromptsPerSession: advertisedMaxPendingPromptsPerSession(
          opts.maxPendingPromptsPerSession,
        ),
      },
      supportedLanguages: LANGUAGE_CODES,
    };
    res.status(200).json(envelope);
  });

  app.get('/workspace/mcp', async (req, res) => {
    try {
      const ctx = buildWorkspaceCtx(req, 'GET /workspace/mcp');
      res.status(200).json(await workspace.getWorkspaceMcpStatus(ctx));
    } catch (err) {
      sendBridgeError(res, err, { route: 'GET /workspace/mcp' });
    }
  });

  app.get('/workspace/mcp/:server/tools', async (req, res) => {
    const serverName = req.params['server'];
    if (!serverName || typeof serverName !== 'string') {
      res.status(400).json({
        error: 'Server name path parameter is required',
        code: 'invalid_server_name',
      });
      return;
    }
    if (serverName.length > MAX_SERVER_NAME_LENGTH) {
      res.status(400).json({
        error: `Server name exceeds ${MAX_SERVER_NAME_LENGTH}-character limit`,
        code: 'invalid_server_name',
      });
      return;
    }
    try {
      res.status(200).json(await bridge.getWorkspaceMcpToolsStatus(serverName));
    } catch (err) {
      sendBridgeError(res, err, { route: 'GET /workspace/mcp/:server/tools' });
    }
  });

  app.get('/workspace/skills', async (req, res) => {
    try {
      const ctx = buildWorkspaceCtx(req, 'GET /workspace/skills');
      res.status(200).json(await workspace.getWorkspaceSkillsStatus(ctx));
    } catch (err) {
      sendBridgeError(res, err, { route: 'GET /workspace/skills' });
    }
  });

  app.get('/workspace/tools', async (_req, res) => {
    try {
      res.status(200).json(await bridge.getWorkspaceToolsStatus());
    } catch (err) {
      sendBridgeError(res, err, { route: 'GET /workspace/tools' });
    }
  });

  app.get('/workspace/providers', async (req, res) => {
    try {
      const ctx = buildWorkspaceCtx(req, 'GET /workspace/providers');
      res.status(200).json(await workspace.getWorkspaceProvidersStatus(ctx));
    } catch (err) {
      sendBridgeError(res, err, { route: 'GET /workspace/providers' });
    }
  });

  // Workspace memory + agents CRUD routes.
  mountWorkspaceMemoryRoutes(app, {
    bridge,
    boundWorkspace,
    mutate,
    parseClientId: parseClientIdHeader,
    safeBody,
  });
  mountWorkspaceAgentsRoutes(app, {
    bridge,
    boundWorkspace,
    mutate,
    parseClientId: parseClientIdHeader,
    safeBody,
  });

  // TODO(#4175 PR 24 — PermissionMediator audit log): emit an
  // `audit.diagnostic_read` event from these two routes so a security
  // operator can correlate "who read what when". Read-only diagnostic
  // surfaces are reconnaissance vectors (env: secret-var presence;
  // preflight: workspace path + CLI entry + Node version) and the absence
  // of audit emission here is a deliberate scope deferral, not an
  // oversight — the audit topic does not yet exist; PR 24 lands the
  // shared `bridge.emitAudit` infrastructure that this and PR 18's
  // `fs.access` events will both use.
  app.get('/workspace/env', async (req, res) => {
    try {
      const ctx = buildWorkspaceCtx(req, 'GET /workspace/env');
      res.status(200).json(await workspace.getWorkspaceEnvStatus(ctx));
    } catch (err) {
      sendBridgeError(res, err, { route: 'GET /workspace/env' });
    }
  });

  app.get('/workspace/preflight', async (req, res) => {
    try {
      const ctx = buildWorkspaceCtx(req, 'GET /workspace/preflight');
      res.status(200).json(await workspace.getWorkspacePreflightStatus(ctx));
    } catch (err) {
      sendBridgeError(res, err, { route: 'GET /workspace/preflight' });
    }
  });

  // GET /workspace/hooks — read-only hook configuration status.
  app.get('/workspace/hooks', async (req, res) => {
    try {
      const ctx = buildWorkspaceCtx(req, 'GET /workspace/hooks');
      res.status(200).json(await workspace.getWorkspaceHooksStatus(ctx));
    } catch (err) {
      sendBridgeError(res, err, { route: 'GET /workspace/hooks' });
    }
  });

  // GET /workspace/extensions — read-only installed extension status.
  app.get('/workspace/extensions', async (req, res) => {
    try {
      buildWorkspaceCtx(req, 'GET /workspace/extensions');
      res.status(200).json(await buildLocalExtensionsStatus());
    } catch (err) {
      sendBridgeError(res, err, { route: 'GET /workspace/extensions' });
    }
  });

  // POST /workspace/extensions/install — install an extension and refresh
  // all active sessions asynchronously.
  app.post(
    '/workspace/extensions/install',
    mutate({ strict: true }),
    async (req, res) => {
      try {
        if (
          !validateExtensionMutationClient(
            req,
            res,
            'POST /workspace/extensions/install',
          )
        ) {
          return;
        }
        const body = safeBody(req);
        const source = body['source'];
        const ref = body['ref'];
        const autoUpdate = body['autoUpdate'];
        const allowPreRelease = body['allowPreRelease'];
        const registry = body['registry'];
        const consent = body['consent'];

        if (!source || typeof source !== 'string') {
          res.status(400).json({ error: 'Missing or invalid source' });
          return;
        }
        if (ref !== undefined && (typeof ref !== 'string' || ref === '')) {
          res.status(400).json({ error: '`ref` must be a string' });
          return;
        }
        if (typeof ref === 'string' && ref.startsWith('-')) {
          res.status(400).json({ error: '`ref` must not start with "-"' });
          return;
        }
        if (autoUpdate !== undefined && typeof autoUpdate !== 'boolean') {
          res.status(400).json({ error: '`autoUpdate` must be a boolean' });
          return;
        }
        if (
          allowPreRelease !== undefined &&
          typeof allowPreRelease !== 'boolean'
        ) {
          res
            .status(400)
            .json({ error: '`allowPreRelease` must be a boolean' });
          return;
        }
        if (registry !== undefined && typeof registry !== 'string') {
          res.status(400).json({ error: '`registry` must be a string' });
          return;
        }
        const registryUrl =
          registry !== undefined
            ? parseExtensionRegistryUrl(registry, res)
            : undefined;
        if (registryUrl === null) return;
        if (consent !== true) {
          res.status(400).json({
            error: 'Extension installation requires explicit consent',
          });
          return;
        }
        if (!validateExtensionSourceHost(source, res)) {
          return;
        }

        runQueuedExtensionMutation(
          'install',
          { source },
          res,
          async (extensionManager) => {
            const installMetadata = await parseInstallSource(source);

            if (
              installMetadata.type !== 'git' &&
              installMetadata.type !== 'github-release' &&
              installMetadata.type !== 'npm'
            ) {
              throw new Error(
                'Only GitHub, Git, and npm extension installs are supported over the daemon endpoint.',
              );
            }
            if (installMetadata.type === 'npm' && ref) {
              throw new Error('--ref is not applicable for npm extensions.');
            }
            if (installMetadata.type !== 'npm' && registry) {
              throw new Error(
                '--registry is only applicable for npm extensions.',
              );
            }
            if (!validateExtensionSourceMetadata(installMetadata)) {
              throw new Error('`source` host is not allowed');
            }
            if (installMetadata.type === 'npm' && registryUrl) {
              installMetadata.registryUrl = registryUrl;
            }
            const extension = await extensionManager.installExtension(
              { ...installMetadata, ref, autoUpdate, allowPreRelease },
              () => Promise.resolve(),
            );
            return {
              status: 'installed',
              source,
              name: extension.name,
              version: extension.config.version,
            };
          },
        );
      } catch (err) {
        sendBridgeError(res, err, {
          route: 'POST /workspace/extensions/install',
        });
      }
    },
  );

  app.post(
    '/workspace/extensions/check-updates',
    mutate({ strict: true }),
    async (req, res) => {
      try {
        if (
          !validateExtensionMutationClient(
            req,
            res,
            'POST /workspace/extensions/check-updates',
          )
        ) {
          return;
        }
        const states = await enqueueExtensionInstall(async () =>
          withExtensionTimeout(
            (async () => {
              const extensionManager = createExtensionManager();
              await extensionManager.refreshCache();
              const updateStates: Record<string, string> = {};
              await extensionManager.checkForAllExtensionUpdates(
                (name, state) => {
                  updateStates[name] = state;
                },
              );
              return updateStates;
            })(),
            EXTENSION_REFRESH_TIMEOUT_MS,
            'extension update check',
          ),
        );
        res.status(200).json({ states });
      } catch (err) {
        if (isExtensionQueueFullError(err)) {
          sendExtensionQueueFull(res);
          return;
        }
        sendBridgeError(res, err, {
          route: 'POST /workspace/extensions/check-updates',
        });
      }
    },
  );

  app.post(
    '/workspace/extensions/refresh',
    mutate({ strict: true }),
    async (req, res) => {
      try {
        if (
          !validateExtensionMutationClient(
            req,
            res,
            'POST /workspace/extensions/refresh',
          )
        ) {
          return;
        }
        const result = await enqueueExtensionInstall(async () =>
          withExtensionTimeout(
            workspace.refreshExtensionsForAllSessions(),
            EXTENSION_REFRESH_TIMEOUT_MS,
            'extension refresh',
          ),
        );
        res.status(200).json(result);
      } catch (err) {
        if (isExtensionQueueFullError(err)) {
          sendExtensionQueueFull(res);
          return;
        }
        sendBridgeError(res, err, {
          route: 'POST /workspace/extensions/refresh',
        });
      }
    },
  );

  app.post(
    '/workspace/extensions/:name/enable',
    mutate({ strict: true }),
    async (req, res) => {
      try {
        if (
          !validateExtensionMutationClient(
            req,
            res,
            'POST /workspace/extensions/:name/enable',
          )
        ) {
          return;
        }
        const name = req.params['name'];
        if (!name) {
          res.status(400).json({ error: 'Missing extension name' });
          return;
        }
        const scope = parseExtensionScope(safeBody(req), res);
        if (scope === null) return;
        runQueuedExtensionMutation(
          'enable',
          { name },
          res,
          async (extensionManager) => {
            const extension = findLoadedExtension(extensionManager, name);
            if (!extension) {
              throw new Error(`Extension "${name}" not found`);
            }
            await extensionManager.enableExtension(
              extension.name,
              scope,
              boundWorkspace,
            );
            return { status: 'enabled', name: extension.name };
          },
        );
      } catch (err) {
        sendBridgeError(res, err, {
          route: 'POST /workspace/extensions/:name/enable',
        });
      }
    },
  );

  app.post(
    '/workspace/extensions/:name/disable',
    mutate({ strict: true }),
    async (req, res) => {
      try {
        if (
          !validateExtensionMutationClient(
            req,
            res,
            'POST /workspace/extensions/:name/disable',
          )
        ) {
          return;
        }
        const name = req.params['name'];
        if (!name) {
          res.status(400).json({ error: 'Missing extension name' });
          return;
        }
        const scope = parseExtensionScope(safeBody(req), res);
        if (scope === null) return;
        runQueuedExtensionMutation(
          'disable',
          { name },
          res,
          async (extensionManager) => {
            const extension = findLoadedExtension(extensionManager, name);
            if (!extension) {
              throw new Error(`Extension "${name}" not found`);
            }
            await extensionManager.disableExtension(
              extension.name,
              scope,
              boundWorkspace,
            );
            return { status: 'disabled', name: extension.name };
          },
        );
      } catch (err) {
        sendBridgeError(res, err, {
          route: 'POST /workspace/extensions/:name/disable',
        });
      }
    },
  );

  app.post(
    '/workspace/extensions/:name/update',
    mutate({ strict: true }),
    async (req, res) => {
      try {
        if (
          !validateExtensionMutationClient(
            req,
            res,
            'POST /workspace/extensions/:name/update',
          )
        ) {
          return;
        }
        const name = req.params['name'];
        if (!name) {
          res.status(400).json({ error: 'Missing extension name' });
          return;
        }
        runQueuedExtensionMutation(
          'update',
          { name },
          res,
          async (extensionManager) => {
            const extension = findLoadedExtension(extensionManager, name);
            if (!extension) {
              throw new Error(`Extension "${name}" not found`);
            }
            let updateError: unknown;
            const updateState = await withExtensionTimeout(
              checkForExtensionUpdate(extension, extensionManager).catch(
                (err: unknown) => {
                  updateError = err;
                  return ExtensionUpdateState.ERROR;
                },
              ),
              EXTENSION_REFRESH_TIMEOUT_MS,
              'extension update check',
            );
            if (updateState === ExtensionUpdateState.ERROR) {
              const message =
                updateError === undefined
                  ? undefined
                  : redactUrlCredentials(
                      updateError instanceof Error
                        ? updateError.message
                        : String(updateError),
                    );
              throw new Error(
                `Update check failed for extension "${extension.name}"${
                  message ? `: ${message}` : ''
                }`,
              );
            }
            if (updateState !== ExtensionUpdateState.UPDATE_AVAILABLE) {
              throw new Error(`Extension "${extension.name}" has no update`);
            }
            const info = await extensionManager.updateExtension(
              extension,
              updateState,
              () => undefined,
            );
            return {
              status: 'updated',
              name: extension.name,
              ...(info?.updatedVersion ? { version: info.updatedVersion } : {}),
            };
          },
        );
      } catch (err) {
        sendBridgeError(res, err, {
          route: 'POST /workspace/extensions/:name/update',
        });
      }
    },
  );

  app.delete(
    '/workspace/extensions/:name',
    mutate({ strict: true }),
    async (req, res) => {
      try {
        if (
          !validateExtensionMutationClient(
            req,
            res,
            'DELETE /workspace/extensions/:name',
          )
        ) {
          return;
        }
        const name = req.params['name'];
        if (!name) {
          res.status(400).json({ error: 'Missing extension name' });
          return;
        }
        runQueuedExtensionMutation(
          'uninstall',
          { name },
          res,
          async (extensionManager) => {
            const extension = findLoadedExtension(extensionManager, name);
            if (!extension) {
              throw new Error(`Extension "${name}" not found`);
            }
            await extensionManager.uninstallExtension(
              extension.name,
              false,
              boundWorkspace,
            );
            return { status: 'uninstalled', name: extension.name };
          },
        );
      } catch (err) {
        sendBridgeError(res, err, {
          route: 'DELETE /workspace/extensions/:name',
        });
      }
    },
  );

  // Workspace file routes (read-only + mutation).
  registerWorkspaceFileReadRoutes(app, {
    parseClientId: parseClientIdHeader,
  });
  registerWorkspaceFileWriteRoutes(app, {
    bridge,
    mutate,
    parseClientId: parseClientIdHeader,
    safeBody,
  });

  if (deps.persistSetting) {
    const persistSetting = deps.persistSetting;
    registerWorkspaceSettingsRoutes(app, {
      boundWorkspace,
      mutate,
      safeBody,
      persistSetting,
      broadcastSettingsChanged: (key, value, scope, clientId) => {
        bridge.publishWorkspaceEvent({
          type: 'settings_changed',
          data: { key, value, scope },
          ...(clientId ? { originatorClientId: clientId } : {}),
        });
      },
      parseAndValidateClientId: (req, res) =>
        parseAndValidateWorkspaceClientId(req, res, bridge),
    });
  }

  // A2UI action inbound (the upstream half of A2UI-over-MCP): user
  // interactions from web clients are proxied to the UI MCP server's
  // standard `action` tool.
  registerA2uiActionRoutes(app, {
    boundWorkspace,
    mutate,
    safeBody,
    // UI-server discovery uses the daemon's workspace MCP status, which
    // includes servers registered at runtime.
    getMcpServers: async (req) => {
      const ctx = buildWorkspaceCtx(req, 'POST /session/:id/a2ui-action');
      const status = await workspace.getWorkspaceMcpStatus(ctx);
      return (status.servers ?? []) as Array<{
        name: string;
        mcpStatus?: string;
        config?: Record<string, unknown>;
      }>;
    },
  });

  // -- auth device-flow routes ---------------------------------------------

  app.post(
    '/workspace/auth/device-flow',
    mutate({ strict: true }),
    async (req, res) => {
      const body = safeBody(req);
      const providerIdRaw = body['providerId'];
      if (typeof providerIdRaw !== 'string' || providerIdRaw.length === 0) {
        res.status(400).json({
          error: '`providerId` must be a non-empty string',
          code: 'invalid_request',
        });
        return;
      }
      // Validate against the runtime provider map (not the static
      // tuple) so injected providers are accepted.
      if (!deviceFlowProviderMap.has(providerIdRaw as DeviceFlowProviderId)) {
        res.status(400).json({
          error: `Unsupported device-flow provider: ${providerIdRaw}`,
          code: 'unsupported_provider',
          supportedProviders: Array.from(deviceFlowProviderMap.keys()),
        });
        return;
      }
      const providerId = providerIdRaw as DeviceFlowProviderId;
      const clientId = parseClientIdHeader(req, res);
      if (clientId === null) return;
      try {
        const { view, attached } = await deviceFlowRegistry.start({
          providerId,
          ...(clientId !== undefined ? { initiatorClientId: clientId } : {}),
        });
        // Idempotent take-over → 200 with `attached: true`. Fresh start →
        // 201 + `attached: false`. The registry is the source of truth on
        // which branch fired (it's the one that decided not to call
        // `provider.start()` again).
        res
          .status(attached ? 200 : 201)
          .json(toDeviceFlowStartResponseBody(view, attached, clientId));
      } catch (err) {
        if (err instanceof UnsupportedDeviceFlowProviderError) {
          res
            .status(400)
            .json({ error: err.message, code: 'unsupported_provider' });
          return;
        }
        if (err instanceof TooManyActiveDeviceFlowsError) {
          res
            .status(409)
            .json({ error: err.message, code: 'too_many_active_flows' });
          return;
        }
        if (err instanceof UpstreamDeviceFlowError) {
          // IdP-side failure (network / parse / non-2xx). 502 distinguishes
          // "the upstream we depend on misbehaved" from a daemon bug (5xx
          // generic) so SDK clients can branch on retry strategy.
          res.status(502).json({ error: err.message, code: 'upstream_error' });
          return;
        }
        sendBridgeError(res, err, {
          route: 'POST /workspace/auth/device-flow',
        });
      }
    },
  );

  // GET surfaces verification material; strict-gated + caller-identity
  // check so only the original initiator sees `userCode` etc.
  app.get(
    '/workspace/auth/device-flow/:id',
    mutate({ strict: true }),
    async (req, res) => {
      const id = req.params['id'];
      if (!id) {
        res.status(404).json({
          error: 'Device-flow id required',
          code: 'device_flow_not_found',
        });
        return;
      }
      const view = deviceFlowRegistry.get(id);
      if (!view) {
        res.status(404).json({
          error: `Device-flow ${id} not found`,
          code: 'device_flow_not_found',
        });
        return;
      }
      const clientId = parseClientIdHeader(req, res);
      if (clientId === null) return;
      // Debug-mode breadcrumb when verification fields are redacted
      // due to caller-clientId mismatch.
      if (!callerIsDeviceFlowInitiator(view, clientId) && isServeDebugMode()) {
        writeStderrLine(
          `qwen serve debug: GET /workspace/auth/device-flow/${id} redacted verification fields — caller-clientId mismatch (initiator=${view.initiatorClientId ?? 'anonymous'}, caller=${clientId ?? 'anonymous'})`,
        );
      }
      res.status(200).json(toDeviceFlowStateBody(view, clientId));
    },
  );

  app.delete(
    '/workspace/auth/device-flow/:id',
    mutate({ strict: true }),
    (req, res) => {
      const id = req.params['id'];
      if (!id) {
        res.status(404).json({
          error: 'Device-flow id required',
          code: 'device_flow_not_found',
        });
        return;
      }
      const clientId = parseClientIdHeader(req, res);
      if (clientId === null) return;
      const result = deviceFlowRegistry.cancel(id, clientId);
      if (result === undefined) {
        res.status(404).json({
          error: `Device-flow ${id} not found`,
          code: 'device_flow_not_found',
        });
        return;
      }
      // Both freshly-cancelled and already-terminal are 204 (idempotent).
      res.status(204).end();
    },
  );

  app.get('/workspace/auth/status', (_req, res) => {
    const pending = deviceFlowRegistry.listPending();
    res.status(200).json({
      v: 1,
      workspaceCwd: boundWorkspace,
      providers: [],
      pendingDeviceFlows: pending.map((view) => ({
        deviceFlowId: view.deviceFlowId,
        providerId: view.providerId,
        ...(view.expiresAt !== undefined ? { expiresAt: view.expiresAt } : {}),
      })),
      // Derive from runtime provider map (single source of truth).
      supportedDeviceFlowProviders: Array.from(deviceFlowProviderMap.keys()),
    });
  });

  app.get('/workspace/auth/providers', (_req, res) => {
    res.status(200).json(buildAuthProviderCatalog(boundWorkspace));
  });

  app.post(
    '/workspace/auth/provider',
    mutate({ strict: true }),
    async (req, res) => {
      if (!deps.installAuthProvider) {
        res.status(501).json({
          error: 'Auth provider installation is not implemented by this daemon',
          code: 'not_implemented',
        });
        return;
      }
      const parsed = parseAuthProviderInstallRequest(safeBody(req), {
        allowPrivateBaseUrl: opts.allowPrivateAuthBaseUrl === true,
      });
      if (!parsed.ok) {
        res.status(400).json({
          error: parsed.error,
          code: parsed.code,
        });
        return;
      }
      const installRequest = parsed.value;
      const knownProvider = ALL_PROVIDERS.find(
        (provider) => provider.id === installRequest.providerId,
      );
      if (!knownProvider) {
        res.status(400).json({
          error: `Unsupported auth provider: ${installRequest.providerId}`,
          code: 'unsupported_provider',
        });
        return;
      }
      if (installRequest.protocol) {
        const allowedProtocols =
          knownProvider.protocolOptions && knownProvider.protocolOptions.length
            ? knownProvider.protocolOptions
            : [knownProvider.protocol];
        if (!allowedProtocols.includes(installRequest.protocol as Protocol)) {
          res.status(400).json({
            error: `protocol must be one of: ${allowedProtocols.join(', ')}`,
            code: 'unsupported_protocol',
          });
          return;
        }
      }
      try {
        res.status(200).json(await deps.installAuthProvider(installRequest));
      } catch (err) {
        sendBridgeError(res, err, {
          route: 'POST /workspace/auth/provider',
          providerId: installRequest.providerId,
        });
      }
    },
  );

  app.post('/session', mutate(), async (req, res) => {
    const body = safeBody(req);
    // 1 daemon = 1 workspace. Three input shapes:
    //   - `cwd` ABSENT from body → fall back to the daemon's bound
    //     workspace (clients pre-flight
    //     `caps.workspaceCwd` and may then omit `cwd`).
    //   - `cwd` PRESENT but not a string → 400 malformed. A
    //     client/orchestrator serialization bug (`cwd: null`,
    //     `cwd: 123`, `cwd: {}`) must not silently bind a session
    //     to the daemon's workspace; surface the bug instead.
    //   - `cwd` PRESENT as a string → fall through to the
    //     `path.isAbsolute` check (empty string and relative both
    //     fail there with "must be an absolute path when provided").
    //
    // `safeBody` returns an `Object.create(null)` map, so
    // `'cwd' in body` reflects exactly "did the client send the
    // key?" without prototype-chain confusion. The presence-check
    // is safe as long as `PROTOTYPE_POLLUTION_KEYS` doesn't grow to
    // include `cwd` — see the cross-reference in the const's JSDoc
    // for what to do if that invariant ever has to break.
    const hasCwd = 'cwd' in body;
    if (hasCwd && typeof body['cwd'] !== 'string') {
      res
        .status(400)
        .json({ error: '`cwd` must be a string absolute path when provided' });
      return;
    }
    // Length cap BEFORE assignment so a multi-MB `cwd` body can't
    // amplify through downstream interpolations
    // (`WorkspaceMismatchError`'s `.message` echoes `requested` twice;
    // `sendBridgeError` writes it to stderr; `res.json` echoes it
    // again). On the loopback-default-no-token deployment shape this
    // is pre-auth, so a 10 MB cwd body — right under
    // `express.json({limit: '10mb'})` — would otherwise cost
    // ~60 MB per request × `maxConnections` (default 256). The
    // `MAX_WORKSPACE_PATH_LENGTH` constant matches Linux's PATH_MAX
    // (4096); legitimate filesystem paths fit well under it. The
    // `WorkspaceMismatchError` constructor also truncates as a
    // belt-and-suspenders defense for non-route callers (tests,
    // embeds, future entry points that throw the error directly).
    if (hasCwd && (body['cwd'] as string).length > MAX_WORKSPACE_PATH_LENGTH) {
      res.status(400).json({
        error: `\`cwd\` exceeds the ${MAX_WORKSPACE_PATH_LENGTH}-character limit`,
      });
      return;
    }
    const cwd = hasCwd ? (body['cwd'] as string) : boundWorkspace;
    if (!path.isAbsolute(cwd)) {
      res
        .status(400)
        .json({ error: '`cwd` must be an absolute path when provided' });
      return;
    }
    const modelServiceId =
      typeof body['modelServiceId'] === 'string'
        ? (body['modelServiceId'] as string)
        : undefined;
    // Per-request `sessionScope` override. Validate at the route
    // boundary so a 400 surfaces before touching the bridge.
    const rawSessionScope = body['sessionScope'];
    let sessionScope: 'single' | 'thread' | undefined;
    if (rawSessionScope !== undefined) {
      if (rawSessionScope !== 'single' && rawSessionScope !== 'thread') {
        res.status(400).json({
          error: '`sessionScope` must be "single" or "thread" when provided',
          code: 'invalid_session_scope',
        });
        return;
      }
      sessionScope = rawSessionScope;
    }
    const clientId = parseClientIdHeader(req, res);
    if (clientId === null) return;
    try {
      const session = await bridge.spawnOrAttach({
        workspaceCwd: cwd,
        modelServiceId,
        ...(clientId !== undefined ? { clientId } : {}),
        ...(sessionScope !== undefined ? { sessionScope } : {}),
      });
      // Client may have disconnected during the 1–3s spawn window. If
      // so, the response can't be delivered. The session is otherwise
      // orphaned (in `byId` / `defaultEntry` with no client knowing the
      // id), and under churn this leaks one child per aborted request.
      //
      // Detect "can we still write the response?" via `res.writable`,
      // which stays true until the SOCKET destination side closes
      // (the right signal for our case). The legacy `req.aborted`
      // only flips while the request body is still being received,
      // so a client that completed the POST and then closed during
      // the spawn would slip past it. `req.destroyed` is too eager
      // — clients (incl. supertest) close their writable end after
      // sending the body even though they're still listening for the
      // response. `res.writable` is the documented signal for
      // "ServerResponse can still send to client".
      //
      // Combined with `!session.attached` we only reap when WE spawned
      // a fresh child for this request — if another client legitimately
      // attached, killing it would tear out their work mid-flight.
      // The disconnect-without-reap branch also needs to skip
      // `res.json` — writing to a closed socket would throw EPIPE
      // through Express's default error handler.
      if (daemonLog) {
        daemonLog.info(
          session.attached ? 'session attached' : 'session spawned',
          { sessionId: session.sessionId, clientId: session.clientId },
        );
      }
      if (!res.writable) {
        if (daemonLog) {
          daemonLog.warn(
            'session reaped (client disconnected before response)',
            {
              sessionId: session.sessionId,
              attached: session.attached,
            },
          );
        }
        if (!session.attached) {
          // `requireZeroAttaches: true` closes a race: if
          // a second client called `spawnOrAttach` for the same
          // workspace between our `await` resolving and this reap
          // dispatching, the bridge will see `attachCount > 0` and
          // skip the kill. Without the flag, that second client's
          // session would die mid-prompt.
          bridge
            .killSession(session.sessionId, { requireZeroAttaches: true })
            .catch(() => {
              // Best-effort cleanup; channel.exited will eventually reap.
            });
        } else {
          // When an attaching client disconnects
          // before its 200 response can be written, the
          // `attachCount` bump we did inside `spawnOrAttach` is
          // fictitious — there's no live attaching client. Roll the
          // counter back and let the bridge decide whether to reap
          // (it does if attachCount returns to 0 AND no live SSE
          // subscribers). Without this, both-coalesced-callers-
          // disconnect leaves an orphan agent child no client knows
          // the id of.
          bridge.detachClient(session.sessionId, session.clientId).catch(() => {
            // Best-effort cleanup; channel.exited will eventually reap.
          });
        }
        return;
      }
      res.status(200).json(session);
    } catch (err) {
      sendBridgeError(res, err, { route: 'POST /session' });
    }
  });

  const restoreSessionHandler =
    (action: 'load' | 'resume') =>
    async (req: express.Request, res: express.Response) => {
      const sessionId = requireSessionId(req, res);
      if (!sessionId) return;
      const body = safeBody(req);
      const cwd = parseOptionalWorkspaceCwd(body, boundWorkspace, res);
      if (cwd === undefined) return;
      const clientId = parseClientIdHeader(req, res);
      if (clientId === null) return;
      try {
        const session =
          action === 'load'
            ? await bridge.loadSession({
                sessionId,
                workspaceCwd: cwd,
                ...(clientId !== undefined ? { clientId } : {}),
              })
            : await bridge.resumeSession({
                sessionId,
                workspaceCwd: cwd,
                ...(clientId !== undefined ? { clientId } : {}),
              });
        if (daemonLog) {
          daemonLog.info(
            `session ${action}${session.attached ? ' (attached)' : ''}`,
            { sessionId: session.sessionId, clientId: session.clientId },
          );
        }
        // Mirror the `POST /session` disconnect-cleanup path (see the
        // long comment above the matching `if (!res.writable)` there
        // for the rationale around `res.writable` vs `req.aborted` /
        // `req.destroyed`, plus the `requireZeroAttaches` race
        // and the attach-rollback case). Restore needs the
        // same cleanup because a client that disconnects during a
        // multi-second `session/load` would otherwise leave a freshly
        // restored session in `byId` with no client holding its id.
        if (!res.writable) {
          if (!session.attached) {
            bridge
              .killSession(session.sessionId, { requireZeroAttaches: true })
              .catch(() => {
                // Best-effort cleanup; channel.exited will eventually reap.
              });
          } else {
            bridge
              .detachClient(session.sessionId, session.clientId)
              .catch(() => {
                // Best-effort cleanup; channel.exited will eventually reap.
              });
          }
          return;
        }
        res.status(200).json(session);
      } catch (err) {
        sendBridgeError(res, err, {
          route: `POST /session/:id/${action}`,
          sessionId,
        });
      }
    };

  app.post('/session/:id/load', mutate(), restoreSessionHandler('load'));
  app.post('/session/:id/resume', mutate(), restoreSessionHandler('resume'));

  app.post('/session/:id/branch', mutate(), async (req, res) => {
    const sessionId = requireSessionId(req, res);
    if (sessionId === null) return;
    const body = safeBody(req);
    let name = typeof body?.['name'] === 'string' ? body['name'] : undefined;
    if (name) {
      // eslint-disable-next-line no-control-regex
      name = name.replace(/[\x00-\x1F\x7F-\x9F]/g, '');
      if (name.length > 200) {
        name = name.slice(0, 200);
      }
    }
    const clientId = parseClientIdHeader(req, res);
    if (clientId === null) return;
    try {
      const result = await bridge.branchSession(
        sessionId,
        { name },
        { clientId },
      );
      if (!res.writable) {
        if (!result.attached) {
          bridge
            .killSession(result.sessionId, { requireZeroAttaches: true })
            .catch(() => {
              // Best-effort cleanup; channel.exited will eventually reap.
            });
        } else {
          bridge.detachClient(result.sessionId, result.clientId).catch(() => {
            // Best-effort cleanup; channel.exited will eventually reap.
          });
        }
        return;
      }
      res.status(201).json(result);
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'POST /session/:id/branch',
        sessionId,
      });
    }
  });

  app.post('/session/:id/fork', mutate(), async (req, res) => {
    const sessionId = requireSessionId(req, res);
    if (sessionId === null) return;
    const body = safeBody(req);
    const directive = body['directive'];
    if (typeof directive !== 'string' || directive.trim().length === 0) {
      res.status(400).json({
        error: '`directive` is required and must be a non-empty string',
        code: 'missing_directive',
      });
      return;
    }
    const clientId = parseClientIdHeader(req, res);
    if (clientId === null) return;
    try {
      const result = await bridge.launchSessionForkAgent(
        sessionId,
        directive,
        clientId !== undefined ? { clientId } : undefined,
      );
      res.status(202).json(result);
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'POST /session/:id/fork',
        sessionId,
      });
    }
  });

  app.get('/session/:id/context', async (req, res) => {
    const sessionId = requireSessionId(req, res);
    if (sessionId === null) return;
    try {
      res.status(200).json(await bridge.getSessionContextStatus(sessionId));
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'GET /session/:id/context',
        sessionId,
      });
    }
  });

  app.get('/session/:id/context-usage', async (req, res) => {
    const sessionId = requireSessionId(req, res);
    if (sessionId === null) return;
    try {
      res.status(200).json(
        await bridge.getSessionContextUsageStatus(sessionId, {
          detail: req.query['detail'] === 'true',
        }),
      );
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'GET /session/:id/context-usage',
        sessionId,
      });
    }
  });

  app.get('/session/:id/stats', async (req, res) => {
    const sessionId = requireSessionId(req, res);
    if (sessionId === null) return;
    try {
      res.status(200).json(await bridge.getSessionStatsStatus(sessionId));
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'GET /session/:id/stats',
        sessionId,
      });
    }
  });

  app.get('/session/:id/supported-commands', async (req, res) => {
    const sessionId = requireSessionId(req, res);
    if (sessionId === null) return;
    try {
      res
        .status(200)
        .json(await bridge.getSessionSupportedCommandsStatus(sessionId));
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'GET /session/:id/supported-commands',
        sessionId,
      });
    }
  });

  app.get('/session/:id/tasks', async (req, res) => {
    const sessionId = requireSessionId(req, res);
    if (sessionId === null) return;
    try {
      res.status(200).json(await bridge.getSessionTasksStatus(sessionId));
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'GET /session/:id/tasks',
        sessionId,
      });
    }
  });

  // GET /session/:id/hooks — read-only session-scoped hook status.
  app.get('/session/:id/hooks', async (req, res) => {
    const sessionId = requireSessionId(req, res);
    if (sessionId === null) return;
    try {
      res.status(200).json(await bridge.getSessionHooksStatus(sessionId));
    } catch (err) {
      sendBridgeError(res, err, { route: 'GET /session/:id/hooks', sessionId });
    }
  });

  app.post(
    '/session/:id/tasks/:taskId/cancel',
    mutate({ strict: true }),
    async (req, res) => {
      const sessionId = req.params['id'];
      const taskId = req.params['taskId'];
      if (!sessionId || !taskId) {
        res.status(400).json({
          error: '`sessionId` and `taskId` route parameters are required',
        });
        return;
      }
      const body = safeBody(req);
      const kind = body['kind'];
      if (kind !== 'agent' && kind !== 'shell' && kind !== 'monitor') {
        res
          .status(400)
          .json({ error: '`kind` must be "agent", "shell", or "monitor"' });
        return;
      }
      try {
        res
          .status(200)
          .json(await bridge.cancelSessionTask(sessionId, taskId, kind));
      } catch (err) {
        sendBridgeError(res, err, {
          route: 'POST /session/:id/tasks/:taskId/cancel',
          sessionId,
        });
      }
    },
  );

  app.post(
    '/session/:id/goal/clear',
    mutate({ strict: true }),
    async (req, res) => {
      const sessionId = req.params['id'];
      if (!sessionId) {
        res
          .status(400)
          .json({ error: '`sessionId` route parameter is required' });
        return;
      }
      try {
        res.status(200).json(await bridge.clearSessionGoal(sessionId));
      } catch (err) {
        sendBridgeError(res, err, {
          route: 'POST /session/:id/goal/clear',
          sessionId,
        });
      }
    },
  );

  app.post('/session/:id/prompt', mutate(), async (req, res) => {
    const sessionId = req.params['id'];
    const body = safeBody(req);
    const prompt = body['prompt'];
    if (!Array.isArray(prompt) || prompt.length === 0) {
      res.status(400).json({
        error:
          '`prompt` is required and must be a non-empty array of content blocks',
      });
      return;
    }
    if (
      !prompt.every(
        (item: unknown) =>
          typeof item === 'object' && item !== null && !Array.isArray(item),
      )
    ) {
      res.status(400).json({
        error: 'each `prompt` element must be an object (content block)',
      });
      return;
    }
    const rawRequestDeadline = body['deadlineMs'];
    let requestDeadlineMs: number | undefined;
    if (rawRequestDeadline !== undefined && rawRequestDeadline !== null) {
      if (
        typeof rawRequestDeadline !== 'number' ||
        !Number.isFinite(rawRequestDeadline) ||
        !Number.isInteger(rawRequestDeadline) ||
        rawRequestDeadline <= 0
      ) {
        res.status(400).json({
          error: '`deadlineMs` must be a positive integer (milliseconds)',
          code: 'invalid_deadline_ms',
        });
        return;
      }
      requestDeadlineMs = rawRequestDeadline;
    }
    const clientId = parseClientIdHeader(req, res);
    if (clientId === null) return;

    const promptId = crypto.randomUUID();
    const forwardedBody = { ...body };
    delete forwardedBody['deadlineMs'];

    let lastEventId: number;
    try {
      lastEventId = bridge.getSessionLastEventId(sessionId);
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'POST /session/:id/prompt',
        sessionId,
      });
      return;
    }
    addDaemonRequestAttribute('qwen-code.prompt_id', promptId);

    const abort = new AbortController();
    const effectiveDeadlineMs = resolvePromptDeadlineMs(
      opts.promptDeadlineMs,
      requestDeadlineMs,
    );
    let deadlineTimer: NodeJS.Timeout | undefined;
    if (effectiveDeadlineMs !== undefined) {
      deadlineTimer = setTimeout(() => {
        if (!abort.signal.aborted) {
          abort.abort(new PromptDeadlineExceededError(effectiveDeadlineMs));
        }
      }, effectiveDeadlineMs);
      deadlineTimer.unref();
    }

    let promptPromise: ReturnType<AcpSessionBridge['sendPrompt']>;
    try {
      promptPromise = bridge.sendPrompt(
        sessionId,
        {
          ...forwardedBody,
          sessionId,
          prompt,
        } as Parameters<AcpSessionBridge['sendPrompt']>[1],
        abort.signal,
        {
          ...(clientId !== undefined ? { clientId } : {}),
          promptId,
        },
      );
    } catch (err) {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      if (daemonLog && err instanceof PromptQueueFullError) {
        daemonLog.warn('prompt admission rejected: queue full', {
          sessionId,
          promptId,
          ...(clientId !== undefined ? { clientId } : {}),
          limit: err.limit,
          pendingCount: err.pendingCount,
        });
      }
      sendBridgeError(res, err, {
        route: 'POST /session/:id/prompt',
        sessionId,
      });
      return;
    }

    promptPromise
      .then(
        () => {
          if (daemonLog) {
            daemonLog.info('prompt turn completed', {
              sessionId,
              promptId,
              clientId,
            });
          }
        },
        (err) => {
          if (daemonLog) {
            const errName = err instanceof Error ? err.name : undefined;
            daemonLog.warn(
              `prompt turn failed: ${errName ? `[${errName}] ` : ''}${err instanceof Error ? err.message : String(err)}`,
              { sessionId, promptId, clientId },
            );
          }
        },
      )
      .finally(() => {
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      })
      .catch(() => {});

    if (daemonLog) {
      daemonLog.info('prompt enqueued', { sessionId, promptId, clientId });
    }
    res.status(202).json({ promptId, lastEventId });
  });

  app.post('/session/:id/heartbeat', mutate(), (req, res) => {
    const sessionId = requireSessionId(req, res);
    if (sessionId === null) return;
    const clientId = parseClientIdHeader(req, res);
    if (clientId === null) return;
    try {
      const result = bridge.recordHeartbeat(
        sessionId,
        clientId !== undefined ? { clientId } : undefined,
      );
      res.status(200).json(result);
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'POST /session/:id/heartbeat',
        sessionId,
      });
    }
  });

  app.post('/session/:id/detach', mutate(), async (req, res) => {
    const sessionId = requireSessionId(req, res);
    if (sessionId === null) return;
    const clientId = parseClientIdHeader(req, res);
    if (clientId === null) return;
    try {
      await bridge.detachClient(sessionId, clientId);
      res.status(204).end();
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'POST /session/:id/detach',
        sessionId,
      });
    }
  });

  app.post('/session/:id/cancel', mutate(), async (req, res) => {
    const sessionId = req.params['id'];
    const body = safeBody(req);
    const clientId = parseClientIdHeader(req, res);
    if (clientId === null) return;
    try {
      await bridge.cancelSession(
        sessionId,
        {
          ...(body as object),
          sessionId,
        } as Parameters<AcpSessionBridge['cancelSession']>[1],
        clientId !== undefined ? { clientId } : undefined,
      );
      if (daemonLog) {
        daemonLog.info('cancel sent', { sessionId, clientId });
      }
      res.status(204).end();
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'POST /session/:id/cancel',
        sessionId,
      });
    }
  });

  app.delete('/session/:id', async (req, res) => {
    const sessionId = req.params['id'];
    const clientId = parseClientIdHeader(req, res);
    if (clientId === null) return;
    try {
      await bridge.closeSession(
        sessionId,
        clientId !== undefined ? { clientId } : undefined,
      );
      res.status(204).end();
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'DELETE /session/:id',
        sessionId,
      });
    }
  });

  app.post('/sessions/delete', mutate(), async (req, res) => {
    const clientId = parseClientIdHeader(req, res);
    if (clientId === null) return;
    const body = safeBody(req);
    const sessionIds: unknown = body['sessionIds'];
    if (
      !Array.isArray(sessionIds) ||
      sessionIds.length === 0 ||
      sessionIds.length > 100 ||
      !sessionIds.every((id) => typeof id === 'string')
    ) {
      res.status(400).json({
        error: '`sessionIds` must be a non-empty string array (max 100)',
        code: 'invalid_request',
      });
      return;
    }
    try {
      const uniqueIds = [...new Set(sessionIds as string[])];
      const closeResults = await Promise.allSettled(
        uniqueIds.map(async (id) => {
          // Intentional: no clientId — batch delete bypasses per-tab ownership.
          await bridge.closeSession(id);
          return id;
        }),
      );
      const closeErrors: Array<{ sessionId: string; error: string }> = [];
      const closedIds: string[] = [];
      for (let i = 0; i < closeResults.length; i++) {
        const r = closeResults[i];
        const id = uniqueIds[i];
        if (r.status === 'fulfilled') {
          closedIds.push(id);
        } else {
          const closeErr = r.reason;
          if (closeErr instanceof SessionNotFoundError) {
            // Session not active in bridge — still attempt to remove its transcript file
            closedIds.push(id);
          } else {
            const msg =
              closeErr instanceof Error ? closeErr.message : String(closeErr);
            writeStderrLine(
              `qwen serve: closeSession failed for ${safeLogValue(id)}: ${safeLogValue(msg)}`,
            );
            closeErrors.push({ sessionId: id, error: msg });
          }
        }
      }
      const result = await new SessionService(boundWorkspace).removeSessions(
        closedIds,
      );
      for (const e of result.errors) {
        const msg =
          e.error instanceof Error ? e.error.message : String(e.error);
        writeStderrLine(
          `qwen serve: removeSession failed for ${safeLogValue(e.sessionId)}: ${safeLogValue(msg)}`,
        );
      }
      res.status(200).json({
        removed: result.removed,
        notFound: result.notFound,
        errors: [
          ...closeErrors,
          ...result.errors.map((e) => ({
            sessionId: e.sessionId,
            error: e.error instanceof Error ? e.error.message : String(e.error),
          })),
        ],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeStderrLine(
        `qwen serve: failed to batch delete sessions: ${safeLogValue(message)}`,
      );
      res.status(500).json({
        error: 'Failed to delete sessions',
        code: 'sessions_delete_failed',
      });
    }
  });

  app.patch('/session/:id/metadata', async (req, res) => {
    const sessionId = req.params['id'];
    const body = safeBody(req);
    const clientId = parseClientIdHeader(req, res);
    if (clientId === null) return;
    const rawDisplayName = body['displayName'];
    if (rawDisplayName !== undefined && typeof rawDisplayName !== 'string') {
      res.status(400).json({
        error: '`displayName` must be a string',
        code: 'invalid_metadata',
        field: 'displayName',
      });
      return;
    }
    const displayName =
      typeof rawDisplayName === 'string'
        ? rawDisplayName.slice(0, 256)
        : undefined;
    try {
      const effective = bridge.updateSessionMetadata(
        sessionId,
        { displayName },
        clientId !== undefined ? { clientId } : undefined,
      );
      res.status(200).json({ sessionId, ...effective });
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'PATCH /session/:id/metadata',
        sessionId,
      });
    }
  });

  app.get('/workspace/:id/sessions', async (req, res) => {
    // Express decodes URL-encoded path params automatically; clients pass
    // the absolute workspace cwd encoded (e.g.
    // GET /workspace/%2Fwork%2Fa/sessions).
    const workspaceCwd = req.params['id'] ?? '';
    if (!path.isAbsolute(workspaceCwd)) {
      res
        .status(400)
        .json({ error: '`:id` must decode to an absolute workspace path' });
      return;
    }
    // Reject cross-workspace queries so orchestrators don't mistake
    // "no sessions here" for "workspace is idle".
    const key = canonicalizeWorkspace(workspaceCwd);
    if (key !== boundWorkspace) {
      res.status(400).json({
        error: `Workspace mismatch: daemon is bound to "${boundWorkspace}"`,
        code: 'workspace_mismatch',
        boundWorkspace,
        requestedWorkspace: key,
      });
      return;
    }
    try {
      const cursor =
        typeof req.query['cursor'] === 'string'
          ? req.query['cursor']
          : undefined;
      const size = parseSessionPageSizeQuery(req.query['size']);
      const result = await listWorkspaceSessionsForResponse(bridge, key, {
        cursor,
        size,
      });
      res.status(200).json({
        sessions: result.sessions,
        ...(result.nextCursor != null ? { nextCursor: result.nextCursor } : {}),
      });
    } catch (err) {
      if (err instanceof InvalidCursorError) {
        res.status(400).json({
          error: err.message,
          code: 'invalid_cursor',
        });
        return;
      }
      writeStderrLine(
        `qwen serve: failed to list sessions for workspace ${safeLogValue(
          key,
        )}: ${safeLogValue(err instanceof Error ? err.message : String(err))}`,
      );
      res.status(500).json({
        error: 'Failed to list sessions',
        code: 'session_list_failed',
      });
    }
  });

  app.post('/session/:id/model', mutate(), async (req, res) => {
    const sessionId = req.params['id'];
    const body = safeBody(req);
    const modelId = body['modelId'];
    if (typeof modelId !== 'string' || !modelId) {
      res.status(400).json({
        error: '`modelId` is required and must be a non-empty string',
      });
      return;
    }
    const clientId = parseClientIdHeader(req, res);
    if (clientId === null) return;
    try {
      const response = await bridge.setSessionModel(
        sessionId,
        {
          ...(body as object),
          sessionId,
          modelId,
        } as Parameters<AcpSessionBridge['setSessionModel']>[1],
        clientId !== undefined ? { clientId } : undefined,
      );
      res.status(200).json(response);
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'POST /session/:id/model',
        sessionId,
      });
    }
  });

  app.post('/session/:id/recap', mutate(), async (req, res) => {
    // Wraps `generateSessionRecap` so daemon clients can fetch a
    // one-sentence "where did I leave off" summary without a full
    // prompt turn. Best-effort — `recap: null` on short history or
    // transient model failure is a normal 200, not an error.
    const sessionId = requireSessionId(req, res);
    if (sessionId === null) return;
    const clientId = parseClientIdHeader(req, res);
    if (clientId === null) return;
    try {
      const response = await bridge.generateSessionRecap(
        sessionId,
        clientId !== undefined ? { clientId } : undefined,
      );
      if (daemonLog) {
        const recap = response.recap;
        daemonLog.info(
          recap ? `recap generated len=${recap.length}` : 'recap returned null',
          { sessionId, clientId },
        );
      }
      res.status(200).json(response);
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'POST /session/:id/recap',
        sessionId,
      });
    }
  });

  app.post('/session/:id/btw', mutate(), async (req, res) => {
    const sessionId = requireSessionId(req, res);
    if (sessionId === null) return;
    const body = safeBody(req);
    const question = body['question'];
    if (
      typeof question !== 'string' ||
      question.trim().length === 0 ||
      question.length > BTW_MAX_INPUT_LENGTH
    ) {
      res.status(400).json({
        error: `\`question\` is required, must be a non-empty string, and at most ${BTW_MAX_INPUT_LENGTH} characters`,
      });
      return;
    }
    const abort = new AbortController();
    const onResClose = () => {
      if (!res.writableEnded) abort.abort();
    };
    res.once('close', onResClose);
    const clientId = parseClientIdHeader(req, res);
    if (clientId === null) {
      res.off('close', onResClose);
      return;
    }
    try {
      const result = await bridge.generateSessionBtw(
        sessionId,
        question.trim(),
        abort.signal,
        clientId !== undefined ? { clientId } : undefined,
      );
      res.status(200).json(result);
    } catch (err) {
      if (
        err instanceof DOMException &&
        err.name === 'AbortError' &&
        abort.signal.aborted
      ) {
        return;
      }
      sendBridgeError(res, err, {
        route: 'POST /session/:id/btw',
        sessionId,
      });
    } finally {
      res.off('close', onResClose);
    }
  });

  // Queue a user message typed while the session's turn is still running. The
  // ACP child drains it between tool batches (`craft/drainMidTurnQueue`) so the
  // model sees it before the turn ends, instead of waiting for the next turn.
  // Returns `{ accepted }`: `false` when the session is idle (or the per-session
  // queue is full), so the browser keeps the message in its own queue and sends
  // it as a normal next-turn prompt. Synchronous — the bridge only pushes onto
  // an in-memory queue.
  //
  // Per-message abuse guard. The sibling `/btw` caps its field; without this
  // only the global 10 MB body limit applies. Not a UX limit — a rejected
  // message stays in the browser's own queue and is sent as the (uncapped)
  // next-turn prompt — it only bounds how much a single mid-turn push can pin in
  // the in-memory queue (the queue DEPTH is bounded in `enqueueMidTurnMessage`).
  const MID_TURN_MESSAGE_MAX_LENGTH = 16 * 1024;
  app.post('/session/:id/mid-turn-message', mutate(), (req, res) => {
    const sessionId = requireSessionId(req, res);
    if (sessionId === null) return;
    const body = safeBody(req);
    const message = body['message'];
    // Validate (and length-check, and enqueue) the TRIMMED value — the bridge
    // stores the trimmed string, so checking the raw length would reject input
    // whose real content fits but is padded with whitespace.
    const trimmed = typeof message === 'string' ? message.trim() : '';
    if (trimmed.length === 0) {
      res.status(400).json({
        error: '`message` is required and must be a non-empty string',
      });
      return;
    }
    if (trimmed.length > MID_TURN_MESSAGE_MAX_LENGTH) {
      res.status(400).json({
        error: `\`message\` must be at most ${MID_TURN_MESSAGE_MAX_LENGTH} characters`,
      });
      return;
    }
    // Forward the client id so the bridge authorizes it against the session
    // (like `/prompt` and `/btw`) — a token-holding client bound to another
    // session must not push into this one — and records it as the message's
    // originator for SSE echo routing. `null` = malformed id (already answered).
    const clientId = parseClientIdHeader(req, res);
    if (clientId === null) return;
    try {
      const result = bridge.enqueueMidTurnMessage(
        sessionId,
        trimmed,
        clientId !== undefined ? { clientId } : undefined,
      );
      res.status(200).json(result);
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'POST /session/:id/mid-turn-message',
        sessionId,
      });
    }
  });

  app.post('/session/:id/shell', mutate({ strict: true }), async (req, res) => {
    const sessionId = req.params['id'];
    if (!sessionShellCommandEnabled) {
      sendBridgeError(res, new SessionShellDisabledError(), {
        route: 'POST /session/:id/shell',
        sessionId,
      });
      return;
    }
    const clientId = parseClientIdHeader(req, res);
    if (clientId === null) {
      return;
    }
    if (clientId === undefined) {
      sendBridgeError(res, new SessionShellClientRequiredError(), {
        route: 'POST /session/:id/shell',
        sessionId,
      });
      return;
    }
    const body = safeBody(req);
    const command = body['command'];
    if (typeof command !== 'string' || command.trim().length === 0) {
      res.status(400).json({
        error: '`command` is required and must be a non-empty string',
      });
      return;
    }
    const abort = new AbortController();
    const onResClose = () => {
      if (!res.writableEnded) abort.abort();
    };
    res.once('close', onResClose);
    try {
      const result = await bridge.executeShellCommand(
        sessionId,
        command.trim(),
        abort.signal,
        { clientId },
      );
      if (daemonLog) {
        daemonLog.info('shell command completed', {
          sessionId,
          clientId,
          exitCode: result.exitCode,
        });
      }
      res.status(200).json(result);
    } catch (err) {
      if (
        err instanceof DOMException &&
        err.name === 'AbortError' &&
        abort.signal.aborted
      ) {
        return;
      }
      sendBridgeError(res, err, {
        route: 'POST /session/:id/shell',
        sessionId,
      });
    } finally {
      res.off('close', onResClose);
    }
  });

  app.get('/session/:id/rewind/snapshots', async (req, res) => {
    const sessionId = req.params['id'];
    if (!sessionId) {
      res
        .status(400)
        .json({ error: '`sessionId` route parameter is required' });
      return;
    }
    try {
      res.status(200).json(await bridge.getRewindSnapshots(sessionId));
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'GET /session/:id/rewind/snapshots',
        sessionId,
      });
    }
  });

  app.post(
    '/session/:id/rewind',
    mutate({ strict: true }),
    async (req, res) => {
      const sessionId = req.params['id'];
      const body = safeBody(req);
      const promptId = body['promptId'];
      if (typeof promptId !== 'string' || promptId.length === 0) {
        res.status(400).json({
          error: '`promptId` is required and must be a non-empty string',
          code: 'missing_prompt_id',
        });
        return;
      }
      const clientId = parseClientIdHeader(req, res);
      if (clientId === null) return;
      try {
        const response = await bridge.rewindSession(
          sessionId,
          { promptId },
          clientId !== undefined ? { clientId } : undefined,
        );
        res.status(200).json(response);
      } catch (err) {
        sendBridgeError(res, err, {
          route: 'POST /session/:id/rewind',
          sessionId,
        });
      }
    },
  );

  app.post(
    '/session/:id/approval-mode',
    mutate({ strict: true }),
    async (req, res) => {
      // Validates `mode` against `APPROVAL_MODES` and an optional
      // `persist: boolean` flag.
      const sessionId = req.params['id'];
      const body = safeBody(req);
      const mode = body['mode'];
      const persist = body['persist'];
      if (
        typeof mode !== 'string' ||
        !APPROVAL_MODES.includes(mode as ApprovalMode)
      ) {
        res.status(400).json({
          error: '`mode` is required and must be one of the allowed values',
          code: 'invalid_approval_mode',
          allowed: APPROVAL_MODES,
        });
        return;
      }
      if (persist !== undefined && typeof persist !== 'boolean') {
        res.status(400).json({
          error: '`persist` must be a boolean when provided',
          code: 'invalid_persist_flag',
        });
        return;
      }
      const clientId = parseClientIdHeader(req, res);
      if (clientId === null) return;
      try {
        const response = await bridge.setSessionApprovalMode(
          sessionId,
          mode as ApprovalMode,
          { persist: persist === true },
          clientId !== undefined ? { clientId } : undefined,
        );
        res.status(200).json(response);
      } catch (err) {
        sendBridgeError(res, err, {
          route: 'POST /session/:id/approval-mode',
          sessionId,
        });
      }
    },
  );

  app.post('/session/:id/language', mutate(), async (req, res) => {
    const sessionId = req.params['id'];
    const body = safeBody(req);
    const language = body['language'];
    const syncOutputLanguage = body['syncOutputLanguage'];

    if (typeof language !== 'string' || !LANGUAGE_CODES.includes(language)) {
      res.status(400).json({
        error:
          '`language` is required and must be one of: ' +
          LANGUAGE_CODES.join(', '),
        code: 'invalid_language',
        allowed: LANGUAGE_CODES,
      });
      return;
    }

    if (
      syncOutputLanguage !== undefined &&
      typeof syncOutputLanguage !== 'boolean'
    ) {
      res.status(400).json({
        error: '`syncOutputLanguage` must be a boolean when provided',
        code: 'invalid_sync_flag',
      });
      return;
    }

    const clientId = parseClientIdHeader(req, res);
    if (clientId === null) return;

    try {
      const response = await bridge.setSessionLanguage(
        sessionId,
        {
          language,
          syncOutputLanguage: syncOutputLanguage === true,
        },
        clientId !== undefined ? { clientId } : undefined,
      );
      res.status(200).json(response);
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'POST /session/:id/language',
        sessionId,
      });
    }
  });

  app.post(
    '/workspace/mcp/:server/restart',
    mutate({ strict: true }),
    async (req, res) => {
      // Single-server MCP restart with budget pre-check. Soft refusals
      // are 200 OK with `{restarted:false, skipped:true, reason}`.
      const serverName = req.params['server'];
      if (!serverName || typeof serverName !== 'string') {
        res.status(400).json({
          error: 'Server name path parameter is required',
          code: 'invalid_server_name',
        });
        return;
      }
      // Cap server name length to prevent unbounded path-parameter input.
      if (serverName.length > MAX_SERVER_NAME_LENGTH) {
        res.status(400).json({
          error: `Server name exceeds ${MAX_SERVER_NAME_LENGTH}-character limit`,
          code: 'invalid_server_name',
        });
        return;
      }
      // Validate `X-Qwen-Client-Id` against known client ids.
      const clientId = parseAndValidateWorkspaceClientId(req, res, bridge);
      if (clientId === null) return;
      // Parse `?entryIndex=` for pool-mode targeted restarts. Accepts
      // a non-negative integer or `*` / omitted (restart all).
      let entryIndex: number | undefined;
      const rawEntryIndex = req.query['entryIndex'];
      if (rawEntryIndex !== undefined && rawEntryIndex !== '*') {
        const candidate =
          typeof rawEntryIndex === 'string' ? rawEntryIndex : undefined;
        const parsed =
          candidate !== undefined ? Number.parseInt(candidate, 10) : NaN;
        if (
          !Number.isInteger(parsed) ||
          parsed < 0 ||
          String(parsed) !== candidate
        ) {
          res.status(400).json({
            error:
              '`entryIndex` query parameter must be a non-negative integer or "*"',
            code: 'invalid_entry_index',
          });
          return;
        }
        entryIndex = parsed;
      }
      try {
        const ctx = buildWorkspaceCtx(
          req,
          'POST /workspace/mcp/:server/restart',
          clientId,
        );
        const result = await workspace.restartMcpServer(
          ctx,
          serverName,
          entryIndex !== undefined ? { entryIndex } : undefined,
        );
        res.status(200).json(result);
      } catch (err) {
        sendBridgeError(res, err, {
          route: 'POST /workspace/mcp/:server/restart',
        });
      }
    },
  );

  for (const [routeAction, bridgeAction] of [
    ['enable', 'enable'],
    ['disable', 'disable'],
    ['authenticate', 'authenticate'],
    ['clear-auth', 'clear-auth'],
  ] as const) {
    app.post(
      `/workspace/mcp/:server/${routeAction}`,
      mutate({ strict: true }),
      async (req, res) => {
        const serverName = req.params['server'];
        if (!serverName || typeof serverName !== 'string') {
          res.status(400).json({
            error: 'Server name path parameter is required',
            code: 'invalid_server_name',
          });
          return;
        }
        if (serverName.length > MAX_SERVER_NAME_LENGTH) {
          res.status(400).json({
            error: `Server name exceeds ${MAX_SERVER_NAME_LENGTH}-character limit`,
            code: 'invalid_server_name',
          });
          return;
        }
        const clientId = parseAndValidateWorkspaceClientId(req, res, bridge);
        if (clientId === null) return;
        try {
          const result = await bridge.manageMcpServer(
            serverName,
            bridgeAction,
            clientId,
          );
          res.status(200).json(result);
        } catch (err) {
          sendBridgeError(res, err, {
            route: `POST /workspace/mcp/:server/${routeAction}`,
          });
        }
      },
    );
  }

  // Add a runtime MCP server.
  app.post(
    '/workspace/mcp/servers',
    mutate({ strict: true }),
    async (req, res) => {
      const body = safeBody(req);
      const name = body['name'];
      if (!validateMcpRuntimeServerName(name, res)) return;
      // Validate config: must be a non-null object
      const config = body['config'];
      if (
        typeof config !== 'object' ||
        config === null ||
        Array.isArray(config)
      ) {
        res.status(400).json({
          error: '`config` must be a non-null object',
          code: 'missing_required_field',
          field: 'config',
        });
        return;
      }
      // Validate client identity (required for runtime MCP mutation)
      const clientId = parseAndValidateWorkspaceClientId(req, res, bridge);
      if (clientId === null) return;
      if (!clientId) {
        res.status(400).json({
          error:
            '`X-Qwen-Client-Id` header is required for runtime MCP mutation',
          code: 'missing_client_id',
        });
        return;
      }
      try {
        const result = await bridge.addRuntimeMcpServer(
          name,
          config as Record<string, unknown>,
          clientId,
        );
        res.status(200).json(result);
      } catch (err) {
        sendBridgeError(res, err, {
          route: 'POST /workspace/mcp/servers',
        });
      }
    },
  );

  // Remove a runtime MCP server. Idempotent.
  app.delete(
    '/workspace/mcp/servers/:name',
    mutate({ strict: true }),
    async (req, res) => {
      const name = req.params['name'] ?? '';
      if (!validateMcpRuntimeServerName(name, res)) return;
      // Validate client identity (required for runtime MCP mutation)
      const clientId = parseAndValidateWorkspaceClientId(req, res, bridge);
      if (clientId === null) return;
      if (!clientId) {
        res.status(400).json({
          error:
            '`X-Qwen-Client-Id` header is required for runtime MCP mutation',
          code: 'missing_client_id',
        });
        return;
      }
      try {
        const result = await bridge.removeRuntimeMcpServer(name, clientId);
        res.status(200).json(result);
      } catch (err) {
        sendBridgeError(res, err, {
          route: 'DELETE /workspace/mcp/servers/:name',
        });
      }
    },
  );

  app.post('/workspace/init', mutate({ strict: true }), async (req, res) => {
    // #4175 Wave 4 PR 17. Scaffold-only init: the workspace service
    // writes an empty QWEN.md without invoking the LLM. Default refuses
    // overwrite (409); body `{force: true}` overrides.
    const body = safeBody(req);
    const force = body['force'];
    if (force !== undefined && typeof force !== 'boolean') {
      res.status(400).json({
        error: '`force` must be a boolean when provided',
        code: 'invalid_force_flag',
      });
      return;
    }
    // Validate against known client ids.
    const clientId = parseAndValidateWorkspaceClientId(req, res, bridge);
    if (clientId === null) return;
    try {
      const ctx = buildWorkspaceCtx(req, 'POST /workspace/init', clientId);
      const result = await workspace.initWorkspace(ctx, {
        force: force === true,
      });
      res.status(200).json(result);
    } catch (err) {
      sendBridgeError(res, err, { route: 'POST /workspace/init' });
    }
  });

  app.post(
    '/workspace/reload',
    mutate({ strict: true }),
    async (req: Request, res: Response) => {
      const clientId = parseAndValidateWorkspaceClientId(req, res, bridge);
      if (clientId === null) return;
      try {
        const ctx = buildWorkspaceCtx(req, 'POST /workspace/reload', clientId);
        const result = await workspace.reload(ctx);
        res.status(200).json(result);
      } catch (err) {
        sendBridgeError(res, err, { route: 'POST /workspace/reload' });
      }
    },
  );

  app.post(
    '/workspace/tools/:name/enable',
    mutate({ strict: true }),
    async (req, res) => {
      // Toggles a tool name in the workspace `tools.disabled` settings
      // list. Strict-gated alongside other
      // mutation routes; bridge writes the file directly (no
      // ACP roundtrip) and fan-outs `tool_toggled` to every live
      // session SSE bus. Already-registered tools in live sessions
      // are NOT retroactively unregistered — toggling takes effect on
      // the next ACP child spawn or session refresh.
      const rawToolName = req.params['name'];
      if (!rawToolName || typeof rawToolName !== 'string') {
        res.status(400).json({
          error: 'Tool name path parameter is required',
          code: 'invalid_tool_name',
        });
        return;
      }
      // Trim before persistence so the write path matches the read path.
      const toolName = rawToolName.trim();
      if (toolName.length === 0) {
        res.status(400).json({
          error: 'Tool name path parameter is required',
          code: 'invalid_tool_name',
        });
        return;
      }
      // Cap tool name length to prevent settings file bloat.
      if (toolName.length > MAX_TOOL_NAME_LENGTH) {
        res.status(400).json({
          error: `Tool name exceeds ${MAX_TOOL_NAME_LENGTH}-character limit`,
          code: 'invalid_tool_name',
        });
        return;
      }
      const body = safeBody(req);
      const enabled = body['enabled'];
      if (typeof enabled !== 'boolean') {
        res.status(400).json({
          error: '`enabled` is required and must be a boolean',
          code: 'invalid_enabled_flag',
        });
        return;
      }
      // Validate against known client ids.
      const clientId = parseAndValidateWorkspaceClientId(req, res, bridge);
      if (clientId === null) return;
      try {
        const ctx = buildWorkspaceCtx(
          req,
          'POST /workspace/tools/:name/enable',
          clientId,
        );
        const result = await workspace.setWorkspaceToolEnabled(
          ctx,
          toolName,
          enabled,
        );
        res.status(200).json(result);
      } catch (err) {
        sendBridgeError(res, err, {
          route: 'POST /workspace/tools/:name/enable',
        });
      }
    },
  );

  app.post('/session/:id/permission/:requestId', mutate(), (req, res) => {
    const sessionId = req.params['id'];
    const requestId = req.params['requestId'];
    const response = parsePermissionVoteBody(req, res);
    if (response === undefined) return;
    const clientId = parseClientIdHeader(req, res);
    if (clientId === null) return;
    // Thread the kernel-stamped peer-IP loopback bit through the bridge
    // context so the `local-only` policy can gate votes by transport.
    const fromLoopback = detectFromLoopback(req);
    const context = {
      ...(clientId !== undefined ? { clientId } : {}),
      fromLoopback,
    };
    let accepted: boolean;
    try {
      accepted = bridge.respondToSessionPermission(
        sessionId,
        requestId,
        response,
        context,
      );
    } catch (err) {
      sendPermissionVoteError(res, err, {
        route: 'POST /session/:id/permission/:requestId',
        sessionId,
      });
      return;
    }
    if (!accepted) {
      res.status(404).json({
        error: 'No pending permission request for session',
        sessionId,
        requestId,
      });
      return;
    }
    res.status(200).json({});
  });

  app.post('/permission/:requestId', mutate(), (req, res) => {
    const requestId = req.params['requestId'];
    const response = parsePermissionVoteBody(req, res);
    if (response === undefined) return;
    const clientId = parseClientIdHeader(req, res);
    if (clientId === null) return;
    // Same loopback bit threading as the session-scoped route above.
    const fromLoopback = detectFromLoopback(req);
    const context = {
      ...(clientId !== undefined ? { clientId } : {}),
      fromLoopback,
    };
    let accepted: boolean;
    try {
      accepted = bridge.respondToPermission(requestId, response, context);
    } catch (err) {
      sendPermissionVoteError(res, err, {
        route: 'POST /permission/:requestId',
      });
      return;
    }
    if (!accepted) {
      // Either the requestId never existed or another client already won
      // the race. Stage 1 doesn't distinguish — both surface as 404.
      res
        .status(404)
        .json({ error: 'No pending permission request', requestId });
      return;
    }
    res.status(200).json({});
  });

  app.get('/session/:id/events', (req, res) => {
    const sessionId = req.params['id'];
    const lastEventId = parseLastEventId(req.headers['last-event-id']);
    const maxQueued = parseMaxQueuedQuery(req.query['maxQueued'], res);
    // `parseMaxQueuedQuery` sends its own 400 + JSON body on rejection
    // (returns `null`) so the SSE handshake doesn't get half-written.
    // `undefined` means "client didn't ask for an override; use bus
    // default 256" — proceed as before.
    if (maxQueued === null) return;

    let iter: AsyncIterator<BridgeEvent> | undefined;
    const abort = new AbortController();
    try {
      const snapshot = req.query['snapshot'] === '1';
      const iterable = bridge.subscribeEvents(sessionId, {
        signal: abort.signal,
        lastEventId,
        ...(maxQueued !== undefined ? { maxQueued } : {}),
        ...(snapshot ? { snapshot: true } : {}),
      });
      iter = iterable[Symbol.asyncIterator]();
    } catch (err) {
      // `EventBus` throws `SubscriberLimitExceededError` when the
      // per-session subscriber cap (default 64) is reached.
      //
      // Surface as `429 Too Many Requests` + `Retry-After`
      // header rather than `200 + stream_error`. The previous
      // SSE-shaped response triggered `EventSource`'s
      // auto-reconnect (which honors the `retry:` directive AND
      // default-reconnects on any closed stream). The reconnect hit
      // the same cap, looped, amplifying the exact load the limit
      // exists to prevent.
      //
      // `429` is the standard "back off" signal — browsers'
      // `EventSource` treats `4xx` as terminal and does NOT
      // auto-reconnect on it, unlike `200 + close` which DOES
      // reconnect. Body shape mirrors the SSE frame's data field so
      // a raw-fetch client gets the same structured error.
      if (err instanceof SubscriberLimitExceededError) {
        writeStderrLine(
          `qwen serve: subscriber limit reached for session ${sessionId} (limit=${err.limit}); rejecting new SSE client with 429`,
        );
        res.setHeader('Retry-After', '5');
        res.status(429).json({
          error: err.message,
          code: 'subscriber_limit_exceeded',
          limit: err.limit,
        });
        return;
      }
      sendBridgeError(res, err, {
        route: 'GET /session/:id/events',
        sessionId,
      });
      return;
    }

    if (daemonLog) {
      const sseOpenedAt = Date.now();
      const sseClientId = req.headers['x-qwen-client-id'] as string | undefined;
      daemonLog.info('SSE stream opened', { sessionId, clientId: sseClientId });
      res.on('close', () => {
        try {
          daemonLog.info('SSE stream closed', {
            sessionId,
            clientId: sseClientId,
            durationMs: Date.now() - sseOpenedAt,
          });
        } catch {
          /* logger failure must not prevent counter decrement */
        }
      });
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Disable proxy buffering (nginx); event-stream content type alone
    // doesn't always reach the client through every proxy.
    res.setHeader('X-Accel-Buffering', 'no');
    // Always present on the supported Node versions (engines.node >=22).
    res.flushHeaders();

    activeSseCount++;
    let sseCounted = true;
    res.on('close', () => {
      if (sseCounted) {
        sseCounted = false;
        activeSseCount--;
      }
    });

    // Backpressure helper: `res.write` returns false when the kernel send
    // buffer is full. Without awaiting `drain` Node accumulates the
    // payload in user-space memory unboundedly — a slow consumer on a
    // chatty session can balloon daemon RSS. Wait for `drain` (or
    // close/error) before scheduling the next write.
    //
    // Concurrency: serialize ALL writes through a per-connection chain
    // so the heartbeat (fire-and-forget interval, see below) can't
    // interleave with the main event-write loop. Without serialization,
    // the heartbeat firing while the main loop is mid-`drain` await
    // would issue a second `res.write()` that bypasses the
    // backpressure guard — and could even interleave bytes between two
    // SSE frames on the wire. The chain is single-flight: each call
    // waits for the previous write to settle before scheduling its own.
    let writeChain: Promise<void> = Promise.resolve();
    // T2.9: epoch (ms) of the last write that fully resolved — either
    // synchronous `res.write` returned `true`, or the async `drain`
    // fired. The idle-timeout interval below compares
    // `Date.now() - lastWriteAt` against the configured budget; a
    // writer that stalls indefinitely on `drain` will never refresh
    // this stamp, so the timer fires and forces cleanup. Initialized
    // to "now" because cleanup runs only after the FIRST stall, and
    // the SSE handshake itself counts as activity.
    //
    // Gated on `trackWriterIdle` so the default (flag unset) avoids
    // a per-chunk `Date.now()` on a chatty stream — SSE writers can
    // be in the hundreds-to-thousands of frames per session.
    const trackWriterIdle =
      opts.writerIdleTimeoutMs !== undefined && opts.writerIdleTimeoutMs > 0;
    let lastWriteAt = trackWriterIdle ? Date.now() : 0;
    const doWrite = (chunk: string): Promise<void> =>
      new Promise((resolve, reject) => {
        if (res.writableEnded) {
          resolve();
          return;
        }
        // `res.write` can throw synchronously when the socket is
        // already destroyed (typical EPIPE shape). Wrap in try/catch
        // so that surfaces as a rejection on this promise instead of
        // escaping the executor and turning into an unhandled
        // exception. Async failures still arrive via the `'error'`
        // event handler below — Node's Writable.write callback isn't
        // documented to receive an error argument (errors come on
        // the event), so we don't rely on it.
        let ok: boolean;
        try {
          ok = res.write(chunk);
        } catch (err) {
          reject(err);
          return;
        }
        if (ok) {
          if (trackWriterIdle) lastWriteAt = Date.now();
          resolve();
          return;
        }
        const onDrain = () => {
          res.off('close', onClose);
          res.off('error', onError);
          if (trackWriterIdle) lastWriteAt = Date.now();
          resolve();
        };
        const onClose = () => {
          res.off('drain', onDrain);
          res.off('error', onError);
          resolve();
        };
        const onError = (err: Error) => {
          res.off('drain', onDrain);
          res.off('close', onClose);
          reject(err);
        };
        res.once('drain', onDrain);
        res.once('close', onClose);
        res.once('error', onError);
      });
    const writeWithBackpressure = (chunk: string): Promise<void> => {
      const next = writeChain.then(() => doWrite(chunk));
      // Tail-swallow rejections on the chain itself so a single failed
      // write doesn't poison every subsequent call. The CALLER's
      // returned promise still rejects — chain-internal failures are
      // someone else's problem, not blockers for queueing.
      writeChain = next.catch(() => undefined);
      return next;
    };

    // Tell EventSource to retry after 3s on disconnect. Awaiting drain on
    // the very first write is overkill but cheap — `ok` is true the
    // overwhelming majority of the time. Always swallow rejection: a
    // socket that errors before the very first write would otherwise
    // surface as an unhandled promise rejection (the `res.on('error')`
    // hook below is what we actually rely on for cleanup).
    void writeWithBackpressure('retry: 3000\n\n').catch(() => {});

    // Heartbeat keeps NAT/proxy connections alive and lets the server
    // notice a dead client through write-back-pressure. Comment frame is
    // ignored by EventSource.
    //
    // The 15s heartbeat detects a TCP-dead writer
    // via `drain` back-pressure on the comment frame itself. The
    // `--writer-idle-timeout-ms` flag below adds the orthogonal
    // application-level guard: if the LAST SUCCESSFUL FLUSH (any
    // write — heartbeat, replay frame, live event) is older than the
    // configured budget, the writer is considered stuck (NAT silently
    // dropping flows, peer process frozen, etc.) and we force a
    // terminal `client_evicted` frame + cleanup. The historical "Stage
    // 2 may add an explicit application-level idle timeout" gap
    // referenced here is now closed when the flag is set.
    const heartbeatTimer = setInterval(() => {
      if (!res.writableEnded) {
        // Heartbeat writes are best-effort; failure swallowed via the
        // `res.on('error')` hook below.
        void writeWithBackpressure(': heartbeat\n\n').catch(() => {});
      }
    }, 15_000);
    heartbeatTimer.unref();

    // T2.9: declare the idle-timer slot up-front so `cleanup` below can
    // clear it unconditionally. The actual interval is armed only when
    // `--writer-idle-timeout-ms` is configured.
    let idleTimer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      clearInterval(heartbeatTimer);
      if (idleTimer !== undefined) clearInterval(idleTimer);
      abort.abort();
    };

    // T2.9: arm the SSE writer idle timeout (if configured). Distinct
    // from the heartbeat above: heartbeat = "try to ping every 15s";
    // this = "if no write SUCCEEDED for N ms, force-evict." Values
    // BELOW the 15s heartbeat interval WILL evict otherwise-healthy
    // idle connections before the first heartbeat fires — they're not
    // a no-op. Production deployments should pick a value comfortably
    // above 15s (e.g. 30000–300000ms) so legitimate idle streams stay
    // alive and only genuinely stuck writers are reaped; small values
    // are useful for tests / short-lived dev sessions. The interval
    // polls at 1/4 the budget (bounded by [250ms, 5s]) so tests
    // using short budgets still detect promptly, while long
    // production budgets stay cheap. Values below roughly 1000ms all
    // use the 250ms polling floor, so eviction can lag until the next
    // tick instead of landing at exact millisecond precision.
    if (trackWriterIdle) {
      // Narrowed by `trackWriterIdle`; the const assertion keeps
      // TypeScript happy inside the closure without re-reading opts.
      const writerIdleTimeoutMs = opts.writerIdleTimeoutMs as number;
      const checkIntervalMs = Math.max(
        250,
        Math.min(5_000, Math.floor(writerIdleTimeoutMs / 4)),
      );
      idleTimer = setInterval(() => {
        if (res.writableEnded) return;
        const idleForMs = Date.now() - lastWriteAt;
        if (idleForMs < writerIdleTimeoutMs) return;
        // Reuse the existing `client_evicted` taxonomy from
        // `event-bus.ts` so SDK reducers branch on the same frame type
        // they already handle for queue-overflow eviction; the new
        // `reason` slot is the differentiator. Write DIRECTLY here
        // (bypassing `writeWithBackpressure`) because the chain may
        // already be stuck on a `drain` that will never come — which
        // is the exact scenario this timer exists to catch. If the
        // kernel send buffer has room the client sees the frame; if
        // not, the client gets EPIPE on next read. Either way the
        // socket is closed in the next two statements, so any drop
        // is bounded.
        try {
          res.write(
            formatSseFrame({
              v: 1,
              type: 'client_evicted',
              data: {
                reason: 'writer_idle_timeout',
                errorKind: 'writer_idle_timeout',
                idleForMs,
                timeoutMs: writerIdleTimeoutMs,
              },
            }),
          );
        } catch {
          /* socket already destroyed; nothing to send. */
        }
        // Wrap stderr + res.end so an
        // EPIPE on the stderr pipe (or a synchronous throw from
        // `res.end()` against a destroyed socket) can't escape this
        // interval callback. If it did, `cleanup()` wouldn't run, the
        // heartbeat + idle timers would never clear, and every
        // subsequent tick would re-throw — turning one transient
        // failure into a permanent uncaughtException loop.
        try {
          writeStderrLine(
            `qwen serve: evicting SSE client (session ${sessionId}) — ` +
              `writer idle for ${idleForMs}ms > ${writerIdleTimeoutMs}ms timeout`,
          );
        } catch {
          /* stderr pipe closed; eviction is still happening. */
        }
        cleanup();
        try {
          if (!res.writableEnded) res.end();
        } catch {
          /* socket already destroyed; nothing more to do. */
        }
      }, checkIntervalMs);
      idleTimer.unref();
    }
    req.on('close', cleanup);
    // Swallow socket-level write errors. When the underlying TCP connection
    // dies (RST, mid-flight kill -9), the next `res.write` throws EPIPE.
    // Without an `error` listener Express forwards it to its default error
    // handler which logs noisily. The req.on('close') path above is what we
    // actually rely on to tear down the subscription; this listener just
    // suppresses the noise + ensures cleanup runs even if for some reason
    // the close event doesn't fire first.
    res.on('error', (err) => {
      // Without this log the daemon side is blind to SSE disconnects
      // (RST, mid-flight kill -9, network blip). Cleanup still runs —
      // the listener exists primarily so Node doesn't crash on EPIPE
      // — but operators get a breadcrumb when chasing flaky clients.
      writeStderrLine(
        `qwen serve: SSE socket error (session ${sessionId}): ${err.message}`,
      );
      cleanup();
    });

    void (async () => {
      try {
        while (true) {
          const next = await iter!.next();
          if (next.done) break;
          if (res.writableEnded) break;
          // Log ring eviction events for operator observability.
          if (next.value.type === 'state_resync_required') {
            const data = next.value.data as {
              lastDeliveredId?: number;
              earliestAvailableId?: number;
              reason?: string;
            };
            const gap =
              typeof data.earliestAvailableId === 'number' &&
              typeof data.lastDeliveredId === 'number'
                ? data.earliestAvailableId - data.lastDeliveredId - 1
                : undefined;
            writeStderrLine(
              `qwen serve: SSE ring eviction detected (session ${sessionId}): ` +
                `lastEventId=${data.lastDeliveredId ?? '?'}, ` +
                `earliestInRing=${data.earliestAvailableId ?? '?'}, ` +
                `gap=${gap ?? '?'} events, ` +
                `reason=${data.reason ?? '?'}. ` +
                `Consumer must call loadSession to recover.`,
            );
          }
          await writeWithBackpressure(formatSseFrame(next.value));
        }
      } catch (err) {
        if (!res.writableEnded) {
          // Don't burn an `id:` slot — `stream_error` is a terminal frame
          // emitted on the daemon side when the bridge iterator throws, so
          // it has no place in the per-session monotonic sequence and a
          // hard-coded `id: 0` would regress the client's `Last-Event-ID`
          // tracker. `formatSseFrame` omits the `id:` line when the input
          // event has no id.
          //
          // Stamp the classified error kind so UIs can render typed responses
          // (auth retry / file picker / proxy hint / etc.) rather than
          // regex-matching the human-readable `error` string. Returns
          // `undefined` for unclassified errors — SDK falls back to
          // rendering `error` text as before, so adding `errorKind` is
          // strictly additive / backward-compatible.
          const errorKind = mapDomainErrorToErrorKind(err);
          // Log bridge iterator errors to daemon stderr for
          // operator observability.
          writeStderrLine(
            `qwen serve: bridge iterator error (session ${sessionId}): ` +
              `${errorMessage(err)}` +
              (errorKind ? ` [${errorKind}]` : ''),
          );
          await writeWithBackpressure(
            formatSseFrame({
              v: 1,
              type: 'stream_error',
              data: {
                error: errorMessage(err),
                ...(errorKind ? { errorKind } : {}),
              },
            }),
          ).catch(() => {});
        }
      } finally {
        cleanup();
        if (!res.writableEnded) res.end();
      }
    })();
  });

  // Official ACP Streamable HTTP transport (RFD #721) mounted at `/acp`
  // alongside the REST surface, sharing this same `bridge` instance.
  // Additive + toggleable (`QWEN_SERVE_ACP_HTTP=0` opts out).
  // See `docs/design/daemon-acp-http/README.md` for the dual-transport
  // decision. Mounted AFTER the REST routes (distinct path, no overlap)
  // and BEFORE the final error handler so malformed `/acp` bodies still
  // route through the JSON error contract below.
  acpHandleRef.current = mountAcpHttp(app, bridge, {
    boundWorkspace,
    workspace,
    fsFactory,
    deviceFlowRegistry,
    token: opts.token,
    sessionShellCommandEnabled,
    checkRate: rateLimiter?.checkRate,
  });
  if (acpHandleRef.current) {
    app.locals['acpHandle'] = acpHandleRef.current;
  }

  // Web Shell SPA deep-link fallback — registered AFTER every API route (and
  // just before the error handler) so real routes, including their bearerAuth
  // 401s, always win; only genuine 404 misses fall through to the shell. This
  // is what keeps an attacker-controlled `Accept: text/html` from coaxing the
  // 200 shell out of an authed route.
  if (webShellDir) {
    mountWebShellSpaFallback(app, webShellDir);
  }

  // Final error handler. `express.json()` throws `SyntaxError` (with
  // `status: 400`) on malformed body — without this 4-arg middleware
  // Express renders an HTML error page, which trips SDK clients that
  // expect a JSON body on every response. Anything else bubbling out
  // is a programmer error; log it and return a JSON 500 (matches the
  // route-level `sendBridgeError` shape so clients have one error
  // contract to parse).
  app.use(
    (
      err: unknown,
      _req: import('express').Request,
      res: import('express').Response,
      _next: import('express').NextFunction,
    ) => {
      if (sendJsonBodyParserError(res, err)) return;
      writeStderrLine(
        `qwen serve: unhandled error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    },
  );

  if (rateLimiter) {
    setRateLimiter(app, rateLimiter);
  }

  return app;
}

function sendJsonBodyParserError(
  res: import('express').Response,
  err: unknown,
): boolean {
  if (
    err instanceof SyntaxError &&
    'status' in err &&
    (err as { status: number }).status === 400
  ) {
    res.status(400).json({ error: 'Invalid JSON in request body' });
    return true;
  }
  // body-parser raises a typed error with `status: 413` when a
  // request body exceeds the `express.json({ limit: '10mb' })`
  // ceiling. Without this branch it falls through to the 500 path
  // and clients see a misleading "Internal server error" instead
  // of a clear "payload too large" — which is the kind of error
  // they can actually act on (chunk the request, raise the limit).
  if (
    err &&
    typeof err === 'object' &&
    'status' in err &&
    (err as { status: number }).status === 413
  ) {
    res.status(413).json({ error: 'Request body too large (max 10 MB)' });
    return true;
  }
  return false;
}

/**
 * Keys stripped by `safeBody` to defend against prototype-pollution
 * Routes downstream of `safeBody` spread
 * the filtered result into objects passed to the bridge / ACP SDK;
 * without this scrub a client could set
 * `{"__proto__": {"polluted": true}}` and pollute
 * `Object.prototype` via downstream spreads.
 *
 * **Cross-reference for route maintainers:** the POST `/session`
 * route distinguishes "absent" from "present" via `'cwd' in body`
 * against `safeBody`'s output. The semantics rely on this set NOT
 * overlapping with user-payload keys. If you ever add a key here
 * that a route's presence-check cares about (highly unlikely — this
 * set is the JS prototype-attack triple, plus a route would have
 * to deliberately name a property after one of these), the
 * presence-check needs to move to the pre-`safeBody` `req.body`
 * (with its own pollution guard) or `safeBody` needs to return a
 * separate "raw-keys" set alongside the filtered object.
 */
const PROTOTYPE_POLLUTION_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

const CLIENT_ID_HEADER = 'x-qwen-client-id';
const MAX_CLIENT_ID_LENGTH = 128;
const MAX_TOOL_NAME_LENGTH = 256;
const MAX_SERVER_NAME_LENGTH = 256;
const CLIENT_ID_RE = /^[A-Za-z0-9._:-]+$/;
const INVALID_PERMISSION_OUTCOME_ERROR =
  '`outcome` must be `{ outcome: "cancelled" }` or `{ outcome: "selected", optionId: string }`';

type PermissionVoteResponse = Parameters<
  AcpSessionBridge['respondToPermission']
>[1];

/**
 * Coerce `req.body` into a safe `Record<string, unknown>` for route
 * handlers.
 *
 * Strips the `PROTOTYPE_POLLUTION_KEYS` set before returning. Uses an
 * `Object.create(null)` target so the returned object itself has no
 * prototype either, blocking second-order spread-into-default-
 * prototype attacks.
 */
function safeBody(req: import('express').Request): Record<string, unknown> {
  const raw = req.body;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return Object.create(null) as Record<string, unknown>;
  }
  const out = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (PROTOTYPE_POLLUTION_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

function parseOptionalWorkspaceCwd(
  body: Record<string, unknown>,
  boundWorkspace: string,
  res: import('express').Response,
): string | undefined {
  const hasCwd = 'cwd' in body;
  if (hasCwd && typeof body['cwd'] !== 'string') {
    res
      .status(400)
      .json({ error: '`cwd` must be a string absolute path when provided' });
    return undefined;
  }
  if (hasCwd && (body['cwd'] as string).length > MAX_WORKSPACE_PATH_LENGTH) {
    res.status(400).json({
      error: `\`cwd\` exceeds the ${MAX_WORKSPACE_PATH_LENGTH}-character limit`,
    });
    return undefined;
  }
  const cwd = hasCwd ? (body['cwd'] as string) : boundWorkspace;
  if (!path.isAbsolute(cwd)) {
    res
      .status(400)
      .json({ error: '`cwd` must be an absolute path when provided' });
    return undefined;
  }
  return cwd;
}

/**
 * Returns true iff the GET / POST caller is the same client that
 * originally started the device flow. Both-undefined is treated as a
 * match (anonymous-start -> anonymous-reattach is the legitimate case).
 *
 * **Threat model:** this is BEST-EFFORT ATTRIBUTION, not authentication.
 * `X-Qwen-Client-Id` is a syntactic header, not bound to a server-
 * validated identity — the bearer token IS the auth boundary. This gate
 * prevents accidental cross-client reads in well-behaved multi-SDK setups.
 */
function callerIsDeviceFlowInitiator(
  view: Pick<DeviceFlowPublicView, 'initiatorClientId'>,
  callerClientId: string | undefined,
): boolean {
  return (
    (view.initiatorClientId === undefined && callerClientId === undefined) ||
    (view.initiatorClientId !== undefined &&
      callerClientId !== undefined &&
      callerClientId === view.initiatorClientId)
  );
}

/**
 * Translate the registry's redacted `DeviceFlowPublicView` into the
 * wire shape for start responses. Splitting "start response" from
 * "state body" preserves the `attached` field without polluting GET.
 */
function toDeviceFlowStartResponseBody(
  view: DeviceFlowPublicView,
  attached: boolean,
  callerClientId?: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    deviceFlowId: view.deviceFlowId,
    providerId: view.providerId,
    status: view.status,
    expiresAt: view.expiresAt ?? 0,
    intervalMs: view.intervalMs ?? 0,
    attached,
  };
  // Only the original starter sees the verification material.
  if (callerIsDeviceFlowInitiator(view, callerClientId)) {
    body['userCode'] = view.userCode ?? '';
    body['verificationUri'] = view.verificationUri ?? '';
    if (view.verificationUriComplete) {
      body['verificationUriComplete'] = view.verificationUriComplete;
    }
  }
  // Only echo `initiatorClientId` back when the caller matches.
  if (
    view.initiatorClientId &&
    callerClientId !== undefined &&
    callerClientId === view.initiatorClientId
  ) {
    body['initiatorClientId'] = view.initiatorClientId;
  }
  return body;
}

function toDeviceFlowStateBody(
  view: DeviceFlowPublicView,
  callerClientId?: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    deviceFlowId: view.deviceFlowId,
    providerId: view.providerId,
    status: view.status,
    createdAt: view.createdAt,
  };
  if (view.errorKind) body['errorKind'] = view.errorKind;
  if (view.hint) body['hint'] = view.hint;
  if (view.expiresAt !== undefined) body['expiresAt'] = view.expiresAt;
  if (view.intervalMs !== undefined) body['intervalMs'] = view.intervalMs;
  if (view.lastPolledAt !== undefined) body['lastPolledAt'] = view.lastPolledAt;
  // Only echo verification fields to the original starter.
  if (callerIsDeviceFlowInitiator(view, callerClientId)) {
    if (view.userCode) body['userCode'] = view.userCode;
    if (view.verificationUri) body['verificationUri'] = view.verificationUri;
    if (view.verificationUriComplete) {
      body['verificationUriComplete'] = view.verificationUriComplete;
    }
    if (view.initiatorClientId) {
      body['initiatorClientId'] = view.initiatorClientId;
    }
  }
  return body;
}

function requireSessionId(
  req: import('express').Request,
  res: import('express').Response,
): string | null {
  const sessionId = req.params['id'];
  if (!sessionId) {
    res.status(400).json({ error: '`sessionId` route parameter is required' });
    return null;
  }
  return sessionId;
}

function parseClientIdHeader(
  req: import('express').Request,
  res: import('express').Response,
): string | undefined | null {
  const raw = req.get(CLIENT_ID_HEADER);
  if (raw === undefined || raw === '') return undefined;
  if (raw.length > MAX_CLIENT_ID_LENGTH || !CLIENT_ID_RE.test(raw)) {
    res.status(400).json({
      error:
        '`X-Qwen-Client-Id` must be a non-empty token of 128 characters or fewer',
      code: 'invalid_client_id',
    });
    return null;
  }
  return raw;
}

/**
 * Decide whether a permission vote arrived from a loopback peer.
 *
 * Per RFC 1122 the entire `127.0.0.0/8` block is loopback (and the
 * IPv4-mapped IPv6 form `::ffff:127.0.0.0/104` mirrors that). IPv6
 * loopback is `::1` (single literal).
 *
 * **Security**: reads `req.socket.remoteAddress` only — does NOT
 * consult `X-Forwarded-For` or any HTTP header (forgeable). Fail-
 * CLOSED: unrecognized shapes return `false`.
 */
export function detectFromLoopback(req: {
  socket?: { remoteAddress?: string | undefined };
}): boolean {
  const addr = req.socket?.remoteAddress;
  if (typeof addr !== 'string') return false;
  // IPv6 loopback (single literal).
  if (addr === '::1') return true;
  // IPv4 loopback: 127.0.0.0/8.
  if (addr.startsWith('127.')) return true;
  // IPv4-mapped IPv6 loopback: ::ffff:127.0.0.0/104.
  if (addr.startsWith('::ffff:127.')) return true;
  return false;
}

/**
 * Validate that a server name from a route parameter is a non-empty
 * alphanumeric string within the length limit and not a reserved JS
 * property name. Emits a 400 JSON response and returns `false` on
 * validation failure.
 */
function validateMcpRuntimeServerName(
  name: unknown,
  res: import('express').Response,
): name is string {
  if (typeof name !== 'string' || name.length === 0) {
    res.status(400).json({
      error: 'Server name is required and must be a non-empty string',
      code: 'invalid_server_name',
    });
    return false;
  }
  if (name.length > MAX_SERVER_NAME_LENGTH) {
    res.status(400).json({
      error: `Server name exceeds ${MAX_SERVER_NAME_LENGTH}-character limit`,
      code: 'invalid_server_name',
    });
    return false;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    res.status(400).json({
      error:
        'Server name must contain only alphanumeric characters, underscores, and hyphens',
      code: 'invalid_server_name',
    });
    return false;
  }
  if (name === '__proto__' || name === 'constructor' || name === 'prototype') {
    res.status(400).json({
      error: 'Server name must not be a reserved JS property name',
      code: 'invalid_server_name',
    });
    return false;
  }
  return true;
}

/**
 * Workspace-level mutation routes validate the parsed `X-Qwen-Client-Id`
 * against `bridge.knownClientIds()` so the `originatorClientId` stamped
 * onto fan-out events is grounded in a known identity. Returns the
 * validated client id (or `undefined` when no header was supplied),
 * `null` when a 400 has already been emitted.
 */
function parseAndValidateWorkspaceClientId(
  req: import('express').Request,
  res: import('express').Response,
  bridge: AcpSessionBridge,
): string | undefined | null {
  const raw = parseClientIdHeader(req, res);
  if (raw === null || raw === undefined) return raw;
  if (!bridge.knownClientIds().has(raw)) {
    res.status(400).json({
      error: `Client id "${raw}" is not registered for this workspace`,
      code: 'invalid_client_id',
      clientId: raw,
    });
    return null;
  }
  return raw;
}

function parsePermissionVoteBody(
  req: import('express').Request,
  res: import('express').Response,
): PermissionVoteResponse | undefined {
  const body = safeBody(req);
  const outcome = body['outcome'];
  if (!isValidOutcome(outcome)) {
    res.status(400).json({ error: INVALID_PERMISSION_OUTCOME_ERROR });
    return undefined;
  }
  return {
    ...(body as object),
    outcome,
  } as PermissionVoteResponse;
}

function isValidOutcome(
  raw: unknown,
): raw is { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string } {
  if (typeof raw !== 'object' || raw === null) return false;
  const obj = raw as Record<string, unknown>;
  if (obj['outcome'] === 'cancelled') return true;
  // `optionId` must be a non-empty string. An empty string is technically a
  // string but isn't a meaningful selection — letting it through would
  // forward malformed votes to the bridge and the agent would reject the
  // unknown option opaquely.
  return (
    obj['outcome'] === 'selected' &&
    typeof obj['optionId'] === 'string' &&
    (obj['optionId'] as string).length > 0
  );
}

/** Range bounds for the `?maxQueued=N` query param on `/session/:id/events`. */
const MIN_QUERY_MAX_QUEUED = 16;
const MAX_QUERY_MAX_QUEUED = 2048;

/**
 * Parse the optional `?maxQueued=N` query param on
 * `GET /session/:id/events`. Returns:
 *   - `undefined` — param absent, EventBus uses its default cap (256).
 *   - a positive integer in `[16, 2048]` — caller wants a custom cap.
 *   - `null` — malformed value; the function ALREADY sent a 400 JSON
 *     response and the route must short-circuit. (Pre-handshake 400
 *     is safer than half-opening an SSE stream and emitting a
 *     `stream_error` frame the client has to parse — `EventSource`
 *     auto-reconnects on the latter.)
 *
 * Cap range rationale: lower bound 16 (smaller is useless for any
 * replay backlog); upper bound 2048 (so a single subscriber can't
 * pin ~1 MB of queue memory just by asking).
 */
function parseMaxQueuedQuery(
  raw: unknown,
  res: import('express').Response,
): number | undefined | null {
  // Absent param → undefined (use bus default). Present-but-empty
  // (`?maxQueued=` typed explicitly) → fail-CLOSED 400 — the API
  // documents fail-closed for any malformed value before opening
  // SSE, and an empty string is unambiguously malformed (real values
  // are positive integers in [16, 2048]).
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    // Sanitize via JSON.stringify so an attacker-controlled value
    // containing `\n` / `\r` / other control chars can't inject extra
    // log lines into stderr (line-based shipper like
    // journald/Loki/Splunk would otherwise treat the injected line as
    // a fresh entry). Matches the `workspace_mismatch` log style in
    // `sendBridgeError`.
    writeStderrLine(
      `qwen serve: rejected ?maxQueued ${safeLogValue(raw)} ` +
        `(not a decimal integer)`,
    );
    res.status(400).json({
      error: '`maxQueued` must be a decimal integer',
      code: 'invalid_max_queued',
    });
    return null;
  }
  const n = Number.parseInt(raw, 10);
  if (
    !Number.isFinite(n) ||
    n < MIN_QUERY_MAX_QUEUED ||
    n > MAX_QUERY_MAX_QUEUED
  ) {
    writeStderrLine(
      `qwen serve: rejected ?maxQueued ${safeLogValue(raw)} ` +
        `(outside [${MIN_QUERY_MAX_QUEUED}, ${MAX_QUERY_MAX_QUEUED}])`,
    );
    res.status(400).json({
      error: `\`maxQueued\` must be in [${MIN_QUERY_MAX_QUEUED}, ${MAX_QUERY_MAX_QUEUED}]`,
      code: 'invalid_max_queued',
    });
    return null;
  }
  return n;
}

/**
 * Wrap an attacker-controllable string for safe interpolation into a
 * stderr log line. `JSON.stringify` escapes control characters
 * (`\n`, `\r`, etc.) and wraps the result in quotes — any injection
 * attempt surfaces as visible-as-quoted-noise rather than a
 * forged log line. Truncated AFTER stringify to keep the budget
 * predictable even for control-heavy inputs.
 */
function safeLogValue(raw: unknown): string {
  return JSON.stringify(String(raw)).slice(0, 82);
}

function parseLastEventId(raw: unknown): number | undefined {
  // Stricter than Number.parseInt: only accept pure decimal digits to avoid
  // values like "1abc" or "1.5e10z" silently parsing to 1.
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    // BX9_I: log a breadcrumb for the operator when a non-empty
    // header is rejected. The client resumed from event 0 instead
    // of where they meant to — without this line, the loss of
    // every event buffered during their disconnect was invisible.
    // Skip the log for missing / empty headers (the common case of
    // "first connect, no resume").
    if (typeof raw === 'string' && raw.length > 0) {
      writeStderrLine(
        `qwen serve: rejected Last-Event-ID ${safeLogValue(raw)} ` +
          `(not a decimal integer)`,
      );
    }
    return undefined;
  }
  const n = Number.parseInt(raw, 10);
  // Reject values that lose precision as a JS `number`. The bus's monotonic
  // ids are bounded by `Number.MAX_SAFE_INTEGER` (2^53 - 1); a client that
  // tries to resume from beyond that is either malicious or broken.
  if (!Number.isFinite(n) || n > Number.MAX_SAFE_INTEGER) {
    writeStderrLine(
      `qwen serve: rejected Last-Event-ID ${safeLogValue(raw)} ` +
        `(exceeds Number.MAX_SAFE_INTEGER)`,
    );
    return undefined;
  }
  return n;
}

function sendPermissionVoteErrorImpl(
  res: import('express').Response,
  err: unknown,
  ctx: { route: string; sessionId?: string },
  daemonLog?: DaemonLogger,
): void {
  // BkwQI: voter's `optionId` wasn't in the option set the agent
  // originally offered (e.g. forging `ProceedAlways*` when the
  // prompt's `hideAlwaysAllow` policy suppressed it). 400, not
  // 404 — the requestId IS known, but the chosen option isn't.
  if (err instanceof InvalidPermissionOptionError) {
    res.status(400).json({
      error: err.message,
      code: 'invalid_option_id',
      requestId: err.requestId,
      optionId: err.optionId,
    });
    return;
  }
  // Designated voter mismatch / `local-only` remote
  // rejection. 403 because the request is well-formed and the voter
  // was authenticated; the policy refuses their vote.
  if (err instanceof PermissionForbiddenError) {
    res.status(403).json({
      error: err.message,
      code: 'permission_forbidden',
      requestId: err.requestId,
      sessionId: err.sessionId,
      reason: err.reason,
    });
    return;
  }
  // Operator configured a permission policy whose
  // implementation has not landed in this build yet. 501 (not 500)
  // so the SDK can render "your daemon is older than your settings
  // expect; upgrade" rather than a generic Internal Server Error.
  if (err instanceof PermissionPolicyNotImplementedError) {
    res.status(501).json({
      error: err.message,
      code: 'permission_policy_not_implemented',
      policy: err.policy,
    });
    return;
  }
  // Agent declared an `allowedOptionIds` set that
  // includes the cancel-vote sentinel. This is a contract violation
  // between agent and daemon (not a client mistake), so 500 is the
  // right shape; structured `code` lets the SDK distinguish from
  // unrelated 500s.
  if (err instanceof CancelSentinelCollisionError) {
    res.status(500).json({
      error: err.message,
      code: 'cancel_sentinel_collision',
      requestId: err.requestId,
      sentinel: err.sentinel,
    });
    return;
  }
  sendBridgeErrorImpl(res, err, ctx, daemonLog);
}

function formatSseFrame(event: BridgeEvent | OmitId<BridgeEvent>): string {
  // SSE format: id (optional), event (optional), data, blank line.
  // The `id:` line is intentionally omitted when `event.id` is absent —
  // terminal/synthetic frames (e.g. daemon-side `stream_error`) must not
  // burn a slot in the per-session monotonic sequence the client uses for
  // `Last-Event-ID` reconnect tracking.
  //
  // We always emit the payload as a single `data:` line. The EventSource
  // spec also allows a frame to span multiple `data:` lines (which a
  // conformant parser joins with `\n`); we don't emit that form because
  // our payload is JSON without embedded newlines after `JSON.stringify`.
  // The SDK parser at `sdk-typescript/src/daemon/sse.ts` handles the
  // multi-line variant on the receive side — input/output asymmetry is
  // intentional.
  //
  // `_meta.serverTimestamp`: EventBus stamps normal session frames when they
  // are published so SSE and load/replay share the same event time. Keep this
  // fallback for synthetic frames that do not pass through EventBus.
  const existingMeta = (event as { _meta?: Record<string, unknown> })._meta;
  const existingServerTimestamp = existingMeta?.['serverTimestamp'];
  const serverTimestamp =
    typeof existingServerTimestamp === 'number' &&
    Number.isFinite(existingServerTimestamp)
      ? existingServerTimestamp
      : Date.now();
  const stamped = {
    ...event,
    _meta: { ...(existingMeta ?? {}), serverTimestamp },
  };
  const dataJson = JSON.stringify(stamped);
  const idLine =
    'id' in event && event.id !== undefined ? `id: ${event.id}\n` : '';
  return `${idLine}event: ${event.type}\ndata: ${dataJson}\n\n`;
}

type OmitId<T> = Omit<T, 'id'>;

type BridgeErrorContext = {
  route?: string;
  sessionId?: string;
  [key: string]: string | number | boolean | undefined;
};

function bridgeErrorExtraContext(
  ctx: BridgeErrorContext | undefined,
): Record<string, string | number | boolean> {
  const extra: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(ctx ?? {})) {
    if (key === 'route' || key === 'sessionId' || value === undefined) {
      continue;
    }
    extra[key] = value;
  }
  return extra;
}

/**
 * Map a thrown bridge error to an HTTP response.
 *
 * `ctx` is operator-facing: route + sessionId folded into the stderr
 * log line so a bare `ECONNRESET` / `ENOMEM` stack trace is
 * attributable to a specific session and request without having to
 * timestamp-correlate against client logs. Pass via the route handlers
 * — see how they call `sendBridgeError(res, err, { route: 'POST
 * /session/:id/prompt', sessionId })`. Optional so test/dev call
 * sites that don't care about the log can omit it.
 */
function sendBridgeErrorImpl(
  res: import('express').Response,
  err: unknown,
  ctx?: BridgeErrorContext,
  daemonLog?: DaemonLogger,
): void {
  if (err instanceof WorkspaceInitConflictError) {
    // The target file already exists with non-
    // whitespace content and the caller did not pass `force: true`.
    // Body carries the resolved path + size so SDK clients can render
    // a "file already exists; pass force: true to overwrite" prompt
    // without re-stat'ing the workspace.
    res.status(409).json({
      error: err.message,
      code: 'workspace_init_conflict',
      path: err.path,
      existingSize: err.existingSize,
    });
    return;
  }
  if (err instanceof WorkspaceInitPathEscapeError) {
    // The configured `context.fileName` resolves outside the bound
    // workspace. 400 because this is a fixable misconfiguration.
    res.status(400).json({
      error: err.message,
      code: 'workspace_init_path_escape',
      filename: err.filename,
      boundWorkspace: err.boundWorkspace,
    });
    return;
  }
  if (err instanceof WorkspaceInitSymlinkError) {
    // Either the target file is a symlink, or a parent directory is
    // a symlink that escapes the workspace.
    res.status(400).json({
      error: err.message,
      code: 'workspace_init_symlink',
      target: err.target,
      kind: err.kind,
    });
    return;
  }
  if (err instanceof WorkspaceInitRaceError) {
    // Race-condition: EEXIST after absence check or ENOENT after
    // content check (concurrent writer). Distinct
    // `code: 'workspace_init_race'` for dashboard classification.
    res.status(400).json({
      error: err.message,
      code: 'workspace_init_race',
      target: err.target,
      kind: err.kind,
    });
    return;
  }
  if (err instanceof McpServerNotFoundError) {
    // Stable 404 for "MCP server name not in config".
    res.status(404).json({
      error: err.message,
      code: 'mcp_server_not_found',
      serverName: err.serverName,
    });
    return;
  }
  if (err instanceof McpServerRestartFailedError) {
    // 502 because the MCP server failed to come back online.
    res.status(502).json({
      error: err.message,
      code: 'mcp_server_restart_failed',
      errorKind: 'protocol_error',
      serverName: err.serverName,
      mcpStatus: err.mcpStatus,
    });
    return;
  }
  if (err instanceof BranchWhilePromptActiveError) {
    res.status(409).json({
      error: err.message,
      code: 'branch_while_prompt_active',
      sessionId: err.sessionId,
    });
    return;
  }
  if (err instanceof TrustGateError) {
    // Trust-folder rejection. 403 because the workspace's trust posture
    // forbids the privileged mode.
    res.status(403).json({
      error: err.message,
      code: 'trust_gate',
      errorKind: 'auth_env_error',
    });
    return;
  }
  if (err instanceof SessionNotFoundError) {
    res.status(404).json({ error: err.message, sessionId: err.sessionId });
    return;
  }
  if (err instanceof InvalidClientIdError) {
    res.status(400).json({
      error: err.message,
      code: 'invalid_client_id',
      sessionId: err.sessionId,
      clientId: err.clientId,
    });
    return;
  }
  if (err instanceof SessionShellDisabledError) {
    res.status(403).json({
      error: err.message,
      code: 'session_shell_disabled',
      errorKind: 'session_shell_disabled',
    });
    return;
  }
  if (err instanceof SessionShellClientRequiredError) {
    res.status(403).json({
      error: err.message,
      code: 'client_id_required',
      errorKind: 'client_id_required',
    });
    return;
  }
  if (err instanceof WorkspaceMismatchError) {
    // Single-workspace mode: the daemon binds to one workspace at
    // boot; cross-workspace POSTs are rejected here.
    // 400 (not 404 — the daemon is "fine", the client just picked
    // the wrong daemon for their workspace). Body includes both
    // paths so orchestrator-aware clients can route to the right
    // daemon / spawn a new one.
    //
    // Operator log line: unlike SessionNotFoundError (per-session
    // 404 with rich URL context), workspace_mismatch indicates an
    // orchestration / deployment drift (operator booted with the
    // wrong workspace, or client is routing to the wrong daemon).
    // Without a breadcrumb the daemon's log looks healthy while
    // every client request silently 400s. Limited to authenticated
    // requests by the upstream bearer-token gate, so probing-DoS
    // log noise stays bounded.
    // SECURITY: `err.requested` is derived from the request body
    // (`req.workspaceCwd` → `canonicalizeWorkspace` → here). `path.resolve`
    // + `realpathSync.native` both preserve control characters inside
    // path segments — they only normalize separators / `..` / `.` and
    // walk symlinks. A body like `{"cwd": "/legit/path\nqwen serve:
    // FAKE LOG LINE"}` would otherwise emit two valid-looking daemon
    // log lines, weaponizing line-based log shippers (Splunk / Loki /
    // journald → SIEM). `JSON.stringify` escapes control chars and
    // wraps in quotes so any injection attempt surfaces as
    // visible-as-quoted-noise rather than forged-line. `err.bound` is
    // safe (canonicalized at boot from operator-controlled
    // `--workspace` / `process.cwd()`) but quoted symmetrically for
    // readability.
    writeStderrLine(
      `qwen serve: workspace_mismatch (POST /session): ` +
        `daemon bound to ${JSON.stringify(err.bound)}, ` +
        `rejected ${JSON.stringify(err.requested)}`,
    );
    res.status(400).json({
      error: err.message,
      code: 'workspace_mismatch',
      boundWorkspace: err.bound,
      requestedWorkspace: err.requested,
    });
    return;
  }
  if (err instanceof InvalidSessionScopeError) {
    // Same wire shape as the route-layer 400 (`server.ts` validates
    // body['sessionScope'] before calling the bridge). A direct embed
    // / test caller bypassing the route would otherwise see a generic
    // 500 — the typed translation keeps both layers in agreement so
    // SDK clients can branch on `code` regardless of which layer
    // surfaced the rejection.
    res.status(400).json({
      error: err.message,
      code: 'invalid_session_scope',
    });
    return;
  }
  if (err instanceof InvalidSessionMetadataError) {
    res.status(400).json({
      error: err.message,
      code: 'invalid_metadata',
      field: err.field,
    });
    return;
  }
  if (err instanceof SessionLimitExceededError) {
    // 503 Service Unavailable + `Retry-After` is the canonical
    // "we'd serve you, but we're full right now" shape. The hint
    // is intentionally conservative (5s) because a session that
    // finishes a prompt frees a slot quickly under normal load;
    // a client that backs off too aggressively wastes capacity.
    res.set('Retry-After', '5');
    res.status(503).json({
      error: err.message,
      code: 'session_limit_exceeded',
      limit: err.limit,
    });
    return;
  }
  if (err instanceof PromptQueueFullError) {
    res.set('Retry-After', '5');
    res.status(503).json({
      error: err.message,
      code: 'prompt_queue_full',
      sessionId: err.sessionId,
      limit: err.limit,
      pendingCount: err.pendingCount,
    });
    return;
  }
  if (err instanceof RestoreInProgressError) {
    // Match `SessionLimitExceededError`'s 5s hint (above) — the
    // underlying restore can take up to `initTimeoutMs` (default
    // 10s) on the agent side, so a 1s retry hint pushed clients
    // into tight loops that kept hitting the same 409.
    res.set('Retry-After', '5');
    res.status(409).json({
      error: err.message,
      code: 'restore_in_progress',
      sessionId: err.sessionId,
      activeAction: err.activeAction,
      requestedAction: err.requestedAction,
    });
    return;
  }
  if (err instanceof SessionBusyError) {
    res.set('Retry-After', '5');
    res.status(409).json({
      error: err.message,
      code: 'session_busy',
      sessionId: err.sessionId,
    });
    return;
  }
  if (err instanceof InvalidRewindTargetError) {
    res.status(400).json({
      error: err.message,
      code: 'invalid_rewind_target',
      sessionId: err.sessionId,
    });
    return;
  }
  // Errors from the ACP child with `data.errorKind` carry structured
  // error semantics. Map known kinds to stable HTTP status codes.
  if (err && typeof err === 'object') {
    const data = (err as { data?: unknown }).data;
    if (data && typeof data === 'object') {
      const kind = (data as { errorKind?: unknown }).errorKind;
      if (kind === 'mcp_budget_would_exceed') {
        const d = data as { serverName?: string };
        res.status(409).json({
          error: errorMessage(err),
          code: 'mcp_budget_would_exceed',
          serverName: d.serverName,
        });
        return;
      }
      if (kind === 'mcp_server_spawn_failed') {
        const d = data as {
          errorKind: string;
          serverName?: string;
          exitCode?: number | null;
          stderr?: string;
          timeout?: boolean;
        };
        res.status(502).json({
          error: errorMessage(err),
          code: 'mcp_server_spawn_failed',
          serverName: d.serverName,
          exitCode: d.exitCode,
          stderr: d.stderr,
          ...(d.timeout !== undefined ? { timeout: d.timeout } : {}),
        });
        return;
      }
      if (kind === 'invalid_config') {
        const d = data as { serverName?: string; reason?: string };
        res.status(400).json({
          error: errorMessage(err),
          code: 'invalid_config',
          serverName: d.serverName,
          reason: d.reason,
        });
        return;
      }
      if (kind === 'acp_channel_unavailable') {
        res.status(503).json({
          error: errorMessage(err),
          code: 'acp_channel_unavailable',
        });
        return;
      }
    }
  }
  // 5xx is the kind of error operators need to see in their daemon log
  // — bridge ENOMEM, agent stack trace, unexpected throw, etc. Without
  // logging here every 500 disappears once the caller consumes the
  // response body. When `daemonLog` is provided, route through the
  // structured daemon logger (which tees to stderr + log file). When
  // absent (tests, direct embeds), fall back to the legacy stderr-only
  // `writeStderrLine` path.
  recordDaemonBridgeError(err);
  const extraContext = bridgeErrorExtraContext(ctx);
  recordDaemonError(undefined, err, {
    ...(ctx?.route ? { 'http.route': ctx.route } : {}),
    ...(ctx?.sessionId ? { 'session.id': ctx.sessionId } : {}),
  });
  emitDaemonLog('Daemon bridge error.', {
    ...(ctx?.route ? { 'http.route': ctx.route } : {}),
    ...(ctx?.sessionId ? { 'session.id': ctx.sessionId } : {}),
    ...extraContext,
    'error.type': err instanceof Error ? err.name : typeof err,
    'error.message': (err instanceof Error ? err.message : String(err)).slice(
      0,
      1024,
    ),
  });
  if (daemonLog) {
    daemonLog.error(
      err instanceof Error ? err.message : String(err),
      err instanceof Error ? err : undefined,
      {
        ...(ctx?.route ? { route: ctx.route } : {}),
        ...(ctx?.sessionId ? { sessionId: ctx.sessionId } : {}),
        ...extraContext,
      },
    );
  } else {
    const ctxParts = [
      ctx?.route,
      ctx?.sessionId ? `session=${ctx.sessionId}` : undefined,
      ...Object.entries(extraContext).map(([key, value]) => `${key}=${value}`),
    ].filter(Boolean);
    const ctxStr = ctxParts.length > 0 ? ` (${ctxParts.join(' ')})` : '';
    writeStderrLine(
      `qwen serve: bridge error${ctxStr}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
  }
  res.status(500).json(errorPayload(err));
}

/**
 * Coerce an arbitrary thrown value to a useful string. Plain `String(err)`
 * yields `[object Object]` for JSON-RPC-shaped errors (`{code, message,
 * data}`) which are exactly what the ACP SDK forwards from the agent. Try
 * the `message` field first, fall back to JSON-stringify, then `String`.
 */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const maybe = (err as { message?: unknown }).message;
    if (typeof maybe === 'string' && maybe.length > 0) return maybe;
    try {
      return JSON.stringify(err);
    } catch {
      /* fall through */
    }
  }
  return String(err);
}

/**
 * Build the JSON body for a 5xx response. The ACP SDK forwards
 * JSON-RPC-shaped errors like `{code: -32000, message: "Internal error",
 * data: {reason: "model quota exceeded"}}` — discarding `code`/`data`
 * collapses every distinct failure (quota / rate-limit / auth /
 * crash) to the same opaque `"Internal error"` string at the client.
 * Forward both fields so callers can triage from response body alone.
 * `error` stays as the human-readable string for backward compatibility
 * with clients that only consumed `error` in the original shape.
 *
 * BSA0G acknowledged: forwarding `data` verbatim leaks per-error
 * detail (file paths in upstream tool failures, partial API response
 * snippets, etc.) to every authenticated SSE subscriber that
 * observes 5xx responses. In Stage 1's single-user / small-team
 * trust model (every authenticated client is the same human or
 * collaborators they trust) this is acceptable — and the triage
 * value of the rich error is high. Stage 2 multi-tenant deployments
 * will need an opt-in `--redact-errors` flag (or per-deployment
 * policy hook) that strips `data` and replaces it with an
 * error-class identifier.
 */
function errorPayload(err: unknown): {
  error: string;
  code?: unknown;
  data?: unknown;
} {
  const out: { error: string; code?: unknown; data?: unknown } = {
    error: errorMessage(err),
  };
  if (err && typeof err === 'object') {
    const obj = err as Record<string, unknown>;
    if ('code' in obj) out.code = obj['code'];
    if ('data' in obj) out.data = obj['data'];
  }
  return out;
}
