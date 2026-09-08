/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const LIVE_HOST_PROTOCOL_VERSION = 9 as const;
export const LIVE_HOST_BUNDLE_ID = 'com.alibaba.qwen-code.live-host' as const;

export type LiveVisualSource = 'screen' | 'camera';
export type LiveVisualMode = 'on-demand' | 'live-feed';

export interface LiveMemoryState {
  enabled: boolean;
  visualEnabled: boolean;
  libraryId: string;
  model: string;
  libraries: Array<{ id: string; name: string }>;
  locked: boolean;
  error?: string;
}

export type LiveMemoryAction =
  | { action: 'set_enabled'; enabled: boolean }
  | { action: 'set_visual_enabled'; enabled: boolean }
  | { action: 'select'; libraryId: string }
  | { action: 'create'; name: string }
  | { action: 'rename'; libraryId: string; name: string }
  | { action: 'set_model'; model: string };

export type LiveHostMemoryAction = LiveMemoryAction & {
  type: 'host.memory_action';
  requestId: string;
  epoch: number;
};

export type LiveMemoryResult =
  | {
      type: 'host.memory_result';
      requestId: string;
      ok: true;
      memory: LiveMemoryState;
    }
  | {
      type: 'host.memory_result';
      requestId: string;
      ok: false;
      error: string;
      memory?: LiveMemoryState;
    };

export interface LiveVisualInput {
  source: LiveVisualSource;
  mode: LiveVisualMode;
  fps: number;
  cameraWidth?: number;
  cameraHeight?: number;
  cameraSnapshotWidth?: number;
  cameraSnapshotHeight?: number;
  liveWidth: number;
  liveHeight: number;
  snapshotWidth?: number;
  snapshotHeight?: number;
}
export const LIVE_INPUT_AUDIO_EPOCH_BYTES = 8;
export const LIVE_OUTPUT_AUDIO_EPOCH_BYTES = 8;
export const LIVE_OUTPUT_AUDIO_ID_BYTES = 8;
export const LIVE_OUTPUT_AUDIO_HEADER_BYTES =
  LIVE_OUTPUT_AUDIO_EPOCH_BYTES + LIVE_OUTPUT_AUDIO_ID_BYTES;

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
  | 'camera_permission'
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
      | 'camera'
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
  capabilities?: {
    outputAudioEndMarkerV1: true;
  };
  permissions: {
    microphone: LivePermissionState;
    camera: LivePermissionState;
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

export interface LiveHostPlaybackStarted {
  type: 'host.playback_started';
  epoch: number;
  outputId: number;
}

export interface LiveHostPlaybackCompleted {
  type: 'host.playback_completed';
  epoch: number;
  outputId: number;
}

export interface LiveHostVisualFrame {
  type: 'host.visual_frame';
  epoch: number;
  source: LiveVisualSource;
  image: string;
}

export interface LiveHostVisualSettings {
  type: 'host.visual_settings';
  epoch: number;
  source: LiveVisualSource;
  mode: LiveVisualMode;
  permissions: {
    camera: LivePermissionState;
    accessibility: LivePermissionState;
    screenRecording: LivePermissionState;
  };
  appshot: boolean;
}

export type LiveHostVisualCaptureResult =
  | {
      type: 'host.visual_capture_result';
      requestId: string;
      success: true;
      source: 'screen';
      image: string;
      width: number;
      height: number;
      appName: string;
      windowTitle?: string;
      accessibilityText: string;
      screenshotPath?: string;
    }
  | {
      type: 'host.visual_capture_result';
      requestId: string;
      success: true;
      source: 'camera';
      image: string;
      width: number;
      height: number;
      screenshotPath?: string;
    }
  | {
      type: 'host.visual_capture_result';
      requestId: string;
      success: false;
      error: string;
    };

export type LiveLanguageState = { language: 'en' | 'zh-CN' };
export type LiveHostLanguageAction = {
  type: 'host.language_action';
  requestId: string;
  epoch: number;
  language: LiveLanguageState['language'];
};
export type LiveLanguageResult =
  | {
      type: 'host.language_result';
      requestId: string;
      ok: true;
      uiLanguageV1: LiveLanguageState;
    }
  | {
      type: 'host.language_result';
      requestId: string;
      ok: false;
      error: string;
      uiLanguageV1?: LiveLanguageState;
    };

export type LiveHostMessage =
  | LiveHostHello
  | LiveHostAction
  | LiveHostMemoryAction
  | LiveHostPong
  | LiveHostShortcutResult
  | LiveHostPlaybackStarted
  | LiveHostPlaybackCompleted
  | LiveHostVisualFrame
  | LiveHostVisualSettings
  | LiveHostVisualCaptureResult;

export type LiveDaemonMessage =
  | {
      type: 'host.welcome';
      protocolVersion: typeof LIVE_HOST_PROTOCOL_VERSION;
      daemonInstanceNonce: string;
      daemonShutdownV1?: true;
      uiLanguageV1?: LiveLanguageState;
      heartbeatIntervalMs: number;
      epoch: number;
      capabilities?: {
        outputAudioEndMarkerV1: true;
      };
      visualInput?: LiveVisualInput;
      memory?: LiveMemoryState;
      status: LiveHostStatus;
    }
  | {
      type: 'host.state';
      epoch: number;
      uiLanguageV1?: LiveLanguageState;
      visualInput?: LiveVisualInput;
      memory?: LiveMemoryState;
      status: LiveHostStatus;
    }
  | LiveMemoryResult
  | LiveLanguageResult
  | { type: 'host.ping'; pingId: string }
  | { type: 'host.clear_output'; epoch: number }
  | { type: 'host.output_audio_finished'; epoch: number; outputId: number }
  | { type: 'host.set_shortcut'; requestId: string; shortcut: string }
  | {
      type: 'host.capture_visual';
      requestId: string;
      epoch: number;
      source: LiveVisualSource;
      snapshotWidth?: number;
      snapshotHeight?: number;
      persistAsset?: boolean;
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
