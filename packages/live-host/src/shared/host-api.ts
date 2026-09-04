import type {
  HostPermissions,
  HostSelfChecks,
  LiveStatus,
} from './protocol.ts';

export type AudioInputDevice = {
  deviceId: string;
  label: string;
  selected: boolean;
};

export type HostPublicState = {
  connection:
    | 'disconnected'
    | 'connecting'
    | 'ready'
    | 'incompatible'
    | 'error';
  connectionError?: string;
  live: LiveStatus;
  permissions: HostPermissions;
  selfChecks: HostSelfChecks;
};

export type LiveHostApi = {
  toggle: () => Promise<void>;
  newConversation: () => Promise<void>;
  stop: () => Promise<void>;
  openWebShellForPermission: () => Promise<void>;
  setInputMuted: (muted: boolean) => Promise<void>;
  setOutputMuted: (muted: boolean) => Promise<void>;
  requestPermission: (permission: keyof HostPermissions) => Promise<void>;
  listInputDevices: () => Promise<AudioInputDevice[]>;
  setInputDevice: (deviceId?: string) => Promise<void>;
  onInputLevel: (listener: (level: number) => void) => () => void;
  getState: () => Promise<HostPublicState>;
  onState: (listener: (state: HostPublicState) => void) => () => void;
};
