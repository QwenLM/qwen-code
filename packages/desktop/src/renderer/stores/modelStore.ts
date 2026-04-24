/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  DesktopApprovalMode,
  DesktopSessionModeState,
  DesktopSessionModelState,
} from '../../shared/desktopProtocol.js';

export interface ModelState {
  models: DesktopSessionModelState | null;
  modes: DesktopSessionModeState | null;
  savingModel: boolean;
  savingMode: boolean;
  error: string | null;
}

export type ModelAction =
  | {
      type: 'session_runtime_loaded';
      models?: DesktopSessionModelState;
      modes?: DesktopSessionModeState;
    }
  | { type: 'model_save_start' }
  | { type: 'model_saved'; models: DesktopSessionModelState }
  | { type: 'mode_save_start' }
  | { type: 'mode_saved'; modes: DesktopSessionModeState }
  | { type: 'model_changed'; modelId: string }
  | { type: 'mode_changed'; mode: DesktopApprovalMode }
  | { type: 'error'; message: string }
  | { type: 'reset' };

export function createInitialModelState(): ModelState {
  return {
    models: null,
    modes: null,
    savingModel: false,
    savingMode: false,
    error: null,
  };
}

export function modelReducer(
  state: ModelState,
  action: ModelAction,
): ModelState {
  switch (action.type) {
    case 'session_runtime_loaded':
      return {
        ...state,
        models: action.models ?? state.models,
        modes: action.modes ?? state.modes,
        error: null,
      };
    case 'model_save_start':
      return { ...state, savingModel: true, error: null };
    case 'model_saved':
      return {
        ...state,
        savingModel: false,
        models: action.models,
        error: null,
      };
    case 'mode_save_start':
      return { ...state, savingMode: true, error: null };
    case 'mode_saved':
      return {
        ...state,
        savingMode: false,
        modes: action.modes,
        error: null,
      };
    case 'model_changed':
      return {
        ...state,
        models: state.models
          ? { ...state.models, currentModelId: action.modelId }
          : state.models,
      };
    case 'mode_changed':
      return {
        ...state,
        modes: state.modes
          ? { ...state.modes, currentModeId: action.mode }
          : state.modes,
      };
    case 'error':
      return {
        ...state,
        savingModel: false,
        savingMode: false,
        error: action.message,
      };
    case 'reset':
      return createInitialModelState();
    default:
      return state;
  }
}
