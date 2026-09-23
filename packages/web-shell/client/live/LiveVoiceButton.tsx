/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useEffect, useState } from 'react';
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
import { LiveLevelMeter } from './LiveLevelMeter';
import type { LiveBrowserHostCloseReason } from './useLiveBrowserHost';
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

// A page owns the microphone and the speakers, nothing else: no Accessibility,
// Screen Recording or global shortcut to grant. `appshot` stays because the
// daemon reports its Live runtime readiness under that name.
const BROWSER_REQUIREMENTS: ReadonlySet<string> = new Set([
  'host',
  'microphone',
  'audioInput',
  'audioOutput',
  'appshot',
  'provider',
]);

// In the browser form the Host is this tab, and `appshot` only ever means the
// daemon-side Live runtime.
const BROWSER_REQUIREMENT_LABELS = {
  host: 'live.browser.requirement.host',
  appshot: 'live.browser.requirement.runtime',
} as const;

/**
 * Who holds the daemon's single Host lease, from this page's point of view.
 * `native`: the macOS Host — this dialog is its remote control, as before.
 * `self`: this page is the audio endpoint. `other-tab`: another Web Shell page
 * is. `none`: nobody yet.
 */
type LiveHostMode = 'native' | 'self' | 'other-tab' | 'none';

/** How long "Qwen looked at your screen" stays on screen. */
const LOOK_NOTICE_MS = 4_000;

const CLOSE_REASON_MESSAGES: Record<LiveBrowserHostCloseReason, string> = {
  occupied: 'live.browser.closed.occupied',
  'superseded-native': 'live.browser.closed.supersededNative',
  'superseded-tab': 'live.browser.closed.supersededTab',
  refused: 'live.browser.closed.refused',
  microphone: 'live.browser.closed.microphone',
  lost: 'live.browser.closed.lost',
};

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

export function LiveVoiceButton({
  hideInactiveTrigger = false,
  open,
  onOpenChange,
  onSupportedChange,
  onRequestFocusFallback,
}: {
  hideInactiveTrigger?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onSupportedChange?: (supported: boolean) => void;
  onRequestFocusFallback?: () => void;
} = {}): React.JSX.Element | null {
  const { t } = useI18n();
  const {
    supported,
    nativeSupported,
    browserSupported,
    browserHost,
    status,
    loading,
    mutating,
    refresh,
    start,
    stop,
    setMute,
  } = useLiveVoice();
  // Flips a couple of times a second at most (the hook holds it), so state is
  // fine here; the level itself never goes through React.
  const [inputDropping, setInputDropping] = useState(false);
  // Held briefly so a look is legible, then cleared so the region is empty
  // again and the next look announces as a change rather than as more of the
  // same text.
  const [looked, setLooked] = useState(false);
  const lastLookAt = browserHost.screenShare.lastLookAt;
  useEffect(() => {
    if (lastLookAt === undefined) {
      setLooked(false);
      return;
    }
    setLooked(true);
    const timer = setTimeout(() => setLooked(false), LOOK_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [lastLookAt]);
  useEffect(() => {
    onSupportedChange?.(supported);
  }, [onSupportedChange, supported]);
  useEffect(() => {
    if (open && supported) void refresh();
  }, [open, supported, refresh]);
  if (!supported) return null;

  const active = isActive(status);
  const busy = loading || mutating;
  const label = active ? t('live.manage') : t('live.open');
  const requirements = status?.requirements ?? {};
  const mode: LiveHostMode = !status?.host
    ? 'none'
    : status.host.kind !== 'browser'
      ? 'native'
      : browserHost.phase === 'connected'
        ? 'self'
        : 'other-tab';
  const connecting = browserHost.phase === 'connecting';
  // Offer this page as the audio endpoint whenever no native Host is attached.
  const canUseBrowser =
    browserSupported && mode !== 'native' && mode !== 'self';
  // Where a native Host can attach it stays the default: until a Host is
  // chosen the dialog keeps its native gate and the browser is the secondary
  // way in. Elsewhere the browser is the only endpoint there is.
  const browserForm =
    browserSupported &&
    (mode === 'self' || mode === 'other-tab' || !nativeSupported);
  // "Qwen Live Host is not connected" is the daemon's wording for the native
  // app. Here the missing Host is this very tab, one click away.
  const hostMissingInBrowserForm =
    browserForm &&
    (status?.blocker === 'host_missing' ||
      status?.blocker === 'host_disconnected');
  const visibleRequirements = browserForm
    ? REQUIREMENTS.filter(([key]) => BROWSER_REQUIREMENTS.has(key))
    : REQUIREMENTS;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange?.(nextOpen);
        if (nextOpen && open === undefined) void refresh();
      }}
    >
      {(!hideInactiveTrigger || active) && (
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
      )}
      {/* Wider than the default dialog, with a wrapping footer: three footer
          buttons do not fit 384px and used to push the requirement states
          outside the dialog. */}
      <DialogContent
        data-web-shell-live-dialog
        className="sm:max-w-md"
        onCloseAutoFocus={(event) => {
          if (hideInactiveTrigger && !active && onRequestFocusFallback) {
            event.preventDefault();
            onRequestFocusFallback();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('live.title')}</DialogTitle>
          <DialogDescription>
            {mode === 'self'
              ? t('live.browser.readyDescription')
              : mode === 'other-tab'
                ? t('live.browser.otherTabDescription')
                : status?.available
                  ? t('live.readyDescription')
                  : browserForm
                    ? t('live.browser.setupDescription')
                    : t('live.setupDescription')}
          </DialogDescription>
        </DialogHeader>

        {!status?.available ? (
          <ul className={styles.requirements}>
            {visibleRequirements.map(([key, messageKey]) => {
              const requirementState = requirements[key];
              return (
                <li className={styles.requirement} key={key}>
                  <span>
                    {t(
                      browserForm && key in BROWSER_REQUIREMENT_LABELS
                        ? BROWSER_REQUIREMENT_LABELS[
                            key as keyof typeof BROWSER_REQUIREMENT_LABELS
                          ]
                        : messageKey,
                    )}
                  </span>
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
          <div
            className={styles.liveStateGroup}
            // Which capture path is live: the audio-thread worklet, or the
            // main-thread fallback. Not shown; here for support and tests.
            data-live-capture={
              mode === 'self' ? browserHost.captureMode : undefined
            }
          >
            <div className={styles.liveState} data-state={status.state}>
              <span className={styles.liveStateOrb} />
              <span>{liveStateLabel(status, t)}</span>
              {mode === 'self' ? (
                <LiveLevelMeter
                  level={browserHost.inputLevel}
                  muted={status.inputMuted === true}
                  label={t(
                    status.inputMuted === true
                      ? 'live.browser.levelMuted'
                      : 'live.browser.level',
                  )}
                  droppingLabel={t('live.browser.levelDropping')}
                  onDroppingChange={setInputDropping}
                />
              ) : null}
            </div>
            {/* Always mounted while this tab is the endpoint: a live region
                has to exist before its text changes for the change to be
                announced. The bar says the same thing in colour, which
                reaches neither a screen reader nor a touch or colour-blind
                user. */}
            {mode === 'self' ? (
              <p
                role="status"
                className={styles.droppingStatus}
                data-live-input-dropping={inputDropping}
              >
                {inputDropping ? t('live.browser.levelDropping') : ''}
              </p>
            ) : null}
          </div>
        )}

        {status?.message && !hostMissingInBrowserForm ? (
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
        {browserHost.closeReason ? (
          <p className={styles.error} data-live-browser-closed>
            {browserHost.closeReason === 'microphone' &&
            browserHost.errorMessage
              ? browserHost.errorMessage
              : t(CLOSE_REASON_MESSAGES[browserHost.closeReason])}
          </p>
        ) : null}
        {status?.shortcut && !browserForm ? (
          <p className={styles.hint}>
            {t('live.shortcutHint', { shortcut: status.shortcut })}
          </p>
        ) : null}
        {!status?.available && !browserSupported ? (
          <p className={styles.hint}>{t('live.noFallback')}</p>
        ) : null}
        {browserForm ? (
          <p className={styles.hint}>{t('live.browser.headphonesHint')}</p>
        ) : null}

        {mode === 'self' && browserHost.screenShare.supported ? (
          <div className={styles.screenShare} data-live-screen-share>
            <Button
              variant="outline"
              data-live-screen-share-toggle
              onClick={() => {
                if (browserHost.screenShare.sharing) {
                  browserHost.stopSharingScreen();
                  return;
                }
                // Inside the click: getDisplayMedia needs the gesture.
                void browserHost.startSharingScreen();
              }}
            >
              {browserHost.screenShare.sharing
                ? t('live.browser.stopScreenShare')
                : t('live.browser.startScreenShare')}
            </Button>
            {browserHost.screenShare.sharing ? (
              <span className={styles.hint} data-live-screen-share-label>
                {browserHost.screenShare.label
                  ? t('live.browser.sharingNamed', {
                      target: browserHost.screenShare.label,
                    })
                  : t('live.browser.sharing')}
              </span>
            ) : browserHost.screenShare.requestedWhileIdle ? (
              <span className={styles.hint} data-live-screen-share-requested>
                {t('live.browser.screenRequested')}
              </span>
            ) : null}
            {browserHost.screenShare.errorMessage ? (
              <span className={styles.error} data-live-screen-share-error>
                {browserHost.screenShare.errorMessage}
              </span>
            ) : null}
            {/* Mounted whenever this tab can share, so the announcement of a
                look is a text change in an existing region. A glance at the
                screen leaves no other trace: the transcript shows the reply,
                not what was read to produce it. */}
            <p role="status" className={styles.droppingStatus} data-live-looked>
              {looked ? t('live.browser.lookedAtScreen') : ''}
            </p>
          </div>
        ) : null}

        {canUseBrowser || (mode === 'self' && !active) ? (
          <div className={styles.browserActions}>
            {canUseBrowser ? (
              <Button
                variant={browserForm && mode === 'none' ? 'default' : 'outline'}
                disabled={connecting}
                data-live-browser-connect
                onClick={() =>
                  browserHost.connect({
                    takeover:
                      mode === 'other-tab' ||
                      browserHost.closeReason === 'occupied',
                  })
                }
              >
                {connecting
                  ? t('live.browser.connecting')
                  : mode === 'other-tab' ||
                      browserHost.closeReason === 'occupied'
                    ? t('live.browser.takeOver')
                    : t('live.browser.connect')}
              </Button>
            ) : null}
            {mode === 'self' && !active ? (
              <Button
                variant="outline"
                data-live-browser-disconnect
                onClick={() => browserHost.disconnect()}
              >
                {t('live.browser.disconnect')}
              </Button>
            ) : null}
          </div>
        ) : null}

        <DialogFooter className="flex-wrap">
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
