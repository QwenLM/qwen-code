/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Extension } from '@qwen-code/qwen-code-core';
import { opensAttachedContent } from '@qwen-code/qwen-code-core/utils/attached-content.js';
import { buildExtensionContextText } from './extension-mention.js';

describe('buildExtensionContextText', () => {
  it('opens with a header compaction recognizes as attached', () => {
    const extension = {
      name: 'docs',
      config: { name: 'docs' },
    } as unknown as Extension;

    expect(opensAttachedContent(buildExtensionContextText(extension))).toBe(
      true,
    );
  });

  it('advertises extension skills under their registered name', () => {
    const extension = {
      name: 'rust',
      config: { name: 'rust' },
      skills: [{ name: 'pdf' }],
    } as unknown as Extension;

    const skillsLine = buildExtensionContextText(extension)
      .split('\n')
      .find((line) => line.startsWith('- Skills:'));

    expect(skillsLine).toBe('- Skills: rust:pdf (invoke via /<skill-name>)');
  });
});
