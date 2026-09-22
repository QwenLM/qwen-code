import { describe, expect, it } from 'vitest';
import {
  getDialogSettingKeys,
  getSettingDefinition,
} from '../packages/cli/src/config/settingsUtils.js';
import {
  getTranslator,
  hasMessage,
  messageKeys,
} from '../packages/web-shell/client/i18n.js';
import { WEB_SHELL_THEMES } from '../packages/web-shell/client/themeContext.js';

// NOTE (R2-2): These sets are hand-copied from production because they are not exported.
// Production sources:
//   - TUI_ONLY_SETTINGS: packages/cli/src/serve/routes/workspace-settings.ts:36-52
//   - SECURITY_SENSITIVE_SETTINGS: workspace-settings.ts:108
//   - WEB_SHELL_SETTINGS: workspace-settings.ts:56-62
//   - HIDDEN_SETTING_KEYS: packages/web-shell/client/components/messages/SettingsMessage.tsx:123-131
//   - LIVE_SETTING_KEYS: SettingsMessage.tsx:132-135
// If a setting is added to any of these sets in production, this test must be updated.
// The workspace-settings.test.ts "web-shell settings alias drift" test parses some of these
// from source, but that mechanism is not available for integration tests across packages.
const TUI_ONLY_SETTINGS = new Set([
  'general.vimMode',
  'general.terminalBell',
  'general.notificationMode',
  'general.preferredEditor',
  'general.outputLanguage',
  'ide.enabled',
  'ui.showLineNumbers',
  'ui.showToolCallArgs',
  'ui.renderMode',
  'ui.useTerminalBuffer',
  'ui.mouseTracking',
  'ui.showScrollbar',
  'ui.hideBanner',
  'ui.accessibility.enableLoadingPhrases',
  'ui.enableWelcomeBack',
]);

const SECURITY_SENSITIVE_SETTINGS = new Set(['tools.approvalMode']);

const WEB_SHELL_SETTINGS = new Set([
  'ui.compactMode',
  'voiceModel',
  'imageModel',
  'mcpServers',
]);

const HIDDEN_SETTING_KEYS = new Set([
  'ui.hideTips',
  'ui.enableUserFeedback',
  'ui.compactMode',
  'mcpServers',
  'model.reasoningEffort',
]);

const LIVE_SETTING_KEYS = new Set([
  'experimental.liveVoice.enabled',
  'experimental.liveVoice.shortcut',
]);

/**
 * Get all setting keys visible in the Web Shell settings panel.
 * This mirrors the filtering logic in SettingsMessage.tsx and workspace-settings.ts.
 */
function getPanelVisibleSettingKeys(): string[] {
  const dialogKeys = getDialogSettingKeys();
  const filtered = dialogKeys.filter(
    (k) =>
      !TUI_ONLY_SETTINGS.has(k) &&
      !SECURITY_SENSITIVE_SETTINGS.has(k) &&
      !LIVE_SETTING_KEYS.has(k),
  );

  // Add WEB_SHELL_SETTINGS that are not already in dialogKeys
  const webShellOnlyKeys = [...WEB_SHELL_SETTINGS].filter(
    (k) => !dialogKeys.includes(k),
  );

  // Combine and filter HIDDEN_SETTING_KEYS
  return [...filtered, ...webShellOnlyKeys].filter(
    (k) => !HIDDEN_SETTING_KEYS.has(k),
  );
}

/**
 * Get all categories that formatSettingCategory can actually produce.
 * This includes both descriptor categories from visible settings and
 * hardcoded literals from SettingsMessage.tsx.
 */
function getReachableCategories(visibleKeys: string[]): Set<string> {
  const reachable = new Set<string>();

  // From descriptor categories
  for (const key of visibleKeys) {
    const def = getSettingDefinition(key);
    if (def?.category) {
      reachable.add(def.category);
    }
  }

  // Hardcoded literals from formatSettingCategory (SettingsMessage.tsx:496/511/522/532/539)
  // These must be added unconditionally (R2-4)
  for (const lit of ['UI', 'Experimental', 'Daemon', 'Model', 'Connections']) {
    reachable.add(lit);
  }

  return reachable;
}

const zh = getTranslator('zh-CN');

describe('settings i18n parity', () => {
  const visibleKeys = getPanelVisibleSettingKeys();
  const reachableCategories = getReachableCategories(visibleKeys);

  // Label translation tests with direct ZH catalog assertion (R1-4 fix-induced)
  it.each(visibleKeys)('translates settings.label.%s', (key) => {
    const labelKey = `settings.label.${key}`;
    // Direct catalog assertion: key must exist in ZH, not just resolve via EN fallback
    expect(hasMessage('zh-CN', labelKey)).toBe(true);
    const translated = zh(labelKey);
    expect(translated).not.toBe(labelKey);
    expect(translated.length).toBeGreaterThan(0);
  });

  // Description translation tests with direct ZH catalog assertion
  it.each(visibleKeys)('translates settings.description.%s', (key) => {
    const descKey = `settings.description.${key}`;
    expect(hasMessage('zh-CN', descKey)).toBe(true);
    const translated = zh(descKey);
    expect(translated).not.toBe(descKey);
    expect(translated.length).toBeGreaterThan(0);
  });

  // Enum option translation tests with direct ZH catalog assertion
  // Filter to keys that actually have options to avoid vacuous passes
  const keysWithEnumOptions = visibleKeys.filter((key) => {
    if (key === 'general.language') return false; // Special-cased in SettingsMessage.tsx
    const def = getSettingDefinition(key);
    return def?.options && def.options.length > 0;
  });

  it.each(keysWithEnumOptions)(
    'translates enum options for settings.option.%s.*',
    (key) => {
      const def = getSettingDefinition(key);
      if (!def?.options || def.options.length === 0) return;

      for (const opt of def.options) {
        const optionKey = `settings.option.${key}.${String(opt.value)}`;
        expect(hasMessage('zh-CN', optionKey)).toBe(true);
        const translated = zh(optionKey);
        expect(translated).not.toBe(optionKey);
        expect(translated.length).toBeGreaterThan(0);
      }
    },
  );

  // Theme translation test (R2-3)
  // ui.theme options come from WEB_SHELL_THEMES, not schema options
  it.each(WEB_SHELL_THEMES)('translates theme.%s', (id) => {
    const key = `theme.${id}`;
    expect(hasMessage('zh-CN', key)).toBe(true);
    const translated = zh(key);
    expect(translated).not.toBe(key);
    expect(translated.length).toBeGreaterThan(0);
  });

  // Forward direction: all reachable categories have translations
  it('translates every reachable settings category', () => {
    for (const cat of reachableCategories) {
      const catKey = `settings.category.${cat}`;
      expect(hasMessage('zh-CN', catKey)).toBe(true);
      const translated = zh(catKey);
      expect(translated).not.toBe(catKey);
    }
  });

  // Reverse direction: all category keys in ZH catalog are reachable (R1-2 still stands)
  // This catches dead category keys that no code path reads
  it('has no dead category keys in ZH catalog', () => {
    const zhKeys = messageKeys('zh-CN');
    for (const key of zhKeys) {
      if (!key.startsWith('settings.category.')) continue;
      const cat = key.slice('settings.category.'.length);
      expect(reachableCategories.has(cat)).toBe(true);
    }
  });
});
