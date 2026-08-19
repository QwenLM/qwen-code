/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ComputerUseApi,
  ComputerUseSurfaceState,
} from '../shared/computer-use';

interface ControlElements {
  action: HTMLElement;
  alwaysHide: HTMLInputElement;
  alwaysHideLabel: HTMLElement;
  heading: HTMLElement;
  pictureInPicture: HTMLButtonElement;
  pictureInPictureLabel: HTMLElement;
  popover: HTMLElement;
  root: HTMLElement;
  stop: HTMLButtonElement;
  target: HTMLElement;
  trigger: HTMLButtonElement;
  triggerText: HTMLElement;
}

export function installComputerUseControl(api: ComputerUseApi): () => void {
  let elements: ControlElements | undefined;
  let state: ComputerUseSurfaceState | undefined;

  const update = (nextState: ComputerUseSurfaceState): void => {
    state = nextState;
    if (!elements) return;
    const labels = labelsFor(state.language);
    elements.root.hidden = !state.active;
    if (!state.active) {
      elements.popover.hidden = true;
      elements.trigger.setAttribute('aria-expanded', 'false');
    }
    elements.trigger.setAttribute(
      'aria-label',
      `${labels.title}: ${state.action}`,
    );
    elements.action.textContent = state.active ? state.action : labels.finished;
    elements.triggerText.textContent = labels.title;
    elements.heading.textContent = labels.title;
    elements.popover.setAttribute('aria-label', labels.title);
    elements.pictureInPictureLabel.textContent = labels.pictureInPicture;
    elements.alwaysHideLabel.textContent = labels.alwaysHide;
    elements.target.textContent = state.target
      ? `${labels.target}: ${state.target}`
      : '';
    elements.target.hidden = !state.target;
    elements.alwaysHide.checked = state.alwaysHidePictureInPicture;
    elements.pictureInPicture.textContent = state.pictureInPictureVisible
      ? labels.hide
      : labels.show;
    elements.pictureInPicture.disabled = !state.active;
    elements.stop.textContent = state.stopping ? labels.stopping : labels.stop;
    elements.stop.disabled = !state.active || state.stopping;
  };

  const mount = (): void => {
    if (elements?.root.isConnected) return;
    elements = createControl(labelsFor(currentLanguage()));
    document.body.append(elements.root);
    elements.trigger.addEventListener('click', () => {
      const open = elements!.popover.hidden;
      elements!.popover.hidden = !open;
      elements!.trigger.setAttribute('aria-expanded', String(open));
    });
    elements.pictureInPicture.addEventListener('click', () => {
      if (!state) return;
      void api
        .setPictureInPictureVisible(!state.pictureInPictureVisible)
        .catch(ignoreFailure);
    });
    elements.alwaysHide.addEventListener('change', () => {
      void api
        .setAlwaysHidePictureInPicture(elements!.alwaysHide.checked)
        .catch(ignoreFailure);
    });
    elements.stop.addEventListener('click', () => {
      void api.stop().catch(ignoreFailure);
    });
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    if (state) update(state);
  };

  const closeOnOutsidePointer = (event: PointerEvent): void => {
    if (!elements || elements.root.contains(event.target as Node)) return;
    elements.popover.hidden = true;
    elements.trigger.setAttribute('aria-expanded', 'false');
  };

  const stopStateUpdates = api.onStateChanged(update);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
  return () => {
    stopStateUpdates();
    document.removeEventListener('DOMContentLoaded', mount);
    document.removeEventListener('pointerdown', closeOnOutsidePointer);
    elements?.root.remove();
  };
}

function createControl(labels: Labels): ControlElements {
  const root = document.createElement('aside');
  root.dataset['qwenDesktopComputerUseControl'] = '';
  root.hidden = true;

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.dataset['qwenDesktopComputerUseTrigger'] = '';
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-expanded', 'false');
  const dot = document.createElement('span');
  dot.dataset['qwenDesktopComputerUseDot'] = '';
  dot.setAttribute('aria-hidden', 'true');
  const triggerText = document.createElement('span');
  triggerText.textContent = labels.title;
  trigger.append(dot, triggerText);

  const popover = document.createElement('section');
  popover.dataset['qwenDesktopComputerUsePopover'] = '';
  popover.hidden = true;
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-label', labels.title);

  const heading = document.createElement('div');
  heading.dataset['qwenDesktopComputerUseHeading'] = '';
  heading.textContent = labels.title;
  const action = document.createElement('div');
  action.dataset['qwenDesktopComputerUseAction'] = '';
  const target = document.createElement('div');
  target.dataset['qwenDesktopComputerUseTarget'] = '';

  const pictureInPictureRow = document.createElement('div');
  pictureInPictureRow.dataset['qwenDesktopComputerUseRow'] = '';
  const pictureInPictureLabel = document.createElement('span');
  pictureInPictureLabel.textContent = labels.pictureInPicture;
  const pictureInPicture = document.createElement('button');
  pictureInPicture.type = 'button';
  pictureInPicture.dataset['qwenDesktopComputerUseSecondary'] = '';
  pictureInPictureRow.append(pictureInPictureLabel, pictureInPicture);

  const alwaysHideRow = document.createElement('label');
  alwaysHideRow.dataset['qwenDesktopComputerUseRow'] = '';
  const alwaysHideLabel = document.createElement('span');
  alwaysHideLabel.textContent = labels.alwaysHide;
  const alwaysHide = document.createElement('input');
  alwaysHide.type = 'checkbox';
  alwaysHideRow.append(alwaysHideLabel, alwaysHide);

  const stop = document.createElement('button');
  stop.type = 'button';
  stop.dataset['qwenDesktopComputerUseStop'] = '';
  stop.textContent = labels.stop;
  popover.append(
    heading,
    action,
    target,
    pictureInPictureRow,
    alwaysHideRow,
    stop,
  );
  root.append(trigger, popover);
  return {
    action,
    alwaysHide,
    alwaysHideLabel,
    heading,
    pictureInPicture,
    pictureInPictureLabel,
    popover,
    root,
    stop,
    target,
    trigger,
    triggerText,
  };
}

interface Labels {
  alwaysHide: string;
  finished: string;
  hide: string;
  pictureInPicture: string;
  show: string;
  stop: string;
  stopping: string;
  target: string;
  title: string;
}

function labelsFor(language: string): Labels {
  if (language.toLowerCase().startsWith('zh')) {
    return {
      alwaysHide: '总是隐藏画中画',
      finished: '本轮电脑操作已结束',
      hide: '隐藏',
      pictureInPicture: '画中画',
      show: '显示',
      stop: '停止电脑操作',
      stopping: '正在停止…',
      target: '目标',
      title: 'Computer Use',
    };
  }
  return {
    alwaysHide: 'Always hide picture in picture',
    finished: 'Computer activity finished for this turn',
    hide: 'Hide',
    pictureInPicture: 'Picture in picture',
    show: 'Show',
    stop: 'Stop computer use',
    stopping: 'Stopping…',
    target: 'Target',
    title: 'Computer Use',
  };
}

function ignoreFailure(): void {}

function currentLanguage(): string {
  return navigator.language || document.documentElement.lang;
}
