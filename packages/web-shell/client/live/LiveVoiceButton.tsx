/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import type {
  DaemonLiveRequirementState,
  DaemonLiveStatus,
} from '@qwen-code/sdk';
import { Button } from '../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../components/ui/dialog';
import { useI18n } from '../i18n';
import { useLiveVoice } from './useLiveVoice';
import styles from './LiveVoiceButton.module.css';

const REQUIREMENTS = [
  ['host', 'live.requirement.host'],
  ['microphone', 'live.requirement.microphone'],
  ['accessibility', 'live.requirement.accessibility'],
  ['screenRecording', 'live.requirement.screenRecording'],
  ['audioInput', 'live.requirement.audioInput'],
  ['audioOutput', 'live.requirement.audioOutput'],
  ['globalShortcut', 'live.requirement.globalShortcut'],
  ['appshot', 'live.requirement.appshot'],
  ['provider', 'live.requirement.provider'],
] as const;

function LiveIcon(): React.JSX.Element {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4 13v-2" />
      <path d="M8 16V8" />
      <path d="M12 19V5" />
      <path d="M16 16V8" />
      <path d="M20 13v-2" />
    </svg>
  );
}

function isActive(status: DaemonLiveStatus | undefined): boolean {
  return Boolean(
    status &&
      ['starting', 'listening', 'thinking', 'speaking', 'stopping'].includes(
        status.state,
      ),
  );
}

function stateLabel(
  state: DaemonLiveRequirementState | undefined,
  t: ReturnType<typeof useI18n>['t'],
): string {
  return t(`live.requirementState.${state ?? 'missing'}`);
}

function liveStateLabel(
  status: DaemonLiveStatus | undefined,
  t: ReturnType<typeof useI18n>['t'],
): string {
  if (status?.statusText) return status.statusText;
  return t(`live.state.${status?.state ?? 'unavailable'}`);
}

export function LiveVoiceButton(): React.JSX.Element | null {
  const { t } = useI18n();
  const {
    supported,
    status,
    loading,
    mutating,
    refresh,
    start,
    stop,
    setMute,
  } = useLiveVoice();
  if (!supported) return null;

  const active = isActive(status);
  const busy = loading || mutating;
  const label = active ? t('live.manage') : t('live.open');
  const requirements = status?.requirements ?? {};

  return (
    <Dialog
      onOpenChange={(open) => {
        if (open) void refresh();
      }}
    >
      <DialogTrigger asChild>
        <button
          type="button"
          className={styles.trigger}
          aria-label={label}
          title={label}
          data-active={active}
          data-state={status?.state ?? 'unavailable'}
          data-available={status?.available === true}
        >
          <LiveIcon />
        </button>
      </DialogTrigger>
      <DialogContent data-web-shell-live-dialog>
        <DialogHeader>
          <DialogTitle>{t('live.title')}</DialogTitle>
          <DialogDescription>
            {status?.available
              ? t('live.readyDescription')
              : t('live.setupDescription')}
          </DialogDescription>
        </DialogHeader>

        {!status?.available ? (
          <ul className={styles.requirements}>
            {REQUIREMENTS.map(([key, messageKey]) => {
              const requirementState = requirements[key];
              return (
                <li className={styles.requirement} key={key}>
                  <span>{t(messageKey)}</span>
                  <span className={styles.requirementState}>
                    <span
                      className={styles.dot}
                      data-ready={requirementState === 'ready'}
                      data-denied={requirementState === 'denied'}
                    />
                    {stateLabel(requirementState, t)}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className={styles.liveState} data-state={status.state}>
            <span className={styles.liveStateOrb} />
            <span>{liveStateLabel(status, t)}</span>
          </div>
        )}

        {status?.message ? (
          <p className={styles.error}>{status.message}</p>
        ) : null}
        {status?.transcript ? (
          <p className={styles.transcript} data-role="user">
            {status.transcript}
          </p>
        ) : null}
        {status?.caption ? (
          <p className={styles.transcript} data-role="assistant">
            {status.caption}
          </p>
        ) : null}
        {status?.shortcut ? (
          <p className={styles.hint}>
            {t('live.shortcutHint', { shortcut: status.shortcut })}
          </p>
        ) : null}
        {!status?.available ? (
          <p className={styles.hint}>{t('live.noFallback')}</p>
        ) : null}

        <DialogFooter>
          {!status?.available ? (
            <Button variant="outline" disabled={busy} onClick={() => refresh()}>
              {t('live.refresh')}
            </Button>
          ) : null}
          {active ? (
            <>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setMute({ inputMuted: !status?.inputMuted })}
              >
                {status?.inputMuted
                  ? t('live.unmuteInput')
                  : t('live.muteInput')}
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setMute({ outputMuted: !status?.outputMuted })}
              >
                {status?.outputMuted
                  ? t('live.unmuteOutput')
                  : t('live.muteOutput')}
              </Button>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => stop()}
              >
                {t('live.stop')}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                disabled={!status?.available || busy}
                onClick={() => start('new')}
              >
                {t('live.newConversation')}
              </Button>
              <Button
                disabled={!status?.available || busy}
                onClick={() => start('resume')}
              >
                {t('live.startOrResume')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
