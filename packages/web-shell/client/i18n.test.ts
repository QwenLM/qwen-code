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
});
