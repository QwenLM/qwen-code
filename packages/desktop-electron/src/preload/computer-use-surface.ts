/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcRenderer } from 'electron';
import {
  COMPUTER_USE_CHANNELS,
  type ComputerUseSurfaceState,
} from '../shared/computer-use';

const mode = new URLSearchParams(window.location.search).get('mode');
let state: ComputerUseSurfaceState | undefined;

ipcRenderer.on(
  COMPUTER_USE_CHANNELS.stateChanged,
  (_event, nextState: ComputerUseSurfaceState) => {
    state = nextState;
    render();
  },
);

window.addEventListener('DOMContentLoaded', () => {
  document.body.dataset['mode'] = mode === 'pip' ? 'pip' : 'status';
  document
    .querySelector('[data-action="stop"]')
    ?.addEventListener('click', () => {
      void ipcRenderer.invoke(COMPUTER_USE_CHANNELS.stop);
    });
  document
    .querySelector('[data-action="hide"]')
    ?.addEventListener('click', () => {
      void ipcRenderer.invoke(
        COMPUTER_USE_CHANNELS.setPictureInPictureVisible,
        false,
      );
    });
  render();
});

function render(): void {
  if (!state || document.readyState === 'loading') return;
  const labels = labelsFor(state.language);
  document.documentElement.lang = state.language;
  setText('[data-value="title"]', labels.title);
  setText('[data-value="action"]', state.action);
  setText('[data-value="target"]', state.target ? ` · ${state.target}` : '');
  setText(
    '[data-value="shortcut"]',
    state.canStopWithEscape ? labels.escape : labels.stopInQwen,
  );
  setText(
    '[data-value="waiting"]',
    state.previewUnavailable ? labels.unavailable : labels.waiting,
  );
  const image = document.querySelector<HTMLImageElement>(
    '[data-value="screenshot"]',
  );
  const empty = document.querySelector<HTMLElement>('[data-value="empty"]');
  if (image && empty) {
    if (state.screenshot) {
      image.src = state.screenshot;
      image.hidden = false;
      empty.hidden = true;
    } else {
      image.removeAttribute('src');
      image.hidden = true;
      empty.hidden = false;
    }
  }
  const stop = document.querySelector<HTMLButtonElement>(
    '[data-action="stop"]',
  );
  if (stop) {
    stop.disabled = state.stopping;
    stop.textContent = state.stopping ? labels.stopping : labels.stop;
  }
  const hide = document.querySelector<HTMLButtonElement>(
    '[data-action="hide"]',
  );
  if (hide) {
    hide.title = labels.hide;
    hide.setAttribute('aria-label', labels.hide);
  }
}

function setText(selector: string, value: string): void {
  for (const element of document.querySelectorAll<HTMLElement>(selector)) {
    element.textContent = value;
  }
}

interface Labels {
  escape: string;
  hide: string;
  stop: string;
  stopInQwen: string;
  stopping: string;
  title: string;
  unavailable: string;
  waiting: string;
}

function labelsFor(language: string): Labels {
  if (language.toLowerCase().startsWith('zh')) {
    return {
      escape: '按 Esc 取消',
      hide: '隐藏画中画',
      stop: '停止',
      stopInQwen: '在 Qwen Code 中停止',
      stopping: '正在停止…',
      title: 'Qwen Code 正在使用你的电脑',
      unavailable: '屏幕预览不可用',
      waiting: '正在等待屏幕画面',
    };
  }
  return {
    escape: 'Esc to cancel',
    hide: 'Hide picture in picture',
    stop: 'Stop',
    stopInQwen: 'Stop in Qwen Code',
    stopping: 'Stopping…',
    title: 'Qwen Code is using your computer',
    unavailable: 'Screen preview unavailable',
    waiting: 'Waiting for the screen',
  };
}
