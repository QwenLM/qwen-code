/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { UpResult, StatusResult } from '../main/launcherClient.js';
import type { ProviderEnv } from '../main/envConfig.js';
import type { PollState } from '../main/statusPoll.js';

export interface LauncherConfig extends ProviderEnv {
  distro?: string;
}

/** The `window.launcher` surface the renderer (Task 4) consumes. */
export interface LauncherApi {
  up(): Promise<UpResult>;
  down(): Promise<{ ok: boolean; hint?: string }>;
  status(): Promise<StatusResult>;
  pairingCode(): Promise<string | undefined>;
  listDistros(): Promise<string[]>;
  getConfig(): Promise<LauncherConfig>;
  saveConfig(env: ProviderEnv): Promise<{ ok: boolean }>;
  setDistro(distro: string): Promise<{ ok: boolean }>;
  onLog(cb: (line: string) => void): void;
  onStatus(cb: (state: PollState) => void): void;
  startLogs(): Promise<{ ok: boolean }>;
  stopLogs(): Promise<{ ok: boolean }>;
}

const api: LauncherApi = {
  up: () => ipcRenderer.invoke('up'),
  down: () => ipcRenderer.invoke('down'),
  status: () => ipcRenderer.invoke('status'),
  pairingCode: () => ipcRenderer.invoke('pairingCode'),
  listDistros: () => ipcRenderer.invoke('listDistros'),
  getConfig: () => ipcRenderer.invoke('getConfig'),
  saveConfig: (env) => ipcRenderer.invoke('saveConfig', env),
  setDistro: (distro) => ipcRenderer.invoke('setDistro', distro),
  onLog: (cb) => {
    ipcRenderer.on('log', (_event, line: string) => cb(line));
  },
  onStatus: (cb) => {
    ipcRenderer.on('status', (_event, state: PollState) => cb(state));
  },
  startLogs: () => ipcRenderer.invoke('startLogs'),
  stopLogs: () => ipcRenderer.invoke('stopLogs'),
};

contextBridge.exposeInMainWorld('launcher', api);

declare global {
  interface Window {
    launcher: LauncherApi;
  }
}
