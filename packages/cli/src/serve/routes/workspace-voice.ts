/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express, {
  type Application,
  type Request,
  type Response,
} from 'express';
import type { CredentialStore } from '@qwen-code/qwen-code-core';
import {
  loadSettings,
  SettingScope,
  type LoadedSettings,
} from '../../config/settings.js';
import { getWorkspaceTrustStatus } from '../../config/trustedFolders.js';
import {
  buildWorkspaceVoiceSettingsWrites,
  buildWorkspaceVoiceStatus,
  EMPTY_WORKSPACE_VOICE_UPDATE_ERROR,
  transcribeWorkspaceVoiceAudio,
  validateWorkspaceVoiceState,
  voiceSettingsScopeToWire,
  WorkspaceVoiceError,
  type WorkspaceVoiceStateUpdate,
  type WorkspaceVoiceSettingsWrite,
  type WorkspaceVoiceTranscriptionInput,
  type WorkspaceVoiceTranscriptionResult,
} from '../../services/voice-service.js';
import { sanitizeVoiceErrorMessage } from '../../services/voice-transcriber.js';
import {
  isVoiceEnabled,
  isVoiceMode,
  readVoiceModel,
} from '../../services/voice-settings.js';
import {
  MAX_VOICE_LANGUAGE_LENGTH,
  MAX_VOICE_MODEL_LENGTH,
} from '../validation-limits.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import {
  WorkspaceSettingsPartialPersistError,
  type WorkspaceSettingsWrite,
} from '../workspace-service/types.js';
import type {
  VoiceAdmissionLease,
  VoiceAdmissionResult,
} from '../voice/workspace-voice-coordinator.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import {
  requireTrustedWorkspaceRuntime,
  resolveManagedWorkspaceRuntimeFromParam,
  resolveWorkspaceRuntimeFromParam,
} from '../workspace-route-runtime.js';

type WorkspaceVoiceTranscriber = (
  input: WorkspaceVoiceTranscriptionInput,
) => Promise<WorkspaceVoiceTranscriptionResult>;

type PersistSetting = (
  workspace: string,
  scope: SettingScope,
  key: string,
  value: unknown,
) => Promise<void | LoadedSettings>;

type PersistSettings = (
  workspace: string,
  writes: WorkspaceSettingsWrite[],
) => Promise<void>;

export interface WorkspaceVoiceRouteDeps {
  boundWorkspace: string;
  mutate: (opts?: { strict?: boolean }) => import('express').RequestHandler;
  safeBody: (req: Request) => Record<string, unknown>;
  persistSetting?: PersistSetting;
  persistSettings?: PersistSettings;
  broadcastSettingsChanged: (
    key: string,
    value: unknown,
    scope: string,
    clientId: string | undefined,
  ) => void;
  parseAndValidateClientId: (
    req: Request,
    res: Response,
  ) => string | undefined | null;
  scopeOverride?: SettingScope;
  acquireVoiceLease?: () => VoiceAdmissionResult;
  transcribe?: WorkspaceVoiceTranscriber;
  credentialStore?: CredentialStore;
  /**
   * Env for voice credential resolution. The daemon passes a store-merged env
   * so QWEN_CUSTOM_API_KEY_* (scrubbed from process.env) reach the transcriber.
   */
  env?: Readonly<Record<string, string | undefined>>;
}

export interface WorkspaceQualifiedVoiceRouteDeps {
  workspaceRegistry: WorkspaceRegistry;
  mutate: WorkspaceVoiceRouteDeps['mutate'];
  safeBody: WorkspaceVoiceRouteDeps['safeBody'];
  persistSetting?: PersistSetting;
  persistSettings?: PersistSettings;
  transcribe?: WorkspaceVoiceTranscriber;
  acquireVoiceLease: (runtime: WorkspaceRuntime) => VoiceAdmissionResult;
  parseAndValidateClientId: (
    req: Request,
    res: Response,
    runtime: WorkspaceRuntime,
  ) => string | undefined | null;
  invalidateServeFeaturesCache: () => void;
  credentialStore?: CredentialStore;
}

function sendVoiceError(res: Response, err: unknown): boolean {
  if (err instanceof WorkspaceVoiceError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return true;
  }
  return false;
}

function broadcastVoiceWrite(
  deps: WorkspaceVoiceRouteDeps,
  write: WorkspaceVoiceSettingsWrite,
  clientId: string | undefined,
): void {
  try {
    deps.broadcastSettingsChanged(
      write.key,
      write.value,
      voiceSettingsScopeToWire(write.scope),
      clientId,
    );
  } catch (err) {
    writeStderrLine(
      `qwen serve: POST /workspace/voice broadcast error (key=${write.key}, scope=${voiceSettingsScopeToWire(write.scope)}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export function parseWorkspaceVoiceUpdateParams(
  body: Record<string, unknown>,
): WorkspaceVoiceStateUpdate | { error: string; code: string } {
  const parsed: WorkspaceVoiceStateUpdate = {};
  if ('enabled' in body) {
    if (typeof body['enabled'] !== 'boolean') {
      return { error: '`enabled` must be a boolean', code: 'invalid_enabled' };
    }
    parsed.enabled = body['enabled'];
  }
  if ('mode' in body) {
    if (!isVoiceMode(body['mode'])) {
      return {
        error: '`mode` must be either "hold" or "tap"',
        code: 'invalid_voice_mode',
      };
    }
    parsed.mode = body['mode'];
  }
  if ('language' in body) {
    if (typeof body['language'] !== 'string') {
      return {
        error: '`language` must be a string',
        code: 'invalid_voice_language',
      };
    }
    const language = body['language'].trim();
    if (language.length > MAX_VOICE_LANGUAGE_LENGTH) {
      return {
        error: `\`language\` exceeds the ${MAX_VOICE_LANGUAGE_LENGTH}-character limit`,
        code: 'invalid_voice_language',
      };
    }
    parsed.language = language;
  }
  if ('voiceModel' in body) {
    if (typeof body['voiceModel'] !== 'string') {
      return {
        error: '`voiceModel` must be a non-empty string',
        code: 'invalid_voice_model',
      };
    }
    const voiceModel = body['voiceModel'].trim();
    if (!voiceModel) {
      return {
        error: '`voiceModel` must be a non-empty string',
        code: 'invalid_voice_model',
      };
    }
    if (voiceModel.length > MAX_VOICE_MODEL_LENGTH) {
      return {
        error: `\`voiceModel\` exceeds the ${MAX_VOICE_MODEL_LENGTH}-character limit`,
        code: 'invalid_voice_model',
      };
    }
    parsed.voiceModel = voiceModel;
  }
  if (Object.keys(parsed).length === 0) {
    return {
      error: EMPTY_WORKSPACE_VOICE_UPDATE_ERROR,
      code: 'invalid_voice_update',
    };
  }
  return parsed;
}

async function persistVoiceUpdate(
  deps: WorkspaceVoiceRouteDeps,
  settings: LoadedSettings,
  update: WorkspaceVoiceStateUpdate,
  clientId: string | undefined,
  workspaceTrusted: boolean,
): Promise<void> {
  if (!deps.persistSettings && !deps.persistSetting) {
    throw new Error('workspace voice settings persistence is not available');
  }
  const writes = buildWorkspaceVoiceSettingsWrites(settings, update, {
    workspaceTrusted,
    ...(deps.scopeOverride ? { scopeOverride: deps.scopeOverride } : {}),
  });

  if (deps.persistSettings) {
    try {
      await deps.persistSettings(deps.boundWorkspace, writes);
    } catch (err) {
      if (err instanceof WorkspaceSettingsPartialPersistError) {
        for (const write of err.committedWrites) {
          broadcastVoiceWrite(deps, write, clientId);
        }
      }
      throw err;
    }
    for (const write of writes) {
      broadcastVoiceWrite(deps, write, clientId);
    }
  } else {
    const committed: WorkspaceVoiceSettingsWrite[] = [];
    for (const write of writes) {
      try {
        await deps.persistSetting!(
          deps.boundWorkspace,
          write.scope,
          write.key,
          write.value,
        );
      } catch (err) {
        writeStderrLine(
          `qwen serve: POST /workspace/voice partial persist error (workspace=${deps.boundWorkspace}, committed=${committed.length}/${writes.length}, failedKey=${write.key}, failedScope=${voiceSettingsScopeToWire(write.scope)}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        for (const committedWrite of committed) {
          broadcastVoiceWrite(deps, committedWrite, clientId);
        }
        throw new WorkspaceSettingsPartialPersistError(
          `Voice settings partial persist failed: committed=${committed.length}/${writes.length}`,
          committed,
          err,
        );
      }
      committed.push(write);
    }
    for (const write of committed) {
      broadcastVoiceWrite(deps, write, clientId);
    }
  }
}

function normalizeContentType(req: Request): string | undefined {
  return req.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
}

function requestAbortSignal(req: Request, res: Response): AbortSignal {
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once('aborted', abort);
  res.once('close', () => {
    if (!res.writableEnded) abort();
  });
  return controller.signal;
}

function loadVoiceSettings(deps: WorkspaceVoiceRouteDeps): LoadedSettings {
  return loadSettings(deps.boundWorkspace, {
    credentialStore: deps.credentialStore,
    ...(deps.env ? { skipLoadEnvironment: true } : {}),
  });
}

interface VoiceAdmissionState {
  lease: VoiceAdmissionLease;
  operationStarted: boolean;
  release: () => void;
}

function admissionState(req: Request): VoiceAdmissionState | undefined {
  return (req as { voiceAdmissionState?: VoiceAdmissionState })
    .voiceAdmissionState;
}

function admissionLease(req: Request): VoiceAdmissionLease | undefined {
  return admissionState(req)?.lease;
}

function installAdmissionLease(
  req: Request,
  res: Response,
  deps: WorkspaceVoiceRouteDeps,
): boolean {
  const result = deps.acquireVoiceLease?.();
  if (!result) return true;
  if (result.kind === 'rejected') {
    if (result.reason === 'draining') {
      sendWorkspaceDraining(res);
    } else {
      res.set('Retry-After', '5').status(503).json({
        error: 'Too many voice sessions in progress; try again shortly.',
        code: 'voice_capacity_exceeded',
      });
    }
    return false;
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    result.lease.release();
  };
  const state: VoiceAdmissionState = {
    lease: result.lease,
    operationStarted: false,
    release,
  };
  (req as { voiceAdmissionState?: VoiceAdmissionState }).voiceAdmissionState =
    state;
  const releaseBeforeOperation = () => {
    if (!state.operationStarted) release();
  };
  res.once('finish', releaseBeforeOperation);
  res.once('close', releaseBeforeOperation);
  return true;
}

function beginVoiceOperation(req: Request): (() => void) | undefined {
  const state = admissionState(req);
  if (!state) return;
  state.operationStarted = true;
  return state.release;
}

function combinedAbortSignal(req: Request, res: Response): AbortSignal {
  const requestSignal = requestAbortSignal(req, res);
  const leaseSignal = admissionLease(req)?.signal;
  return leaseSignal
    ? AbortSignal.any([requestSignal, leaseSignal])
    : requestSignal;
}

function sendWorkspaceDraining(res: Response): void {
  res.set('Retry-After', '5').status(503).json({
    error: 'Workspace runtime is being removed',
    code: 'workspace_draining',
  });
}

function isSupportedAudioContentType(
  contentType: string | undefined,
): contentType is string {
  return (
    typeof contentType === 'string' &&
    (contentType.startsWith('audio/') ||
      contentType === 'application/octet-stream')
  );
}

function readBinaryBody(req: Request): Uint8Array | undefined {
  const body = req.body as unknown;
  if (body instanceof Uint8Array || Buffer.isBuffer(body)) {
    return body as Uint8Array;
  }
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  return undefined;
}

function sendUnsupportedVoiceContentType(res: Response): void {
  res.status(415).json({
    error:
      'Content-Type must be audio/* or application/octet-stream for voice transcription',
    code: 'unsupported_voice_content_type',
  });
}

function handleVoiceStatus(
  res: Response,
  deps: WorkspaceVoiceRouteDeps,
  route: string,
): void {
  try {
    res
      .status(200)
      .json(
        buildWorkspaceVoiceStatus(deps.boundWorkspace, loadVoiceSettings(deps)),
      );
  } catch (err) {
    writeStderrLine(
      `qwen serve: ${route} error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    res.status(500).json({
      error: 'Failed to load voice settings',
      code: 'internal_error',
    });
  }
}

async function handleVoiceUpdate(
  req: Request,
  res: Response,
  deps: WorkspaceVoiceRouteDeps,
  route: string,
): Promise<void> {
  if (!deps.persistSettings && !deps.persistSetting) {
    res.status(501).json({
      error: 'Workspace voice settings persistence is not available',
      code: 'not_implemented',
    });
    return;
  }
  const parsed = parseWorkspaceVoiceUpdateParams(deps.safeBody(req));
  if ('error' in parsed) {
    res.status(400).json(parsed);
    return;
  }
  const settings = loadVoiceSettings(deps);
  try {
    validateWorkspaceVoiceState(settings, parsed, { env: deps.env });
  } catch (err) {
    if (sendVoiceError(res, err)) return;
    throw err;
  }
  const clientId = deps.parseAndValidateClientId(req, res);
  if (clientId === null) return;
  try {
    const workspaceTrusted =
      getWorkspaceTrustStatus(settings.merged, deps.boundWorkspace).effective
        .state === 'trusted';
    await persistVoiceUpdate(
      deps,
      settings,
      parsed,
      clientId,
      workspaceTrusted,
    );
  } catch (err) {
    writeStderrLine(
      `qwen serve: ${route} persist error (workspace=${deps.boundWorkspace}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    res.status(500).json({
      error: 'Failed to persist voice settings',
      code: 'persist_error',
    });
    return;
  }
  try {
    res
      .status(200)
      .json(
        buildWorkspaceVoiceStatus(deps.boundWorkspace, loadVoiceSettings(deps)),
      );
  } catch (err) {
    writeStderrLine(
      `qwen serve: ${route} reload error after persist (workspace=${deps.boundWorkspace}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    res.status(500).json({
      error: 'Voice settings persisted but failed to reload',
      code: 'internal_error',
    });
  }
}

async function handleVoiceTranscription(
  req: Request,
  res: Response,
  deps: WorkspaceVoiceRouteDeps,
  route: string,
): Promise<void> {
  const contentType = normalizeContentType(req);
  if (!isSupportedAudioContentType(contentType)) {
    sendUnsupportedVoiceContentType(res);
    return;
  }
  if (admissionLease(req)?.signal.aborted) {
    sendWorkspaceDraining(res);
    return;
  }
  const clientId = deps.parseAndValidateClientId(req, res);
  if (clientId === null) return;
  const data = readBinaryBody(req);
  if (!data || data.byteLength === 0) {
    res.status(400).json({
      error: 'Voice audio body must be non-empty binary data',
      code: 'invalid_voice_audio',
    });
    return;
  }
  const settings = loadVoiceSettings(deps);
  if (!isVoiceEnabled(settings)) {
    res.status(403).json({
      error: 'Voice transcription is disabled for this workspace',
      code: 'voice_disabled',
    });
    return;
  }
  const queryVoiceModel = req.query['voiceModel'];
  if (queryVoiceModel !== undefined && typeof queryVoiceModel !== 'string') {
    res.status(400).json({
      error: '`voiceModel` query parameter must be a string',
      code: 'invalid_voice_model',
    });
    return;
  }
  const requestedVoiceModel =
    typeof queryVoiceModel === 'string' ? queryVoiceModel.trim() : '';
  if (
    requestedVoiceModel &&
    requestedVoiceModel.length > MAX_VOICE_MODEL_LENGTH
  ) {
    res.status(400).json({
      error: `\`voiceModel\` exceeds the ${MAX_VOICE_MODEL_LENGTH}-character limit`,
      code: 'invalid_voice_model',
    });
    return;
  }
  const voiceModel = requestedVoiceModel || readVoiceModel(settings);
  if (!voiceModel) {
    res.status(400).json({
      error: 'A valid voiceModel is required before transcription.',
      code: 'voice_model_required',
    });
    return;
  }
  try {
    const releaseOperation = beginVoiceOperation(req);
    let result: WorkspaceVoiceTranscriptionResult;
    try {
      result = await (deps.transcribe ?? transcribeWorkspaceVoiceAudio)({
        data,
        mimeType: contentType,
        voiceModel,
        settings,
        workspaceCwd: deps.boundWorkspace,
        env: deps.env,
        abortSignal: combinedAbortSignal(req, res),
      });
    } finally {
      releaseOperation?.();
    }
    if (admissionLease(req)?.signal.aborted) {
      sendWorkspaceDraining(res);
      return;
    }
    res.status(200).json({ v: 1, ...result });
  } catch (err) {
    if (admissionLease(req)?.signal.aborted) {
      sendWorkspaceDraining(res);
      return;
    }
    if (sendVoiceError(res, err)) return;
    const message = sanitizeVoiceErrorMessage(
      err instanceof Error ? err.message : String(err),
    );
    writeStderrLine(
      `qwen serve: ${route} error (workspace=${deps.boundWorkspace}): ${message}`,
    );
    res.status(502).json({
      error: 'Voice transcription failed',
      code: 'voice_transcription_failed',
    });
  }
}

function admitVoiceTranscription(
  req: Request,
  res: Response,
  deps: WorkspaceVoiceRouteDeps,
): boolean {
  if (!isSupportedAudioContentType(normalizeContentType(req))) {
    sendUnsupportedVoiceContentType(res);
    return false;
  }
  return installAdmissionLease(req, res, deps);
}

function voiceAudioBodyParser(): import('express').RequestHandler {
  const parse = express.raw({
    type: (req) =>
      isSupportedAudioContentType(
        req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase(),
      ),
    limit: '10mb',
  });
  return (req, res, next) => {
    const signal = admissionLease(req)?.signal;
    let aborted = signal?.aborted === true;
    const onAbort = () => {
      aborted = true;
      if (!res.headersSent) sendWorkspaceDraining(res);
      const destroyRequest = () => {
        if (!req.destroyed) req.destroy();
      };
      if (res.writableFinished) destroyRequest();
      else {
        res.once('finish', destroyRequest);
        res.once('close', destroyRequest);
      }
    };
    if (aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    parse(req, res, (err) => {
      signal?.removeEventListener('abort', onAbort);
      if (aborted || signal?.aborted) {
        if (!res.headersSent) sendWorkspaceDraining(res);
        return;
      }
      next(err);
    });
  };
}

export function registerWorkspaceVoiceRoutes(
  app: Application,
  deps: WorkspaceVoiceRouteDeps,
): void {
  app.get('/workspace/voice', (_req: Request, res: Response) =>
    handleVoiceStatus(res, deps, 'GET /workspace/voice'),
  );

  app.post(
    '/workspace/voice',
    deps.mutate({ strict: true }),
    async (req: Request, res: Response) => {
      await handleVoiceUpdate(req, res, deps, 'POST /workspace/voice');
    },
  );

  app.post(
    '/workspace/voice/transcribe',
    deps.mutate({ strict: true }),
    (req: Request, res: Response, next: import('express').NextFunction) => {
      if (admitVoiceTranscription(req, res, deps)) next();
    },
    voiceAudioBodyParser(),
    async (req: Request, res: Response) => {
      await handleVoiceTranscription(
        req,
        res,
        deps,
        'POST /workspace/voice/transcribe',
      );
    },
  );
}

function createRuntimeVoiceDeps(
  runtime: WorkspaceRuntime,
  deps: WorkspaceQualifiedVoiceRouteDeps,
): WorkspaceVoiceRouteDeps {
  const env =
    runtime.env.mode === 'runtime-overlay'
      ? (runtime.env.effectiveEnv ?? {})
      : runtime.env.effectiveEnv;
  return {
    boundWorkspace: runtime.workspaceCwd,
    mutate: deps.mutate,
    safeBody: deps.safeBody,
    persistSetting: deps.persistSetting,
    persistSettings: deps.persistSettings,
    transcribe: deps.transcribe,
    ...(env ? { env: { ...env, ...deps.credentialStore?.snapshot() } } : {}),
    credentialStore: deps.credentialStore,
    scopeOverride: SettingScope.Workspace,
    acquireVoiceLease: () => deps.acquireVoiceLease(runtime),
    broadcastSettingsChanged: (key, value, scope, clientId) => {
      if (runtime.primary) deps.invalidateServeFeaturesCache();
      runtime.bridge.publishWorkspaceEvent({
        type: 'settings_changed',
        data: { key, value, scope },
        originatorClientId: clientId,
      });
    },
    parseAndValidateClientId: (req, res) =>
      deps.parseAndValidateClientId(req, res, runtime),
  };
}

type QualifiedVoiceRequest = Request & {
  voiceRouteDeps?: WorkspaceVoiceRouteDeps;
};

function resolveQualifiedVoiceTarget(
  req: Request,
  res: Response,
  deps: WorkspaceQualifiedVoiceRouteDeps,
  includeDraining = false,
): WorkspaceVoiceRouteDeps | undefined {
  const runtime = includeDraining
    ? resolveManagedWorkspaceRuntimeFromParam(deps.workspaceRegistry, req, res)
    : resolveWorkspaceRuntimeFromParam(deps.workspaceRegistry, req, res);
  if (!runtime || !requireTrustedWorkspaceRuntime(runtime, res)) return;
  return createRuntimeVoiceDeps(runtime, deps);
}

export function registerWorkspaceQualifiedVoiceRoutes(
  app: Application,
  deps: WorkspaceQualifiedVoiceRouteDeps,
): void {
  app.get('/workspaces/:workspace/voice', (req: Request, res: Response) => {
    const target = resolveQualifiedVoiceTarget(req, res, deps);
    if (!target) return;
    handleVoiceStatus(res, target, 'GET /workspaces/:workspace/voice');
  });

  app.post(
    '/workspaces/:workspace/voice',
    deps.mutate({ strict: true }),
    async (req: Request, res: Response) => {
      const target = resolveQualifiedVoiceTarget(req, res, deps);
      if (!target) return;
      await handleVoiceUpdate(
        req,
        res,
        target,
        'POST /workspaces/:workspace/voice',
      );
    },
  );

  app.post(
    '/workspaces/:workspace/voice/transcribe',
    deps.mutate({ strict: true }),
    (
      req: QualifiedVoiceRequest,
      res: Response,
      next: import('express').NextFunction,
    ) => {
      const target = resolveQualifiedVoiceTarget(req, res, deps, true);
      if (!target) return;
      req.voiceRouteDeps = target;
      if (admitVoiceTranscription(req, res, target)) next();
    },
    voiceAudioBodyParser(),
    async (req: QualifiedVoiceRequest, res: Response) => {
      const target = req.voiceRouteDeps;
      if (!target) return;
      await handleVoiceTranscription(
        req,
        res,
        target,
        'POST /workspaces/:workspace/voice/transcribe',
      );
    },
  );
}
