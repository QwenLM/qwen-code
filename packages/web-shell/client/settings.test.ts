import { describe, expect, it } from 'vitest';
import {
  isSettingExcluded,
  WEB_SHELL_SETTING_ITEM_IDS,
  type WebShellSettingItemId,
} from './settings';

describe('settings presentation aliases', () => {
  it('maps stable public aliases to configuration keys without accepting raw paths', () => {
    expect(
      isSettingExcluded('fastModel', { excludeItems: ['setting:fast-model'] }),
    ).toBe(true);
    expect(
      isSettingExcluded('general.language', {
        excludeItems: ['setting:language'],
      }),
    ).toBe(true);
    expect(
      isSettingExcluded('visionModel', {
        excludeItems: ['setting:fast-model'],
      }),
    ).toBe(false);
    expect(
      isSettingExcluded('fastModel', {
        excludeItems: ['setting:fastModel' as WebShellSettingItemId],
      }),
    ).toBe(false);
  });
  it('ignores unknown runtime IDs and inherited property names', () => {
    for (const id of ['unknown', 'toString', '__proto__']) {
      expect(
        isSettingExcluded('fastModel', {
          excludeItems: [id as WebShellSettingItemId],
        }),
      ).toBe(false);
    }
    expect(isSettingExcluded('fastModel')).toBe(false);
    expect(isSettingExcluded('fastModel', { excludeItems: [] })).toBe(false);
  });
  it('publishes unique IDs including each native frontend block', () => {
    expect(new Set(WEB_SHELL_SETTING_ITEM_IDS).size).toBe(
      WEB_SHELL_SETTING_ITEM_IDS.length,
    );
    for (const id of [
      'builtin:chat-width',
      'builtin:browser-notifications',
      'builtin:live-setup',
      'builtin:local-control',
      'builtin:model-management',
    ]) {
      expect(WEB_SHELL_SETTING_ITEM_IDS).toContain(id);
    }
  });
});
