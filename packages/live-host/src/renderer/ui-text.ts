import {
  liveText,
  type LiveLanguage,
  type LiveMessageKey,
} from '@qwen-code/qwen-live/i18n';

export function uiText<T extends HTMLElement>(
  element: T,
  key: LiveMessageKey,
): T {
  element.dataset.liveText = key;
  element.textContent = liveText('en', key);
  return element;
}

export function uiLabel<T extends HTMLElement>(
  element: T,
  key: LiveMessageKey,
): T {
  element.dataset.liveLabel = key;
  element.setAttribute('aria-label', liveText('en', key));
  element.title = liveText('en', key);
  return element;
}

export function localizeUi(element: HTMLElement, language: LiveLanguage): void {
  for (const child of element.querySelectorAll<HTMLElement>(
    '[data-live-text]',
  )) {
    const value = liveText(language, child.dataset.liveText as LiveMessageKey);
    if (child.textContent !== value) child.textContent = value;
  }
  for (const child of element.querySelectorAll<HTMLElement>(
    '[data-live-label]',
  )) {
    const value = liveText(language, child.dataset.liveLabel as LiveMessageKey);
    if (child.getAttribute('aria-label') !== value)
      child.setAttribute('aria-label', value);
    if (child.title !== value) child.title = value;
  }
}
