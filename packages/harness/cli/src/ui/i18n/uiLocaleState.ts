/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { I18nService, UiLocale } from '@qwen-code/core';
type UiLocaleListener = (locale: UiLocale) => void;
let current: I18nService | undefined;
let stopBinding: (() => void) | undefined;
const listeners = new Set<UiLocaleListener>();
export function getUiLocale(): UiLocale | undefined {
  return current?.locale;
}
export function onUiLocaleChange(listener: UiLocaleListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function bindUiLocale(service: I18nService): () => void {
  stopBinding?.();
  current = service;
  let locale = service.locale;
  for (const listener of listeners) listener(locale);
  const stop = service.subscribe(() => {
    if (locale === service.locale) return;
    locale = service.locale;
    for (const listener of [...listeners]) listener(locale);
  });
  const cleanup = () => {
    stop();
    if (stopBinding === cleanup) {
      current = undefined;
      stopBinding = undefined;
    }
  };
  stopBinding = cleanup;
  return cleanup;
}
export function resetUiLocaleForTest(): void {
  stopBinding?.();
  listeners.clear();
}
