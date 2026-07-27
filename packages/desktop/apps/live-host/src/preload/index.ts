import { contextBridge, ipcRenderer } from 'electron';
import type { HostPublicState, LiveHostApi } from '../shared/host-api.ts';
import type { HostPermissions, SessionLocator } from '../shared/protocol.ts';
import { HostAudioEngine } from './audio-engine.ts';

const audio = new HostAudioEngine();

const invoke = (channel: string, ...args: unknown[]): Promise<void> =>
  ipcRenderer.invoke(channel, ...args) as Promise<void>;

const api: LiveHostApi = {
  toggle: () => invoke('live:toggle'),
  newConversation: () => invoke('live:new-conversation'),
  stop: () => invoke('live:stop'),
  setInputMuted: (muted) => invoke('live:set-input-muted', muted),
  setOutputMuted: (muted) => invoke('live:set-output-muted', muted),
  openSession: (locator: SessionLocator) =>
    invoke('live:open-session', locator),
  requestPermission: (permission: keyof HostPermissions) =>
    invoke('live:request-permission', permission),
  getState: () =>
    ipcRenderer.invoke('live:get-state') as Promise<HostPublicState>,
  onState: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      state: HostPublicState,
    ) => {
      listener(state);
    };
    ipcRenderer.on('live:state', handler);
    return () => ipcRenderer.removeListener('live:state', handler);
  },
};

contextBridge.exposeInMainWorld('qwenLiveHost', api);

ipcRenderer.on(
  'live:audio:initialize',
  (_event, microphoneAllowed: boolean) => {
    void audio.initialize(microphoneAllowed);
  },
);
ipcRenderer.on(
  'live:audio:set-capture',
  (_event, value: { enabled: boolean; muted: boolean; epoch?: number }) => {
    void audio
      .setCapture(value.enabled, value.muted, value.epoch)
      .catch((error: unknown) => {
        ipcRenderer.send('live:audio:capture-error', {
          code:
            error instanceof DOMException
              ? error.name
              : 'audio_input_unavailable',
        });
      });
  },
);
ipcRenderer.on('live:audio:set-output-muted', (_event, muted: boolean) => {
  audio.setOutputMuted(muted);
});
ipcRenderer.on('live:audio:play', (_event, frame: Uint8Array) => {
  void audio.play(frame).catch(() => {
    ipcRenderer.send('live:audio:output-error');
  });
});
ipcRenderer.on('live:audio:clear', () => audio.clearOutput());

window.addEventListener('mousemove', (event) => {
  const element = document.elementFromPoint(event.clientX, event.clientY);
  ipcRenderer.send(
    'live:pointer-interactivity',
    Boolean(element?.closest('[data-live-interactive]')),
  );
});
window.addEventListener('mouseleave', () => {
  ipcRenderer.send('live:pointer-interactivity', false);
});
window.addEventListener('beforeunload', () => void audio.dispose());
