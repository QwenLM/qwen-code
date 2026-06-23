/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import {
  SettingScope,
  resetHomeEnvBootstrapForTesting,
} from '../../config/settings.js';
import {
  resetTrustedFoldersForTesting,
  TRUSTED_FOLDERS_FILENAME,
  TrustLevel,
} from '../../config/trustedFolders.js';
import { createServeApp } from '../server.js';
import type { ServeOptions } from '../types.js';
import { registerWorkspaceVoiceRoutes } from './workspace-voice.js';

const mockWriteStderrLine = vi.hoisted(() => vi.fn());

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStderrLine: mockWriteStderrLine,
}));

const baseOpts: ServeOptions = {
  hostname: '127.0.0.1',
  port: 4170,
  mode: 'http-bridge',
  token: 'secret',
};
const hostHeader = `127.0.0.1:${baseOpts.port}`;

const originalQwenHome = process.env['QWEN_HOME'];
const originalTrustedFoldersPath =
  process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'];

interface Harness {
  scratch: string;
  home: string;
  workspace: string;
  persistSetting: ReturnType<typeof vi.fn>;
  transcribe: ReturnType<typeof vi.fn>;
  app: ReturnType<typeof createServeApp>;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
}

async function makeHarness(
  opts: { persistSetting?: boolean; token?: string; trusted?: boolean } = {},
): Promise<Harness> {
  const scratch = await fsp.mkdtemp(
    path.join(
      os.tmpdir(),
      `qwen-workspace-voice-${randomBytes(4).toString('hex')}-`,
    ),
  );
  const home = path.join(scratch, 'home');
  const workspace = path.join(scratch, 'workspace');
  await fsp.mkdir(home, { recursive: true });
  await fsp.mkdir(workspace, { recursive: true });
  process.env['QWEN_HOME'] = home;
  process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'] = path.join(
    home,
    TRUSTED_FOLDERS_FILENAME,
  );
  if (opts.trusted !== undefined) {
    await writeJson(path.join(home, TRUSTED_FOLDERS_FILENAME), {
      [workspace]: opts.trusted
        ? TrustLevel.TRUST_FOLDER
        : TrustLevel.DO_NOT_TRUST,
    });
  }
  resetHomeEnvBootstrapForTesting();
  resetTrustedFoldersForTesting();

  const persistSetting = vi.fn(
    async (
      _workspace: string,
      _scope: SettingScope,
      _key: string,
      _value: unknown,
    ) => {},
  );
  const transcribe = vi.fn(async () => ({
    text: 'hello from audio',
    model: 'qwen3-asr-flash',
    transport: 'qwen-asr-chat',
  }));
  const serveOpts: ServeOptions = { ...baseOpts };
  if ('token' in opts) {
    serveOpts.token = opts.token;
  }
  const deps = {
    boundWorkspace: workspace,
    voiceTranscriber: transcribe,
    ...(opts.persistSetting === false ? {} : { persistSetting }),
  };
  const app = createServeApp(serveOpts, undefined, deps as never);

  return { scratch, home, workspace, persistSetting, transcribe, app };
}

async function teardown(h: Harness): Promise<void> {
  await fsp.rm(h.scratch, { recursive: true, force: true });
  if (originalQwenHome === undefined) {
    delete process.env['QWEN_HOME'];
  } else {
    process.env['QWEN_HOME'] = originalQwenHome;
  }
  if (originalTrustedFoldersPath === undefined) {
    delete process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'];
  } else {
    process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'] = originalTrustedFoldersPath;
  }
  resetHomeEnvBootstrapForTesting();
  resetTrustedFoldersForTesting();
}

async function writeVoiceModelSettings(h: Harness): Promise<void> {
  await writeJson(path.join(h.home, 'settings.json'), {
    modelProviders: {
      openai: [
        {
          id: 'qwen3-asr-flash',
          label: 'Qwen ASR',
          baseUrl: 'https://dashscope.example/compatible-mode/v1',
          envKey: 'DASHSCOPE_API_KEY',
        },
        {
          id: 'gpt-4o',
          label: 'GPT',
          baseUrl: 'https://example.invalid/v1',
          envKey: 'OPENAI_API_KEY',
        },
      ],
    },
    env: { DASHSCOPE_API_KEY: 'sk-secret' },
    voiceModel: 'qwen3-asr-flash',
    general: { voice: { enabled: true, mode: 'tap', language: 'chinese' } },
  });
}

async function writeVoiceProviderSettings(h: Harness): Promise<void> {
  await writeJson(path.join(h.home, 'settings.json'), {
    modelProviders: {
      openai: [
        {
          id: 'qwen3-asr-flash',
          label: 'Qwen ASR',
          baseUrl: 'https://dashscope.example/compatible-mode/v1',
          envKey: 'DASHSCOPE_API_KEY',
        },
      ],
    },
    env: { DASHSCOPE_API_KEY: 'sk-secret' },
    voiceModel: 'qwen3-asr-flash',
  });
}

async function writeWorkspaceVoiceEnabled(
  h: Harness,
  enabled: boolean,
): Promise<void> {
  await writeJson(path.join(h.workspace, '.qwen', 'settings.json'), {
    general: { voice: { enabled } },
  });
}

describe('workspace voice routes', () => {
  let h: Harness;

  beforeEach(async () => {
    mockWriteStderrLine.mockClear();
    h = await makeHarness();
  });

  afterEach(async () => {
    await teardown(h);
  });

  it('GET returns voice status and selectable ASR models without secrets', async () => {
    await writeVoiceModelSettings(h);

    const res = await request(h.app)
      .get('/workspace/voice')
      .set('Host', hostHeader)
      .set('Authorization', 'Bearer secret');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      v: 1,
      workspaceCwd: h.workspace,
      enabled: true,
      mode: 'tap',
      language: 'chinese',
      voiceModel: 'qwen3-asr-flash',
      availableVoiceModels: [
        { id: 'qwen3-asr-flash', transport: 'qwen-asr-chat' },
      ],
    });
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('sk-secret');
    expect(serialized).not.toContain('dashscope.example');
    expect(serialized).not.toContain('envKey');
  });

  it('POST updates voice settings only after validating the resulting state', async () => {
    await writeVoiceModelSettings(h);

    const res = await request(h.app)
      .post('/workspace/voice')
      .set('Host', hostHeader)
      .set('Authorization', 'Bearer secret')
      .send({
        enabled: true,
        mode: 'hold',
        language: 'english',
        voiceModel: 'qwen3-asr-flash',
      });

    expect(res.status).toBe(200);
    expect(h.persistSetting).toHaveBeenCalledWith(
      h.workspace,
      SettingScope.User,
      'voiceModel',
      'qwen3-asr-flash',
    );
    expect(h.persistSetting).toHaveBeenCalledWith(
      h.workspace,
      SettingScope.User,
      'general.voice.mode',
      'hold',
    );
    expect(h.persistSetting).toHaveBeenCalledWith(
      h.workspace,
      SettingScope.User,
      'general.voice.language',
      'english',
    );
    expect(h.persistSetting).toHaveBeenCalledWith(
      h.workspace,
      SettingScope.User,
      'general.voice.enabled',
      true,
    );
  });

  it('POST writes initial trusted workspace voice settings to user scope', async () => {
    await teardown(h);
    h = await makeHarness({ trusted: true });
    await writeVoiceProviderSettings(h);

    const res = await request(h.app)
      .post('/workspace/voice')
      .set('Host', hostHeader)
      .set('Authorization', 'Bearer secret')
      .send({
        enabled: true,
        mode: 'tap',
      });

    expect(res.status).toBe(200);
    expect(h.persistSetting).toHaveBeenCalledWith(
      h.workspace,
      SettingScope.User,
      'general.voice.mode',
      'tap',
    );
    expect(h.persistSetting).toHaveBeenCalledWith(
      h.workspace,
      SettingScope.User,
      'general.voice.enabled',
      true,
    );
  });

  it('POST writes trusted workspace voice settings to workspace scope after workspace opt-in', async () => {
    await teardown(h);
    h = await makeHarness({ trusted: true });
    await writeVoiceProviderSettings(h);
    await writeWorkspaceVoiceEnabled(h, false);

    const res = await request(h.app)
      .post('/workspace/voice')
      .set('Host', hostHeader)
      .set('Authorization', 'Bearer secret')
      .send({
        enabled: true,
        mode: 'tap',
      });

    expect(res.status).toBe(200);
    expect(h.persistSetting).toHaveBeenCalledWith(
      h.workspace,
      SettingScope.Workspace,
      'general.voice.mode',
      'tap',
    );
    expect(h.persistSetting).toHaveBeenCalledWith(
      h.workspace,
      SettingScope.Workspace,
      'general.voice.enabled',
      true,
    );
  });

  it('POST rejects requests without recognized voice update fields', async () => {
    await writeVoiceModelSettings(h);

    const res = await request(h.app)
      .post('/workspace/voice')
      .set('Host', hostHeader)
      .set('Authorization', 'Bearer secret')
      .send({ enabled_: true });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: 'invalid_voice_update',
      error:
        'At least one of `enabled`, `mode`, `language`, or `voiceModel` must be provided',
    });
    expect(h.persistSetting).not.toHaveBeenCalled();
  });

  it('POST broadcasts settings_changed for persisted voice settings', async () => {
    await writeVoiceModelSettings(h);
    const broadcastSettingsChanged = vi.fn();
    const persistSettings = vi.fn(async () => {});
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    registerWorkspaceVoiceRoutes(app, {
      boundWorkspace: h.workspace,
      mutate: () => (_req: Request, _res: Response, next: NextFunction) =>
        next(),
      safeBody: (req) => req.body as Record<string, unknown>,
      persistSetting: h.persistSetting,
      persistSettings,
      broadcastSettingsChanged,
      parseAndValidateClientId: vi.fn(() => 'client-1'),
      transcribe: h.transcribe,
    });

    const res = await request(app).post('/workspace/voice').send({
      enabled: true,
      mode: 'hold',
      language: 'english',
      voiceModel: 'qwen3-asr-flash',
    });

    expect(res.status).toBe(200);
    expect(h.persistSetting).not.toHaveBeenCalled();
    expect(persistSettings).toHaveBeenCalledWith(h.workspace, [
      {
        scope: SettingScope.User,
        key: 'voiceModel',
        value: 'qwen3-asr-flash',
      },
      {
        scope: SettingScope.User,
        key: 'general.voice.mode',
        value: 'hold',
      },
      {
        scope: SettingScope.User,
        key: 'general.voice.language',
        value: 'english',
      },
      {
        scope: SettingScope.User,
        key: 'general.voice.enabled',
        value: true,
      },
    ]);
    expect(broadcastSettingsChanged).toHaveBeenNthCalledWith(
      1,
      'voiceModel',
      'qwen3-asr-flash',
      'user',
      'client-1',
    );
    expect(broadcastSettingsChanged).toHaveBeenNthCalledWith(
      2,
      'general.voice.mode',
      'hold',
      'user',
      'client-1',
    );
    expect(broadcastSettingsChanged).toHaveBeenNthCalledWith(
      3,
      'general.voice.language',
      'english',
      'user',
      'client-1',
    );
    expect(broadcastSettingsChanged).toHaveBeenNthCalledWith(
      4,
      'general.voice.enabled',
      true,
      'user',
      'client-1',
    );
  });

  it('POST does not broadcast fallback voice writes when a later write fails', async () => {
    await writeVoiceModelSettings(h);
    const broadcastSettingsChanged = vi.fn();
    const persistSetting = vi.fn(
      async (
        _workspace: string,
        _scope: SettingScope,
        key: string,
        _value: unknown,
      ) => {
        if (key === 'general.voice.mode') {
          throw new Error('disk full');
        }
      },
    );
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    registerWorkspaceVoiceRoutes(app, {
      boundWorkspace: h.workspace,
      mutate: () => (_req: Request, _res: Response, next: NextFunction) =>
        next(),
      safeBody: (req) => req.body as Record<string, unknown>,
      persistSetting,
      broadcastSettingsChanged,
      parseAndValidateClientId: vi.fn(() => 'client-1'),
      transcribe: h.transcribe,
    });

    const res = await request(app).post('/workspace/voice').send({
      voiceModel: 'qwen3-asr-flash',
      mode: 'hold',
    });

    expect(res.status).toBe(500);
    expect(broadcastSettingsChanged).not.toHaveBeenCalled();
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('partial persist error'),
    );
  });

  it('POST rejects enabling voice when no valid voice model is selected', async () => {
    const res = await request(h.app)
      .post('/workspace/voice')
      .set('Host', hostHeader)
      .set('Authorization', 'Bearer secret')
      .send({ enabled: true });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('voice_model_required');
    expect(h.persistSetting).not.toHaveBeenCalled();
  });

  it('POST rejects invalid voice settings before persisting', async () => {
    await writeVoiceModelSettings(h);

    const invalidMode = await request(h.app)
      .post('/workspace/voice')
      .set('Host', hostHeader)
      .set('Authorization', 'Bearer secret')
      .send({ mode: 'push' });

    expect(invalidMode.status).toBe(400);
    expect(invalidMode.body.code).toBe('invalid_voice_mode');

    const unknownModel = await request(h.app)
      .post('/workspace/voice')
      .set('Host', hostHeader)
      .set('Authorization', 'Bearer secret')
      .send({ voiceModel: 'not-configured' });

    expect(unknownModel.status).toBe(400);
    expect(unknownModel.body.code).toBe('unknown_voice_model');
    expect(h.persistSetting).not.toHaveBeenCalled();
  });

  it('POST rejects enabling voice when the selected model config is unusable', async () => {
    await writeJson(path.join(h.home, 'settings.json'), {
      modelProviders: {
        openai: [
          {
            id: 'qwen3-asr-flash',
            label: 'Qwen ASR',
            baseUrl: 'https://dashscope.example/compatible-mode/v1',
            envKey: 'QWEN_VOICE_TEST_MISSING_KEY',
          },
        ],
      },
      voiceModel: 'qwen3-asr-flash',
    });

    const missingKey = await request(h.app)
      .post('/workspace/voice')
      .set('Host', hostHeader)
      .set('Authorization', 'Bearer secret')
      .send({ enabled: true });

    expect(missingKey.status).toBe(400);
    expect(missingKey.body.code).toBe('invalid_voice_model');
    expect(missingKey.body.error).toContain(
      'requires QWEN_VOICE_TEST_MISSING_KEY',
    );

    await writeJson(path.join(h.home, 'settings.json'), {
      modelProviders: {
        openai: [
          {
            id: 'qwen3-asr-flash',
            label: 'Qwen ASR',
            baseUrl: 'http://dashscope.example/compatible-mode/v1',
          },
        ],
      },
      voiceModel: 'qwen3-asr-flash',
    });

    const insecureBaseUrl = await request(h.app)
      .post('/workspace/voice')
      .set('Host', hostHeader)
      .set('Authorization', 'Bearer secret')
      .send({ enabled: true });

    expect(insecureBaseUrl.status).toBe(400);
    expect(insecureBaseUrl.body.code).toBe('invalid_voice_model');
    expect(insecureBaseUrl.body.error).toContain('must use an https baseUrl');
    expect(h.persistSetting).not.toHaveBeenCalled();
  });

  it('POST allows disabling voice without a selected model', async () => {
    const res = await request(h.app)
      .post('/workspace/voice')
      .set('Host', hostHeader)
      .set('Authorization', 'Bearer secret')
      .send({ enabled: false });

    expect(res.status).toBe(200);
    expect(h.persistSetting).toHaveBeenCalledWith(
      h.workspace,
      SettingScope.User,
      'general.voice.enabled',
      false,
    );
  });

  it('POST reports not implemented when voice settings persistence is unavailable', async () => {
    await teardown(h);
    h = await makeHarness({ persistSetting: false });

    const res = await request(h.app)
      .post('/workspace/voice')
      .set('Host', hostHeader)
      .set('Authorization', 'Bearer secret')
      .send({ enabled: false });

    expect(res.status).toBe(501);
    expect(res.body.code).toBe('not_implemented');
    expect(h.persistSetting).not.toHaveBeenCalled();
  });

  it('POST /workspace/voice/transcribe accepts binary audio and delegates transcription', async () => {
    await writeVoiceModelSettings(h);

    const res = await request(h.app)
      .post('/workspace/voice/transcribe?voiceModel=qwen3-asr-flash')
      .set('Host', hostHeader)
      .set('Authorization', 'Bearer secret')
      .set('Content-Type', 'audio/wav')
      .send(Buffer.from([1, 2, 3, 4]));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      v: 1,
      text: 'hello from audio',
      model: 'qwen3-asr-flash',
      transport: 'qwen-asr-chat',
    });
    const call = h.transcribe.mock.calls[0]?.[0] as
      | { data: Uint8Array; mimeType: string; voiceModel: string }
      | undefined;
    expect(call).toMatchObject({
      mimeType: 'audio/wav',
      voiceModel: 'qwen3-asr-flash',
    });
    expect(Array.from(call?.data ?? [])).toEqual([1, 2, 3, 4]);
  });

  it('POST /workspace/voice/transcribe works without settings persistence', async () => {
    await teardown(h);
    h = await makeHarness({ persistSetting: false });
    await writeVoiceModelSettings(h);

    const res = await request(h.app)
      .post('/workspace/voice/transcribe?voiceModel=qwen3-asr-flash')
      .set('Host', hostHeader)
      .set('Authorization', 'Bearer secret')
      .set('Content-Type', 'audio/wav')
      .send(Buffer.from([1, 2, 3, 4]));

    expect(res.status).toBe(200);
    expect(h.transcribe).toHaveBeenCalledWith(
      expect.objectContaining({ voiceModel: 'qwen3-asr-flash' }),
    );
    expect(h.persistSetting).not.toHaveBeenCalled();
  });

  it('POST /workspace/voice/transcribe is protected by bearer auth when configured', async () => {
    await writeVoiceModelSettings(h);

    const res = await request(h.app)
      .post('/workspace/voice/transcribe?voiceModel=qwen3-asr-flash')
      .set('Host', hostHeader)
      .set('Content-Type', 'audio/wav')
      .send(Buffer.from([1, 2, 3, 4]));

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
    expect(h.transcribe).not.toHaveBeenCalled();
  });

  it('POST /workspace/voice/transcribe requires a configured token on loopback defaults', async () => {
    await teardown(h);
    h = await makeHarness({ token: '' });
    await writeVoiceModelSettings(h);

    const res = await request(h.app)
      .post('/workspace/voice/transcribe?voiceModel=qwen3-asr-flash')
      .set('Host', hostHeader)
      .set('Content-Type', 'audio/wav')
      .send(Buffer.from([1, 2, 3, 4]));

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('token_required');
    expect(h.transcribe).not.toHaveBeenCalled();
  });

  it('registers transcription as a strict mutation route', () => {
    const mutate = vi.fn(
      () => (_req: Request, _res: Response, next: NextFunction) => next(),
    );

    registerWorkspaceVoiceRoutes(express(), {
      boundWorkspace: h.workspace,
      mutate,
      safeBody: () => ({}),
      persistSetting: h.persistSetting,
      broadcastSettingsChanged: vi.fn(),
      parseAndValidateClientId: vi.fn(),
      transcribe: h.transcribe,
    });

    expect(mutate).toHaveBeenNthCalledWith(1, { strict: true });
    expect(mutate).toHaveBeenNthCalledWith(2, { strict: true });
  });

  it('POST /workspace/voice/transcribe accepts omitted client id', async () => {
    await writeVoiceModelSettings(h);

    const res = await request(h.app)
      .post('/workspace/voice/transcribe')
      .set('Host', hostHeader)
      .set('Authorization', 'Bearer secret')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from([9]));

    expect(res.status).toBe(200);
    expect(h.transcribe).toHaveBeenCalledWith(
      expect.objectContaining({
        voiceModel: 'qwen3-asr-flash',
        mimeType: 'application/octet-stream',
      }),
    );
  });

  it('POST /workspace/voice/transcribe rejects unknown client id', async () => {
    await writeVoiceModelSettings(h);

    const res = await request(h.app)
      .post('/workspace/voice/transcribe')
      .set('Host', hostHeader)
      .set('Authorization', 'Bearer secret')
      .set('X-Qwen-Client-Id', 'detached-client')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from([9]));

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_client_id');
    expect(h.transcribe).not.toHaveBeenCalled();
  });

  it('POST /workspace/voice/transcribe rejects duplicate voiceModel query parameters', async () => {
    await writeVoiceModelSettings(h);

    const res = await request(h.app)
      .post(
        '/workspace/voice/transcribe?voiceModel=qwen3-asr-flash&voiceModel=other',
      )
      .set('Host', hostHeader)
      .set('Authorization', 'Bearer secret')
      .set('Content-Type', 'audio/wav')
      .send(Buffer.from([1]));

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_voice_model');
    expect(h.transcribe).not.toHaveBeenCalled();
  });

  it('POST /workspace/voice/transcribe rejects empty audio and missing models', async () => {
    await writeVoiceModelSettings(h);

    const emptyAudio = await request(h.app)
      .post('/workspace/voice/transcribe')
      .set('Host', hostHeader)
      .set('Authorization', 'Bearer secret')
      .set('Content-Type', 'audio/wav')
      .send(Buffer.alloc(0));

    expect(emptyAudio.status).toBe(400);
    expect(emptyAudio.body.code).toBe('invalid_voice_audio');

    await writeJson(path.join(h.home, 'settings.json'), {
      general: { voice: { enabled: true, mode: 'hold' } },
    });

    const missingModel = await request(h.app)
      .post('/workspace/voice/transcribe')
      .set('Host', hostHeader)
      .set('Authorization', 'Bearer secret')
      .set('Content-Type', 'audio/wav')
      .send(Buffer.from([1]));

    expect(missingModel.status).toBe(400);
    expect(missingModel.body.code).toBe('voice_model_required');
    expect(h.transcribe).not.toHaveBeenCalledWith(
      expect.objectContaining({ voiceModel: expect.any(String) }),
    );
  });

  it('POST /workspace/voice/transcribe rejects audio over 10 MB', async () => {
    await writeVoiceModelSettings(h);

    const res = await request(h.app)
      .post('/workspace/voice/transcribe')
      .set('Host', hostHeader)
      .set('Authorization', 'Bearer secret')
      .set('Content-Type', 'audio/wav')
      .send(Buffer.alloc(10 * 1024 * 1024 + 1));

    expect(res.status).toBe(413);
    expect(res.body.error).toBe('Request body too large (max 10 MB)');
    expect(h.transcribe).not.toHaveBeenCalled();
  });

  it('POST /workspace/voice/transcribe redacts unexpected ASR errors', async () => {
    await writeVoiceModelSettings(h);
    h.transcribe.mockRejectedValueOnce(
      new Error(
        'upstream failed with Authorization: ApiKey top-secret and sk-secret',
      ),
    );

    const res = await request(h.app)
      .post('/workspace/voice/transcribe')
      .set('Host', hostHeader)
      .set('Authorization', 'Bearer secret')
      .set('Content-Type', 'audio/wav')
      .send(Buffer.from([1]));

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('voice_transcription_failed');
    expect(res.body.error).toBe('Voice transcription failed');
    expect(JSON.stringify(res.body)).not.toContain('sk-secret');
    expect(JSON.stringify(res.body)).not.toContain('top-secret');
    const stderrOutput = mockWriteStderrLine.mock.calls
      .map((call) => String(call[0]))
      .join('\n');
    expect(stderrOutput).toContain('[REDACTED]');
    expect(stderrOutput).not.toContain('sk-secret');
    expect(stderrOutput).not.toContain('top-secret');
  });

  it('POST /workspace/voice/transcribe rejects unsupported content types', async () => {
    const res = await request(h.app)
      .post('/workspace/voice/transcribe')
      .set('Host', hostHeader)
      .set('Authorization', 'Bearer secret')
      .set('Content-Type', 'application/json')
      .send({ audioBase64: 'AQID' });

    expect(res.status).toBe(415);
    expect(res.body.code).toBe('unsupported_voice_content_type');
    expect(h.transcribe).not.toHaveBeenCalled();
  });
});
