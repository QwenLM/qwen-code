/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { AppPlugin } from '@qwen-code/cli';
import { QwenTuiAppFramework } from './qwen-tui-app-framework.js';
import { QwenSubscriptionPlugin } from './subscription-plugin.js';

describe('QwenTuiAppFramework', () => {
  it('keeps the kernel plugins and adds /upgrade', () => {
    const createAppPlugins = (
      QwenTuiAppFramework.prototype as unknown as {
        createAppPlugins(): readonly AppPlugin[];
      }
    ).createAppPlugins;

    const plugins = createAppPlugins.call({
      input: { workspaceRoot: process.cwd() },
    });

    expect(plugins.map((plugin) => plugin.id)).toEqual([
      'qwen-installation',
      'qoder-auth',
      'qwen-subscription',
    ]);
    expect(plugins.at(-1)).toBeInstanceOf(QwenSubscriptionPlugin);
  });
});
