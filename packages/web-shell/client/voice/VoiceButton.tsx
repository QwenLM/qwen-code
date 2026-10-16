/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { XIcon } from 'lucide-react';
import type { DaemonVoiceMode } from '@qwen-code/sdk';
import {
  useConnection,
  useWorkspace,
  useWorkspaceEventSignals,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { useI18n } from '../i18n';
import { Button } from '../components/ui/button';
import { useVoiceCapture } from './useVoiceCapture';
import { formatVoiceError } from './voice-error';
import {
  loadVoiceStatus,
  supportsVoiceCapture,
  type VoiceStatusRevision,
  type VoiceWorkspaceTarget,
} from './voice-workspace-target';
import styles from './VoiceButton.module.css';

/** Live waveform bar count in the recording pill. */
const BAR_COUNT = 16;
const NOTICE_TIMEOUT_MS = 2_000;
const HOLD_THRESHOLD_MS = 250;

export interface VoiceButtonProps {
  /** Insert the final transcript into the composer (user reviews, then sends). */
  onInsert: (text: string) => void;
  onActiveChange?: (active: boolean) => void;
  disabled?: boolean;
  target: VoiceWorkspaceTarget | undefined;
  statusRevision?: VoiceStatusRevision;
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
  onActiveChange,
  disabled,
  target,
  statusRevision = { user: 0, workspace: 0 },
}: VoiceButtonProps): React.JSX.Element | null {
  const workspace = useWorkspace();
  const connection = useConnection();
  const signals = useWorkspaceEventSignals();
  const { t } = useI18n();
  const features = workspace.capabilities?.features ?? [];
  const captureSupported = supportsVoiceCapture(target, features);
  const settingsVersion =
    target?.sessionId &&
    target.sessionId === connection.sessionId &&
    (!target.cwd || target.cwd === connection.workspaceCwd)
      ? signals?.settingsVersion
      : undefined;
  const [localRevision, setLocalRevision] = useState(0);
  const [capabilityRefreshFailed, setCapabilityRefreshFailed] = useState(false);
  const queryKey = useMemo(
    () =>
      target
        ? JSON.stringify([
            target.workspaceKey,
            target.ownerKey,
            settingsVersion ?? null,
            statusRevision.user,
            statusRevision.workspace,
            localRevision,
          ])
        : undefined,
    [
      localRevision,
      settingsVersion,
      statusRevision.user,
      statusRevision.workspace,
      target,
    ],
  );
  const [voiceGate, setVoiceGate] = useState<{
    queryKey: string | undefined;
    enabled: boolean;
    mode: DaemonVoiceMode;
  }>(() => ({
    queryKey,
    enabled: false,
    mode: 'hold',
  }));
  const holdPointerIdRef = useRef<number | null>(null);
  const controlRef = useRef<HTMLButtonElement>(null);
  const holdStartedAtRef = useRef(0);
  const ignoreNextClickRef = useRef(false);
  const targetRef = useRef(target);
  targetRef.current = target;
  const requestGenerationRef = useRef(0);
  const capabilityRefreshGenerationRef = useRef(0);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      capabilityRefreshGenerationRef.current += 1;
    };
  }, []);

  useEffect(() => {
    const generation = ++requestGenerationRef.current;
    const requestTarget = targetRef.current;
    let current = true;
    setVoiceGate({
      queryKey,
      enabled: false,
      mode: 'hold',
    });
    if (
      !requestTarget ||
      !queryKey ||
      !captureSupported ||
      capabilityRefreshFailed
    ) {
      return undefined;
    }

    void loadVoiceStatus(workspace.client, requestTarget)
      .then((voice) => {
        if (current && requestGenerationRef.current === generation) {
          setVoiceGate({
            queryKey,
            enabled: voice.enabled === true,
            mode: voice.mode,
          });
        }
      })
      .catch((error: unknown) => {
        console.warn('[web-shell] Voice status probe failed:', error);
      });

    return () => {
      current = false;
    };
  }, [capabilityRefreshFailed, captureSupported, queryKey, workspace.client]);

  const voiceEnabled =
    captureSupported &&
    !capabilityRefreshFailed &&
    voiceGate.queryKey === queryKey &&
    voiceGate.enabled;
  // Surfaced when a recording finalizes with no transcript (e.g. silence).
  const [hasNoSpeech, setHasNoSpeech] = useState(false);
  const noticeMessage = hasNoSpeech ? t('voice.noSpeech') : undefined;
  useEffect(() => {
    if (!hasNoSpeech) return undefined;
    const timer = window.setTimeout(
      () => setHasNoSpeech(false),
      NOTICE_TIMEOUT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [hasNoSpeech]);

  const { status, interimText, audioLevel, errorMessage, start, stop, abort } =
    useVoiceCapture({
      baseUrl: workspace.baseUrl,
      token: workspace.token,
      target: target
        ? { ownerKey: target.ownerKey, streamPath: target.streamPath }
        : undefined,
      onFinal: (text) => {
        const trimmed = text.trim();
        if (trimmed) {
          setHasNoSpeech(false);
          onInsert(trimmed);
        } else {
          setHasNoSpeech(true);
        }
      },
      onUnexpectedClose: ({ code }) => {
        if (code === 1013) return;
        setLocalRevision((revision) => revision + 1);
        if (code !== 1012) return;
        const refreshOwnerKey = targetRef.current?.ownerKey;
        const refreshGeneration = ++capabilityRefreshGenerationRef.current;
        setCapabilityRefreshFailed(true);
        const settleRefresh = () => {
          if (
            !mountedRef.current ||
            capabilityRefreshGenerationRef.current !== refreshGeneration ||
            targetRef.current?.ownerKey !== refreshOwnerKey
          ) {
            return;
          }
          setCapabilityRefreshFailed(false);
          setLocalRevision((revision) => revision + 1);
        };
        try {
          const refresh = workspace.refreshCapabilities?.();
          if (refresh) {
            void refresh.then(settleRefresh, settleRefresh);
          } else {
            settleRefresh();
          }
        } catch {
          settleRefresh();
        }
      },
    });

  const isActive =
    status === 'connecting' ||
    status === 'recording' ||
    status === 'transcribing';
  const isRecording = status === 'recording';

  useEffect(() => {
    onActiveChange?.(isActive);
  }, [isActive, onActiveChange]);

  useEffect(
    () => () => {
      onActiveChange?.(false);
    },
    [onActiveChange],
  );

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

  useLayoutEffect(() => {
    if (
      !voiceEnabled &&
      (status === 'recording' ||
        status === 'connecting' ||
        status === 'transcribing')
    ) {
      abort();
    }
  }, [abort, status, voiceEnabled]);

  const previousOwnerRef = useRef(target?.ownerKey);
  useLayoutEffect(() => {
    if (previousOwnerRef.current === target?.ownerKey) return;
    previousOwnerRef.current = target?.ownerKey;
    capabilityRefreshGenerationRef.current += 1;
    setHasNoSpeech(false);
    setCapabilityRefreshFailed(false);
  }, [target?.ownerKey]);

  if (!voiceEnabled) return null;

  const isConnecting = status === 'connecting';
  const isTranscribing = status === 'transcribing';
  const isError = status === 'error';
  const localizedError = isError
    ? formatVoiceError(errorMessage, t)
    : undefined;
  const isNotice = Boolean(noticeMessage) && !isError;
  // Stopping/aborting an in-progress capture must stay available even when the
  // composer is disabled (e.g. mid-turn) — only starting a new one is blocked.
  const canCancel = isRecording || isConnecting;

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (voiceGate.mode === 'hold') {
      const ignore = event.detail !== 0 && ignoreNextClickRef.current;
      ignoreNextClickRef.current = false;
      if (ignore || (event.detail !== 0 && !isRecording && !isConnecting)) {
        return;
      }
    }
    if (isRecording) {
      stop();
    } else if (isConnecting) {
      abort();
    } else if (!disabled) {
      setHasNoSpeech(false);
      start();
    }
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (voiceGate.mode === 'hold' && holdPointerIdRef.current === null) {
      ignoreNextClickRef.current = false;
    }
    if (
      voiceGate.mode !== 'hold' ||
      event.button !== 0 ||
      disabled ||
      isConnecting ||
      isRecording
    ) {
      return;
    }
    event.preventDefault();
    holdPointerIdRef.current = event.pointerId;
    holdStartedAtRef.current = event.timeStamp;
    ignoreNextClickRef.current = true;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is best-effort; release on the button still works.
    }
    setHasNoSpeech(false);
    start();
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (
      voiceGate.mode !== 'hold' ||
      holdPointerIdRef.current !== event.pointerId
    ) {
      return;
    }
    holdPointerIdRef.current = null;
    if (
      event.timeStamp - holdStartedAtRef.current >= HOLD_THRESHOLD_MS &&
      (isConnecting || isRecording)
    ) {
      stop();
    }
  };

  const handlePointerCancel = (
    event: React.PointerEvent<HTMLButtonElement>,
  ) => {
    if (
      voiceGate.mode !== 'hold' ||
      holdPointerIdRef.current !== event.pointerId
    ) {
      return;
    }
    holdPointerIdRef.current = null;
    ignoreNextClickRef.current = false;
    abort();
  };

  const label = isRecording
    ? t('voice.stopDictation')
    : isTranscribing
      ? t('voice.transcribing')
      : isConnecting
        ? t('voice.starting')
        : isError
          ? t('voice.errorRetry', { message: localizedError ?? '' })
          : isNotice
            ? t('voice.noSpeechRetry')
            : t('voice.startDictation');

  let control: React.JSX.Element;
  if (isRecording) {
    control = (
      <button
        ref={controlRef}
        type="button"
        className={styles.pill}
        onClick={handleClick}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
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
        ref={controlRef}
        type="button"
        className={iconClass}
        onClick={handleClick}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        disabled={Boolean(disabled) && !canCancel}
        aria-label={label}
        title={localizedError ?? noticeMessage ?? label}
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
          className={`${styles.interim}${isError ? ` ${styles.error}` : ''}${isError || isNotice ? ` ${styles.feedback}` : ''}`}
        >
          <span role="status" aria-live="polite">
            {isError ? localizedError : isNotice ? noticeMessage : interimText}
          </span>
          {(isError || isNotice) && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className={styles.dismiss}
              aria-label={t('voice.dismissFeedback')}
              title={t('voice.dismissFeedback')}
              onClick={() => {
                setHasNoSpeech(false);
                if (isError) abort();
                controlRef.current?.focus();
              }}
            >
              <XIcon aria-hidden="true" />
            </Button>
          )}
        </span>
      )}
    </span>
  );
}
