/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { contextBridge, ipcRenderer } from 'electron';
import type {
  DesktopServerInfo,
  QwenDesktopApi,
} from '../shared/desktopApi.js';
import { IPC_CHANNELS } from '../shared/ipcChannels.js';

const api: QwenDesktopApi = {
  getServerInfo: () =>
    ipcRenderer.invoke(
      IPC_CHANNELS.getServerInfo,
    ) as Promise<DesktopServerInfo>,
  selectDirectory: () =>
    ipcRenderer.invoke(IPC_CHANNELS.selectDirectory) as Promise<string | null>,
  openPath: async (path: string) => {
    await ipcRenderer.invoke(IPC_CHANNELS.openPath, path);
  },
  showItemInFolder: async (path: string) => {
    await ipcRenderer.invoke(IPC_CHANNELS.showItemInFolder, path);
  },
  writeClipboardText: async (text: string) => {
    await ipcRenderer.invoke(IPC_CHANNELS.writeClipboardText, text);
  },
  window: {
    minimize: async () => {
      await ipcRenderer.invoke(IPC_CHANNELS.windowMinimize);
    },
    maximize: async () => {
      await ipcRenderer.invoke(IPC_CHANNELS.windowMaximize);
    },
    close: async () => {
      await ipcRenderer.invoke(IPC_CHANNELS.windowClose);
    },
    isMaximized: () =>
      ipcRenderer.invoke(IPC_CHANNELS.windowIsMaximized) as Promise<boolean>,
  },
};

contextBridge.exposeInMainWorld('qwenDesktop', api);
