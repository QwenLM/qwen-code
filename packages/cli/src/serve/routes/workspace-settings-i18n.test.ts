/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment node */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getAllowedKeys } from './workspace-settings.js';
import { getSettingDefinition } from '../../config/settingsUtils.js';

// The Web Shell settings page renders the schema's English label/description
// when `settings.label.<key>` / `settings.description.<key>` are absent from
// the locale table in packages/web-shell/client/settings/messages.ts.
// These assertions keep zh-CN and ru coverage complete as the schema grows.

const I18N_PATH = fileURLToPath(
  new URL('../../../../web-shell/client/settings/messages.ts', import.meta.url),
);

// Settings rendered by the Web Shell frontend itself, with no schema entry.
const FRONTEND_ONLY_KEYS = new Set(['ui.chatWidth']);

const SETTINGS_LOCALES = [
  { name: 'zh-CN', exportName: 'SETTINGS_MESSAGES_ZH' },
  { name: 'ru', exportName: 'SETTINGS_MESSAGES_RU' },
] as const;

function localeTableSource(exportName: string): string {
  const source = readFileSync(I18N_PATH, 'utf8');
  const start = source.indexOf(`export const ${exportName}`);
  const end = source.indexOf('\n};', start);
  if (start === -1 || end === -1) {
    throw new Error(`Cannot locate ${exportName} in settings/messages.ts`);
  }
  return source.slice(start, end);
}

describe.each(SETTINGS_LOCALES)(
  'Web Shell settings $name coverage',
  ({ exportName }) => {
    it('every served setting has label and description entries', () => {
      const table = localeTableSource(exportName);
      const missing: string[] = [];
      for (const key of getAllowedKeys(true)) {
        if (!table.includes(`'settings.label.${key}'`)) {
          missing.push(`settings.label.${key}`);
        }
        const def = getSettingDefinition(key);
        if (
          def?.description &&
          !table.includes(`'settings.description.${key}'`)
        ) {
          missing.push(`settings.description.${key}`);
        }
      }
      expect(missing).toEqual([]);
    });

    it('every category of a served setting has an entry', () => {
      const table = localeTableSource(exportName);
      const missing = new Set<string>();
      for (const key of getAllowedKeys(true)) {
        const category = getSettingDefinition(key)?.category;
        if (category && !table.includes(`'settings.category.${category}'`)) {
          missing.add(`settings.category.${category}`);
        }
      }
      expect([...missing]).toEqual([]);
    });
  },
);

describe('Web Shell settings locale tables', () => {
  it('has no settings entries unknown to the schema', () => {
    const source = readFileSync(I18N_PATH, 'utf8');
    const orphans = new Set<string>();
    for (const match of source.matchAll(
      /'settings\.(label|description)\.([^']+)'/g,
    )) {
      const key = match[2];
      if (!FRONTEND_ONLY_KEYS.has(key) && !getSettingDefinition(key)) {
        orphans.add(`settings.${match[1]}.${key}`);
      }
    }
    expect([...orphans]).toEqual([]);
  });
});
