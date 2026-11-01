/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
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
  buildWaitingMinigameStartCluster,
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
const QWEN_CELL_COL = Math.floor(WAITING_MINIGAME_COLS / 2);
const QWEN_CELL_ROW = Math.floor(WAITING_MINIGAME_ROWS / 2);
// 文字出现后整体飞向右侧堆，落定后再切到游戏面板
const INTRO_FLIGHT_MS = 750;
const INTRO_LAND_MS = 1_270;
const INTRO_MS = 1_700;
// 贪吃蛇没有右侧堆，文字停留后直接进入游戏
const INTRO_SNAKE_MS = 1_250;
const INTRO_FONT: Record<string, readonly string[]> = {
  Q: ['1111', '1001', '1001', '1011', '1111'],
  W: ['1001', '1001', '1001', '1011', '1111'],
  E: ['1111', '1000', '1110', '1000', '1111'],
  N: ['1001', '1101', '1101', '1011', '1001'],
  C: ['0111', '1000', '1000', '1000', '0111'],
  O: ['0110', '1001', '1001', '1001', '0110'],
  D: ['1110', '1001', '1001', '1001', '1110'],
};

function buildIntroCells(): ReadonlySet<number> {
  const cells = new Set<number>();
  let col = 2;
  for (const char of 'QWEN CODE') {
    if (char === ' ') {
      col += 2;
      continue;
    }
    const rows = INTRO_FONT[char];
    if (!rows) continue;
    rows.forEach((row, rowIndex) => {
      for (let offset = 0; offset < row.length; offset++) {
        if (row[offset] === '1') {
          cells.add((rowIndex + 1) * WAITING_MINIGAME_COLS + col + offset);
        }
      }
    });
    col += rows[0]!.length + 1;
  }
  return cells;
}

const INTRO_CELLS = buildIntroCells();

/**
 * 每个字符方块飞向右侧堆里高度最接近的格子，保持大致水平移动，
 * 同高候选中按源列轮换，避免所有方块叠到同一格。
 */
function buildIntroFlight(
  targets: readonly number[],
): ReadonlyMap<number, number> {
  const flight = new Map<number, number>();
  if (targets.length === 0) return flight;
  for (const source of INTRO_CELLS) {
    const sourceRow = Math.floor(source / WAITING_MINIGAME_COLS);
    let bestDistance = Number.POSITIVE_INFINITY;
    const candidates: number[] = [];
    for (const target of targets) {
      const distance = Math.abs(
        Math.floor(target / WAITING_MINIGAME_COLS) - sourceRow,
      );
      if (distance < bestDistance) {
        bestDistance = distance;
        candidates.length = 0;
        candidates.push(target);
      } else if (distance === bestDistance) {
        candidates.push(target);
      }
    }
    flight.set(source, candidates[source % candidates.length]!);
  }
  return flight;
}

type CardView = 'heatmap' | 'tokens' | 'intro' | 'tetris' | 'snake';
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
  /** Jump to the message that represents the clicked activity bucket. */
  onSelectActivity?: (messageId: string) => void;
  /** Delay before the game entry appears; the product default is 5s. */
  entryDelayMs?: number;
}

export function WaitingMinigame({
  open,
  onClose,
  activity = [],
  tokenUsage = { input: 0, output: 0, cached: 0 },
  onSelectActivity,
  entryDelayMs = 5_000,
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
  const [introTargets, setIntroTargets] = useState<readonly number[]>([]);
  const [introSettling, setIntroSettling] = useState(false);
  const [introLanded, setIntroLanded] = useState(false);
  const [hoveredBucket, setHoveredBucket] = useState<number | null>(null);
  const [qwenCell, setQwenCell] = useState({
    col: QWEN_CELL_COL,
    row: QWEN_CELL_ROW,
  });
  const [qwenEntryReady, setQwenEntryReady] = useState(false);
  const entryTimer = useRef<number | undefined>(undefined);
  const noticeTimer = useRef<number | undefined>(undefined);
  const introTimer = useRef<number | undefined>(undefined);
  const introRevealTimer = useRef<number | undefined>(undefined);
  const introLandTimer = useRef<number | undefined>(undefined);
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
  const activityRef = useRef(activity);
  activityRef.current = activity;
  const introFlight = useMemo(
    () => buildIntroFlight(introTargets),
    [introTargets],
  );

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

  const cancelIntro = useCallback(() => {
    if (introTimer.current !== undefined) {
      window.clearTimeout(introTimer.current);
      introTimer.current = undefined;
    }
    if (introRevealTimer.current !== undefined) {
      window.clearTimeout(introRevealTimer.current);
      introRevealTimer.current = undefined;
    }
    if (introLandTimer.current !== undefined) {
      window.clearTimeout(introLandTimer.current);
      introLandTimer.current = undefined;
    }
    setIntroTargets([]);
    setIntroSettling(false);
    setIntroLanded(false);
  }, []);

  useEffect(() => {
    if (previousOpen.current === open) return;
    previousOpen.current = open;
    cancelIntro();
    if (open) {
      setView('heatmap');
      return;
    }
    setQwenEntryReady(false);
    if (!gameRef.current.paused && !gameRef.current.over) {
      apply(setWaitingMinigamePaused(gameRef.current, true));
    }
    if (!snakeRef.current.paused && !snakeRef.current.over) {
      applySnake(setWaitingSnakePaused(snakeRef.current, true));
    }
  }, [open, apply, applySnake, cancelIntro]);

  useEffect(() => {
    if (view !== 'heatmap') setHoveredBucket(null);
  }, [view]);

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
    if (!open) return;
    setQwenEntryReady(false);
    if (entryTimer.current !== undefined) {
      window.clearTimeout(entryTimer.current);
      entryTimer.current = undefined;
    }
    if (entryDelayMs <= 0) {
      setQwenEntryReady(true);
      return;
    }
    entryTimer.current = window.setTimeout(() => {
      entryTimer.current = undefined;
      setQwenEntryReady(true);
    }, entryDelayMs);
    return () => {
      if (entryTimer.current !== undefined) {
        window.clearTimeout(entryTimer.current);
        entryTimer.current = undefined;
      }
    };
  }, [open, entryDelayMs]);

  useEffect(() => {
    if (!qwenEntryReady) return;
    const counts = Array.from(
      { length: WAITING_MINIGAME_COLS },
      (_, col) => activityRef.current[col]?.count ?? 0,
    );
    const coldest = Math.min(...counts);
    const columns = counts.flatMap((count, col) =>
      count === coldest ? [col] : [],
    );
    const col =
      columns[Math.floor(Math.random() * columns.length)] ?? QWEN_CELL_COL;
    const row = Math.floor(Math.random() * WAITING_MINIGAME_ROWS);
    setQwenCell({ col, row });
  }, [qwenEntryReady]);

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
      if (introTimer.current !== undefined) {
        window.clearTimeout(introTimer.current);
      }
      if (introRevealTimer.current !== undefined) {
        window.clearTimeout(introRevealTimer.current);
      }
      if (introLandTimer.current !== undefined) {
        window.clearTimeout(introLandTimer.current);
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

  const startFreshGame = useCallback(
    (kind: GameKind, cluster: readonly number[]) => {
      if (kind === 'tetris') {
        apply(createWaitingMinigame({ initialSettled: cluster }));
        setNotice(null);
      } else {
        applySnake(createWaitingSnake());
      }
      ensureAudio();
      setView(kind);
    },
    [apply, applySnake, ensureAudio],
  );

  const restartActiveGame = useCallback(() => {
    if (view === 'snake') restartSnake();
    else if (view === 'tetris') restartTetris();
  }, [restartSnake, restartTetris, view]);

  const beginIntroGame = useCallback(
    (kind: GameKind) => {
      cancelIntro();
      ensureAudio();
      setView('intro');
      if (kind === 'snake') {
        introTimer.current = window.setTimeout(() => {
          introTimer.current = undefined;
          startFreshGame('snake', []);
        }, INTRO_SNAKE_MS);
        return;
      }
      const cluster = buildWaitingMinigameStartCluster();
      setIntroTargets(cluster);
      setIntroSettling(false);
      setIntroLanded(false);
      introRevealTimer.current = window.setTimeout(() => {
        introRevealTimer.current = undefined;
        setIntroSettling(true);
      }, INTRO_FLIGHT_MS);
      introLandTimer.current = window.setTimeout(() => {
        introLandTimer.current = undefined;
        setIntroLanded(true);
      }, INTRO_LAND_MS);
      introTimer.current = window.setTimeout(() => {
        introTimer.current = undefined;
        startFreshGame(kind, cluster);
      }, INTRO_MS);
    },
    [cancelIntro, ensureAudio, startFreshGame],
  );

  const startRandomGame = useCallback(() => {
    beginIntroGame(Math.random() < 0.5 ? 'tetris' : 'snake');
  }, [beginIntroGame]);

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
              else {
                cancelIntro();
                setView('heatmap');
              }
            }}
          >
            <span aria-hidden="true">←</span>
            <span>
              {view === 'heatmap' || view === 'tokens'
                ? t('waitingGame.collapse')
                : t('waitingGame.backToHeatmap')}
            </span>
          </button>
          <span className={styles.title}>
            {view === 'heatmap'
              ? t('waitingGame.activityTitle')
              : view === 'tokens'
                ? t('waitingGame.usageTitle')
                : t('waitingGame.title')}
          </span>
          {gameView ? (
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

        {view === 'intro' && (
          <div
            className={styles.board}
            data-intro="true"
            data-settling={introSettling ? 'true' : undefined}
            data-landed={introLanded ? 'true' : undefined}
            role="img"
            aria-label="Qwen Code"
          >
            <div
              className={styles.cells}
              style={{
                gridTemplateColumns: `repeat(${WAITING_MINIGAME_COLS}, minmax(0, 1fr))`,
              }}
              aria-hidden="true"
            >
              {CELLS.map((index) => (
                <span key={index} className={styles.cell} />
              ))}
            </div>
            <div
              className={`${styles.cells} ${styles.introCells}`}
              style={{
                gridTemplateColumns: `repeat(${WAITING_MINIGAME_COLS}, minmax(0, 1fr))`,
              }}
              aria-hidden="true"
            >
              {CELLS.map((index) => {
                const lit = INTRO_CELLS.has(index);
                const state = introLanded
                  ? introTargets.includes(index)
                    ? 1
                    : 0
                  : lit
                    ? 2
                    : 0;
                const target = introFlight.get(index) ?? index;
                const sourceRow = Math.floor(index / WAITING_MINIGAME_COLS);
                const sourceCol = index % WAITING_MINIGAME_COLS;
                const targetRow = Math.floor(target / WAITING_MINIGAME_COLS);
                const targetCol = target % WAITING_MINIGAME_COLS;
                return (
                  <span
                    key={index}
                    className={styles.cell}
                    data-state={state}
                    style={
                      lit && !introLanded
                        ? ({
                            animationDelay: `${sourceCol * 6}ms`,
                            '--intro-dx': String(targetCol - sourceCol),
                            '--intro-dy': String(targetRow - sourceRow),
                          } as CSSProperties)
                        : undefined
                    }
                  />
                );
              })}
            </div>
          </div>
        )}

        {view === 'heatmap' && (
          <div className={styles.heatmap}>
            {qwenEntryReady && (
              <div
                className={styles.heatGrid}
                style={{
                  gridTemplateColumns: `repeat(${WAITING_MINIGAME_COLS}, minmax(0, 1fr))`,
                  gridTemplateRows: `repeat(${WAITING_MINIGAME_ROWS}, minmax(0, 1fr))`,
                }}
              >
                <button
                  type="button"
                  className={styles.qwenStart}
                  data-component="waiting-minigame-start"
                  title={t('waitingGame.startGame')}
                  aria-label={t('waitingGame.startGame')}
                  style={{
                    gridColumn: qwenCell.col + 1,
                    gridRow: qwenCell.row + 1,
                  }}
                  onClick={startRandomGame}
                >
                  <QwenLogoIcon className={styles.qwenLogo} />
                </button>
              </div>
            )}
            <div
              className={styles.heatColumns}
              style={{
                gridTemplateColumns: `repeat(${WAITING_MINIGAME_COLS}, minmax(0, 1fr))`,
              }}
            >
              {buckets.map((bucket, index) => {
                const label =
                  bucket.startAt === undefined
                    ? t('waitingGame.noActivity')
                    : t('waitingGame.heatmapTooltip', {
                        time: `${formatTime(bucket.startAt)}–${formatTime(bucket.endAt)}`,
                        count: bucket.count,
                      });
                return (
                  <button
                    key={index}
                    type="button"
                    className={styles.heatColumn}
                    data-level={activityLevel(bucket, maxCount)}
                    data-empty={bucket.messageId ? undefined : 'true'}
                    aria-label={
                      bucket.messageId
                        ? `${label}. ${t('waitingGame.jumpToMessage')}`
                        : label
                    }
                    aria-disabled={bucket.messageId ? undefined : true}
                    tabIndex={bucket.messageId ? 0 : -1}
                    onMouseEnter={() => setHoveredBucket(index)}
                    onMouseLeave={() =>
                      setHoveredBucket((value) =>
                        value === index ? null : value,
                      )
                    }
                    onFocus={() => setHoveredBucket(index)}
                    onBlur={() =>
                      setHoveredBucket((value) =>
                        value === index ? null : value,
                      )
                    }
                    onClick={() => {
                      if (bucket.messageId) {
                        onSelectActivity?.(bucket.messageId);
                      }
                    }}
                  >
                    {Array.from({ length: WAITING_MINIGAME_ROWS }, (_, row) => (
                      <span key={row} className={styles.heatCell} />
                    ))}
                  </button>
                );
              })}
            </div>
            {hoveredBucket !== null && buckets[hoveredBucket] && (
              <div
                className={styles.heatTooltip}
                data-align={
                  hoveredBucket < 4
                    ? 'start'
                    : hoveredBucket > WAITING_MINIGAME_COLS - 5
                      ? 'end'
                      : 'center'
                }
                style={
                  hoveredBucket >= 4 &&
                  hoveredBucket <= WAITING_MINIGAME_COLS - 5
                    ? {
                        left: `${((hoveredBucket + 0.5) / WAITING_MINIGAME_COLS) * 100}%`,
                      }
                    : undefined
                }
                role="tooltip"
              >
                <span>
                  {buckets[hoveredBucket]!.startAt === undefined
                    ? t('waitingGame.noActivity')
                    : t('waitingGame.heatmapTooltip', {
                        time: `${formatTime(buckets[hoveredBucket]!.startAt)}–${formatTime(buckets[hoveredBucket]!.endAt)}`,
                        count: buckets[hoveredBucket]!.count,
                      })}
                </span>
                {buckets[hoveredBucket]!.messageId && (
                  <span className={styles.heatTooltipHint}>
                    {t('waitingGame.jumpToMessage')}
                  </span>
                )}
              </div>
            )}
          </div>
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
                {CELLS.map((index) => {
                  const state = snakeGrid[index] ?? 0;
                  return (
                    <span
                      key={index}
                      className={styles.cell}
                      data-state={state}
                    >
                      {state === 3 ? '🍎' : null}
                    </span>
                  );
                })}
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
      aria-label={t('waitingGame.openActivity')}
      aria-expanded={open}
      title={t('waitingGame.activityTitle')}
      onClick={onToggle}
    >
      <HeatmapIcon />
    </button>
  );
}

function HeatmapIcon() {
  return (
    <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden>
      <g fill="currentColor">
        <rect x="2" y="2" width="4" height="4" rx="1" opacity="0.3" />
        <rect x="8" y="2" width="4" height="4" rx="1" opacity="0.85" />
        <rect x="14" y="2" width="4" height="4" rx="1" opacity="0.2" />
        <rect x="2" y="8" width="4" height="4" rx="1" opacity="0.6" />
        <rect x="8" y="8" width="4" height="4" rx="1" opacity="0.25" />
        <rect x="14" y="8" width="4" height="4" rx="1" opacity="0.9" />
        <rect x="2" y="14" width="4" height="4" rx="1" opacity="0.2" />
        <rect x="8" y="14" width="4" height="4" rx="1" opacity="0.55" />
        <rect x="14" y="14" width="4" height="4" rx="1" opacity="0.4" />
      </g>
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
