/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import type {
  DaemonLiveRequirementState,
  DaemonLiveSessionLocator,
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
  ['inputMonitoring', 'live.requirement.inputMonitoring'],
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

function openSession(locator: DaemonLiveSessionLocator): void {
  window.dispatchEvent(
    new CustomEvent('qwen:open-session', { detail: locator }),
  );
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
    <Dialog>
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

        {status?.message ? (
          <p className={styles.error}>{status.message}</p>
        ) : null}
        {status?.transcript ? (
          <p className={styles.transcript}>{status.transcript}</p>
        ) : null}
        {status?.coordinator || status?.workers?.length ? (
          <div className={styles.sessions}>
            {status.coordinator ? (
              <Button
                variant="outline"
                onClick={() => openSession(status.coordinator!)}
              >
                {t('live.openCoordinator')}
              </Button>
            ) : null}
            {status.workers?.map((worker, index) => (
              <Button
                key={`${worker.workspaceCwd}\0${worker.sessionId}`}
                variant="outline"
                onClick={() => openSession(worker)}
              >
                {t('live.openWorker', { index: index + 1 })}
              </Button>
            ))}
          </div>
        ) : null}
        <p className={styles.hint}>{t('live.noFallback')}</p>

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => refresh()}>
            {t('live.refresh')}
          </Button>
          {status?.installUrl ? (
            <Button
              variant="outline"
              onClick={() =>
                window.open(status.installUrl, '_blank', 'noopener')
              }
            >
              {t('live.installHost')}
            </Button>
          ) : null}
          {active ? (
            <>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => start('new')}
              >
                {t('live.newConversation')}
              </Button>
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
