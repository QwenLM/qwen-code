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
import {
  COMPUTER_USE_CHANNELS,
  type ComputerUseApi,
  type ComputerUseSurfaceState,
} from '../shared/computer-use';
import { installComputerUseControl } from './computer-use';

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

const computerUseApi: ComputerUseApi = {
  onStateChanged: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      state: ComputerUseSurfaceState,
    ) => callback(state);
    ipcRenderer.on(COMPUTER_USE_CHANNELS.stateChanged, listener);
    return () =>
      ipcRenderer.removeListener(COMPUTER_USE_CHANNELS.stateChanged, listener);
  },
  setAlwaysHidePictureInPicture: (hidden) =>
    ipcRenderer.invoke(
      COMPUTER_USE_CHANNELS.setAlwaysHidePictureInPicture,
      hidden,
    ) as Promise<void>,
  setPictureInPictureVisible: (visible) =>
    ipcRenderer.invoke(
      COMPUTER_USE_CHANNELS.setPictureInPictureVisible,
      visible,
    ) as Promise<void>,
  stop: () => ipcRenderer.invoke(COMPUTER_USE_CHANNELS.stop) as Promise<void>,
};

installBrowserPanel(api, process.platform);
installComputerUseControl(computerUseApi);
