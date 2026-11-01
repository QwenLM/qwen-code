/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Blocks, Worm } from 'lucide-react';
import { useI18n } from '../i18n';
import { isCoarsePointerDevice } from '../hooks/useIsTouchComposer';
import { formatTokenCount } from '../utils/formatTokenCount';
import type {
  WaitingActivityBucket,
  WaitingTokenUsage,
} from '../utils/waitingActivity';
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
import {
  createWaitingSnake,
  setWaitingSnakePaused,
  tickWaitingSnake,
  toggleWaitingSnakePause,
  turnWaitingSnake,
  waitingSnakeRenderGrid,
  waitingSnakeTickMs,
  type WaitingSnakeDirection,
  type WaitingSnakeState,
} from '../utils/waitingSnake';
import { QwenLogoIcon } from './QwenLogoIcon';
import styles from './WaitingMinigame.module.css';

const BEST_SCORE_KEY = 'qwen-code-web-shell-waiting-minigame-best';
const SNAKE_BEST_SCORE_KEY = 'qwen-code-web-shell-waiting-minigame-snake-best';
const SOUND_KEY = 'qwen-code-web-shell-waiting-minigame-sound';
const NOTICE_MS = 1_200;
const CELLS = Array.from(
  { length: WAITING_MINIGAME_ROWS * WAITING_MINIGAME_COLS },
  (_, index) => index,
);

type CardView = 'heatmap' | 'tokens' | 'picker' | 'tetris' | 'snake';
type GameKind = 'tetris' | 'snake';

function readBestScore(key: string): number {
  try {
    const raw = window.localStorage.getItem(key);
    const value = raw ? Number.parseInt(raw, 10) : 0;
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  } catch {
    return 0;
  }
}

function writeBestScore(key: string, value: number): void {
  try {
    window.localStorage.setItem(key, String(value));
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

function padActivity(
  activity: readonly WaitingActivityBucket[],
): readonly WaitingActivityBucket[] {
  return Array.from(
    { length: WAITING_MINIGAME_COLS },
    (_, index) => activity[index] ?? { count: 0 },
  );
}

function activityLevel(
  bucket: WaitingActivityBucket,
  maxCount: number,
): number {
  if (bucket.count <= 0) return 0;
  if (maxCount <= 0) return 1;
  return Math.min(4, Math.max(1, Math.ceil((bucket.count / maxCount) * 4)));
}

function snakeDirectionForKey(key: string): WaitingSnakeDirection | undefined {
  switch (key) {
    case 'ArrowUp':
    case 'w':
    case 'W':
      return 'up';
    case 'ArrowDown':
    case 's':
    case 'S':
      return 'down';
    case 'ArrowLeft':
    case 'a':
    case 'A':
      return 'left';
    case 'ArrowRight':
    case 'd':
    case 'D':
      return 'right';
    default:
      return undefined;
  }
}

export interface WaitingMinigameProps {
  open: boolean;
  onClose: () => void;
  activity?: readonly WaitingActivityBucket[];
  tokenUsage?: WaitingTokenUsage;
}

export function WaitingMinigame({
  open,
  onClose,
  activity = [],
  tokenUsage = { input: 0, output: 0, cached: 0 },
}: WaitingMinigameProps) {
  const { t, language } = useI18n();
  const [view, setView] = useState<CardView>('heatmap');
  const [game, setGame] = useState<WaitingMinigameState>(() =>
    createWaitingMinigame(),
  );
  const gameRef = useRef(game);
  const [snake, setSnake] = useState<WaitingSnakeState>(() =>
    createWaitingSnake(),
  );
  const snakeRef = useRef(snake);
  const [best, setBest] = useState(() => readBestScore(BEST_SCORE_KEY));
  const [snakeBest, setSnakeBest] = useState(() =>
    readBestScore(SNAKE_BEST_SCORE_KEY),
  );
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
  const rootRef = useRef<HTMLDivElement | null>(null);
  const soundRef = useRef(sound);
  const previousCleared = useRef(game.cleared);
  const previousOver = useRef(game.over);
  const previousSnakeScore = useRef(snake.score);
  const previousSnakeOver = useRef(snake.over);
  const previousOpen = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const coarsePointer = isCoarsePointerDevice();
  const gameView = view === 'tetris' || view === 'snake';

  useEffect(() => {
    gameRef.current = game;
  }, [game]);

  useEffect(() => {
    snakeRef.current = snake;
  }, [snake]);

  useEffect(() => {
    soundRef.current = sound;
  }, [sound]);

  const playSound = useCallback((kind: 'clear' | 'over' | 'toggle') => {
    if (!soundRef.current) return;
    const context = audioContext.current;
    if (!context) return;
    const notes =
      kind === 'clear' ? [660, 880] : kind === 'over' ? [392, 294, 196] : [520];
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
  }, []);

  const ensureAudio = useCallback(() => {
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
  }, []);

  const apply = useCallback((next: WaitingMinigameState) => {
    const current = gameRef.current;
    if (next === current) return;
    gameRef.current = next;
    setGame(next);
  }, []);

  const applySnake = useCallback((next: WaitingSnakeState) => {
    const current = snakeRef.current;
    if (next === current) return;
    snakeRef.current = next;
    setSnake(next);
  }, []);

  useEffect(() => {
    if (previousOpen.current === open) return;
    previousOpen.current = open;
    if (open) {
      setView('heatmap');
      return;
    }
    if (!gameRef.current.paused && !gameRef.current.over) {
      apply(setWaitingMinigamePaused(gameRef.current, true));
    }
    if (!snakeRef.current.paused && !snakeRef.current.over) {
      applySnake(setWaitingSnakePaused(snakeRef.current, true));
    }
  }, [open, apply, applySnake]);

  useEffect(() => {
    if (!open || !documentVisible || view !== 'tetris') return;
    if (game.paused || game.over) return;
    const timer = window.setInterval(() => {
      apply(tickWaitingMinigame(gameRef.current));
    }, waitingMinigameTickMs(game.cleared));
    return () => window.clearInterval(timer);
  }, [
    open,
    documentVisible,
    view,
    game.paused,
    game.over,
    game.cleared,
    apply,
  ]);

  useEffect(() => {
    if (!open || !documentVisible || view !== 'snake') return;
    if (snake.paused || snake.over) return;
    const timer = window.setInterval(() => {
      applySnake(tickWaitingSnake(snakeRef.current));
    }, waitingSnakeTickMs(snake.score));
    return () => window.clearInterval(timer);
  }, [
    open,
    documentVisible,
    view,
    snake.paused,
    snake.over,
    snake.score,
    applySnake,
  ]);

  useEffect(() => {
    if (!open) return;
    const onVisibility = () => {
      const visibleNow = !isVisibilityHidden();
      setDocumentVisible(visibleNow);
      if (visibleNow) return;
      if (view === 'tetris') {
        const current = gameRef.current;
        if (!current.paused && !current.over) {
          apply(setWaitingMinigamePaused(current, true));
        }
      } else if (view === 'snake') {
        const current = snakeRef.current;
        if (!current.paused && !current.over) {
          applySnake(setWaitingSnakePaused(current, true));
        }
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    onVisibility();
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [open, view, apply, applySnake]);

  useEffect(() => {
    if (game.score > best) {
      setBest(game.score);
      writeBestScore(BEST_SCORE_KEY, game.score);
    }
  }, [game.score, best]);

  useEffect(() => {
    if (snake.score > snakeBest) {
      setSnakeBest(snake.score);
      writeBestScore(SNAKE_BEST_SCORE_KEY, snake.score);
    }
  }, [snake.score, snakeBest]);

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
    if (snake.score > previousSnakeScore.current) playSound('clear');
    if (snake.over && !previousSnakeOver.current) playSound('over');
    previousSnakeScore.current = snake.score;
    previousSnakeOver.current = snake.over;
  }, [snake.score, snake.over, playSound]);

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

  const restartTetris = useCallback(() => {
    apply(createWaitingMinigame());
    setNotice(null);
  }, [apply]);

  const restartSnake = useCallback(() => {
    applySnake(createWaitingSnake());
  }, [applySnake]);

  const startGame = useCallback(
    (kind: GameKind) => {
      setView(kind);
      ensureAudio();
      if (kind === 'tetris') {
        const current = gameRef.current;
        if (current.over) restartTetris();
        else if (current.paused) {
          apply(setWaitingMinigamePaused(current, false));
        }
        return;
      }
      const current = snakeRef.current;
      if (current.over) restartSnake();
      else if (current.paused) {
        applySnake(setWaitingSnakePaused(current, false));
      }
    },
    [apply, applySnake, ensureAudio, restartSnake, restartTetris],
  );

  const restartActiveGame = useCallback(() => {
    if (view === 'snake') restartSnake();
    else if (view === 'tetris') restartTetris();
  }, [restartSnake, restartTetris, view]);

  const toggleSound = useCallback(() => {
    const next = !sound;
    soundRef.current = next;
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
        if (
          event
            .composedPath()
            .some(
              (node) =>
                node instanceof Element &&
                node.matches(
                  '[data-web-shell-dialog], [role="dialog"], [role="alertdialog"]',
                ),
            )
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (!gameView || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;
      const target = event.target;
      const nativeControl =
        target instanceof Element &&
        Boolean(rootRef.current?.contains(target)) &&
        Boolean(
          target.closest('button, a[href], [role="button"], [role="link"]'),
        );
      if (
        nativeControl &&
        (event.key === ' ' || event.code === 'Space' || event.key === 'Enter')
      ) {
        return;
      }
      if (event.key === ' ' || event.code === 'Space') {
        if (!event.repeat) {
          event.preventDefault();
          if (view === 'tetris') {
            apply(toggleWaitingMinigamePause(gameRef.current));
          } else {
            applySnake(toggleWaitingSnakePause(snakeRef.current));
          }
        }
        return;
      }
      if (event.key === 'Enter') {
        if (event.repeat) return;
        const active = view === 'tetris' ? gameRef.current : snakeRef.current;
        if (active.over) {
          event.preventDefault();
          restartActiveGame();
        }
        return;
      }
      if (view === 'tetris') {
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
        return;
      }
      if (snakeRef.current.paused || snakeRef.current.over) return;
      const direction = snakeDirectionForKey(event.key);
      if (!direction) return;
      event.preventDefault();
      applySnake(turnWaitingSnake(snakeRef.current, direction));
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    open,
    coarsePointer,
    gameView,
    view,
    apply,
    applySnake,
    restartActiveGame,
  ]);

  if (!open || coarsePointer) return null;

  const buckets = padActivity(activity);
  const maxCount = Math.max(1, ...buckets.map((bucket) => bucket.count));
  const tetrisGrid = waitingMinigameRenderGrid(game);
  const snakeGrid = waitingSnakeRenderGrid(snake);
  const locale =
    language === 'zh-CN' ? 'zh-CN' : language === 'ru' ? 'ru-RU' : 'en';
  const formatTime = (value: number | undefined) =>
    value === undefined
      ? ''
      : new Intl.DateTimeFormat(locale, {
          hour: '2-digit',
          minute: '2-digit',
        }).format(new Date(value));
  const totalTokens = tokenUsage.input + tokenUsage.output;
  const hasTokenUsage = totalTokens > 0 || tokenUsage.cached > 0;
  const contextPercent =
    tokenUsage.contextLimit && tokenUsage.contextLimit > 0
      ? Math.min(
          100,
          ((tokenUsage.context ?? 0) / tokenUsage.contextLimit) * 100,
        )
      : 0;

  return (
    <div
      ref={rootRef}
      className={styles.root}
      data-component="waiting-minigame"
      role="group"
      tabIndex={-1}
      aria-label={t('waitingGame.region')}
    >
      <div className={styles.card}>
        <div className={styles.head}>
          <button
            type="button"
            className={styles.textButton}
            onClick={() => {
              if (view === 'heatmap' || view === 'tokens') onClose();
              else setView('heatmap');
            }}
          >
            <span aria-hidden="true">←</span>
            <span>
              {view === 'heatmap' || view === 'tokens'
                ? t('waitingGame.collapse')
                : t('waitingGame.backToHeatmap')}
            </span>
          </button>
          <span className={styles.title}>{t('waitingGame.title')}</span>
          {gameView ? (
            <>
              <button
                type="button"
                className={styles.textButton}
                onClick={() => setView('picker')}
              >
                {t('waitingGame.switchGame')}
              </button>
              <button
                type="button"
                className={styles.iconButton}
                aria-pressed={sound}
                aria-label={
                  sound ? t('waitingGame.mute') : t('waitingGame.unmute')
                }
                onClick={toggleSound}
              >
                <SoundIcon muted={!sound} />
              </button>
            </>
          ) : (
            <span className={styles.headSpacer} aria-hidden="true" />
          )}
        </div>

        {(view === 'heatmap' || view === 'tokens') && (
          <div className={styles.viewTabs} role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={view === 'heatmap'}
              className={styles.viewTab}
              onClick={() => setView('heatmap')}
            >
              {t('waitingGame.heatmap')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'tokens'}
              className={styles.viewTab}
              onClick={() => setView('tokens')}
            >
              {t('waitingGame.tokens')}
            </button>
          </div>
        )}

        {view === 'heatmap' && (
          <>
            <div className={styles.heatmap}>
              <div
                className={styles.heatColumns}
                style={{
                  gridTemplateColumns: `repeat(${WAITING_MINIGAME_COLS}, minmax(0, 1fr))`,
                }}
                aria-hidden="true"
              >
                {buckets.map((bucket, index) => (
                  <div
                    key={index}
                    className={styles.heatColumn}
                    data-level={activityLevel(bucket, maxCount)}
                    title={
                      bucket.startAt === undefined
                        ? t('waitingGame.noActivity')
                        : t('waitingGame.heatmapTooltip', {
                            time: `${formatTime(bucket.startAt)}–${formatTime(bucket.endAt)}`,
                            count: bucket.count,
                          })
                    }
                  >
                    {Array.from({ length: WAITING_MINIGAME_ROWS }, (_, row) => (
                      <span key={row} className={styles.heatCell} />
                    ))}
                  </div>
                ))}
              </div>
              <button
                type="button"
                className={styles.qwenStart}
                style={{ background: '#ffffff' }}
                data-component="waiting-minigame-start"
                title={t('waitingGame.startGame')}
                aria-label={t('waitingGame.startGame')}
                onClick={() => setView('picker')}
              >
                <QwenLogoIcon className={styles.qwenLogo} />
              </button>
            </div>
            <div className={styles.heatFoot}>
              {t('waitingGame.heatmapHint')}
            </div>
          </>
        )}

        {view === 'tokens' && (
          <div className={styles.tokenView}>
            {hasTokenUsage ? (
              <div className={styles.tokenGrid}>
                <div className={styles.tokenMetric}>
                  <span>{t('waitingGame.tokenTotal')}</span>
                  <strong title={String(totalTokens)}>
                    {formatTokenCount(totalTokens)}
                  </strong>
                </div>
                <div className={styles.tokenMetric}>
                  <span>{t('waitingGame.tokenInput')}</span>
                  <strong title={String(tokenUsage.input)}>
                    {formatTokenCount(tokenUsage.input)}
                  </strong>
                </div>
                <div className={styles.tokenMetric}>
                  <span>{t('waitingGame.tokenOutput')}</span>
                  <strong title={String(tokenUsage.output)}>
                    {formatTokenCount(tokenUsage.output)}
                  </strong>
                </div>
                <div className={styles.tokenMetric}>
                  <span>{t('waitingGame.tokenCached')}</span>
                  <strong title={String(tokenUsage.cached)}>
                    {formatTokenCount(tokenUsage.cached)}
                  </strong>
                </div>
              </div>
            ) : (
              <div className={styles.tokenEmpty}>
                {t('waitingGame.tokenEmpty')}
              </div>
            )}
            {contextPercent > 0 && (
              <div className={styles.context}>
                <div className={styles.contextHead}>
                  <span>{t('waitingGame.tokenContext')}</span>
                  <span>
                    {formatTokenCount(tokenUsage.context ?? 0)} /{' '}
                    {formatTokenCount(tokenUsage.contextLimit ?? 0)}
                  </span>
                </div>
                <div className={styles.contextTrack}>
                  <span
                    className={styles.contextFill}
                    style={{ width: `${contextPercent}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {view === 'picker' && (
          <div className={styles.picker}>
            <span className={styles.pickerTitle}>
              {t('waitingGame.chooseGame')}
            </span>
            <div className={styles.pickerButtons}>
              <button
                type="button"
                className={styles.pickerButton}
                onClick={() => startGame('tetris')}
              >
                <Blocks size={20} aria-hidden />
                <span>{t('waitingGame.tetris')}</span>
              </button>
              <button
                type="button"
                className={styles.pickerButton}
                onClick={() => startGame('snake')}
              >
                <Worm size={20} aria-hidden />
                <span>{t('waitingGame.snake')}</span>
              </button>
            </div>
          </div>
        )}

        {view === 'tetris' && (
          <>
            <div className={styles.board}>
              <div
                className={styles.cells}
                data-game="tetris"
                style={{
                  gridTemplateColumns: `repeat(${WAITING_MINIGAME_COLS}, minmax(0, 1fr))`,
                }}
                aria-hidden="true"
              >
                {CELLS.map((index) => (
                  <span
                    key={index}
                    className={styles.cell}
                    data-state={tetrisGrid[index] ?? 0}
                  />
                ))}
              </div>
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
                    onClick={restartTetris}
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
              <span className={styles.controls}>
                {t('waitingGame.controls')}
              </span>
            </div>
          </>
        )}

        {view === 'snake' && (
          <>
            <div className={styles.board}>
              <div
                className={styles.cells}
                data-game="snake"
                style={{
                  gridTemplateColumns: `repeat(${WAITING_MINIGAME_COLS}, minmax(0, 1fr))`,
                }}
                aria-hidden="true"
              >
                {CELLS.map((index) => (
                  <span
                    key={index}
                    className={styles.cell}
                    data-state={snakeGrid[index] ?? 0}
                  />
                ))}
              </div>
              {snake.paused && !snake.over && (
                <div className={styles.overlay}>
                  <span className={styles.overlayTitle}>
                    {t('waitingGame.paused')}
                  </span>
                  <span className={styles.overlayHint}>
                    {t('waitingGame.pausedHint')}
                  </span>
                </div>
              )}
              {snake.over && (
                <div className={styles.overlay}>
                  <span className={styles.overlayTitle}>
                    {t('waitingGame.gameOver')}
                  </span>
                  <button
                    type="button"
                    className={styles.restartButton}
                    onClick={restartSnake}
                  >
                    {t('waitingGame.restart')}
                  </button>
                </div>
              )}
            </div>
            <div className={styles.foot}>
              <span className={styles.score} aria-live="polite">
                {t('waitingGame.score', { score: snake.score })}
              </span>
              <span>{t('waitingGame.best', { score: snakeBest })}</span>
              <span className={styles.controls}>
                {t('waitingGame.snakeControls')}
              </span>
            </div>
          </>
        )}
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
