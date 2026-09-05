import { contextBridge, ipcRenderer } from 'electron';
import type { HostPublicState, LiveHostApi } from '../shared/host-api.ts';
import type { HostPermissions } from '../shared/protocol.ts';
import { HostAudioEngine } from './audio-engine.ts';

const inputLevelListeners = new Set<(level: number) => void>();
const diagnosticsEnabled = process.env['QWEN_LIVE_DIAGNOSTICS'] === '1';
const audio = new HostAudioEngine(
  (level) => {
    for (const listener of inputLevelListeners) listener(level);
  },
  (event, details) => {
    if (diagnosticsEnabled) {
      ipcRenderer.send('live:audio:diagnostic', { event, details });
    }
  },
  () => {
    if (currentPlaybackEpoch !== undefined) {
      ipcRenderer.send('live:audio:playback-started', currentPlaybackEpoch);
    }
  },
  () => {
    if (currentPlaybackEpoch !== undefined) {
      ipcRenderer.send('live:audio:playback-completed', currentPlaybackEpoch);
    }
  },
);

const invoke = (channel: string, ...args: unknown[]): Promise<void> =>
  ipcRenderer.invoke(channel, ...args) as Promise<void>;

const api: LiveHostApi = {
  toggle: () => invoke('live:toggle'),
  newConversation: () => invoke('live:new-conversation'),
  stop: () => invoke('live:stop'),
  openWebShellForPermission: () => invoke('live:open-web-shell-permission'),
  setInputMuted: (muted) => invoke('live:set-input-muted', muted),
  setOutputMuted: (muted) => invoke('live:set-output-muted', muted),
  requestPermission: (permission: keyof HostPermissions) =>
    invoke('live:request-permission', permission),
  listInputDevices: () => audio.listInputDevices(),
  setInputDevice: (deviceId) => audio.setInputDevice(deviceId),
  onInputLevel: (listener) => {
    inputLevelListeners.add(listener);
    return () => inputLevelListeners.delete(listener);
  },
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
ipcRenderer.on('live:audio:deactivate', () => {
  void audio.dispose();
});
ipcRenderer.on('live:audio:recheck', (_event, reason: string) => {
  void audio.recheck(reason);
});
ipcRenderer.on(
  'live:audio:set-capture',
  (_event, value: { enabled: boolean; muted: boolean; epoch?: number }) => {
    void audio
      .setCapture(value.enabled, value.muted, value.epoch)
      .then(() => {
        if (value.enabled) {
          ipcRenderer.send('live:audio:capture-ready', { epoch: value.epoch });
        }
      })
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
let currentPlaybackEpoch: number | undefined;
ipcRenderer.on(
  'live:audio:play',
  (_event, payload: { audio: Uint8Array; epoch: number }) => {
    currentPlaybackEpoch = payload.epoch;
    void audio.play(payload.audio).catch(() => {
      audio.clearOutput();
      ipcRenderer.send('live:audio:output-error', {
        code: 'audio_output_unavailable',
      });
    });
  },
);
ipcRenderer.on('live:audio:clear', () => audio.clearOutput());

let lastPointerInteractive = false;
let pointerRafPending = false;
let pointerX = 0;
let pointerY = 0;
window.addEventListener('mousemove', (event) => {
  pointerX = event.clientX;
  pointerY = event.clientY;
  if (pointerRafPending) return;
  pointerRafPending = true;
  requestAnimationFrame(() => {
    pointerRafPending = false;
    const element = document.elementFromPoint(pointerX, pointerY);
    const interactive = Boolean(element?.closest('[data-live-interactive]'));
    if (interactive === lastPointerInteractive) return;
    lastPointerInteractive = interactive;
    ipcRenderer.send('live:pointer-interactivity', interactive);
  });
});
window.addEventListener('mouseleave', () => {
  lastPointerInteractive = false;
  ipcRenderer.send('live:pointer-interactivity', false);
});
window.addEventListener('beforeunload', () => void audio.dispose());
