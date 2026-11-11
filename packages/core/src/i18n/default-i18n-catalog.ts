/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { UiLocale } from '../utils/locale.js';
import type { I18nCatalog } from './i18n-service.js';

/** Immutable built-in dictionary. Other catalog implementations own their storage. */
export class DefaultI18nCatalog implements I18nCatalog {
  private readonly messages = new Map<string, ReadonlyMap<string, string>>();

  constructor(
    messages: Partial<Record<UiLocale, Readonly<Record<string, string>>>>,
  ) {
    for (const [locale, entries] of Object.entries(messages)) {
      this.messages.set(locale, new Map(Object.entries(entries)));
    }
  }

  getTemplate(key: string, locale: UiLocale): string | undefined {
    return (
      this.messages.get(locale)?.get(key) ?? this.messages.get('en')?.get(key)
    );
  }
}
