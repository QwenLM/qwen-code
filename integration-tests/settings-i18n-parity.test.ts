import { describe, expect, it } from 'vitest';
import {
  getDialogSettingKeys,
  getSettingDefinition,
} from '../packages/cli/src/config/settingsUtils.js';
import { getTranslator } from '../packages/web-shell/client/i18n.js';

// Settings only visible in TUI (terminal UI), not in Web Shell panel
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

// Settings hidden from Web Shell panel for security reasons
const SECURITY_SENSITIVE_SETTINGS = new Set(['tools.approvalMode']);

// Settings added to Web Shell but not in dialog allowlist
const WEB_SHELL_SETTINGS = new Set([
  'ui.compactMode',
  'voiceModel',
  'imageModel',
  'mcpServers',
]);

// Settings hidden from Web Shell panel (retired or internal)
const HIDDEN_SETTING_KEYS = new Set([
  'ui.hideTips',
  'ui.enableUserFeedback',
  'ui.compactMode',
  'mcpServers',
  'model.reasoningEffort',
]);

/**
 * Get all setting keys visible in the Web Shell settings panel.
 * This mirrors the filtering logic in SettingsMessage.tsx and workspace-settings.ts.
 */
function getPanelVisibleSettingKeys(): string[] {
  const dialogKeys = new Set(getDialogSettingKeys());
  const webShellOnlyKeys = [...WEB_SHELL_SETTINGS].filter(
    (k) => !dialogKeys.has(k),
  );

  return [...dialogKeys, ...webShellOnlyKeys].filter(
    (k) =>
      !TUI_ONLY_SETTINGS.has(k) &&
      !SECURITY_SENSITIVE_SETTINGS.has(k) &&
      !HIDDEN_SETTING_KEYS.has(k),
  );
}

const zh = getTranslator('zh-CN');

describe('settings i18n parity', () => {
  const visibleKeys = getPanelVisibleSettingKeys();

  it.each(visibleKeys)('translates settings.label.%s', (key) => {
    const labelKey = `settings.label.${key}`;
    const translated = zh(labelKey);
    expect(translated).not.toBe(labelKey);
    expect(translated.length).toBeGreaterThan(0);
  });

  it.each(visibleKeys)('translates settings.description.%s', (key) => {
    const descKey = `settings.description.${key}`;
    const translated = zh(descKey);
    expect(translated).not.toBe(descKey);
    expect(translated.length).toBeGreaterThan(0);
  });

  it.each(visibleKeys)(
    'translates enum options for settings.option.%s.*',
    (key) => {
      // general.language is special-cased in SettingsMessage.tsx:705-716
      // and built from WEB_SHELL_LANGUAGES, not formatSettingOption
      if (key === 'general.language') return;

      const def = getSettingDefinition(key);
      if (!def?.options || def.options.length === 0) return;

      for (const opt of def.options) {
        const optionKey = `settings.option.${key}.${String(opt.value)}`;
        const translated = zh(optionKey);
        expect(translated).not.toBe(optionKey);
        expect(translated.length).toBeGreaterThan(0);
      }
    },
  );

  it('has no unreachable category keys in ZH catalog', () => {
    // Valid category values from settingsSchema.ts
    const validCategories = new Set([
      'General',
      'Advanced',
      'Model',
      'UI',
      'IDE',
      'Privacy',
      'Context',
      'Memory',
      'Tools',
      'Daemon',
      'MCP',
      'Security',
      'Experimental',
      'Generation Configuration',
    ]);

    // Categories that formatSettingCategory can actually produce
    // (from hardcoded literals + descriptor.category values used by visible settings)
    const reachableCategories = new Set<string>();
    for (const key of visibleKeys) {
      const def = getSettingDefinition(key);
      if (def?.category) {
        reachableCategories.add(def.category);
      }
    }
    // Add hardcoded literals from formatSettingCategory
    for (const lit of [
      'UI',
      'Experimental',
      'Daemon',
      'Model',
      'Connections',
    ]) {
      if (validCategories.has(lit)) {
        reachableCategories.add(lit);
      }
    }

    // Verify all reachable categories have translations
    for (const cat of reachableCategories) {
      const catKey = `settings.category.${cat}`;
      const translated = zh(catKey);
      expect(translated).not.toBe(catKey);
    }
  });
});
