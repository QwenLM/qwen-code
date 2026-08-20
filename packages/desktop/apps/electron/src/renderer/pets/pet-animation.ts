/**
 * Pet sprite-atlas animation (clean-room).
 *
 * Atlas: 1536x1872, 8 cols x 9 rows, 192x208 px cells, transparent.
 * Each row is one animation state. Frames are stepped by mutating a single
 * element's `background-position`; `background-size` is set so the sheet maps
 * cell-to-cell at percentage positions.
 */

export type PetState =
  | 'idle'
  | 'running-right'
  | 'running-left'
  | 'waving'
  | 'jumping'
  | 'failed'
  | 'waiting'
  | 'running'
  | 'review';

export const PET_STATES: readonly PetState[] = [
  'idle',
  'running-right',
  'running-left',
  'waving',
  'jumping',
  'failed',
  'waiting',
  'running',
  'review',
];

export const PET_COLUMNS = 8;
export const PET_ROWS = 9;
export const PET_CELL_WIDTH = 192;
export const PET_CELL_HEIGHT = 208;

export interface PetFrame {
  rowIndex: number;
  columnIndex: number;
  durationMs: number;
}

/** Build a row's frames: `count` frames, last one held a little longer. */
function buildRow(
  rowIndex: number,
  count: number,
  normalMs: number,
  lastMs: number,
): PetFrame[] {
  return Array.from({ length: count }, (_, i) => ({
    rowIndex,
    columnIndex: i,
    durationMs: i === count - 1 ? lastMs : normalMs,
  }));
}

// The idle row has hand-tuned per-frame timing (breathe + blink).
const IDLE_FRAMES: PetFrame[] = [
  { rowIndex: 0, columnIndex: 0, durationMs: 280 },
  { rowIndex: 0, columnIndex: 1, durationMs: 110 },
  { rowIndex: 0, columnIndex: 2, durationMs: 110 },
  { rowIndex: 0, columnIndex: 3, durationMs: 140 },
  { rowIndex: 0, columnIndex: 4, durationMs: 140 },
  { rowIndex: 0, columnIndex: 5, durationMs: 320 },
];

// When the pet settles back to idle it loops slowly and calmly.
const IDLE_SLOWDOWN = 6;
const IDLE_SETTLED: PetFrame[] = IDLE_FRAMES.map((f) => ({
  ...f,
  durationMs: f.durationMs * IDLE_SLOWDOWN,
}));

export const PET_STATE_FRAMES: Record<PetState, PetFrame[]> = {
  idle: IDLE_FRAMES,
  'running-right': buildRow(1, 8, 120, 220),
  'running-left': buildRow(2, 8, 120, 220),
  waving: buildRow(3, 4, 140, 280),
  jumping: buildRow(4, 5, 140, 280),
  failed: buildRow(5, 8, 140, 240),
  waiting: buildRow(6, 6, 150, 260),
  running: buildRow(7, 6, 120, 220),
  review: buildRow(8, 6, 150, 280),
};

export interface PetSequence {
  frames: PetFrame[];
  /** When the last frame is reached, jump back here; null = stop. */
  loopStartIndex: number | null;
}

// Non-idle states play through a few times, then settle into the idle loop.
const ACTION_REPEATS = 3;

/**
 * Resolve the frame sequence to play for a state.
 * - reduced motion: a single static frame, no loop.
 * - idle: the slow idle loop, forever.
 * - any action: play it `ACTION_REPEATS` times, then loop the idle settle.
 */
export function buildSequence(
  state: PetState,
  reducedMotion: boolean,
): PetSequence {
  const base = PET_STATE_FRAMES[state];
  if (reducedMotion) {
    return { frames: [base[0]], loopStartIndex: null };
  }
  if (state === 'idle') {
    return { frames: IDLE_SETTLED, loopStartIndex: 0 };
  }
  const action: PetFrame[] = [];
  for (let i = 0; i < ACTION_REPEATS; i += 1) action.push(...base);
  return {
    frames: [...action, ...IDLE_SETTLED],
    loopStartIndex: action.length,
  };
}

/** CSS `background-position` for a frame (percentage-based sprite stepping). */
export function backgroundPositionFor(frame: PetFrame): string {
  const x = (frame.columnIndex / (PET_COLUMNS - 1)) * 100;
  const y = (frame.rowIndex / (PET_ROWS - 1)) * 100;
  return `${x}% ${y}%`;
}

/** `background-size` that makes the atlas map one cell per element. */
export const PET_BACKGROUND_SIZE = `${PET_COLUMNS * 100}% ${PET_ROWS * 100}%`;
