/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { useWorkspace } from '@qwen-code/webui/daemon-react-sdk';
import { useVoiceCapture } from './useVoiceCapture';
import styles from './VoiceButton.module.css';

/** Daemon capability tag gating the mic (see serve/capabilities.ts). */
const VOICE_FEATURE = 'voice_transcribe';
/** Live waveform bar count in the recording pill. */
const BAR_COUNT = 16;

export interface VoiceButtonProps {
  /** Insert the final transcript into the composer (user reviews, then sends). */
  onInsert: (text: string) => void;
  disabled?: boolean;
}

const MicIcon = (): React.JSX.Element => (
  <svg
    width="18"
    height="18"
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
    width="13"
    height="13"
    viewBox="0 0 24 24"
    aria-hidden="true"
    fill="currentColor"
  >
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </svg>
);

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const mm = Math.floor(total / 60);
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

export function VoiceButton({
  onInsert,
  disabled,
}: VoiceButtonProps): React.JSX.Element | null {
  const workspace = useWorkspace();
  const features = workspace.capabilities?.features ?? [];
  // Surfaced when a recording finalizes with no transcript (e.g. silence).
  const [noticeMessage, setNoticeMessage] = useState<string | undefined>(
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

  const isRecording = status === 'recording';

  // Rolling waveform history, fed by the live RMS meter while recording.
  const [levels, setLevels] = useState<number[]>(() =>
    new Array(BAR_COUNT).fill(0),
  );
  useEffect(() => {
    if (!isRecording) {
      setLevels(new Array(BAR_COUNT).fill(0));
      return;
    }
    // Amplify the raw RMS for a livelier meter, clamped to [0, 1].
    setLevels((prev) => [...prev.slice(1), Math.min(1, audioLevel * 8)]);
  }, [audioLevel, isRecording]);

  // Elapsed timer, reset on each recording session.
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (!isRecording) {
      setElapsedMs(0);
      return;
    }
    const startedAt = performance.now();
    const id = setInterval(
      () => setElapsedMs(performance.now() - startedAt),
      200,
    );
    return () => clearInterval(id);
  }, [isRecording]);

  // Only render when the daemon advertises a usable voice model.
  if (!features.includes(VOICE_FEATURE)) return null;

  const isConnecting = status === 'connecting';
  const isTranscribing = status === 'transcribing';
  const isError = status === 'error';
  const isNotice = Boolean(noticeMessage) && !isError;
  // Stopping/aborting an in-progress capture must stay available even when the
  // composer is disabled (e.g. mid-turn) — only starting a new one is blocked.
  const canCancel = isRecording || isConnecting;

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

  let control: React.JSX.Element;
  if (isRecording) {
    control = (
      <button
        type="button"
        className={styles.pill}
        onClick={() => stop()}
        aria-label={label}
        title={label}
      >
        <span className={styles.recDot} aria-hidden="true" />
        <span className={styles.wave} aria-hidden="true">
          {levels.map((lvl, i) => (
            <span
              key={i}
              className={styles.bar}
              style={{ height: `${2 + Math.round(lvl * 14)}px` }}
            />
          ))}
        </span>
        <span className={styles.time}>{formatElapsed(elapsedMs)}</span>
        <span className={styles.stop} aria-hidden="true">
          <StopIcon />
        </span>
      </button>
    );
  } else if (isTranscribing) {
    control = (
      <span
        className={`${styles.pill} ${styles.transcribing}`}
        role="status"
        aria-label={label}
      >
        <span className={styles.spinner} aria-hidden="true" />
        <span className={styles.time}>…</span>
      </span>
    );
  } else {
    // idle / connecting / error / notice → icon button
    const iconClass = [
      styles.iconBtn,
      isError ? styles.error : '',
      isConnecting ? styles.connecting : '',
    ]
      .filter(Boolean)
      .join(' ');
    control = (
      <button
        type="button"
        className={iconClass}
        onClick={() => {
          if (isConnecting) {
            abort();
          } else if (disabled) {
            return;
          } else {
            // idle / error / notice → (re)start
            setNoticeMessage(undefined);
            start();
          }
        }}
        disabled={Boolean(disabled) && !canCancel}
        aria-label={label}
        title={errorMessage ?? noticeMessage ?? label}
      >
        <MicIcon />
      </button>
    );
  }

  const showInterim = (isRecording && interimText) || isError || isNotice;

  return (
    <span className={styles.root}>
      {control}
      {showInterim && (
        <span
          role="status"
          aria-live="polite"
          className={`${styles.interim}${isError ? ` ${styles.error}` : ''}`}
        >
          {isError
            ? errorMessage || 'Voice error'
            : isNotice
              ? noticeMessage
              : interimText}
        </span>
      )}
    </span>
  );
}
