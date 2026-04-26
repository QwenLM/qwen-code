/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  DesktopUserSettings,
  UpdateDesktopSettingsRequest,
} from '../api/client.js';

export interface SettingsFormState {
  provider: 'api-key' | 'coding-plan';
  apiKey: string;
  codingPlanRegion: 'china' | 'global';
  activeModel: string;
  baseUrl: string;
}

export interface SettingsState {
  loading: boolean;
  saving: boolean;
  settings: DesktopUserSettings | null;
  form: SettingsFormState;
  error: string | null;
  saveStatus: SettingsSaveStatus;
}

export interface SettingsFormValidation {
  valid: boolean;
  reason: string | null;
}

export type SettingsSaveStatus =
  | { type: 'idle' }
  | { type: 'saving' }
  | { type: 'saved' }
  | { type: 'error'; message: string };

export type SettingsAction =
  | { type: 'load_start' }
  | { type: 'load_success'; settings: DesktopUserSettings }
  | { type: 'load_error'; message: string }
  | { type: 'save_start' }
  | { type: 'save_success'; settings: DesktopUserSettings }
  | { type: 'save_error'; message: string }
  | { type: 'set_provider'; provider: SettingsFormState['provider'] }
  | { type: 'set_api_key'; apiKey: string }
  | { type: 'set_coding_plan_region'; region: 'china' | 'global' }
  | { type: 'set_active_model'; model: string }
  | { type: 'set_base_url'; baseUrl: string };

export function createInitialSettingsState(): SettingsState {
  return {
    loading: false,
    saving: false,
    settings: null,
    form: {
      provider: 'api-key',
      apiKey: '',
      codingPlanRegion: 'china',
      activeModel: 'qwen-plus',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    },
    error: null,
    saveStatus: { type: 'idle' },
  };
}

export function settingsReducer(
  state: SettingsState,
  action: SettingsAction,
): SettingsState {
  switch (action.type) {
    case 'load_start':
      return {
        ...state,
        loading: true,
        error: null,
        saveStatus: { type: 'idle' },
      };
    case 'load_success':
      return {
        ...state,
        loading: false,
        settings: action.settings,
        form: formFromSettings(action.settings, state.form),
        error: null,
        saveStatus: { type: 'idle' },
      };
    case 'load_error':
      return {
        ...state,
        loading: false,
        error: action.message,
        saveStatus: { type: 'idle' },
      };
    case 'save_start':
      return {
        ...state,
        saving: true,
        error: null,
        saveStatus: { type: 'saving' },
      };
    case 'save_success':
      return {
        ...state,
        saving: false,
        settings: action.settings,
        form: { ...formFromSettings(action.settings, state.form), apiKey: '' },
        error: null,
        saveStatus: { type: 'saved' },
      };
    case 'save_error':
      return {
        ...state,
        saving: false,
        error: action.message,
        saveStatus: { type: 'error', message: action.message },
      };
    case 'set_provider':
      return {
        ...state,
        error: null,
        saveStatus: { type: 'idle' },
        form: { ...state.form, provider: action.provider },
      };
    case 'set_api_key':
      return clearSaveStatus({
        ...state,
        form: { ...state.form, apiKey: action.apiKey },
      });
    case 'set_coding_plan_region':
      return clearSaveStatus({
        ...state,
        form: { ...state.form, codingPlanRegion: action.region },
      });
    case 'set_active_model':
      return clearSaveStatus({
        ...state,
        form: { ...state.form, activeModel: action.model },
      });
    case 'set_base_url':
      return clearSaveStatus({
        ...state,
        form: { ...state.form, baseUrl: action.baseUrl },
      });
    default:
      return state;
  }
}

function clearSaveStatus(state: SettingsState): SettingsState {
  return {
    ...state,
    error: null,
    saveStatus: { type: 'idle' },
  };
}

export function buildSettingsUpdateRequest(
  form: SettingsFormState,
): UpdateDesktopSettingsRequest {
  const apiKey = form.apiKey.trim() || undefined;

  if (form.provider === 'coding-plan') {
    return {
      provider: 'coding-plan',
      apiKey,
      codingPlanRegion: form.codingPlanRegion,
    };
  }

  const activeModel = form.activeModel.trim();
  const baseUrl = form.baseUrl.trim();

  return {
    provider: 'api-key',
    apiKey,
    activeModel,
    modelProviders: {
      [activeModel]: baseUrl,
    },
  };
}

export function validateSettingsForm(
  form: SettingsFormState,
  settings: DesktopUserSettings | null,
): SettingsFormValidation {
  if (form.provider === 'coding-plan') {
    if (
      !hasIncomingOrSavedSecret(form.apiKey, settings?.codingPlan.hasApiKey)
    ) {
      return {
        valid: false,
        reason: 'Enter a Coding Plan API key to save this provider.',
      };
    }

    return { valid: true, reason: null };
  }

  if (form.activeModel.trim().length === 0) {
    return {
      valid: false,
      reason: 'Enter a model name before saving.',
    };
  }

  if (form.baseUrl.trim().length === 0) {
    return {
      valid: false,
      reason: 'Enter an HTTP(S) base URL before saving.',
    };
  }

  if (!isHttpBaseUrl(form.baseUrl)) {
    return {
      valid: false,
      reason: 'Use a valid HTTP(S) base URL.',
    };
  }

  if (!hasIncomingOrSavedSecret(form.apiKey, settings?.openai.hasApiKey)) {
    return {
      valid: false,
      reason: 'Enter an API key to save this provider.',
    };
  }

  return { valid: true, reason: null };
}

function formFromSettings(
  settings: DesktopUserSettings,
  current: SettingsFormState,
): SettingsFormState {
  const provider =
    settings.provider === 'coding-plan' ? 'coding-plan' : 'api-key';
  const firstProvider = settings.openai.providers.find(
    (entry) => entry.envKey === 'OPENAI_API_KEY',
  );

  return {
    provider,
    apiKey: current.apiKey,
    codingPlanRegion: settings.codingPlan.region,
    activeModel:
      settings.model.name || firstProvider?.id || current.activeModel,
    baseUrl: firstProvider?.baseUrl || current.baseUrl,
  };
}

function hasIncomingOrSavedSecret(
  incomingSecret: string,
  hasSavedSecret: boolean | undefined,
): boolean {
  return incomingSecret.trim().length > 0 || hasSavedSecret === true;
}

function isHttpBaseUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
