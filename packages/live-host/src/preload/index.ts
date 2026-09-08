import { contextBridge, ipcRenderer } from 'electron';
import type {
  HostPublicPermissions,
  HostPublicState,
  LiveHostApi,
  OverlayOffset,
} from '../shared/host-api.ts';
import { isLiveHostDiagnosticsEnabled } from '../shared/diagnostics.ts';
import type { MemoryState } from '../shared/protocol.ts';
import { HostAudioEngine } from './audio-engine.ts';
import { HostCameraEngine } from './camera-engine.ts';

const inputLevelListeners = new Set<(level: number) => void>();
const diagnosticsEnabled = isLiveHostDiagnosticsEnabled(
  process.argv,
  process.env,
);
const audio = new HostAudioEngine(
  (level) => {
    for (const listener of inputLevelListeners) listener(level);
  },
  (event, details) => {
    if (diagnosticsEnabled) {
      ipcRenderer.send('live:audio:diagnostic', { event, details });
    }
  },
  (identity) => {
    ipcRenderer.send('live:audio:playback-started', identity);
  },
  (identity) => {
    ipcRenderer.send('live:audio:playback-completed', identity);
  },
);
const camera = new HostCameraEngine(
  (frame) => ipcRenderer.send('live:camera:frame', frame),
  (epoch) => ipcRenderer.send('live:camera:ready', epoch),
  (code) => ipcRenderer.send('live:camera:capture-error', { code }),
  (event, details) => {
    if (diagnosticsEnabled) {
      ipcRenderer.send('live:camera:diagnostic', { event, details });
    }
  },
);

const invoke = (channel: string, ...args: unknown[]): Promise<void> =>
  ipcRenderer.invoke(channel, ...args) as Promise<void>;

const api: LiveHostApi = {
  setSubagentsHover: (hovered) =>
    ipcRenderer.send('live:subagents:orb-hover', hovered),
  setSubagentsKeyboardHeld: (held) =>
    ipcRenderer.send('live:subagents:orb-keyboard', held),
  toggle: () => invoke('live:toggle'),
  newConversation: () => invoke('live:new-conversation'),
  stop: () => invoke('live:stop'),
  openWebShellForPermission: () => invoke('live:open-web-shell-permission'),
  setInputMuted: (muted) => invoke('live:set-input-muted', muted),
  setOutputMuted: (muted) => invoke('live:set-output-muted', muted),
  setVisualSource: (source) => invoke('live:set-visual-source', source),
  setVisualMode: (mode) => invoke('live:set-visual-mode', mode),
  memoryAction: (action) =>
    ipcRenderer.invoke('live:memory-action', action) as Promise<MemoryState>,
  setLanguage: (language) => invoke('live:set-language', language),
  setTheme: (theme) => invoke('live:set-theme', theme),
  setSettingsOpen: (open) => invoke('live:settings-open', open),
  setOverlayLayout: (layout) => ipcRenderer.send('live:overlay-layout', layout),
  onSettingsDismiss: (listener) => {
    const handler = () => listener();
    ipcRenderer.on('live:settings-dismiss', handler);
    return () => ipcRenderer.removeListener('live:settings-dismiss', handler);
  },
  onOverlayOffset: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      offset: OverlayOffset,
    ) => listener(offset);
    ipcRenderer.on('live:overlay-offset', handler);
    return () => ipcRenderer.removeListener('live:overlay-offset', handler);
  },
  dragOverlay: (phase, x, y) =>
    ipcRenderer.send('live:drag-overlay', phase, x, y),
  quit: () => invoke('live:quit'),
  attachCameraPreview: () => camera.attachPreview(),
  requestPermission: (permission: keyof HostPublicPermissions) =>
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
ipcRenderer.on(
  'live:audio:set-output-end-marker-mode',
  (_event, enabled: boolean) => {
    audio.setOutputEndMarkerMode(enabled);
  },
);
ipcRenderer.on(
  'live:audio:play',
  (_event, payload: { audio: Uint8Array; epoch: number; outputId: number }) => {
    void audio
      .play(payload.audio, {
        epoch: payload.epoch,
        outputId: payload.outputId,
      })
      .catch(() => {
        audio.clearOutput();
        ipcRenderer.send('live:audio:output-error', {
          code: 'audio_output_unavailable',
        });
      });
  },
);
ipcRenderer.on(
  'live:audio:output-finished',
  (_event, identity: { epoch: number; outputId: number }) => {
    void audio.finishOutputAudio(identity);
  },
);
ipcRenderer.on('live:audio:clear', () => audio.clearOutput());
ipcRenderer.on(
  'live:camera:set-capture',
  (
    _event,
    value: {
      enabled: boolean;
      settings?: Parameters<HostCameraEngine['setCapture']>[1];
    },
  ) => {
    void camera
      .setCapture(value.enabled, value.settings)
      .catch((error: unknown) => {
        ipcRenderer.send('live:camera:capture-error', {
          code:
            error instanceof DOMException ? error.name : 'camera_unavailable',
        });
      });
  },
);
ipcRenderer.on(
  'live:camera:capture-once',
  async (
    _event,
    value: { requestId: string } & NonNullable<
      Parameters<HostCameraEngine['captureSnapshot']>[0]
    >,
  ) => {
    try {
      const frame = await camera.captureSnapshot(value);
      ipcRenderer.send('live:camera:snapshot-result', {
        requestId: value.requestId,
        success: true,
        ...frame,
      });
    } catch (error) {
      ipcRenderer.send('live:camera:snapshot-result', {
        requestId: value.requestId,
        success: false,
        error:
          error instanceof DOMException
            ? error.name
            : error instanceof Error
              ? error.message.slice(0, 128)
              : 'camera_snapshot_failed',
      });
    }
  },
);
ipcRenderer.on('live:camera:deactivate', () => camera.dispose());

let lastPointerInteractive: boolean | undefined;
let pointerRafPending = false;
let pointerX = 0;
let pointerY = 0;
let pointerPresent = false;
function refreshPointerInteractivity(): void {
  if (pointerRafPending) return;
  pointerRafPending = true;
  requestAnimationFrame(() => {
    pointerRafPending = false;
    const element = pointerPresent
      ? document.elementFromPoint(pointerX, pointerY)
      : null;
    const interactive = Boolean(
      element?.closest('[data-live-interactive], [data-live-drag]'),
    );
    if (interactive === lastPointerInteractive) return;
    lastPointerInteractive = interactive;
    ipcRenderer.send('live:pointer-interactivity', interactive);
  });
}
window.addEventListener('mousemove', (event) => {
  pointerX = event.clientX;
  pointerY = event.clientY;
  pointerPresent = true;
  refreshPointerInteractivity();
});
window.addEventListener('mouseleave', () => {
  pointerPresent = false;
  refreshPointerInteractivity();
});
window.addEventListener('blur', () => {
  pointerPresent = false;
  lastPointerInteractive = undefined;
  refreshPointerInteractivity();
});
const pointerObserver = new MutationObserver(refreshPointerInteractivity);
pointerObserver.observe(document, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: [
    'class',
    'style',
    'hidden',
    'disabled',
    'inert',
    'data-live-interactive',
    'data-live-drag',
  ],
});
window.addEventListener('beforeunload', () => {
  pointerObserver.disconnect();
  camera.dispose();
  void audio.dispose();
});
