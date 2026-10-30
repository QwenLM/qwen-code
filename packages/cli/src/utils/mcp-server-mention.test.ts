/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import { opensAttachedContent } from '@qwen-code/qwen-code-core/utils/attached-content.js';
import { buildMcpServerContextText } from './mcp-server-mention.js';

describe('buildMcpServerContextText', () => {
  it('opens with a header compaction recognizes as attached', () => {
    const text = buildMcpServerContextText({} as Config, 'docs');

    expect(opensAttachedContent(text)).toBe(true);
  });
});
