/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcRenderer } from 'electron';
import {
  BROWSER_PANEL_CHANNELS,
  type BrowserPanelApi,
  type BrowserPanelState,
} from '../shared/browser-panel';
import { installBrowserPanel } from './browser-panel';

const api: BrowserPanelApi = {
  open: (url, bounds) =>
    ipcRenderer.invoke(
      BROWSER_PANEL_CHANNELS.open,
      url,
      bounds,
    ) as Promise<void>,
  navigate: (url) =>
    ipcRenderer.invoke(BROWSER_PANEL_CHANNELS.navigate, url) as Promise<void>,
  setBounds: (bounds) => {
    ipcRenderer.send(BROWSER_PANEL_CHANNELS.setBounds, bounds);
  },
  goBack: () =>
    ipcRenderer.invoke(BROWSER_PANEL_CHANNELS.goBack) as Promise<void>,
  goForward: () =>
    ipcRenderer.invoke(BROWSER_PANEL_CHANNELS.goForward) as Promise<void>,
  reload: () =>
    ipcRenderer.invoke(BROWSER_PANEL_CHANNELS.reload) as Promise<void>,
  openExternal: (url) =>
    ipcRenderer.invoke(
      BROWSER_PANEL_CHANNELS.openExternal,
      url,
    ) as Promise<void>,
  close: () =>
    ipcRenderer.invoke(BROWSER_PANEL_CHANNELS.close) as Promise<void>,
  onStateChanged: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      state: BrowserPanelState,
    ) => callback(state);
    ipcRenderer.on(BROWSER_PANEL_CHANNELS.stateChanged, listener);
    return () =>
      ipcRenderer.removeListener(BROWSER_PANEL_CHANNELS.stateChanged, listener);
  },
};

installBrowserPanel(api, process.platform);
