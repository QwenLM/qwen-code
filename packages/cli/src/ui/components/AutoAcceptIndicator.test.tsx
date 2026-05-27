/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalMode } from '@qwen-code/qwen-code-core';
import { setLanguageAsync } from '../../i18n/index.js';
import { AutoAcceptIndicator } from './AutoAcceptIndicator.js';

describe('<AutoAcceptIndicator />', () => {
  beforeEach(async () => {
    await setLanguageAsync('en');
  });

  afterAll(async () => {
    await setLanguageAsync('en');
  });

  it('localizes AUTO mode classifier status in Chinese', async () => {
    await setLanguageAsync('zh');

    const { lastFrame } = render(
      <AutoAcceptIndicator approvalMode={ApprovalMode.AUTO} />,
    );

    const output = lastFrame() ?? '';
    expect(output).toContain('自动模式（分类器已评估）');
    expect(output).not.toContain('auto mode');
    expect(output).not.toContain('classifier-evaluated');
  });
});
