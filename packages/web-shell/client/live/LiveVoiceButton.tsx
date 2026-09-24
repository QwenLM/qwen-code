/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  MicIcon,
  MicOffIcon,
  Volume2Icon,
  VolumeXIcon,
  PhoneOffIcon,
  MonitorIcon,
  MonitorOffIcon,
} from 'lucide-react';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import type { DaemonLiveStatus } from '@qwen-code/sdk';
import { Button } from '../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../components/ui/dialog';
import { useI18n } from '../i18n';
import { LiveLevelMeter } from './LiveLevelMeter';
import type { LiveBrowserHostCloseReason } from './useLiveBrowserHost';
import { useLiveVoice } from './useLiveVoice';
import styles from './LiveVoiceButton.module.css';

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
    browserSupported,
    browserHost,
    status,
    loading,
    mutating,
    refresh,
    begin,
    cancelPending,
    start,
    stop,
    setMute,
  } = useLiveVoice();
  // Flips a couple of times a second at most (the hook holds it), so state is
  // fine here; the level itself never goes through React.
  const [inputDropping, setInputDropping] = useState(false);
  const [internalOpen, setInternalOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const wasDialogOpen = useRef(false);
  const autoStartPending = useRef(false);
  const autoConnectRequested = useRef(false);
  const reconnectOwnHost = useRef(false);
  const dialogOpen = open ?? internalOpen;
  const statusActive = isActive(status);
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
    if (status?.state === 'listening' || status?.state === 'error') {
      setStarting(false);
    }
  }, [status?.state]);
  useEffect(() => {
    if (dialogOpen && supported) void refresh();
  }, [dialogOpen, supported, refresh]);
  useEffect(() => {
    if (!dialogOpen) {
      wasDialogOpen.current = false;
      autoStartPending.current = false;
      autoConnectRequested.current = false;
      return;
    }
    if (!wasDialogOpen.current) {
      wasDialogOpen.current = true;
      autoStartPending.current = true;
      if (
        open !== undefined &&
        !statusActive &&
        (browserSupported || status?.available === true)
      ) {
        setStarting(true);
        begin();
      }
    }
    if (browserHost.phase !== 'idle') autoConnectRequested.current = false;
    if (
      autoStartPending.current &&
      !autoConnectRequested.current &&
      browserSupported &&
      browserHost.phase === 'idle' &&
      (!status?.host ||
        (status.host.kind === 'browser' && reconnectOwnHost.current))
    ) {
      autoConnectRequested.current = true;
      reconnectOwnHost.current = false;
      browserHost.connect();
    }
  }, [
    dialogOpen,
    open,
    begin,
    browserSupported,
    browserHost,
    browserHost.phase,
    status?.host,
    status?.available,
    status?.state,
    statusActive,
  ]);
  useEffect(() => {
    if (
      !dialogOpen ||
      !autoStartPending.current ||
      reconnectOwnHost.current ||
      !status?.available ||
      isActive(status) ||
      loading ||
      mutating ||
      (status.host?.kind === 'browser' && browserHost.phase !== 'connected') ||
      (!status.host && browserSupported)
    ) {
      return;
    }
    autoStartPending.current = false;
    reconnectOwnHost.current = false;
    void start('new');
  }, [
    dialogOpen,
    status,
    browserHost.phase,
    browserSupported,
    loading,
    mutating,
    start,
  ]);
  if (!supported) return null;

  const active = statusActive;
  const busy = loading || mutating;
  const label = active ? t('live.manage') : t('live.open');
  const mode: LiveHostMode = !status?.host
    ? 'none'
    : status.host.kind !== 'browser'
      ? 'native'
      : browserHost.phase === 'connected'
        ? 'self'
        : 'other-tab';
  const connecting = browserHost.phase === 'connecting';
  const establishing =
    dialogOpen &&
    (status?.state === 'starting' ||
      connecting ||
      (starting &&
        (browserSupported || status?.available) &&
        !status?.message &&
        !browserHost.closeReason));
  // Offer this page as the audio endpoint whenever no native Host is attached.
  const canUseBrowser =
    browserSupported && mode !== 'native' && mode !== 'self';
  const browserForm = browserSupported && mode !== 'native';
  // "Qwen Live Host is not connected" is the daemon's wording for the native
  // app. Here the missing Host is this very tab, one click away.
  const hostMissingInBrowserForm =
    browserForm &&
    (status?.blocker === 'host_missing' ||
      status?.blocker === 'host_disconnected');
  const changeOpen = (nextOpen: boolean) => {
    if (!nextOpen && starting && !active) {
      browserHost.disconnect();
      cancelPending();
    }
    setInternalOpen(nextOpen);
    onOpenChange?.(nextOpen);
    autoStartPending.current = nextOpen;
    setStarting(
      nextOpen && !active && (browserSupported || status?.available === true),
    );
    if (nextOpen && !active && (browserSupported || status?.available === true))
      begin();
    if (
      nextOpen &&
      browserSupported &&
      (mode === 'none' || (mode === 'other-tab' && reconnectOwnHost.current))
    ) {
      autoConnectRequested.current = true;
      reconnectOwnHost.current = false;
      browserHost.connect();
    }
  };

  return (
    <Dialog open={dialogOpen} onOpenChange={changeOpen}>
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
      <DialogContent
        data-web-shell-live-dialog
        className={styles.dialog}
        onCloseAutoFocus={(event) => {
          if (hideInactiveTrigger && !active && onRequestFocusFallback) {
            event.preventDefault();
            onRequestFocusFallback();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('live.title')}</DialogTitle>
          <DialogDescription className="sr-only">
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

        {establishing ? (
          <div
            className={styles.establishing}
            role="status"
            data-live-establishing
            data-live-capture={
              mode === 'self' ? browserHost.captureMode : undefined
            }
          >
            <span className={styles.liveStateOrb} aria-hidden="true" />
            <span>{t('live.state.starting')}</span>
          </div>
        ) : (
          <>
            {status?.available ? (
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
            ) : null}

            {status?.message && !hostMissingInBrowserForm ? (
              <p className={styles.error}>{status.message}</p>
            ) : null}
            {browserHost.closeReason ? (
              <p className={styles.error} data-live-browser-closed>
                {browserHost.closeReason === 'microphone' &&
                browserHost.errorMessage
                  ? browserHost.errorMessage
                  : t(CLOSE_REASON_MESSAGES[browserHost.closeReason])}
              </p>
            ) : null}
            {mode === 'self' && browserHost.screenShare.supported ? (
              <div className={styles.screenShare} data-live-screen-share>
                <Button
                  variant="outline"
                  className={styles.shareButton}
                  aria-pressed={browserHost.screenShare.sharing}
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
                  {browserHost.screenShare.sharing ? (
                    <MonitorOffIcon aria-hidden="true" />
                  ) : (
                    <MonitorIcon aria-hidden="true" />
                  )}
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
                  <span
                    className={styles.hint}
                    data-live-screen-share-requested
                  >
                    {t('live.browser.screenRequested')}
                  </span>
                ) : null}
                {browserHost.screenShare.errorMessage ? (
                  <span className={styles.error} data-live-screen-share-error>
                    {browserHost.screenShare.errorMessage}
                  </span>
                ) : null}
                {browserHost.screenFeed?.supported &&
                browserHost.screenShare.sharing ? (
                  <p
                    role="status"
                    className={
                      browserHost.screenFeed.phase === 'error'
                        ? styles.error
                        : styles.hint
                    }
                    data-live-screen-feed
                  >
                    {t(`live.feed.${browserHost.screenFeed.phase}`)}
                    {browserHost.screenFeed.message
                      ? ` ${browserHost.screenFeed.message}`
                      : ''}
                  </p>
                ) : browserHost.screenShare.sharing ? (
                  <p className={styles.hint} data-live-screen-feed>
                    {t('live.feed.unsupported')}
                  </p>
                ) : null}
                {/* Mounted whenever this tab can share, so the announcement of a
                look is a text change in an existing region. A glance at the
                screen leaves no other trace: the transcript shows the reply,
                not what was read to produce it. */}
                <p
                  role="status"
                  className={styles.droppingStatus}
                  data-live-looked
                >
                  {looked ? t('live.browser.lookedAtScreen') : ''}
                </p>
              </div>
            ) : null}

            {!status?.available && !browserSupported ? (
              <p className={styles.hint}>{t('live.noFallback')}</p>
            ) : null}
            {mode === 'other-tab' ? (
              <p className={styles.hint}>
                {t('live.browser.otherTabDescription')}
              </p>
            ) : null}
            {canUseBrowser ? (
              <div className={styles.browserActions}>
                {canUseBrowser ? (
                  <Button
                    variant={
                      browserForm && mode === 'none' ? 'default' : 'outline'
                    }
                    disabled={connecting}
                    data-live-browser-connect
                    onClick={() => {
                      autoStartPending.current = true;
                      browserHost.connect({
                        takeover:
                          mode === 'other-tab' ||
                          browserHost.closeReason === 'occupied',
                      });
                    }}
                  >
                    {connecting
                      ? t('live.browser.connecting')
                      : mode === 'other-tab' ||
                          browserHost.closeReason === 'occupied'
                        ? t('live.browser.takeOver')
                        : t('live.browser.connect')}
                  </Button>
                ) : null}
              </div>
            ) : null}

            <div className={styles.controls}>
              {active ? (
                <>
                  <Button
                    variant="outline"
                    disabled={busy}
                    className={styles.roundControl}
                    size="icon"
                    aria-label={t(
                      status?.inputMuted
                        ? 'live.unmuteInput'
                        : 'live.muteInput',
                    )}
                    title={t(
                      status?.inputMuted
                        ? 'live.unmuteInput'
                        : 'live.muteInput',
                    )}
                    aria-pressed={status?.inputMuted === true}
                    data-live-mute-input
                    onClick={() => setMute({ inputMuted: !status?.inputMuted })}
                  >
                    {status?.inputMuted ? (
                      <MicOffIcon aria-hidden="true" />
                    ) : (
                      <MicIcon aria-hidden="true" />
                    )}
                    <span className="sr-only">
                      {status?.inputMuted
                        ? t('live.unmuteInput')
                        : t('live.muteInput')}
                    </span>
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy}
                    className={styles.roundControl}
                    size="icon"
                    aria-label={t(
                      status?.outputMuted
                        ? 'live.unmuteOutput'
                        : 'live.muteOutput',
                    )}
                    title={t(
                      status?.outputMuted
                        ? 'live.unmuteOutput'
                        : 'live.muteOutput',
                    )}
                    aria-pressed={status?.outputMuted === true}
                    data-live-mute-output
                    onClick={() =>
                      setMute({ outputMuted: !status?.outputMuted })
                    }
                  >
                    {status?.outputMuted ? (
                      <VolumeXIcon aria-hidden="true" />
                    ) : (
                      <Volume2Icon aria-hidden="true" />
                    )}
                    <span className="sr-only">
                      {status?.outputMuted
                        ? t('live.unmuteOutput')
                        : t('live.muteOutput')}
                    </span>
                  </Button>
                  <Button
                    variant="destructive"
                    size="icon"
                    className={styles.roundControl}
                    aria-label={t('live.stop')}
                    title={t('live.stop')}
                    data-live-hangup
                    disabled={busy}
                    onClick={() => {
                      if (mode === 'self') reconnectOwnHost.current = true;
                      void stop().finally(() => {
                        if (mode === 'self') browserHost.disconnect();
                      });
                      changeOpen(false);
                    }}
                  >
                    <PhoneOffIcon aria-hidden="true" />
                    <span className="sr-only">{t('live.stop')}</span>
                  </Button>
                </>
              ) : null}
            </div>
            {!status?.available && !browserSupported ? (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => refresh()}
              >
                {t('live.refresh')}
              </Button>
            ) : null}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
