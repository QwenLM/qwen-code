/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { isCoarsePointerDevice } from '../hooks/useIsTouchComposer';
import {
  WAITING_MINIGAME_CLEAR_SCORE,
  WAITING_MINIGAME_COLS,
  WAITING_MINIGAME_ROWS,
  createWaitingMinigame,
  dropWaitingMinigamePiece,
  moveWaitingMinigamePiece,
  rotateWaitingMinigamePiece,
  setWaitingMinigamePaused,
  tickWaitingMinigame,
  toggleWaitingMinigamePause,
  waitingMinigameRenderGrid,
  waitingMinigameTickMs,
  type WaitingMinigameState,
} from '../utils/waitingMinigame';
import styles from './WaitingMinigame.module.css';

const BEST_SCORE_KEY = 'qwen-code-web-shell-waiting-minigame-best';
const SOUND_KEY = 'qwen-code-web-shell-waiting-minigame-sound';
const NOTICE_MS = 1_200;
const CELLS = Array.from(
  { length: WAITING_MINIGAME_ROWS * WAITING_MINIGAME_COLS },
  (_, index) => index,
);

function readBestScore(): number {
  try {
    const raw = window.localStorage.getItem(BEST_SCORE_KEY);
    const value = raw ? Number.parseInt(raw, 10) : 0;
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  } catch {
    return 0;
  }
}

function writeBestScore(value: number): void {
  try {
    window.localStorage.setItem(BEST_SCORE_KEY, String(value));
  } catch {
    // localStorage can be unavailable in private or embedded contexts.
  }
}

function readSoundEnabled(): boolean {
  try {
    const raw = window.localStorage.getItem(SOUND_KEY);
    return raw === null ? true : raw === '1';
  } catch {
    return true;
  }
}

function writeSoundEnabled(value: boolean): void {
  try {
    window.localStorage.setItem(SOUND_KEY, value ? '1' : '0');
  } catch {
    // localStorage can be unavailable in private or embedded contexts.
  }
}

type AudioContextConstructor = new () => AudioContext;

function audioContextConstructor(): AudioContextConstructor | undefined {
  const scope = window as unknown as {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return Boolean(
    target.closest(
      'input, textarea, select, [contenteditable="true"], [role="textbox"], .cm-content, [data-lexical-editor], .ProseMirror',
    ),
  );
}

function isVisibilityHidden(): boolean {
  return (
    typeof document !== 'undefined' && document.visibilityState === 'hidden'
  );
}

export interface WaitingMinigameProps {
  open: boolean;
  onClose: () => void;
}

export function WaitingMinigame({ open, onClose }: WaitingMinigameProps) {
  const { t } = useI18n();
  const [game, setGame] = useState<WaitingMinigameState>(() =>
    createWaitingMinigame(),
  );
  const gameRef = useRef(game);
  const [best, setBest] = useState(readBestScore);
  const [sound, setSound] = useState(readSoundEnabled);
  const [notice, setNotice] = useState<{
    count: number;
    score: number;
  } | null>(null);
  const [documentVisible, setDocumentVisible] = useState(
    () => !isVisibilityHidden(),
  );
  const noticeTimer = useRef<number | undefined>(undefined);
  const audioContext = useRef<AudioContext | undefined>(undefined);
  const previousCleared = useRef(game.cleared);
  const previousOver = useRef(game.over);
  const previousOpen = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const coarsePointer = isCoarsePointerDevice();

  useEffect(() => {
    gameRef.current = game;
  }, [game]);

  const playSound = useCallback(
    (kind: 'clear' | 'over' | 'toggle') => {
      if (!sound) return;
      const context = audioContext.current;
      if (!context) return;
      const notes =
        kind === 'clear'
          ? [660, 880]
          : kind === 'over'
            ? [392, 294, 196]
            : [520];
      try {
        const now = context.currentTime;
        notes.forEach((frequency, index) => {
          const start = now + index * 0.08;
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          oscillator.type = 'sine';
          oscillator.frequency.value = frequency;
          gain.gain.setValueAtTime(0.0001, start);
          gain.gain.exponentialRampToValueAtTime(0.045, start + 0.012);
          gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.13);
          oscillator.connect(gain);
          gain.connect(context.destination);
          oscillator.start(start);
          oscillator.stop(start + 0.15);
        });
      } catch {
        // Audio is decorative; a blocked context must not break the game.
      }
    },
    [sound],
  );

  const ensureAudio = useCallback(() => {
    if (!sound) {
      void audioContext.current?.resume?.();
      return;
    }
    if (audioContext.current) {
      void audioContext.current.resume?.();
      return;
    }
    const Constructor = audioContextConstructor();
    if (!Constructor) return;
    try {
      audioContext.current = new Constructor();
    } catch {
      audioContext.current = undefined;
    }
  }, [sound]);

  const apply = useCallback((next: WaitingMinigameState) => {
    const current = gameRef.current;
    if (next === current) return;
    gameRef.current = next;
    setGame(next);
  }, []);

  useEffect(() => {
    if (previousOpen.current === open) return;
    previousOpen.current = open;
    const current = gameRef.current;
    if (open) {
      if (current.over) {
        apply(createWaitingMinigame());
        setNotice(null);
      } else if (current.paused) {
        apply(setWaitingMinigamePaused(current, false));
      }
      ensureAudio();
      return;
    }
    if (!current.paused && !current.over) {
      apply(setWaitingMinigamePaused(current, true));
    }
  }, [open, apply, ensureAudio]);

  useEffect(() => {
    if (!open || !documentVisible) return;
    if (game.paused || game.over) return;
    const timer = window.setInterval(() => {
      apply(tickWaitingMinigame(gameRef.current));
    }, waitingMinigameTickMs(game.cleared));
    return () => window.clearInterval(timer);
  }, [open, documentVisible, game.paused, game.over, game.cleared, apply]);

  useEffect(() => {
    if (!open || !documentVisible) return;
    const onVisibility = () => {
      const visibleNow = !isVisibilityHidden();
      setDocumentVisible(visibleNow);
      if (!visibleNow) {
        const current = gameRef.current;
        if (!current.paused && !current.over) {
          apply(setWaitingMinigamePaused(current, true));
        }
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [open, documentVisible, apply]);

  useEffect(() => {
    if (game.score > best) {
      setBest(game.score);
      writeBestScore(game.score);
    }
  }, [game.score, best]);

  useEffect(() => {
    if (game.cleared > previousCleared.current) {
      const count = game.cleared - previousCleared.current;
      setNotice({ count, score: count * WAITING_MINIGAME_CLEAR_SCORE });
      if (noticeTimer.current !== undefined) {
        window.clearTimeout(noticeTimer.current);
      }
      noticeTimer.current = window.setTimeout(() => setNotice(null), NOTICE_MS);
      playSound('clear');
    }
    if (game.over && !previousOver.current) playSound('over');
    previousCleared.current = game.cleared;
    previousOver.current = game.over;
  }, [game.cleared, game.over, playSound]);

  useEffect(() => {
    return () => {
      if (noticeTimer.current !== undefined) {
        window.clearTimeout(noticeTimer.current);
      }
      try {
        void audioContext.current?.close?.();
      } catch {
        // Ignore teardown errors from an already-closed context.
      }
    };
  }, []);

  const restart = useCallback(() => {
    const next = createWaitingMinigame();
    apply(next);
    setNotice(null);
  }, [apply]);

  const toggleSound = useCallback(() => {
    const next = !sound;
    setSound(next);
    writeSoundEnabled(next);
    if (next) {
      ensureAudio();
      playSound('toggle');
    }
  }, [ensureAudio, playSound, sound]);

  useEffect(() => {
    if (!open || coarsePointer) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (isEditableTarget(event.target)) return;
      if (event.key === ' ' || event.code === 'Space') {
        if (!event.repeat) {
          event.preventDefault();
          apply(toggleWaitingMinigamePause(gameRef.current));
        }
        return;
      }
      if (event.key === 'Enter' && gameRef.current.over) {
        if (!event.repeat) {
          event.preventDefault();
          restart();
        }
        return;
      }
      if (gameRef.current.paused || gameRef.current.over) return;
      switch (event.key) {
        case 'ArrowUp':
          event.preventDefault();
          apply(moveWaitingMinigamePiece(gameRef.current, -1));
          break;
        case 'ArrowDown':
          event.preventDefault();
          apply(moveWaitingMinigamePiece(gameRef.current, 1));
          break;
        case 'ArrowRight':
          event.preventDefault();
          apply(dropWaitingMinigamePiece(gameRef.current));
          break;
        case 'ArrowLeft':
          event.preventDefault();
          apply(rotateWaitingMinigamePiece(gameRef.current));
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, coarsePointer, apply, restart]);

  if (!open || coarsePointer) return null;

  const grid = waitingMinigameRenderGrid(game);

  return (
    <div
      className={styles.root}
      data-component="waiting-minigame"
      role="group"
      aria-label={t('waitingGame.region')}
    >
      <div className={styles.card}>
        <div className={styles.head}>
          <button type="button" className={styles.textButton} onClick={onClose}>
            <span aria-hidden="true">←</span>
            <span>{t('waitingGame.collapse')}</span>
          </button>
          <span className={styles.title}>{t('waitingGame.title')}</span>
          <button
            type="button"
            className={styles.iconButton}
            aria-pressed={sound}
            aria-label={sound ? t('waitingGame.mute') : t('waitingGame.unmute')}
            onClick={toggleSound}
          >
            <SoundIcon muted={!sound} />
          </button>
        </div>
        <div
          className={styles.board}
          style={{
            gridTemplateColumns: `repeat(${WAITING_MINIGAME_COLS}, minmax(0, 1fr))`,
          }}
          aria-hidden="true"
        >
          {CELLS.map((index) => (
            <span
              key={index}
              className={styles.cell}
              data-state={grid[index] ?? 0}
            />
          ))}
          {game.paused && !game.over && (
            <div className={styles.overlay}>
              <span className={styles.overlayTitle}>
                {t('waitingGame.paused')}
              </span>
              <span className={styles.overlayHint}>
                {t('waitingGame.pausedHint')}
              </span>
            </div>
          )}
          {game.over && (
            <div className={styles.overlay}>
              <span className={styles.overlayTitle}>
                {t('waitingGame.gameOver')}
              </span>
              <button
                type="button"
                className={styles.restartButton}
                onClick={restart}
              >
                {t('waitingGame.restart')}
              </button>
            </div>
          )}
          {notice && (
            <span className={styles.notice} aria-live="polite">
              {t('waitingGame.cleared', notice)}
            </span>
          )}
        </div>
        <div className={styles.foot}>
          <span className={styles.score} aria-live="polite">
            {t('waitingGame.score', { score: game.score })}
          </span>
          <span>{t('waitingGame.best', { score: best })}</span>
          <span className={styles.controls}>{t('waitingGame.controls')}</span>
        </div>
      </div>
    </div>
  );
}

export interface WaitingMinigameButtonProps {
  open: boolean;
  onToggle: () => void;
}

export function WaitingMinigameButton({
  open,
  onToggle,
}: WaitingMinigameButtonProps) {
  const { t } = useI18n();
  if (isCoarsePointerDevice()) return null;
  return (
    <button
      type="button"
      className={styles.trigger}
      data-component="waiting-minigame-trigger"
      aria-label={t('waitingGame.start')}
      aria-expanded={open}
      title={t('waitingGame.title')}
      onClick={onToggle}
    >
      <GamepadIcon />
    </button>
  );
}

function GamepadIcon() {
  return (
    <svg viewBox="0 0 20 20" width="15" height="15" fill="none" aria-hidden>
      <path
        d="M7.2 6.5h5.6a4.4 4.4 0 0 1 4.3 3.5l.5 2.5a1.6 1.6 0 0 1-2.9 1.1l-1-1.2H6.3l-1 1.2a1.6 1.6 0 0 1-2.9-1.1l.5-2.5a4.4 4.4 0 0 1 4.3-3.5Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M7 9.3v2.4M5.8 10.5h2.4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <circle cx="13.1" cy="10.5" r="0.9" fill="currentColor" />
    </svg>
  );
}

function SoundIcon({ muted }: { muted: boolean }) {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden>
      <path d="M3 8V12H6L10 15V5L6 8H3Z" fill="currentColor" />
      {muted ? (
        <path
          d="M13 7.5L17 12.5M17 7.5L13 12.5"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="square"
        />
      ) : (
        <path
          d="M12.5 7.5C13.5 8.5 13.5 11.5 12.5 12.5M14.5 5.5C16.5 7.5 16.5 12.5 14.5 14.5"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="square"
        />
      )}
    </svg>
  );
}
