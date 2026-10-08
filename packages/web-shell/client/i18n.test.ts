import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  getTranslator,
  languageLabel,
  languageSettingToWebShellLanguage,
  normalizeLanguage,
  parseUiLanguageArg,
  toDomLanguage,
  toSurfaceLanguage,
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

// The ru catalog ships the goal card first (#13391); everything else falls
// back to EN, so the language mapping and a few pinned strings are what can
// regress silently.
describe('ru locale', () => {
  it('maps Russian browser languages and settings aliases to ru', () => {
    expect(normalizeLanguage('ru')).toBe('ru');
    expect(normalizeLanguage('ru-RU')).toBe('ru');
    expect(normalizeLanguage('ru_RU')).toBe('ru');
    expect(normalizeLanguage('zh_CN')).toBe('zh-CN');
    expect(normalizeLanguage('fr-FR')).toBe('en');
    expect(parseUiLanguageArg('ru_RU')).toBe('ru');
    expect(parseUiLanguageArg('ru-UA')).toBe('ru');
    expect(parseUiLanguageArg('zh_CN')).toBe('zh-CN');
    expect(parseUiLanguageArg('fr')).toBeUndefined();
    expect(parseUiLanguageArg('auto')).toBeUndefined();
    expect(toDomLanguage('ru')).toBe('en');
    expect(toDomLanguage('zh-CN')).toBe('zh-CN');
    expect(toDomLanguage('en')).toBe('en');
    expect(toSurfaceLanguage('ru')).toBe('ru');
    expect(toSurfaceLanguage('en')).toBeUndefined();
    expect(toSurfaceLanguage('zh-CN')).toBeUndefined();
    expect(languageLabel('en')).toBe('English [en]');
    expect(languageLabel('zh-CN')).toBe('中文 [zh-CN]');
    expect(languageLabel('ru')).toBe('Русский [ru] · частично');
    expect(languageLabel('ru', getTranslator('en'))).toBe(
      'Русский [ru] · partial',
    );
    expect(languageSettingToWebShellLanguage('ru')).toBe('ru');
    expect(languageSettingToWebShellLanguage('ru-ru')).toBe('ru');
    expect(languageSettingToWebShellLanguage('russian')).toBe('ru');
    expect(languageSettingToWebShellLanguage('Русский')).toBe('ru');
  });

  it('renders goal-card strings in Russian and falls back to EN', () => {
    const t = getTranslator('ru');
    expect(t('goal.blocked')).toBe('Цель заблокирована');
    expect(t('goal.failed')).toBe('Цель не достигнута');
    expect(t('goal.lastCheck')).toBe('Последняя проверка');
    expect(t('approval.goal.title')).toBe('Подтвердите цель сессии');
    expect(t('goal.turns', { count: 1 })).toBe('1 ход');
    expect(t('goal.turns', { count: 5 })).toBe('5 ходов');
    expect(t('goal.turns', { count: 11 })).toBe('11 ходов');
    expect(t('goal.turns', { count: 14 })).toBe('14 ходов');
    expect(t('goal.turns', { count: 21 })).toBe('21 ход');
    expect(t('goal.turns', { count: 22 })).toBe('22 хода');
    expect(t('goals.count', { count: 2 })).toBe('2 активные цели');
    expect(t('goals.count', { count: 12 })).toBe('12 активных целей');
    expect(t('memory.add')).toBe('Add');
  });

  it('maintains parity between EN and RU for all goal-card keys', () => {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const content = readFileSync(join(currentDir, 'i18n.tsx'), 'utf8');

    const extractKeys = (blockName: string) => {
      const match = content.match(
        new RegExp(`const ${blockName}: Messages = {([\\s\\S]*?)};`),
      );
      if (!match) return new Set<string>();
      const keys = new Set<string>();
      const keyRegex = /'([a-zA-Z0-9_.-]+)':/g;
      let m: RegExpExecArray | null;
      while ((m = keyRegex.exec(match[1])) !== null) {
        if (
          m[1].startsWith('goal.') ||
          m[1].startsWith('goals.') ||
          m[1].startsWith('approval.goal.')
        ) {
          keys.add(m[1]);
        }
      }
      return keys;
    };

    const enGoalKeys = extractKeys('EN');
    const ruGoalKeys = extractKeys('RU');

    expect(ruGoalKeys.size).toBeGreaterThan(0);
    expect(Array.from(ruGoalKeys).sort()).toEqual(
      Array.from(enGoalKeys).sort(),
    );
  });
});
