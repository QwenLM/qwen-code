/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { getQoderErrorText } from '../provider/qoder/qoderErrorText.js';
import {
  getPaidConfirmationMessage,
  isNewPaidConfirmationCode,
} from '../provider/qoder/qoderPaidConfirmationText.js';
import type { UiLocale } from '../utils/locale.js';
import type {
  I18nCatalog,
  I18nSnapshot,
  I18nService,
  I18nUiState,
  MessageParams,
} from './i18n-service.js';
import { UiTextStore } from './ui-text-store.js';
import { formatMessage } from './message-format.js';

const DEFAULT_TEXTS: Record<string, string> = {
  // Model descriptions
  'modelSelector.item.auto.markdownDescription':
    'Smartly select the optimal model, balancing performance and cost',
  'modelSelector.item.ultimate.markdownDescription':
    'Expert-level deep reasoning and thinking with peak output quality',
  'modelSelector.item.performance.markdownDescription':
    'Advanced reasoning with high output quality',
  'modelSelector.item.efficient.markdownDescription':
    'Standard reasoning at low cost',
  'modelSelector.item.lite.markdownDescription':
    'Basic reasoning available on Free (may be slower during peak hours)',
  'modelSelector.item.qmodel.markdownDescription': 'A custom model built on Qwen Code, delivers a better end-to-end coding experience.',
  'modelSelector.item.gmodel.markdownDescription':
    "Zhipu AI's latest flagship model, excels at complex systems engineering and long-horizon tasks",
  'modelSelector.item.kmodel.markdownDescription':
    "Kimi's latest model, excelling in multimodal understanding and complex task handling",
  'modelSelector.item.mmodel.markdownDescription':
    "MiniMax's latest Agentic model, combining speed, performance, and cost-efficiency",
  'modelSelector.item.q35model.markdownDescription':
    "Alibaba's latest model, delivering a comprehensive leap in reasoning capability, efficiency, and multimodal experience.",

  // Tags and labels
  'modelSelector.tag.limited_time_free': 'Limited Time Free',
  'modelSelector.unsupport.image': 'Image input not supported',
  'modelSelector.newModels.header': 'New Models',
};

/** Built-in texts only: no network, file cache or background tasks. */
export class DefaultI18nService implements I18nService {
  protected readonly uiTexts = new UiTextStore();
  get locale() {
    return this.uiTexts.getSnapshot().locale;
  }
  get preference() {
    return this.uiTexts.getSnapshot().preference;
  }
  get dynamicContentEnabled() {
    return this.uiTexts.getSnapshot().dynamicContentEnabled;
  }
  get revision() {
    return this.uiTexts.getSnapshot().revision;
  }
  configureUi(state: I18nUiState): void {
    this.uiTexts.configureUi(state);
  }
  registerCatalog(catalog: I18nCatalog): void {
    this.uiTexts.registerCatalog(catalog);
  }
  getTemplate(key: string): string {
    if (key.startsWith('modelSelector.') || key.startsWith('quota.package.'))
      return this.lookupDynamicText(key, this.locale);
    if (key.startsWith('error.code.')) return this.getErrorCodeMessage(key);
    return this.uiTexts.getTemplate(key);
  }
  private lookup(key: string, params?: MessageParams): string {
    if (key.startsWith('error.code.'))
      return this.getErrorCodeMessage(key, String(params?.['message'] ?? ''));
    const template = this.getTemplate(key);
    return key.startsWith('modelSelector.') || key.startsWith('quota.package.')
      ? template
      : formatMessage(template, params);
  }

  private queryRevision = -1;
  private query: I18nService['get'] = (key, params) => this.lookup(key, params);

  /** A bound query for this revision, so React can memoize using the query itself. */
  get get(): I18nService['get'] {
    if (this.queryRevision !== this.revision) {
      this.queryRevision = this.revision;
      this.query = (key, params) => this.lookup(key, params);
    }
    return this.query;
  }
  formatDate = (
    value: Date | number,
    options?: Intl.DateTimeFormatOptions,
  ): string => new Intl.DateTimeFormat(this.locale, options).format(value);
  formatNumber = (value: number, options?: Intl.NumberFormatOptions): string =>
    new Intl.NumberFormat(this.locale, options).format(value);

  initSync(): void {}
  async init(): Promise<void> {}
  dispose(): void {
    this.uiTexts.dispose();
  }

  protected lookupDynamicText(key: string, _locale: UiLocale = 'en'): string {
    return DEFAULT_TEXTS[key] ?? '';
  }

  getModelDescription(modelKey: string, locale: UiLocale = 'en'): string {
    return this.lookupDynamicText(
      `modelSelector.item.${modelKey}.markdownDescription`,
      locale,
    );
  }

  hasModelDescription(modelKey: string, locale: UiLocale = 'en'): boolean {
    return this.getModelDescription(modelKey, locale) !== '';
  }

  async ensureLocale(_locale: UiLocale): Promise<void> {}
  subscribe(listener: () => void): () => void {
    return this.uiTexts.subscribe(listener);
  }
  getSnapshot(): I18nSnapshot {
    return this.uiTexts.getSnapshot();
  }

  getErrorCodeMessage(
    code: string | number | undefined,
    defaultMessage = '',
  ): string {
    const text = code === undefined ? '' : String(code).trim();
    if (!text) return defaultMessage;
    const key = text.startsWith('error.code.') ? text : `error.code.${text}`;
    const normalizedCode = key.slice('error.code.'.length);
    if (isNewPaidConfirmationCode(normalizedCode)) {
      return getPaidConfirmationMessage(this.locale);
    }
    // Keep the existing fallback for callers that render legacy errors.
    return key === 'error.code.122'
      ? (getQoderErrorText(122) ?? defaultMessage)
      : defaultMessage;
  }
}
