/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { UiLocale } from '../utils/locale.js';

export type MessageParams = Readonly<Record<string, string | number>>;
export type UiLanguagePreference = 'auto' | 'zh-CN' | 'en';
/** Immutable dictionary snapshot. */
export interface I18nCatalog {
  getTemplate(key: string, locale: UiLocale): string | undefined;
}
export interface I18nUiState {
  readonly locale: UiLocale;
  readonly preference: UiLanguagePreference;
  readonly dynamicContentEnabled: boolean;
}
export interface I18nSnapshot extends DynamicTextSnapshot, I18nUiState {}

export interface DynamicTextSnapshot {
  readonly revision: number;
  readonly version: string;
  readonly namespace: string;
  readonly availableLocales: readonly UiLocale[];
}

/** Text lookup, dynamic updates and lifecycle shared by static and product services. */
export interface I18nService {
  readonly locale: UiLocale;
  readonly preference: UiLanguagePreference;
  readonly dynamicContentEnabled: boolean;
  readonly revision: number;

  get(key: string, params?: MessageParams): string;
  getTemplate(key: string): string;
  /** Install the complete dictionary, including any implementation-owned fallback. */
  registerCatalog(catalog: I18nCatalog): void;
  configureUi(state: I18nUiState): void;
  formatDate(
    value: Date | number,
    options?: Intl.DateTimeFormatOptions,
  ): string;
  formatNumber(value: number, options?: Intl.NumberFormatOptions): string;
  initSync(): void;
  init(): Promise<void>;
  dispose(): void;
  getModelDescription(modelKey: string, locale?: UiLocale): string;
  hasModelDescription(modelKey: string, locale?: UiLocale): boolean;
  ensureLocale(locale: UiLocale): Promise<void>;
  subscribe(listener: () => void): () => void;
  getSnapshot(): I18nSnapshot;
  getErrorCodeMessage(
    code: string | number | undefined,
    defaultMessage?: string,
  ): string;
}
