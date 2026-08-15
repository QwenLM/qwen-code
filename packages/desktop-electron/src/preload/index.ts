/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { contextBridge, ipcRenderer } from 'electron';
import {
  BROWSER_PANEL_CHANNELS,
  DESKTOP_LINK_CHANNELS,
  type BrowserPanelApi,
  type BrowserPanelState,
  type DesktopLinkApi,
  type DesktopLinkOpenPreference,
  type QwenCodeDesktopApi,
} from '../shared/browser-panel';

const browserPanel: BrowserPanelApi = {
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
  close: () =>
    ipcRenderer.invoke(BROWSER_PANEL_CHANNELS.close) as Promise<void>,
  onOpenRequested: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, url: string) =>
      callback(url);
    ipcRenderer.on(BROWSER_PANEL_CHANNELS.openRequested, listener);
    return () =>
      ipcRenderer.removeListener(
        BROWSER_PANEL_CHANNELS.openRequested,
        listener,
      );
  },
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

const links: DesktopLinkApi = {
  open: (url, options) =>
    ipcRenderer.invoke(
      DESKTOP_LINK_CHANNELS.open,
      url,
      options,
    ) as Promise<void>,
  getPreference: () =>
    ipcRenderer.invoke(
      DESKTOP_LINK_CHANNELS.getPreference,
    ) as Promise<DesktopLinkOpenPreference>,
  setPreference: (preference) =>
    ipcRenderer.invoke(
      DESKTOP_LINK_CHANNELS.setPreference,
      preference,
    ) as Promise<void>,
};

const api: QwenCodeDesktopApi = { browserPanel, links };
contextBridge.exposeInMainWorld('qwenCodeDesktop', api);
