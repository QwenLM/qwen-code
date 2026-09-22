import { describe, expect, it } from 'vitest';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
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

// Derive filter sets from production source instead of hard-copying them.
// This follows the pattern established in workspace-settings.test.ts:1027
// ("web-shell settings alias drift"). If a key is added to or removed from
// any of these sets in production, this test automatically picks up the
// change — no manual synchronization needed.
const thisDir = dirname(fileURLToPath(import.meta.url));
const workspaceSettingsSource = readFileSync(
  join(thisDir, '../packages/cli/src/serve/routes/workspace-settings.ts'),
  'utf8',
);
const settingsMessageSource = readFileSync(
  join(
    thisDir,
    '../packages/web-shell/client/components/messages/SettingsMessage.tsx',
  ),
  'utf8',
);

function parseKeySet(source: string, name: string): Set<string> {
  const match = source.match(
    new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`),
  );
  if (!match) throw new Error(`${name} not found in source`);
  return new Set(
    [...match[1].replace(/\/\/[^\n]*/g, '').matchAll(/'([^']+)'/g)].map(
      (m) => m[1]!,
    ),
  );
}

const TUI_ONLY_SETTINGS = parseKeySet(
  workspaceSettingsSource,
  'TUI_ONLY_SETTINGS',
);
const SECURITY_SENSITIVE_SETTINGS = parseKeySet(
  workspaceSettingsSource,
  'SECURITY_SENSITIVE_SETTINGS',
);
const WEB_SHELL_SETTINGS = parseKeySet(
  workspaceSettingsSource,
  'WEB_SHELL_SETTINGS',
);
const HIDDEN_SETTING_KEYS = parseKeySet(
  settingsMessageSource,
  'HIDDEN_SETTING_KEYS',
);
const LIVE_SETTING_KEYS = parseKeySet(
  settingsMessageSource,
  'LIVE_SETTING_KEYS',
);

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
 * Parse formatSettingCategory literals from SettingsMessage.tsx source.
 * These are the hardcoded category names that the panel can produce
 * even if no descriptor carries that category value.
 */
function parseFormatSettingCategoryLiterals(source: string): Set<string> {
  const literals = new Set<string>();
  const regex = /formatSettingCategory\(\s*'([^']+)'/g;
  let match;
  while ((match = regex.exec(source)) !== null) {
    literals.add(match[1]!);
  }
  return literals;
}

const zh = getTranslator('zh-CN');

describe('settings i18n parity', () => {
  const visibleKeys = getPanelVisibleSettingKeys();

  // Forward direction: categories from descriptors + all formatSettingCategory literals
  const descriptorCategories = new Set<string>();
  for (const key of visibleKeys) {
    const def = getSettingDefinition(key);
    if (def?.category) {
      descriptorCategories.add(def.category);
    }
  }
  const formatLiterals = parseFormatSettingCategoryLiterals(
    settingsMessageSource,
  );
  const forwardCategories = new Set([
    ...descriptorCategories,
    ...formatLiterals,
  ]);

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
  // Uses descriptor categories + parsed formatSettingCategory literals
  it('translates every reachable settings category', () => {
    for (const cat of forwardCategories) {
      const catKey = `settings.category.${cat}`;
      expect(hasMessage('zh-CN', catKey)).toBe(true);
      const translated = zh(catKey);
      expect(translated).not.toBe(catKey);
    }
  });

  // Reverse direction: all category keys in ZH catalog are reachable (R1-2 still stands)
  // The expected set is derived from descriptor categories + parsed formatSettingCategory
  // literals, so a literal removed from production code becomes unreachable here.
  it('has no dead category keys in ZH catalog', () => {
    const zhKeys = messageKeys('zh-CN');
    for (const key of zhKeys) {
      if (!key.startsWith('settings.category.')) continue;
      const cat = key.slice('settings.category.'.length);
      expect(forwardCategories.has(cat)).toBe(true);
    }
  });
});
