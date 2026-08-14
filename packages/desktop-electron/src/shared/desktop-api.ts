/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const DESKTOP_CHANNELS = {
  loadHostSettings: 'desktop:load-host-settings',
  setHostSetting: 'desktop:set-host-setting',
  hostSettingsChanged: 'desktop:host-settings-changed',
  streamingState: 'desktop:streaming-state',
  sessionChange: 'desktop:session-change',
  petBootstrap: 'desktop:pet-bootstrap',
  petSettingsChanged: 'desktop:pet-settings-changed',
  petActivityChanged: 'desktop:pet-activity-changed',
  petIgnoreMouse: 'desktop:pet-ignore-mouse',
  petDragStart: 'desktop:pet-drag-start',
  petDragMove: 'desktop:pet-drag-move',
  petDragEnd: 'desktop:pet-drag-end',
  petClose: 'desktop:pet-close',
} as const;

export type PetState = 'failed' | 'idle' | 'jumping' | 'running' | 'waiting';

export interface PetSettings {
  enabled: boolean;
  size: number;
  position?: { x: number; y: number };
}

export interface HostSettingItem {
  key: string;
  label: string;
  description?: string;
  kind: 'boolean' | 'number';
  value: boolean | number;
  disabled?: boolean;
}

export interface HostSettingsCategory {
  id: string;
  label: string;
  scopeLabel?: string;
  items: HostSettingItem[];
}

export interface SessionChangeReport {
  type: 'submit' | 'turn_complete';
  failed?: boolean;
}

export interface QwenCodeHostApi {
  loadSettings(language: string): Promise<HostSettingsCategory[]>;
  setSetting(key: string, value: boolean | number): Promise<void>;
  onSettingsChanged(callback: () => void): () => void;
  reportStreamingState(state: string): void;
  reportSessionChange(event: SessionChangeReport): void;
}

export interface QwenCodePetApi {
  getSettings(): Promise<PetSettings>;
  onSettingsChanged(callback: (settings: PetSettings) => void): () => void;
  onActivityChanged(callback: (state: PetState) => void): () => void;
  setIgnoreMouse(ignore: boolean): void;
  beginDrag(screenX: number, screenY: number): void;
  moveDrag(screenX: number, screenY: number): void;
  endDrag(): void;
  close(): void;
}
