/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PetSettings, PetState } from '../shared/desktop-api';
import {
  PET_BACKGROUND_SIZE,
  PET_CELL_HEIGHT,
  PET_CELL_WIDTH,
  buildPetSequence,
  petBackgroundPosition,
} from './pet-animation';

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error('Desktop pet bridge is unavailable.');
  }
  return value;
}

const api = required(window.qwenCodePet);
const pet = required(document.querySelector<HTMLDivElement>('#pet'));
const menu = required(document.querySelector<HTMLDivElement>('#menu'));
const closeButton = required(
  document.querySelector<HTMLButtonElement>('#close-pet'),
);

let animationTimer: ReturnType<typeof setTimeout> | undefined;
let animationState: PetState = 'idle';
let draggingPointer: number | undefined;
let ignoringMouse = true;

function applySettings(settings: PetSettings): void {
  const width = Math.round(settings.size * (PET_CELL_WIDTH / PET_CELL_HEIGHT));
  pet.style.width = `${width}px`;
  pet.style.height = `${settings.size}px`;
  pet.style.backgroundSize = PET_BACKGROUND_SIZE;
}

function play(state: PetState): void {
  animationState = state;
  if (animationTimer) clearTimeout(animationTimer);
  const sequence = buildPetSequence(state);
  let index = 0;
  const reducedMotion = window.matchMedia(
    '(prefers-reduced-motion: reduce)',
  ).matches;

  const showFrame = () => {
    const frame = sequence.frames[index];
    if (!frame) return;
    pet.style.backgroundPosition = petBackgroundPosition(frame);
    if (reducedMotion) return;
    animationTimer = setTimeout(() => {
      index += 1;
      if (index >= sequence.frames.length) index = sequence.loopStartIndex;
      showFrame();
    }, frame.durationMs);
  };
  showFrame();
}

function setIgnoreMouse(ignore: boolean): void {
  if (ignore === ignoringMouse) return;
  ignoringMouse = ignore;
  api.setIgnoreMouse(ignore);
}

function hideMenu(): void {
  menu.hidden = true;
}

window.addEventListener('mousemove', (event) => {
  if (draggingPointer !== undefined) return;
  const target = document.elementFromPoint(event.clientX, event.clientY);
  const interactive = Boolean(target?.closest('[data-pet-interactive]'));
  if (!interactive) hideMenu();
  setIgnoreMouse(!interactive);
});

pet.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  hideMenu();
  draggingPointer = event.pointerId;
  pet.setPointerCapture(event.pointerId);
  api.beginDrag(event.screenX, event.screenY);
});

pet.addEventListener('pointermove', (event) => {
  if (draggingPointer !== event.pointerId || (event.buttons & 1) === 0) return;
  api.moveDrag(event.screenX, event.screenY);
});

function finishDrag(event: PointerEvent): void {
  if (draggingPointer !== event.pointerId) return;
  if (pet.hasPointerCapture(event.pointerId)) {
    pet.releasePointerCapture(event.pointerId);
  }
  draggingPointer = undefined;
  api.endDrag();
}

pet.addEventListener('pointerup', finishDrag);
pet.addEventListener('pointercancel', finishDrag);
pet.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  menu.style.left = `${Math.min(event.clientX, window.innerWidth - 158)}px`;
  menu.style.top = `${Math.min(event.clientY, window.innerHeight - 42)}px`;
  menu.hidden = false;
});

closeButton.addEventListener('click', () => api.close());
window.addEventListener('blur', hideMenu);
window.addEventListener('beforeunload', () => {
  if (animationTimer) clearTimeout(animationTimer);
  api.endDrag();
  api.setIgnoreMouse(false);
});

const removeSettingsListener = api.onSettingsChanged(applySettings);
const removeActivityListener = api.onActivityChanged(play);
window.addEventListener('beforeunload', () => {
  removeSettingsListener();
  removeActivityListener();
});

void api.getSettings().then((settings) => {
  applySettings(settings);
  play(animationState);
});
