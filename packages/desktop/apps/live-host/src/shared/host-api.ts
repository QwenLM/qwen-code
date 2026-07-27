import type {
  HostPermissions,
  HostSelfChecks,
  LiveStatus,
  SessionLocator,
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
};

export type LiveHostApi = {
  toggle: () => Promise<void>;
  newConversation: () => Promise<void>;
  stop: () => Promise<void>;
  setInputMuted: (muted: boolean) => Promise<void>;
  setOutputMuted: (muted: boolean) => Promise<void>;
  openSession: (locator: SessionLocator) => Promise<void>;
  requestPermission: (permission: keyof HostPermissions) => Promise<void>;
  getState: () => Promise<HostPublicState>;
  onState: (listener: (state: HostPublicState) => void) => () => void;
};
