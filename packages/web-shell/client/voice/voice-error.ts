/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { getTranslator } from '../i18n';

// Keep the transport vocabulary compatible with existing daemons.
const ERROR_KEYS: Record<string, string> = {
  'No voice model is configured for this workspace.': 'voice.error.noModel',
  'Voice transcription failed. Please try again.': 'voice.error.transcription',
  'Voice transcription failed.': 'voice.error.transcription',
  'Too many voice sessions in progress; try again shortly.':
    'voice.error.tooManySessions',
  'Microphone blocked. Click the camera/lock icon in the address bar to allow the mic for this site, and enable your browser under System Settings → Privacy → Microphone, then retry.':
    'voice.error.microphoneBlocked',
  'No microphone found. Connect one and retry.': 'voice.error.noMicrophone',
  'Microphone is in use by another app. Close it and retry.':
    'voice.error.microphoneInUse',
  'Microphone capture is not supported in this browser.':
    'voice.error.unsupportedBrowser',
  'Microphone needs a secure context — open the Web Shell via localhost/127.0.0.1 or https.':
    'voice.error.insecureContext',
  'Voice capture timed out while starting.': 'voice.error.startTimeout',
  'Voice capture buffer limit reached while starting.':
    'voice.error.bufferLimit',
  'No response from server. Check that the voice model is running.':
    'voice.error.noResponse',
  'Voice capacity is temporarily unavailable. Retry shortly.':
    'voice.error.capacityUnavailable',
  'Transcription timed out.': 'voice.error.transcriptionTimeout',
  'Failed to finalize voice transcription.': 'voice.error.finalize',
  'Voice session exceeded the time limit.': 'voice.error.sessionTimeLimit',
  'Recording is too long for transcription (max ~5 minutes).':
    'voice.error.recordingTooLong',
  'Queued voice audio exceeded the memory limit.': 'voice.error.queueLimit',
  'Voice error': 'voice.error',
};

const CLOSE_REASON_KEYS: Record<string, string> = {
  none: 'voice.closeReason.none',
  busy: 'voice.closeReason.busy',
  'Connection cap': 'voice.closeReason.connectionLimit',
  'Server shutting down': 'voice.closeReason.serverShutdown',
  'Workspace removed': 'voice.closeReason.workspaceRemoved',
  'Workspace trust reconfigured': 'voice.closeReason.trustChanged',
  'Workspace runtime reconfigured': 'voice.closeReason.runtimeChanged',
  'voice error': 'voice.closeReason.voiceError',
};

export function formatVoiceError(
  message: string | undefined,
  t: ReturnType<typeof getTranslator>,
): string {
  if (message === undefined) return t('voice.error');
  const key = Object.hasOwn(ERROR_KEYS, message)
    ? ERROR_KEYS[message]
    : Object.hasOwn(CLOSE_REASON_KEYS, message)
      ? CLOSE_REASON_KEYS[message]
      : undefined;
  if (key) return t(key);

  const rate =
    /^Browser audio rate (\d+) Hz is not the required (\d+) Hz\.$/.exec(
      message,
    );
  if (rate) {
    return t('voice.error.sampleRate', { actual: rate[1], required: rate[2] });
  }

  const close =
    /^Voice connection closed \(code=(\d+), reason=([\s\S]*)\)\.$/.exec(
      message,
    );
  if (close) {
    const reasonKey = Object.hasOwn(CLOSE_REASON_KEYS, close[2])
      ? CLOSE_REASON_KEYS[close[2]]
      : 'voice.closeReason.unknown';
    return t('voice.error.connectionClosed', {
      code: close[1],
      reason: t(reasonKey),
    });
  }
  return t('voice.error.transcription');
}
