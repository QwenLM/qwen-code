/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Extension } from '@qwen-code/qwen-code-core';
import { buildExtensionContextText } from './extension-mention.js';

describe('buildExtensionContextText', () => {
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
