/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { contextBridge, ipcRenderer } from 'electron';
import {
  DESKTOP_CHANNELS,
  type HostSettingsCategory,
  type PetSettings,
  type PetState,
  type QwenCodeHostApi,
  type QwenCodePetApi,
  type SessionChangeReport,
} from '../shared/desktop-api';

const hostApi: QwenCodeHostApi = {
  loadSettings: (language) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.loadHostSettings, language) as Promise<
      HostSettingsCategory[]
    >,
  setSetting: (key, value) =>
    ipcRenderer.invoke(
      DESKTOP_CHANNELS.setHostSetting,
      key,
      value,
    ) as Promise<void>,
  onSettingsChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on(DESKTOP_CHANNELS.hostSettingsChanged, listener);
    return () =>
      ipcRenderer.removeListener(
        DESKTOP_CHANNELS.hostSettingsChanged,
        listener,
      );
  },
  reportStreamingState: (state) => {
    ipcRenderer.send(DESKTOP_CHANNELS.streamingState, state);
  },
  reportSessionChange: (event: SessionChangeReport) => {
    ipcRenderer.send(DESKTOP_CHANNELS.sessionChange, event);
  },
};

const petApi: QwenCodePetApi = {
  getSettings: () =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.petBootstrap) as Promise<PetSettings>,
  onSettingsChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, value: PetSettings) =>
      callback(value);
    ipcRenderer.on(DESKTOP_CHANNELS.petSettingsChanged, listener);
    return () =>
      ipcRenderer.removeListener(DESKTOP_CHANNELS.petSettingsChanged, listener);
  },
  onActivityChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, value: PetState) =>
      callback(value);
    ipcRenderer.on(DESKTOP_CHANNELS.petActivityChanged, listener);
    return () =>
      ipcRenderer.removeListener(DESKTOP_CHANNELS.petActivityChanged, listener);
  },
  setIgnoreMouse: (ignore) => {
    ipcRenderer.send(DESKTOP_CHANNELS.petIgnoreMouse, ignore);
  },
  beginDrag: (screenX, screenY) => {
    ipcRenderer.send(DESKTOP_CHANNELS.petDragStart, screenX, screenY);
  },
  moveDrag: (screenX, screenY) => {
    ipcRenderer.send(DESKTOP_CHANNELS.petDragMove, screenX, screenY);
  },
  endDrag: () => {
    ipcRenderer.send(DESKTOP_CHANNELS.petDragEnd);
  },
  close: () => {
    ipcRenderer.send(DESKTOP_CHANNELS.petClose);
  },
};

contextBridge.exposeInMainWorld('qwenCodeHost', hostApi);
contextBridge.exposeInMainWorld('qwenCodePet', petApi);
