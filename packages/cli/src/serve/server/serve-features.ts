/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { loadSettings } from '../../config/settings.js';
import { SUPPORTED_LANGUAGES } from '../../i18n/index.js';
import { hasConfiguredBatchVoiceTranscriptionModel } from '../../services/voice-service.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import { resolveAcpHttpEnabled } from '../acp-http-enabled.js';
import { getAdvertisedServeFeatures } from '../capabilities.js';
import { isBrowserAutomationMcpAvailable } from '../cdp-mcp-command.js';
import type { ServeOptions } from '../types.js';

// Keep in sync with acp-bridge bridge.ts and SDK DaemonClient.ts.
const DEFAULT_MAX_SESSIONS = 20;
const DEFAULT_MAX_PENDING_PROMPTS_PER_SESSION = 5;

export const SERVE_LANGUAGE_CODES = [
  ...SUPPORTED_LANGUAGES.map((language) => language.code),
  'auto',
];

export function advertisedMaxPendingPromptsPerSession(
  value: number | undefined,
): number | null {
  if (value === undefined) return DEFAULT_MAX_PENDING_PROMPTS_PER_SESSION;
  if (value === 0 || value === Number.POSITIVE_INFINITY) return null;
  return value;
}

export function advertisedMaxSessions(
  value: number | undefined,
): number | null {
  if (value === undefined) return DEFAULT_MAX_SESSIONS;
  if (value === 0 || value === Number.POSITIVE_INFINITY) return null;
  return value;
}

interface CreateServeFeaturesDeps {
  opts: ServeOptions;
  boundWorkspace: string;
  persistSettingAvailable: boolean;
  sessionArtifactsPersistenceAvailable: boolean;
  reloadAvailable: boolean;
  channelReloadAvailable: boolean;
  sessionShellCommandEnabled: boolean;
  multiWorkspaceSessionsEnabled: boolean;
  env?: Readonly<Record<string, string | undefined>>;
}

export interface ServeFeaturesRuntime {
  languageCodes: string[];
  currentServeFeatures: () => ReturnType<typeof getAdvertisedServeFeatures>;
  invalidateServeFeaturesCache: () => void;
}

export function createServeFeatures(
  deps: CreateServeFeaturesDeps,
): ServeFeaturesRuntime {
  const {
    opts,
    boundWorkspace,
    persistSettingAvailable,
    sessionArtifactsPersistenceAvailable,
    reloadAvailable,
    channelReloadAvailable,
    sessionShellCommandEnabled,
    multiWorkspaceSessionsEnabled,
  } = deps;
  const env = deps.env ?? process.env;
  let cachedVoiceTranscriptionAvailable: boolean | undefined;
  const invalidateServeFeaturesCache = () => {
    cachedVoiceTranscriptionAvailable = undefined;
  };
  const getCachedVoiceTranscriptionAvailable = () => {
    cachedVoiceTranscriptionAvailable ??=
      isWorkspaceVoiceTranscriptionAvailable(boundWorkspace);
    return cachedVoiceTranscriptionAvailable;
  };

  return {
    languageCodes: SERVE_LANGUAGE_CODES,
    invalidateServeFeaturesCache,
    currentServeFeatures: () =>
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
        persistSettingAvailable,
        sessionShellCommandEnabled,
        sessionArtifactsPersistenceAvailable,
        rateLimit: opts.rateLimit === true,
        reloadAvailable,
        channelReloadAvailable,
        multiWorkspaceSessionsEnabled,
        acpHttpEnabled: resolveAcpHttpEnabled(),
        clientMcpOverWsEnabled: opts.clientMcpOverWs === true,
        cdpTunnelOverWsEnabled: opts.cdpTunnelOverWs === true,
        browserAutomationMcpAvailable: isBrowserAutomationMcpAvailable(
          opts,
          env,
        ),
        voiceTranscriptionAvailable: getCachedVoiceTranscriptionAvailable(),
        // Advertised whenever the `/voice/stream` WS endpoint exists (ACP HTTP
        // on). A configured token no longer suppresses it — the browser carries
        // the bearer token via the WS subprotocol, which the upgrade listener
        // verifies (acp-http/index.ts).
        voiceWsAvailable: resolveAcpHttpEnabled(env),
      }),
  };
}

function isWorkspaceVoiceTranscriptionAvailable(
  boundWorkspace: string,
): boolean {
  try {
    return hasConfiguredBatchVoiceTranscriptionModel(
      loadSettings(boundWorkspace),
    );
  } catch (err) {
    writeStderrLine(
      `qwen serve: workspace voice transcription capability check failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}
