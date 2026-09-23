/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
import { setLanguageAsync, t } from '../../../i18n/index.js';
import { SUPPORTED_LANGUAGES } from '../../../i18n/languages.js';
import { CATEGORY_LABEL_WIDTH, THRESHOLD_LABEL_WIDTH } from './ContextUsage.js';

/**
 * `/context` renders each label in a fixed-width column. A translation wider
 * than its column wraps onto a second line and misaligns the whole block, which
 * is what the German and Japanese "Cached prefix" labels did (#12235).
 */
const CATEGORY_LABELS = [
  'Used',
  'Cached prefix',
  'Free',
  'Autocompact buffer',
  'System prompt',
  'Built-in tools',
  'MCP tools',
  'Memory files',
  'Skills',
  'Startup context',
  'Messages',
  'Unattributed',
];

const THRESHOLD_LABELS = [
  'Effective window',
  'Warn threshold',
  'Auto threshold',
  'Hard threshold',
  'Current tier',
];

describe('/context label widths', () => {
  afterEach(async () => {
    await setLanguageAsync('en');
  });

  it.each(SUPPORTED_LANGUAGES.map((language) => language.code))(
    'every %s label fits its column',
    async (code) => {
      await setLanguageAsync(code);
      const overflowing = [
        ...CATEGORY_LABELS.filter(
          (key) => stringWidth(t(key)) > CATEGORY_LABEL_WIDTH,
        ),
        ...THRESHOLD_LABELS.filter(
          (key) => stringWidth(t(key)) > THRESHOLD_LABEL_WIDTH,
        ),
      ].map((key) => `${key} -> ${t(key)}`);

      expect(overflowing).toEqual([]);
    },
  );
});
