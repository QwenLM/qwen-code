import { describe, expect, it } from 'vitest';
import { getTranslator } from './i18n';

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
