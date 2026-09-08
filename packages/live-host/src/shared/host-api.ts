import type {
  HostPermissions,
  HostSelfChecks,
  LiveStatus,
  MemoryAction,
  MemoryState,
  VisualInput,
  VisualMode,
  VisualSource,
} from './protocol.ts';
import type { OverlayLayout } from './overlay-geometry.ts';
import type { LiveLanguage } from '@qwen-code/qwen-live/i18n';
import type { SubagentsSnapshot } from '@qwen-code/qwen-live/subagents';
import type { LiveTheme, ResolvedTheme } from './theme.ts';

export type HostPublicPermissions = HostPermissions;

export type AudioInputDevice = {
  deviceId: string;
  label: string;
  selected: boolean;
};

export type OverlayOffset = { x: number; y: number };

export type HostPublicState = {
  theme?: LiveTheme;
  resolvedTheme?: ResolvedTheme;
  language?: LiveLanguage;
  connection:
    | 'disconnected'
    | 'connecting'
    | 'ready'
    | 'incompatible'
    | 'error';
  connectionError?: string;
  canOpenConfig?: boolean;
  quitState?: 'pending' | 'failed';
  overlayOffset?: OverlayOffset;
  visualInput?: VisualInput;
  memory?: MemoryState;
  subagentsV1?: SubagentsSnapshot;
  live: LiveStatus;
  permissions: HostPublicPermissions;
  selfChecks: HostSelfChecks;
  visualReady: boolean;
  visualError?: string;
};

export type LiveHostApi = {
  toggle: () => Promise<void>;
  newConversation: () => Promise<void>;
  stop: () => Promise<void>;
  openWebShellForPermission: () => Promise<void>;
  setInputMuted: (muted: boolean) => Promise<void>;
  setOutputMuted: (muted: boolean) => Promise<void>;
  setVisualSource: (source: VisualSource) => Promise<void>;
  setVisualMode: (mode: VisualMode) => Promise<void>;
  memoryAction: (action: MemoryAction) => Promise<MemoryState>;
  setLanguage: (language: LiveLanguage) => Promise<void>;
  setTheme: (theme: LiveTheme) => Promise<void>;
  setSettingsOpen: (open: boolean) => Promise<void>;
  openConfig: () => Promise<void>;
  setOverlayLayout: (layout: OverlayLayout) => void;
  onSettingsDismiss: (listener: () => void) => () => void;
  onOverlayOffset: (listener: (offset: OverlayOffset) => void) => () => void;
  dragOverlay: (phase: 'start' | 'move' | 'end', x: number, y: number) => void;
  quit: () => Promise<void>;
  attachCameraPreview: () => void;
  requestPermission: (permission: keyof HostPublicPermissions) => Promise<void>;
  listInputDevices: () => Promise<AudioInputDevice[]>;
  setInputDevice: (deviceId?: string) => Promise<void>;
  onInputLevel: (listener: (level: number) => void) => () => void;
  getState: () => Promise<HostPublicState>;
  onState: (listener: (state: HostPublicState) => void) => () => void;
  setSubagentsHover?: (hovered: boolean) => void;
  setSubagentsKeyboardHeld?: (held: boolean) => void;
};
