/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { localizeAgentTypeName } from './toolFormatting.js';
import {
  FULL_CATALOG_LANGUAGES,
  WEB_SHELL_LANGUAGES,
  getTranslator,
} from '../../i18n.js';

// `localizeAgentTypeName` falls back to the raw agent-type id when no
// `agentType.<name>` key exists, so a missing entry is invisible: the badge
// renders `review-agent` in kebab-case beside siblings showing "Explore" and
// "Status Line Setup", and nothing fails. That fallback is why every builtin
// needs its own pin — a type is only as localised as its key.
//
// The badge is newly VISIBLE for review agents: both surfaces elide the type
// prefix only for the DEFAULT type, so giving the review its own subagent
// type turned a never-rendered label into one shown on every row of a run.
//
// Going through `getTranslator` rather than the raw tables is deliberate: it
// is the lookup the component actually uses, including its fallback to the
// English table, so a key present only in EN cannot pass as localised here
// while rendering English to a Chinese user.
describe('localizeAgentTypeName', () => {
  // The builtin types the product ships. A new builtin added without its
  // keys renders as a raw id, which is what this list exists to catch.
  const BUILTIN_TYPES = [
    'general-purpose',
    'explore',
    'statusline-setup',
    'review-agent',
    'fork',
  ];

  const FULL_CATALOG = WEB_SHELL_LANGUAGES.filter(
    (lang) => FULL_CATALOG_LANGUAGES[lang],
  );

  it.each(FULL_CATALOG)('localises every builtin type in %s', (lang) => {
    const t = getTranslator(lang);
    for (const type of BUILTIN_TYPES) {
      const rendered = localizeAgentTypeName(type, t);
      // Equal to the id means the key is missing from `agentType.*` and the
      // badge would render the raw kebab-case string.
      expect(`${lang}:${type} -> ${rendered}`).not.toBe(
        `${lang}:${type} -> ${type}`,
      );
      expect(rendered.trim().length).toBeGreaterThan(0);
    }
  });

  it.each(FULL_CATALOG.filter((lang) => lang !== 'en'))(
    'gives %s its own agent-type strings, not the English ones',
    (lang) => {
      // `getTranslator` falls back to EN for a missing key, so "not the raw id"
      // alone would pass on a table that never got the entry.
      const en = getTranslator('en');
      const other = getTranslator(lang);
      for (const type of BUILTIN_TYPES) {
        expect(localizeAgentTypeName(type, other)).not.toBe(
          localizeAgentTypeName(type, en),
        );
      }
    },
  );

  it('falls back to the raw id for an unknown type', () => {
    // The documented behaviour the pins above exist to keep from becoming the
    // silent default for a shipped type.
    expect(localizeAgentTypeName('not-a-builtin', getTranslator('en'))).toBe(
      'not-a-builtin',
    );
  });
});
