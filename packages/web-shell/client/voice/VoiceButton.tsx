/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useWorkspace } from '@qwen-code/webui/daemon-react-sdk';
import { useVoiceCapture } from './useVoiceCapture';

/** Daemon capability tag gating the mic (see serve/capabilities.ts). */
const VOICE_FEATURE = 'voice_transcribe';

export interface VoiceButtonProps {
  /** Insert the final transcript into the composer (user reviews, then sends). */
  onInsert: (text: string) => void;
  disabled?: boolean;
}

const MicIcon = (): React.JSX.Element => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    aria-hidden="true"
    fill="currentColor"
  >
    <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3Z" />
    <path d="M17 11a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z" />
  </svg>
);

const StopIcon = (): React.JSX.Element => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    aria-hidden="true"
    fill="currentColor"
  >
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </svg>
);

export function VoiceButton({
  onInsert,
  disabled,
}: VoiceButtonProps): React.JSX.Element | null {
  const workspace = useWorkspace();
  const features = workspace.capabilities?.features ?? [];
  const [noticeMessage, setNoticeMessage] = React.useState<string | undefined>(
    undefined,
  );

  const { status, interimText, audioLevel, errorMessage, start, stop, abort } =
    useVoiceCapture({
      baseUrl: workspace.baseUrl,
      token: workspace.token,
      onFinal: (text) => {
        const trimmed = text.trim();
        if (trimmed) {
          setNoticeMessage(undefined);
          onInsert(trimmed);
        } else {
          setNoticeMessage('No speech detected.');
        }
      },
    });

  // Only render when the daemon advertises a usable voice model.
  if (!features.includes(VOICE_FEATURE)) return null;

  const isRecording = status === 'recording';
  const isConnecting = status === 'connecting';
  const isTranscribing = status === 'transcribing';
  const isError = status === 'error';
  const isBusy = isConnecting || isTranscribing;
  const canCancel = isRecording || isConnecting;
  const isButtonDisabled = isTranscribing || (Boolean(disabled) && !canCancel);
  const isNotice = Boolean(noticeMessage) && !isError;

  const handleClick = () => {
    if (isRecording) {
      stop();
    } else if (isConnecting) {
      abort();
    } else if (disabled) {
      return;
    } else if (!isBusy) {
      // idle or error -> (re)start
      setNoticeMessage(undefined);
      start();
    }
  };

  const label = isRecording
    ? 'Stop dictation'
    : isTranscribing
      ? 'Transcribing…'
      : isConnecting
        ? 'Starting…'
        : isError
          ? `Voice error — click to retry${errorMessage ? `: ${errorMessage}` : ''}`
          : isNotice
            ? 'No speech detected — click to retry'
            : 'Start voice dictation';

  // Amplify the raw RMS for a livelier meter, clamped to [0, 1].
  const level = Math.min(1, audioLevel * 8);

  return (
    <div
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
      }}
    >
      <button
        type="button"
        onClick={handleClick}
        disabled={isButtonDisabled}
        aria-label={label}
        title={errorMessage ?? noticeMessage ?? label}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 4,
          width: isRecording ? 'auto' : 28,
          height: 28,
          padding: isRecording ? '0 8px' : 0,
          borderRadius: 14,
          border: '1px solid var(--border-color, rgba(127,127,127,0.4))',
          cursor: isButtonDisabled ? 'default' : 'pointer',
          background: isRecording
            ? 'var(--error-color, #d9534f)'
            : 'transparent',
          color: isRecording
            ? '#fff'
            : status === 'error'
              ? 'var(--error-color, #d9534f)'
              : 'var(--text-secondary, currentColor)',
          opacity: disabled && !canCancel ? 0.5 : 1,
          transition: 'background 0.15s, color 0.15s',
        }}
      >
        {isRecording ? <StopIcon /> : <MicIcon />}
        {isRecording && (
          <span
            aria-hidden="true"
            style={{
              display: 'inline-block',
              width: 24,
              height: 8,
              borderRadius: 4,
              background: 'rgba(255,255,255,0.35)',
              position: 'relative',
              overflow: 'hidden',
            }}
          >
            <span
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                bottom: 0,
                width: `${Math.round(level * 100)}%`,
                background: '#fff',
                transition: 'width 0.08s linear',
              }}
            />
          </span>
        )}
        {isTranscribing && <span style={{ fontSize: 11 }}>…</span>}
      </button>
      {((isRecording && interimText) ||
        isTranscribing ||
        isError ||
        isNotice) && (
        <div
          style={{
            position: 'absolute',
            bottom: '120%',
            right: 0,
            width: 'max-content',
            maxWidth: 280,
            padding: '4px 8px',
            borderRadius: 6,
            fontSize: 12,
            whiteSpace: isError || isNotice ? 'normal' : 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            lineHeight: 1.4,
            background: isError
              ? 'var(--error-color, #d9534f)'
              : 'var(--background-secondary, rgba(0,0,0,0.8))',
            color: '#fff',
            boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
            pointerEvents: 'none',
          }}
        >
          {isError
            ? errorMessage || 'Voice error'
            : isNotice
              ? noticeMessage
              : isTranscribing
                ? 'Transcribing…'
                : interimText}
        </div>
      )}
    </div>
  );
}
