import { describe, expect, it } from 'vitest';
import {
  isItemVisible,
  isSettingVisible,
  WEB_SHELL_SETTING_ITEM_IDS,
  type WebShellSettingItemId,
} from './settings';

describe('settings presentation aliases', () => {
  it('maps stable public aliases to configuration keys without accepting raw paths', () => {
    expect(
      isSettingVisible('fastModel', { excludeItems: ['setting:fast-model'] }),
    ).toBe(false);
    expect(
      isSettingVisible('general.language', {
        excludeItems: ['setting:language'],
      }),
    ).toBe(false);
    expect(
      isSettingVisible('visionModel', {
        excludeItems: ['setting:fast-model'],
      }),
    ).toBe(true);
    expect(
      isSettingVisible('fastModel', {
        excludeItems: ['setting:fastModel' as WebShellSettingItemId],
      }),
    ).toBe(true);
  });
  it('aliases the omni media delivery row', () => {
    expect(
      isSettingVisible('omni.enabled', {
        excludeItems: ['setting:omni-media-delivery'],
      }),
    ).toBe(false);
    expect(WEB_SHELL_SETTING_ITEM_IDS).toContain('setting:omni-media-delivery');
  });
  it('aliases the named-workflows-only lock row', () => {
    expect(
      isSettingVisible('tools.workflowNameOnly', {
        excludeItems: ['setting:workflow-name-only'],
      }),
    ).toBe(false);
    expect(WEB_SHELL_SETTING_ITEM_IDS).toContain('setting:workflow-name-only');
  });
  it('matches published builtin ids by direct membership', () => {
    expect(
      isItemVisible('builtin:model-management', {
        excludeItems: ['builtin:model-management'],
      }),
    ).toBe(false);
    expect(
      isItemVisible('builtin:chat-width', {
        excludeItems: ['builtin:model-management'],
      }),
    ).toBe(true);
    expect(isItemVisible('builtin:local-control')).toBe(true);
  });
  it('ignores unknown runtime IDs and inherited property names', () => {
    for (const id of ['unknown', 'toString', '__proto__']) {
      expect(
        isSettingVisible('fastModel', {
          excludeItems: [id as WebShellSettingItemId],
        }),
      ).toBe(true);
    }
    expect(isSettingVisible('fastModel')).toBe(true);
    expect(isSettingVisible('fastModel', { excludeItems: [] })).toBe(true);
  });
  it('ignores ids inherited from a polluted Object.prototype', () => {
    (Object.prototype as Record<string, unknown>).someHostProp = 'fastModel';
    try {
      expect(
        isSettingVisible('fastModel', {
          excludeItems: ['someHostProp' as WebShellSettingItemId],
        }),
      ).toBe(true);
    } finally {
      delete (Object.prototype as Record<string, unknown>).someHostProp;
    }
  });
  it('allows only included ordinary settings and builtin blocks', () => {
    const options = {
      includeItems: ['setting:language', 'builtin:chat-width'],
    } as const;
    expect(isSettingVisible('general.language', options)).toBe(true);
    expect(isSettingVisible('fastModel', options)).toBe(false);
    expect(isItemVisible('builtin:chat-width', options)).toBe(true);
    expect(isItemVisible('builtin:model-management', options)).toBe(false);
  });
  it('distinguishes an empty allowlist from an absent one', () => {
    for (const options of [undefined, {}, { includeItems: undefined }]) {
      expect(isSettingVisible('general.language', options)).toBe(true);
      expect(isItemVisible('builtin:chat-width', options)).toBe(true);
    }
    expect(isSettingVisible('general.language', { includeItems: [] })).toBe(
      false,
    );
    for (const id of WEB_SHELL_SETTING_ITEM_IDS) {
      expect(isItemVisible(id, { includeItems: [] })).toBe(false);
    }
  });
  it('gives exclusions precedence over inclusions', () => {
    const options = {
      includeItems: [
        'setting:language',
        'builtin:chat-width',
        'setting:fast-model',
      ],
      excludeItems: ['setting:language', 'builtin:chat-width'],
    } as const;
    expect(isSettingVisible('general.language', options)).toBe(false);
    expect(isItemVisible('builtin:chat-width', options)).toBe(false);
    expect(isSettingVisible('fastModel', options)).toBe(true);
  });
  it('hides unaliased schema keys only when an allowlist is configured', () => {
    for (const key of ['future.setting', 'toString', '__proto__']) {
      expect(isSettingVisible(key)).toBe(true);
      expect(isSettingVisible(key, { excludeItems: [] })).toBe(true);
      expect(
        isSettingVisible(key, { includeItems: WEB_SHELL_SETTING_ITEM_IDS }),
      ).toBe(false);
      expect(isSettingVisible(key, { includeItems: [] })).toBe(false);
    }
  });
  it('does not treat unknown IDs, schema paths, or inherited properties as inclusions', () => {
    (Object.prototype as Record<string, unknown>).someHostProp = 'fastModel';
    try {
      for (const id of [
        'unknown',
        'fastModel',
        'setting:fastModel',
        'toString',
        '__proto__',
        'someHostProp',
      ]) {
        const options = { includeItems: [id as WebShellSettingItemId] };
        expect(isSettingVisible('fastModel', options)).toBe(false);
        expect(isSettingVisible(id, options)).toBe(false);
        expect(isItemVisible('builtin:chat-width', options)).toBe(false);
      }
    } finally {
      delete (Object.prototype as Record<string, unknown>).someHostProp;
    }
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
      'builtin:connections',
      'builtin:model-management',
    ]) {
      expect(WEB_SHELL_SETTING_ITEM_IDS).toContain(id);
    }
  });
});
