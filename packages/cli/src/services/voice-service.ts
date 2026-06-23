/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createDebugLogger,
  ModelsConfig,
  type ModelProvidersConfig,
} from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../config/settings.js';
import {
  isSelectableVoiceModel,
  resolveVoiceTransport,
  type VoiceTransport,
} from './voice-model.js';
import {
  readVoiceLanguage,
  readVoiceMode,
  readVoiceModel,
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

const debugLogger = createDebugLogger('VOICE_SERVICE');

export interface WorkspaceVoiceModelDescriptor {
  id: string;
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

export function createVoiceModelSource(
  settings: LoadedSettings,
): VoiceModelSource {
  return new ModelsConfig({
    modelProvidersConfig: settings.merged.modelProviders as
      | ModelProvidersConfig
      | undefined,
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
  const duplicateIds = [...idCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id);
  if (duplicateIds.length > 0) {
    debugLogger.debug(
      `Skipping duplicate voice model ids: ${duplicateIds.join(', ')}`,
    );
  }

  return models
    .filter((model) => (idCounts.get(model.id) ?? 0) === 1)
    .filter(isSelectableVoiceModel)
    .map((model) => ({
      id: model.id,
      transport: resolveVoiceTransport(model.id),
    }))
    .filter(
      (model): model is WorkspaceVoiceModelDescriptor =>
        model.transport !== 'unsupported',
    );
}

export function buildWorkspaceVoiceStatus(
  workspaceCwd: string,
  settings: LoadedSettings,
): WorkspaceVoiceStatus {
  return {
    v: 1,
    workspaceCwd,
    enabled: isVoiceEnabled(settings),
    mode: readVoiceMode(settings),
    language: readVoiceLanguage(settings),
    voiceModel: readVoiceModel(settings) ?? null,
    availableVoiceModels: listAvailableVoiceModels(settings),
  };
}

export function validateWorkspaceVoiceModel(
  settings: LoadedSettings,
  voiceModel: string,
): WorkspaceVoiceModelDescriptor {
  const models = createVoiceModelSource(settings).getAllConfiguredModels();
  const matches = models.filter((model) => model.id === voiceModel);
  if (matches.length === 0) {
    throw new WorkspaceVoiceError(
      400,
      'unknown_voice_model',
      `Voice model '${voiceModel}' is not configured.`,
    );
  }
  if (matches.length > 1) {
    throw new WorkspaceVoiceError(
      400,
      'ambiguous_voice_model',
      `Voice model '${voiceModel}' is ambiguous.`,
    );
  }
  const [model] = matches;
  if (!model || !isSelectableVoiceModel(model)) {
    throw new WorkspaceVoiceError(
      400,
      'unsupported_voice_model',
      `Voice model '${voiceModel}' cannot be used for transcription.`,
    );
  }
  const transport = resolveVoiceTransport(model.id);
  if (transport === 'unsupported') {
    throw new WorkspaceVoiceError(
      400,
      'unsupported_voice_model',
      `Voice model '${voiceModel}' cannot be used for transcription.`,
    );
  }
  return { id: model.id, transport };
}

export function validateWorkspaceVoiceConfig(
  settings: LoadedSettings,
  voiceModel: string,
): WorkspaceVoiceModelDescriptor {
  const descriptor = validateWorkspaceVoiceModel(settings, voiceModel);
  try {
    const config = createVoiceModelSource(settings);
    if (descriptor.transport === 'qwen-asr-chat') {
      resolveVoiceTranscriptionConfig({ config, settings, voiceModel });
    } else {
      resolveVoiceStreamConfig({ config, settings, voiceModel });
    }
  } catch (err) {
    throw new WorkspaceVoiceError(
      400,
      'invalid_voice_model',
      err instanceof Error
        ? err.message
        : `Voice model '${voiceModel}' is not configured for transcription.`,
    );
  }
  return descriptor;
}

export function validateWorkspaceVoiceState(
  settings: LoadedSettings,
  update: WorkspaceVoiceStateUpdate,
): void {
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
  validateWorkspaceVoiceConfig(settings, nextVoiceModel);
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
      `Voice model '${input.voiceModel}' requires realtime transcription, which is not supported by this daemon endpoint.`,
    );
  }
  const text = await transcribeVoiceAudio(
    { data: input.data, mimeType: input.mimeType },
    {
      config: createVoiceModelSource(input.settings),
      settings: input.settings,
      voiceModel: input.voiceModel,
    },
  );
  return {
    text,
    model: input.voiceModel,
    transport: descriptor.transport,
  };
}
