import { contextBridge, ipcRenderer } from 'electron';
import type {
  SubagentsWindowApi,
  SubagentsWindowState,
} from '../shared/subagents-api.ts';

const api: SubagentsWindowApi = {
  getState: () =>
    ipcRenderer.invoke(
      'live:subagents:get-state',
    ) as Promise<SubagentsWindowState>,
  onState: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      state: SubagentsWindowState,
    ) => listener(state);
    ipcRenderer.on('live:subagents:state', handler);
    return () => ipcRenderer.removeListener('live:subagents:state', handler);
  },
  setHover: (hovered) => ipcRenderer.send('live:subagents:hover', hovered),
  setKeyboardHeld: (held) => ipcRenderer.send('live:subagents:keyboard', held),
  back: () => ipcRenderer.invoke('live:subagents:back') as Promise<void>,
  expand: () => ipcRenderer.invoke('live:subagents:expand') as Promise<void>,
  close: () => ipcRenderer.send('live:subagents:close'),
  openDetail: (id) =>
    ipcRenderer.invoke('live:subagents:detail', id) as Promise<void>,
};
contextBridge.exposeInMainWorld('qwenLiveSubagents', api);
