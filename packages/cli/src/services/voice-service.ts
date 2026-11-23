/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelProvidersConfig } from '@qwen-code/qwen-code-core';
import { createDebugLogger } from '@qwen-code/qwen-code-core/utils/debugLogger.js';
import { ModelsConfig } from '@qwen-code/qwen-code-core/models/modelsConfig.js';
import { AuthType } from '@qwen-code/qwen-code-core/utils/auth-type.js';
import { getPersistScopeForModelSelection } from '../config/modelProvidersScope.js';
import { publicProviderBaseUrl } from '../utils/acpModelUtils.js';
import { SettingScope, type LoadedSettings } from '../config/settings.js';
import {
  isSelectableVoiceModel,
  assertVoiceModelSignedIn,
  findVoiceModels,
  getVoiceModelSelector,
  resolveVoiceModelTransport,
  type VoiceTransport,
} from './voice-model.js';
import {
  readVoiceLanguage,
  readVoiceMode,
  readVoiceModel,
  getVoiceSettingsScope,
  isVoiceEnabled,
  type VoiceMode,
} from './voice-settings.js';
import {
  resolveVoiceStreamConfig,
  resolveVoiceTranscriptionConfig,
  transcribeVoiceAudio,
  type RecordedVoiceAudio,
  type VoiceModelSource,
} from './voice-transcriber.js';
import {
  formatAuxModelSelectorForDisplay,
  publicAuxModelSelectorValue,
} from '../utils/aux-model-selector.js';

const debugLogger = createDebugLogger('VOICE_SERVICE');

export const EMPTY_WORKSPACE_VOICE_UPDATE_ERROR =
  'At least one of `enabled`, `mode`, `language`, or `voiceModel` must be provided';

export interface WorkspaceVoiceModelDescriptor {
  name?: string;
  baseUrl?: string;
  contextWindow?: number;
  id: string;
  authType?: string;
  transport: Exclude<VoiceTransport, 'unsupported'>;
}

export interface WorkspaceVoiceStatus {
  v: 1;
  workspaceCwd: string;
  enabled: boolean;
  mode: 'hold' | 'tap';
  language: string;
  voiceModel: string | null;
  availableVoiceModels: WorkspaceVoiceModelDescriptor[];
}

export interface WorkspaceVoiceTranscriptionInput extends RecordedVoiceAudio {
  voiceModel: string;
  settings: LoadedSettings;
  workspaceCwd: string;
  env?: Readonly<Record<string, string | undefined>>;
  abortSignal?: AbortSignal;
}

export interface WorkspaceVoiceTranscriptionResult {
  text: string;
  model: string;
  transport: Exclude<VoiceTransport, 'unsupported'>;
}

export interface WorkspaceVoiceStateUpdate {
  enabled?: boolean;
  mode?: VoiceMode;
  language?: string;
  voiceModel?: string;
}

export type WorkspaceVoiceSettingsWireScope = 'user' | 'workspace';

export interface WorkspaceVoiceSettingsWrite {
  scope: SettingScope;
  key: string;
  value: unknown;
}

export class WorkspaceVoiceError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'WorkspaceVoiceError';
    this.status = status;
    this.code = code;
  }
}

export function voiceSettingsScopeToWire(
  scope: SettingScope,
): WorkspaceVoiceSettingsWireScope {
  return scope === SettingScope.Workspace ? 'workspace' : 'user';
}

export function buildWorkspaceVoiceSettingsWrites(
  settings: LoadedSettings,
  update: WorkspaceVoiceStateUpdate,
  opts: { workspaceTrusted?: boolean; scopeOverride?: SettingScope } = {},
): WorkspaceVoiceSettingsWrite[] {
  const voiceSettingsScope =
    opts.scopeOverride ??
    getVoiceSettingsScope(settings, opts.workspaceTrusted);
  const writes: WorkspaceVoiceSettingsWrite[] = [];
  if (update.voiceModel !== undefined) {
    writes.push({
      scope: opts.scopeOverride ?? getPersistScopeForModelSelection(settings),
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
  return writes;
}

export function createVoiceModelSource(
  settings: LoadedSettings,
): VoiceModelSource {
  return new ModelsConfig({
    modelProvidersConfig: settings.merged.modelProviders as
      | ModelProvidersConfig
      | undefined,
    providerProtocolConfig: settings.merged.providerProtocol,
  });
}

export function listAvailableVoiceModels(
  settings: LoadedSettings,
): WorkspaceVoiceModelDescriptor[] {
  const models = createVoiceModelSource(settings).getAllConfiguredModels();
  const idCounts = new Map<string, number>();
  for (const model of models) {
    idCounts.set(model.id, (idCounts.get(model.id) ?? 0) + 1);
  }
  return models
    .filter(isSelectableVoiceModel)
    .flatMap((model): WorkspaceVoiceModelDescriptor[] => {
      const transport = resolveVoiceModelTransport(model);
      if (transport === 'unsupported') return [];
      return [
        {
          id:
            model.authType === AuthType.QWEN_SUBSCRIPTION ||
            (idCounts.get(model.id) ?? 0) > 1
              ? publicAuxModelSelectorValue(getVoiceModelSelector(model))
              : model.id,
          ...(model.authType !== AuthType.USE_OPENAI
            ? { authType: model.authType }
            : {}),
          name: model.label || model.id,
          ...(model.baseUrl
            ? { baseUrl: publicProviderBaseUrl(model.baseUrl) }
            : {}),
          ...(model.contextWindowSize
            ? { contextWindow: model.contextWindowSize }
            : {}),
          transport,
        },
      ];
    });
}

export function hasConfiguredBatchVoiceTranscriptionModel(
  settings: LoadedSettings,
  opts: { env?: Readonly<Record<string, string | undefined>> } = {},
): boolean {
  for (const model of listAvailableVoiceModels(settings)) {
    if (model.transport !== 'qwen-asr-chat') {
      continue;
    }
    try {
      validateWorkspaceVoiceConfig(settings, model.id, opts);
      return true;
    } catch (err) {
      debugLogger.debug(
        `Skipping unavailable batch voice model '${model.id}': ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return false;
}

export function buildWorkspaceVoiceStatus(
  workspaceCwd: string,
  settings: LoadedSettings,
): WorkspaceVoiceStatus {
  const voiceModel = readVoiceModel(settings);
  return {
    v: 1,
    workspaceCwd,
    enabled: isVoiceEnabled(settings),
    mode: readVoiceMode(settings),
    language: readVoiceLanguage(settings),
    voiceModel: voiceModel ? publicAuxModelSelectorValue(voiceModel) : null,
    availableVoiceModels: listAvailableVoiceModels(settings),
  };
}

export function validateWorkspaceVoiceModel(
  settings: LoadedSettings,
  voiceModel: string,
): WorkspaceVoiceModelDescriptor {
  assertVoiceModelSignedIn(voiceModel);
  const models = createVoiceModelSource(settings).getAllConfiguredModels();
  const matches = findVoiceModels(models, voiceModel);
  const displayModel = formatAuxModelSelectorForDisplay(voiceModel);
  if (matches.length === 0) {
    throw new WorkspaceVoiceError(
      400,
      'unknown_voice_model',
      `Voice model '${displayModel}' is not configured.`,
    );
  }
  if (matches.length > 1) {
    throw new WorkspaceVoiceError(
      400,
      'ambiguous_voice_model',
      `Voice model '${displayModel}' is ambiguous.`,
    );
  }
  const [model] = matches;
  if (!model || !isSelectableVoiceModel(model)) {
    throw new WorkspaceVoiceError(
      400,
      'unsupported_voice_model',
      `Voice model '${displayModel}' cannot be used for transcription.`,
    );
  }
  const transport = resolveVoiceModelTransport(model);
  if (transport === 'unsupported') {
    throw new WorkspaceVoiceError(
      400,
      'unsupported_voice_model',
      `Voice model '${displayModel}' cannot be used for transcription.`,
    );
  }
  return { id: model.id, transport };
}

export function validateWorkspaceVoiceConfig(
  settings: LoadedSettings,
  voiceModel: string,
  opts: { env?: Readonly<Record<string, string | undefined>> } = {},
): WorkspaceVoiceModelDescriptor {
  const descriptor = validateWorkspaceVoiceModel(settings, voiceModel);
  try {
    const config = createVoiceModelSource(settings);
    if (descriptor.transport === 'qwen-asr-chat') {
      resolveVoiceTranscriptionConfig({
        config,
        settings,
        voiceModel,
        env: opts.env,
      });
    } else {
      resolveVoiceStreamConfig({
        config,
        settings,
        voiceModel,
        env: opts.env,
      });
    }
  } catch (err) {
    throw new WorkspaceVoiceError(
      400,
      'invalid_voice_model',
      err instanceof Error
        ? err.message
        : `Voice model '${formatAuxModelSelectorForDisplay(voiceModel)}' is not configured for transcription.`,
    );
  }
  return descriptor;
}

export function validateWorkspaceVoiceState(
  settings: LoadedSettings,
  update: WorkspaceVoiceStateUpdate,
  opts: { env?: Readonly<Record<string, string | undefined>> } = {},
): void {
  if (
    update.enabled === undefined &&
    update.mode === undefined &&
    update.language === undefined &&
    update.voiceModel === undefined
  ) {
    throw new WorkspaceVoiceError(
      400,
      'invalid_voice_update',
      EMPTY_WORKSPACE_VOICE_UPDATE_ERROR,
    );
  }
  const nextEnabled = update.enabled ?? isVoiceEnabled(settings);
  const nextVoiceModel = update.voiceModel ?? readVoiceModel(settings);
  if (update.voiceModel) {
    validateWorkspaceVoiceModel(settings, update.voiceModel);
  }
  if (!nextEnabled) {
    return;
  }
  if (!nextVoiceModel) {
    throw new WorkspaceVoiceError(
      400,
      'voice_model_required',
      'A valid voiceModel is required before enabling voice.',
    );
  }
  validateWorkspaceVoiceConfig(settings, nextVoiceModel, opts);
}

export async function transcribeWorkspaceVoiceAudio(
  input: WorkspaceVoiceTranscriptionInput,
): Promise<WorkspaceVoiceTranscriptionResult> {
  const descriptor = validateWorkspaceVoiceModel(
    input.settings,
    input.voiceModel,
  );
  if (descriptor.transport !== 'qwen-asr-chat') {
    throw new WorkspaceVoiceError(
      400,
      'unsupported_voice_model',
      `Voice model '${formatAuxModelSelectorForDisplay(input.voiceModel)}' requires realtime transcription, which is not supported by this daemon endpoint.`,
    );
  }
  const text = await transcribeVoiceAudio(
    { data: input.data, mimeType: input.mimeType },
    {
      config: createVoiceModelSource(input.settings),
      settings: input.settings,
      voiceModel: input.voiceModel,
      env: input.env,
      abortSignal: input.abortSignal,
    },
  );
  return {
    text,
    model: publicAuxModelSelectorValue(input.voiceModel),
    transport: descriptor.transport,
  };
}
