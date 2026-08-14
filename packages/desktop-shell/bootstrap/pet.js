const PET_COLUMNS = 8;
const PET_ROWS = 9;
const PET_CELL_WIDTH = 192;
const PET_CELL_HEIGHT = 208;
const PET_BACKGROUND_SIZE = `${PET_COLUMNS * 100}% ${PET_ROWS * 100}%`;

const required = (value) => {
  if (!value) throw new Error('Desktop pet element is unavailable.');
  return value;
};

const pet = required(document.querySelector('#pet'));
const menu = required(document.querySelector('#menu'));
const closeButton = required(document.querySelector('#close-pet'));
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
let animationTimer;
let animationState = 'idle';

const buildRow = (rowIndex, count, normalMs, lastMs) =>
  Array.from({ length: count }, (_, columnIndex) => ({
    rowIndex,
    columnIndex,
    durationMs: columnIndex === count - 1 ? lastMs : normalMs,
  }));

const idleFrames = [
  { rowIndex: 0, columnIndex: 0, durationMs: 280 },
  { rowIndex: 0, columnIndex: 1, durationMs: 110 },
  { rowIndex: 0, columnIndex: 2, durationMs: 110 },
  { rowIndex: 0, columnIndex: 3, durationMs: 140 },
  { rowIndex: 0, columnIndex: 4, durationMs: 140 },
  { rowIndex: 0, columnIndex: 5, durationMs: 320 },
].map((frame) => ({ ...frame, durationMs: frame.durationMs * 6 }));

const stateFrames = {
  running: buildRow(7, 6, 120, 220),
  waiting: buildRow(6, 6, 150, 260),
  jumping: buildRow(4, 5, 140, 280),
  failed: buildRow(5, 8, 140, 240),
};

function applySettings(settings) {
  const width = Math.round(settings.size * (PET_CELL_WIDTH / PET_CELL_HEIGHT));
  pet.style.width = `${width}px`;
  pet.style.height = `${settings.size}px`;
  pet.style.backgroundSize = PET_BACKGROUND_SIZE;
}

function play(state) {
  animationState = state;
  if (animationTimer) clearTimeout(animationTimer);
  const action =
    state === 'idle'
      ? []
      : Array.from({ length: 3 }, () => stateFrames[state]).flat();
  const frames = [...action, ...idleFrames];
  const loopStart = action.length;
  let index = 0;
  const reducedMotion = window.matchMedia(
    '(prefers-reduced-motion: reduce)',
  ).matches;

  const showFrame = () => {
    const frame = frames[index];
    if (!frame) return;
    const x = (frame.columnIndex / (PET_COLUMNS - 1)) * 100;
    const y = (frame.rowIndex / (PET_ROWS - 1)) * 100;
    pet.style.backgroundPosition = `${x}% ${y}%`;
    if (reducedMotion) return;
    animationTimer = setTimeout(() => {
      index += 1;
      if (index >= frames.length) index = loopStart;
      showFrame();
    }, frame.durationMs);
  };
  showFrame();
}

pet.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  menu.hidden = true;
  void invoke('start_pet_dragging');
});

pet.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  menu.style.left = `${Math.min(event.clientX, window.innerWidth - 158)}px`;
  menu.style.top = `${Math.min(event.clientY, window.innerHeight - 42)}px`;
  menu.hidden = false;
});

closeButton.addEventListener('click', () => void invoke('close_desktop_pet'));
window.addEventListener('blur', () => {
  menu.hidden = true;
});
window.addEventListener('beforeunload', () => {
  if (animationTimer) clearTimeout(animationTimer);
});

const unlisteners = await Promise.all([
  listen('desktop-pet-settings-changed', (event) =>
    applySettings(event.payload),
  ),
  listen('desktop-pet-activity-changed', (event) => play(event.payload)),
]);
window.addEventListener('beforeunload', () => {
  for (const unlisten of unlisteners) unlisten();
});

const bootstrap = await invoke('pet_bootstrap');
applySettings(bootstrap.settings);
play(bootstrap.activity ?? animationState);
