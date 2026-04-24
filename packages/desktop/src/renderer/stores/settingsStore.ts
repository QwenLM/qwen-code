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
}

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
  };
}

export function settingsReducer(
  state: SettingsState,
  action: SettingsAction,
): SettingsState {
  switch (action.type) {
    case 'load_start':
      return { ...state, loading: true, error: null };
    case 'load_success':
      return {
        ...state,
        loading: false,
        settings: action.settings,
        form: formFromSettings(action.settings, state.form),
        error: null,
      };
    case 'load_error':
      return { ...state, loading: false, error: action.message };
    case 'save_start':
      return { ...state, saving: true, error: null };
    case 'save_success':
      return {
        ...state,
        saving: false,
        settings: action.settings,
        form: { ...formFromSettings(action.settings, state.form), apiKey: '' },
        error: null,
      };
    case 'save_error':
      return { ...state, saving: false, error: action.message };
    case 'set_provider':
      return {
        ...state,
        form: { ...state.form, provider: action.provider },
      };
    case 'set_api_key':
      return { ...state, form: { ...state.form, apiKey: action.apiKey } };
    case 'set_coding_plan_region':
      return {
        ...state,
        form: { ...state.form, codingPlanRegion: action.region },
      };
    case 'set_active_model':
      return { ...state, form: { ...state.form, activeModel: action.model } };
    case 'set_base_url':
      return { ...state, form: { ...state.form, baseUrl: action.baseUrl } };
    default:
      return state;
  }
}

export function buildSettingsUpdateRequest(
  form: SettingsFormState,
): UpdateDesktopSettingsRequest {
  if (form.provider === 'coding-plan') {
    return {
      provider: 'coding-plan',
      apiKey: form.apiKey || undefined,
      codingPlanRegion: form.codingPlanRegion,
    };
  }

  return {
    provider: 'api-key',
    apiKey: form.apiKey || undefined,
    activeModel: form.activeModel,
    modelProviders: {
      [form.activeModel]: form.baseUrl,
    },
  };
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
