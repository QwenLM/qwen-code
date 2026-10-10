import { describe, expect, it } from 'vitest';
import {
  WEB_SHELL_LANGUAGES,
  getTranslator,
  languageLabel,
  languageSettingToWebShellLanguage,
  normalizeLanguage,
} from './i18n';

// getTranslator returns the raw key when EN has no entry. SettingsMessage
// translateSettingText then substitutes the settingsSchema.ts description,
// which still says Enter accepts into the input buffer — wrong in Web Shell,
// where Enter accepts and submits (#9521). A missing EN override is therefore
// silent in the UI and in tests unless the catalog itself is pinned.
const FOLLOWUP_SETTING_KEYS = [
  'settings.label.ui.enableFollowupSuggestions',
  'settings.description.ui.enableFollowupSuggestions',
] as const;

describe('web-shell i18n catalog', () => {
  it('keeps filter translations available and pluralizes record counts', () => {
    const en = getTranslator('en');
    expect(en('trajectory.filter.search')).toBe('Search loaded records…');
    expect(getTranslator('zh-CN')('trajectory.filter.search')).toBe(
      '搜索已加载记录…',
    );
    expect(en('trajectory.filter.count', { count: 1 })).toBe(
      '1 matching record',
    );
    expect(en('trajectory.filter.count', { count: 2 })).toBe(
      '2 matching records',
    );
    expect(en('trajectory.filter.truncated', { count: 1 })).toContain(
      '(1 record)',
    );
    expect(en('trajectory.filter.truncated', { count: 2 })).toContain(
      '(2 records)',
    );
  });
  it('keeps the follow-up suggestion setting copy overridden in EN', () => {
    const t = getTranslator('en');
    for (const key of FOLLOWUP_SETTING_KEYS) {
      expect(t(key)).not.toBe(key);
    }
  });

  // The daemon validates a saved voice only while Live Voice is on; the copy
  // must not promise an unconditional check, in either locale.
  it('states the provider-validation condition on the voice hint', () => {
    expect(getTranslator('en')('settings.liveSetup.voiceHint')).toContain(
      'when Live Voice is on',
    );
    expect(getTranslator('zh-CN')('settings.liveSetup.voiceHint')).toContain(
      '开启 Live Voice 时',
    );
  });

  it('carries the next-call hint in both locales', () => {
    // Content assertions, not just presence: a missing zh-CN entry falls
    // back to the EN copy, which a not-the-key check cannot catch.
    expect(getTranslator('en')('settings.liveSetup.appliesNextCall')).toContain(
      'next call',
    );
    expect(
      getTranslator('zh-CN')('settings.liveSetup.appliesNextCall'),
    ).toContain('下一次通话');
  });

  // The model hint points at the picker's custom entry by name; keep the two
  // strings in step in both locales.
  it('names the custom model entry in the model hint', () => {
    for (const language of ['en', 'zh-CN'] as const) {
      const t = getTranslator(language);
      expect(t('settings.liveSetup.modelHint')).toContain(
        t('settings.liveSetup.modelCustom'),
      );
    }
  });
});

// #13391: ru ships a PARTIAL catalog covering the Goal card and the Goals
// dialog only; every other key must fall back to EN in getTranslator. These
// pins guard the normalizer branches, the pluralisation and that fallback.
describe('web-shell ru locale', () => {
  it('normalizes ru spellings to ru and leaves the en/zh mappings untouched', () => {
    for (const value of [
      'ru',
      'ru-ru',
      'ru_ru',
      'russian',
      'русский',
      'RU',
      ' RU-RU ',
      // Region-qualified Russian must not fall through to en.
      'ru-UA',
      'ru-KZ',
      'ru-BY',
      'ru-MD',
    ]) {
      expect(normalizeLanguage(value)).toBe('ru');
    }
    expect(normalizeLanguage('en')).toBe('en');
    expect(normalizeLanguage('EN-US')).toBe('en');
    expect(normalizeLanguage('zh')).toBe('zh-CN');
    expect(normalizeLanguage('zh-cn')).toBe('zh-CN');
    expect(normalizeLanguage('zh_cn')).toBe('zh-CN');
    // Unrelated locales still collapse to en (fr, ja, … are not shipped).
    expect(normalizeLanguage('fr-FR')).toBe('en');
    expect(normalizeLanguage('ja-JP')).toBe('en');
    expect(normalizeLanguage(undefined)).toBe('en');
  });

  it('maps daemon language settings to ru, underscore and region forms included', () => {
    for (const value of [
      'ru',
      'ru-ru',
      'ru_ru',
      'russian',
      'русский',
      'RU',
      'ru-UA',
    ]) {
      expect(languageSettingToWebShellLanguage(value)).toBe('ru');
    }
    expect(languageSettingToWebShellLanguage('zh')).toBe('zh-CN');
    expect(languageSettingToWebShellLanguage('en')).toBe('en');
    expect(languageSettingToWebShellLanguage('fr')).toBeUndefined();
  });

  it('lists ru in the picker with the "Русский [ru]" label', () => {
    expect(WEB_SHELL_LANGUAGES).toEqual(['en', 'zh-CN', 'ru']);
    expect(languageLabel('ru')).toBe('Русский [ru]');
  });

  it('pluralises turn counters the Russian way', () => {
    const t = getTranslator('ru');
    expect(t('goal.turns', { count: 1 })).toBe('1 ход');
    expect(t('goal.turns', { count: 2 })).toBe('2 хода');
    expect(t('goal.turns', { count: 5 })).toBe('5 ходов');
    expect(t('goal.turns', { count: 11 })).toBe('11 ходов');
    expect(t('goal.turns', { count: 21 })).toBe('21 ход');
    // The budget side pluralises on the budget, not the used count.
    expect(t('goal.turnsOfBudget', { count: 1, budget: 1 })).toBe('1 / 1 ход');
    expect(t('goal.turnsOfBudget', { count: 1, budget: 2 })).toBe('1 / 2 хода');
    expect(t('goal.turnsOfBudget', { count: 3, budget: 11 })).toBe(
      '3 / 11 ходов',
    );
  });

  it('pluralises token spend the Russian way', () => {
    const t = getTranslator('ru');
    expect(t('goal.tokens', { used: 1 })).toBe('1 токен');
    expect(t('goal.tokens', { used: 3 })).toBe('3 токена');
    expect(t('goal.tokens', { used: 5 })).toBe('5 токенов');
    expect(t('goal.tokens', { used: 11 })).toBe('11 токенов');
    expect(t('goal.tokens', { used: 21 })).toBe('21 токен');
  });

  it('pluralises the goals counter the Russian way', () => {
    const t = getTranslator('ru');
    expect(t('goals.count', { count: 1 })).toBe('1 активная цель');
    expect(t('goals.count', { count: 2 })).toBe('2 активные цели');
    expect(t('goals.count', { count: 5 })).toBe('5 активных целей');
    expect(t('goals.count', { count: 11 })).toBe('11 активных целей');
    expect(t('goals.count', { count: 21 })).toBe('21 активная цель');
  });

  it('renders goals.dropped with the session count and the right plural', () => {
    const t = getTranslator('ru');
    expect(t('goals.dropped', { count: 3 })).toBe(
      '3 сеанса не удалось достичь — цели, которые они выполняли, отсутствуют в этом списке.',
    );
    expect(t('goals.dropped', { count: 5 })).toBe(
      '5 сеансов не удалось достичь — цели, которые они выполняли, отсутствуют в этом списке.',
    );
    expect(t('goals.dropped', { count: 1 })).toBe(
      '1 сеанс не удалось достичь — цели, которые они выполняли, отсутствуют в этом списке.',
    );
  });

  it('renders the Goal card from the ru catalog, not from EN', () => {
    const t = getTranslator('ru');
    const en = getTranslator('en');
    expect(t('goal.blocked')).toBe('Цель заблокирована');
    expect(t('goal.lastCheck')).toBe('Последняя проверка');
    expect(t('goal.status.blocked')).toBe('Заблокирована');
    expect(t('goals.title')).toBe('Цели');
    expect(t('goals.empty')).toBe(
      'Нет активных целей. Задайте: /goal <условие>.',
    );
    expect(t('goal.blocked')).not.toBe(en('goal.blocked'));
  });

  it('falls back to EN for keys the partial ru catalog lacks', () => {
    const t = getTranslator('ru');
    const en = getTranslator('en');
    // Plain and parameterised EN values both resolve, not the raw key.
    expect(t('welcome.prompt')).toBe(en('welcome.prompt'));
    expect(t('welcome.prompt')).not.toBe('welcome.prompt');
    expect(t('capacityChoice.capacity', { used: 1, limit: 2 })).toBe(
      en('capacityChoice.capacity', { used: 1, limit: 2 }),
    );
    // Unknown in every catalog: the key itself, as in all locales.
    expect(t('no.such.key')).toBe('no.such.key');
  });
});
