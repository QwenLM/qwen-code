/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { contextBridge, ipcRenderer } from 'electron';
import type {
  DesktopBrowserState,
  DesktopLaunchConfig,
  DesktopLiveStatus,
  QwenDesktopBridge,
} from '../shared/types';

const bridge: QwenDesktopBridge = Object.freeze({
  getLaunchConfig: () =>
    ipcRenderer.invoke(
      'desktop:get-launch-config',
    ) as Promise<DesktopLaunchConfig>,
  newChatWindow: () =>
    ipcRenderer.invoke('desktop:new-chat-window') as Promise<void>,
  openBrowser: (url?: string) =>
    ipcRenderer.invoke('desktop:open-browser', url) as Promise<void>,
  getBrowserState: () =>
    ipcRenderer.invoke(
      'desktop:get-browser-state',
    ) as Promise<DesktopBrowserState>,
  navigateBrowser: (url: string) =>
    ipcRenderer.invoke(
      'desktop:navigate-browser',
      url,
    ) as Promise<DesktopBrowserState>,
  goBackBrowser: () =>
    ipcRenderer.invoke('desktop:browser-back') as Promise<void>,
  goForwardBrowser: () =>
    ipcRenderer.invoke('desktop:browser-forward') as Promise<void>,
  reloadBrowser: () =>
    ipcRenderer.invoke('desktop:browser-reload') as Promise<void>,
  onBrowserState: (listener: (state: DesktopBrowserState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: unknown) => {
      listener(state as DesktopBrowserState);
    };
    ipcRenderer.on('desktop:browser-state', handler);
    return () => ipcRenderer.removeListener('desktop:browser-state', handler);
  },
  showVoiceOverlay: () =>
    ipcRenderer.invoke('desktop:show-voice-overlay') as Promise<void>,
  closeVoiceOverlay: () =>
    ipcRenderer.invoke('desktop:close-voice-overlay') as Promise<void>,
  getLiveStatus: () =>
    ipcRenderer.invoke('desktop:get-live-status') as Promise<DesktopLiveStatus>,
  startLive: (mode: 'resume' | 'new' = 'resume') =>
    ipcRenderer.invoke(
      'desktop:start-live',
      mode,
    ) as Promise<DesktopLiveStatus>,
  stopLive: () =>
    ipcRenderer.invoke('desktop:stop-live') as Promise<DesktopLiveStatus>,
  setLiveMute: (update: { inputMuted?: boolean; outputMuted?: boolean }) =>
    ipcRenderer.invoke(
      'desktop:set-live-mute',
      update,
    ) as Promise<DesktopLiveStatus>,
});

contextBridge.exposeInMainWorld('qwenDesktop', bridge);
