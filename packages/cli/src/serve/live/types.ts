/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const LIVE_HOST_PROTOCOL_VERSION = 3 as const;
export const LIVE_HOST_BUNDLE_ID = 'com.alibaba.qwen-code.live-host' as const;
export const LIVE_INPUT_AUDIO_EPOCH_BYTES = 8;

export type LiveState =
  | 'unavailable'
  | 'idle'
  | 'starting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'stopping'
  | 'error';

export type LiveBlocker =
  | 'host_missing'
  | 'host_disconnected'
  | 'host_version'
  | 'microphone_permission'
  | 'accessibility_permission'
  | 'screen_recording_permission'
  | 'audio_input'
  | 'audio_output'
  | 'global_shortcut'
  | 'appshot'
  | 'provider_config'
  | 'provider_unreachable';

export type LiveRequirementState =
  | 'ready'
  | 'missing'
  | 'denied'
  | 'unavailable'
  | 'checking';

export interface LiveSessionLocator {
  workspaceCwd: string;
  sessionId: string;
}

export interface LiveStatus {
  v: 1;
  available: boolean;
  state: LiveState;
  shortcut: string;
  blocker?: LiveBlocker;
  message?: string;
  callId?: string;
  inputMuted?: boolean;
  outputMuted?: boolean;
  transcript?: string;
  coordinator?: LiveSessionLocator;
  workers?: LiveSessionLocator[];
  requirements?: Partial<
    Record<
      | 'host'
      | 'microphone'
      | 'accessibility'
      | 'screenRecording'
      | 'audioInput'
      | 'audioOutput'
      | 'globalShortcut'
      | 'appshot'
      | 'provider',
      LiveRequirementState
    >
  >;
  host?: {
    version?: string;
    protocolVersion?: number;
  };
}

export type LiveHostStatus = Omit<LiveStatus, 'coordinator' | 'workers'>;

export type LivePermissionState = 'granted' | 'denied' | 'not_determined';

export interface LiveHostHello {
  type: 'host.hello';
  protocolVersion: number;
  hostVersion: string;
  bundleId: string;
  instanceNonce: string;
  permissions: {
    microphone: LivePermissionState;
    accessibility: LivePermissionState;
    screenRecording: LivePermissionState;
  };
  selfChecks: {
    audioInput: boolean;
    audioOutput: boolean;
    globalShortcut: boolean;
    appshot: boolean;
  };
}

export type LiveHostAction =
  | {
      type: 'host.action';
      action: 'toggle' | 'new' | 'stop';
      epoch?: number;
    }
  | {
      type: 'host.action';
      action: 'mute';
      inputMuted?: boolean;
      outputMuted?: boolean;
      epoch?: number;
    };

export interface LiveHostPong {
  type: 'host.pong';
  pingId: string;
}

export type LiveHostMessage = LiveHostHello | LiveHostAction | LiveHostPong;

export type LiveDaemonMessage =
  | {
      type: 'host.welcome';
      protocolVersion: typeof LIVE_HOST_PROTOCOL_VERSION;
      daemonInstanceNonce: string;
      heartbeatIntervalMs: number;
      epoch: number;
      status: LiveHostStatus;
    }
  | { type: 'host.state'; epoch: number; status: LiveHostStatus }
  | { type: 'host.ping'; pingId: string }
  | { type: 'host.clear_output'; epoch: number }
  | {
      type: 'host.error';
      code: 'invalid_message' | 'stale_epoch';
      message: string;
    };

export interface LiveMuteUpdate {
  inputMuted?: boolean;
  outputMuted?: boolean;
}

export interface LiveProviderReadiness {
  state: 'ready' | 'checking' | 'unavailable';
  blocker?: Extract<LiveBlocker, 'provider_config' | 'provider_unreachable'>;
  message?: string;
}

export interface LiveAppshotReadiness {
  state: 'ready' | 'checking' | 'unavailable';
  message?: string;
}
