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

  // Routes load from user scope only (a repository must not redirect
  // microphone audio), so the hint must name user settings, in both locales.
  it('names the user settings scope in the model hint', () => {
    expect(getTranslator('en')('settings.liveSetup.modelHint')).toContain(
      'user settings',
    );
    expect(getTranslator('zh-CN')('settings.liveSetup.modelHint')).toContain(
      '用户设置',
    );
  });
});
