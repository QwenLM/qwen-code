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
import { getPersistScopeForModelSelection } from '../../config/modelProvidersScope.js';
import {
  loadSettings,
  SettingScope,
  type LoadedSettings,
} from '../../config/settings.js';
import {
  buildWorkspaceVoiceStatus,
  transcribeWorkspaceVoiceAudio,
  validateWorkspaceVoiceState,
  WorkspaceVoiceError,
  type WorkspaceVoiceTranscriptionInput,
  type WorkspaceVoiceTranscriptionResult,
} from '../../services/voice-service.js';
import {
  getVoiceSettingsScope,
  isVoiceMode,
  readVoiceModel,
  type VoiceMode,
} from '../../services/voice-settings.js';
import { MAX_VOICE_LANGUAGE_LENGTH } from '../validation-limits.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';

const MAX_TRANSCRIPTION_ERROR_LENGTH = 200;

type WorkspaceVoiceTranscriber = (
  input: WorkspaceVoiceTranscriptionInput,
) => Promise<WorkspaceVoiceTranscriptionResult>;

type PersistSetting = (
  workspace: string,
  scope: SettingScope,
  key: string,
  value: unknown,
) => Promise<void>;

type PersistSettings = (
  workspace: string,
  writes: Array<{ scope: SettingScope; key: string; value: unknown }>,
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
  transcribe?: WorkspaceVoiceTranscriber;
}

interface ParsedVoiceUpdate {
  enabled?: boolean;
  mode?: VoiceMode;
  language?: string;
  voiceModel?: string;
}

function scopeToWire(scope: SettingScope): 'user' | 'workspace' {
  return scope === SettingScope.Workspace ? 'workspace' : 'user';
}

function sendVoiceError(res: Response, err: unknown): boolean {
  if (err instanceof WorkspaceVoiceError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return true;
  }
  return false;
}

function sanitizeTranscriptionErrorMessage(raw: string): string {
  const redacted = raw
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9._-]{4,}\b/g, '[REDACTED]');
  return redacted.length > MAX_TRANSCRIPTION_ERROR_LENGTH
    ? `${redacted.slice(0, MAX_TRANSCRIPTION_ERROR_LENGTH)}...`
    : redacted;
}

function parseVoiceUpdate(
  body: Record<string, unknown>,
): ParsedVoiceUpdate | { error: string; code: string } {
  const parsed: ParsedVoiceUpdate = {};
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
    parsed.voiceModel = voiceModel;
  }
  return parsed;
}

async function persistVoiceUpdate(
  deps: WorkspaceVoiceRouteDeps,
  settings: LoadedSettings,
  update: ParsedVoiceUpdate,
  clientId: string | undefined,
): Promise<void> {
  const voiceSettingsScope = getVoiceSettingsScope(settings);
  if (!deps.persistSettings && !deps.persistSetting) {
    throw new Error('workspace voice settings persistence is not available');
  }
  const writes: Array<{ scope: SettingScope; key: string; value: unknown }> =
    [];
  if (update.voiceModel !== undefined) {
    writes.push({
      scope: getPersistScopeForModelSelection(settings),
      key: 'voiceModel',
      value: update.voiceModel,
    });
  }
  if (update.mode !== undefined) {
    writes.push({
      scope: voiceSettingsScope,
      key: 'general.voice.mode',
      value: update.mode,
    });
  }
  if (update.language !== undefined) {
    writes.push({
      scope: voiceSettingsScope,
      key: 'general.voice.language',
      value: update.language,
    });
  }
  if (update.enabled !== undefined) {
    writes.push({
      scope: voiceSettingsScope,
      key: 'general.voice.enabled',
      value: update.enabled,
    });
  }

  if (deps.persistSettings) {
    await deps.persistSettings(deps.boundWorkspace, writes);
  } else {
    for (const write of writes) {
      await deps.persistSetting!(
        deps.boundWorkspace,
        write.scope,
        write.key,
        write.value,
      );
    }
  }

  for (const write of writes) {
    try {
      deps.broadcastSettingsChanged(
        write.key,
        write.value,
        scopeToWire(write.scope),
        clientId,
      );
    } catch (err) {
      writeStderrLine(
        `qwen serve: POST /workspace/voice broadcast error (key=${write.key}, scope=${scopeToWire(write.scope)}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

function normalizeContentType(req: Request): string | undefined {
  return req.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
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

export function registerWorkspaceVoiceRoutes(
  app: Application,
  deps: WorkspaceVoiceRouteDeps,
): void {
  const transcribe = deps.transcribe ?? transcribeWorkspaceVoiceAudio;

  app.get('/workspace/voice', (_req: Request, res: Response) => {
    try {
      res
        .status(200)
        .json(
          buildWorkspaceVoiceStatus(
            deps.boundWorkspace,
            loadSettings(deps.boundWorkspace),
          ),
        );
    } catch (err) {
      writeStderrLine(
        `qwen serve: GET /workspace/voice error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      res.status(500).json({
        error: 'Failed to load voice settings',
        code: 'internal_error',
      });
    }
  });

  app.post(
    '/workspace/voice',
    deps.mutate({ strict: true }),
    async (req: Request, res: Response) => {
      if (!deps.persistSettings && !deps.persistSetting) {
        res.status(501).json({
          error: 'Workspace voice settings persistence is not available',
          code: 'not_implemented',
        });
        return;
      }

      const parsed = parseVoiceUpdate(deps.safeBody(req));
      if ('error' in parsed) {
        res.status(400).json(parsed);
        return;
      }

      const settings = loadSettings(deps.boundWorkspace);
      try {
        validateWorkspaceVoiceState(settings, parsed);
      } catch (err) {
        if (sendVoiceError(res, err)) return;
        throw err;
      }

      const clientId = deps.parseAndValidateClientId(req, res);
      if (clientId === null) return;

      try {
        await persistVoiceUpdate(deps, settings, parsed, clientId);
      } catch (err) {
        writeStderrLine(
          `qwen serve: POST /workspace/voice persist error (workspace=${deps.boundWorkspace}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        res.status(500).json({
          error: 'Failed to persist voice settings',
          code: 'persist_error',
        });
        return;
      }

      res
        .status(200)
        .json(
          buildWorkspaceVoiceStatus(
            deps.boundWorkspace,
            loadSettings(deps.boundWorkspace),
          ),
        );
    },
  );

  app.post(
    '/workspace/voice/transcribe',
    deps.mutate(),
    express.raw({
      type: (req) =>
        isSupportedAudioContentType(
          req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase(),
        ),
      limit: '10mb',
    }),
    async (req: Request, res: Response) => {
      const contentType = normalizeContentType(req);
      if (!isSupportedAudioContentType(contentType)) {
        res.status(415).json({
          error:
            'Content-Type must be audio/* or application/octet-stream for voice transcription',
          code: 'unsupported_voice_content_type',
        });
        return;
      }
      const audioContentType = contentType;

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

      const settings = loadSettings(deps.boundWorkspace);
      const queryVoiceModel = req.query['voiceModel'];
      if (
        queryVoiceModel !== undefined &&
        typeof queryVoiceModel !== 'string'
      ) {
        res.status(400).json({
          error: '`voiceModel` query parameter must be a string',
          code: 'invalid_voice_model',
        });
        return;
      }
      const requestedVoiceModel =
        typeof queryVoiceModel === 'string' ? queryVoiceModel.trim() : '';
      const voiceModel = requestedVoiceModel || readVoiceModel(settings);
      if (!voiceModel) {
        res.status(400).json({
          error: 'A valid voiceModel is required before transcription.',
          code: 'voice_model_required',
        });
        return;
      }

      try {
        const result = await transcribe({
          data,
          mimeType: audioContentType,
          voiceModel,
          settings,
          workspaceCwd: deps.boundWorkspace,
        });
        res.status(200).json({ v: 1, ...result });
      } catch (err) {
        if (sendVoiceError(res, err)) return;
        const message =
          err instanceof Error
            ? sanitizeTranscriptionErrorMessage(err.message)
            : sanitizeTranscriptionErrorMessage(String(err));
        writeStderrLine(
          `qwen serve: POST /workspace/voice/transcribe error (workspace=${deps.boundWorkspace}): ${
            message
          }`,
        );
        res.status(502).json({
          error: err instanceof Error ? message : 'Voice transcription failed',
          code: 'voice_transcription_failed',
        });
      }
    },
  );
}
