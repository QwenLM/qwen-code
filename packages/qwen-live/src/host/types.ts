/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const LIVE_HOST_PROTOCOL_VERSION = 7 as const;
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
  workspaceId?: string;
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
  caption?: string;
  statusText?: string;
  pendingPermission?: {
    workspaceId: string;
    sessionId: string;
  };
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

export type LiveHostStatus = LiveStatus;

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

export interface LiveHostShortcutResult {
  type: 'host.shortcut_result';
  requestId: string;
  shortcut: string;
  success: boolean;
  error?: string;
}

export type LiveHostScreenContextResult =
  | {
      type: 'host.screen_context_result';
      requestId: string;
      success: true;
      appName: string;
      windowTitle?: string;
      accessibilityText: string;
      screenshotPath: string;
    }
  | {
      type: 'host.screen_context_result';
      requestId: string;
      success: false;
      error: string;
    };

export interface LiveHostPlaybackStarted {
  type: 'host.playback_started';
  epoch: number;
}

export interface LiveHostPlaybackCompleted {
  type: 'host.playback_completed';
  epoch: number;
}

export type LiveHostMessage =
  | LiveHostHello
  | LiveHostAction
  | LiveHostPong
  | LiveHostShortcutResult
  | LiveHostScreenContextResult
  | LiveHostPlaybackStarted
  | LiveHostPlaybackCompleted;

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
  | { type: 'host.set_shortcut'; requestId: string; shortcut: string }
  | {
      type: 'host.capture_screen_context';
      requestId: string;
      epoch: number;
    }
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
