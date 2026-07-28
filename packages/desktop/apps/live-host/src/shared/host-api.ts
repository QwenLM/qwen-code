import type {
  HostPermissions,
  HostSelfChecks,
  LiveStatus,
} from './protocol.ts';

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
  cuaInstalled: boolean;
};

export type LiveHostApi = {
  toggle: () => Promise<void>;
  newConversation: () => Promise<void>;
  stop: () => Promise<void>;
  setInputMuted: (muted: boolean) => Promise<void>;
  setOutputMuted: (muted: boolean) => Promise<void>;
  requestPermission: (permission: keyof HostPermissions) => Promise<void>;
  getState: () => Promise<HostPublicState>;
  onState: (listener: (state: HostPublicState) => void) => () => void;
};
