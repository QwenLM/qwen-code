/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { runLogger } from '../utils/runLogger.js';
import type {
  I18nCatalog,
  DynamicTextSnapshot,
  I18nSnapshot,
  I18nUiState,
} from './i18n-service.js';

/** Instance-owned dictionary and the single revision observed by UI consumers. */
export class UiTextStore {
  private catalog: I18nCatalog | undefined;
  private readonly listeners = new Set<() => void>();
  private snapshot: I18nSnapshot = Object.freeze({
    locale: 'en',
    preference: 'en',
    dynamicContentEnabled: true,
    revision: 0,
    version: '',
    namespace: '',
    availableLocales: Object.freeze([]),
  });

  getSnapshot = (): I18nSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(patch: Partial<I18nSnapshot> = {}): void {
    this.snapshot = Object.freeze({
      ...this.snapshot,
      ...patch,
      revision: this.snapshot.revision + 1,
    });
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        runLogger.warn('I18n text listener failed:', error);
      }
    }
  }

  configureUi(state: I18nUiState): void {
    if (
      state.locale === this.snapshot.locale &&
      state.preference === this.snapshot.preference &&
      state.dynamicContentEnabled === this.snapshot.dynamicContentEnabled
    )
      return;
    this.publish(state);
  }

  registerCatalog(catalog: I18nCatalog): void {
    if (this.catalog === catalog) return;
    this.catalog = catalog;
    this.publish();
  }

  getTemplate(key: string): string {
    return this.catalog?.getTemplate(key, this.snapshot.locale) ?? key;
  }

  setDynamicMetadata(
    metadata: Omit<DynamicTextSnapshot, 'revision'>,
    notify = true,
  ): void {
    const patch = {
      ...metadata,
      availableLocales: Object.freeze([...metadata.availableLocales]),
    };
    if (notify) this.publish(patch);
    else this.snapshot = Object.freeze({ ...this.snapshot, ...patch });
  }

  dispose(): void {
    this.listeners.clear();
    this.catalog = undefined;
  }
}
