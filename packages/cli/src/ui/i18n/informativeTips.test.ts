/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { BRAND_NAME, BRAND_CLI_NAME } from '@qwen-code/core';
import {
  applyBrandPlaceholders,
  getLocalizedInformativeTip,
} from './informativeTips.js';

const WINDOW_TITLE_TIP_ID = 'settings.show-brand-cli-name-status-in-the';

describe('informativeTips brand placeholders', () => {
  it('resolves {brand} and {cli} from their own sources', () => {
    expect(applyBrandPlaceholders('{brand} / {cli}')).toBe(
      `${BRAND_NAME} / ${BRAND_CLI_NAME}`,
    );

    expect(getLocalizedInformativeTip('en', WINDOW_TITLE_TIP_ID)).toBe(
      `Show ${BRAND_CLI_NAME} status in the terminal window title (/settings)…`,
    );
    expect(getLocalizedInformativeTip('zh-CN', WINDOW_TITLE_TIP_ID)).toBe(
      `在 /settings 中于终端窗口标题显示 ${BRAND_CLI_NAME} 状态…`,
    );
  });
});
