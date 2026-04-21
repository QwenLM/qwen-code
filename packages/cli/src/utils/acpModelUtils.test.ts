/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { AuthType } from '@qwen-code/qwen-code-core';
import {
  formatAcpModelId,
  parseAcpBaseModelId,
  parseAcpModelOption,
} from './acpModelUtils.js';

describe('acpModelUtils', () => {
  it('formats modelId(authType)', () => {
    expect(formatAcpModelId('qwen3', AuthType.QWEN_OAUTH)).toBe(
      `qwen3(${AuthType.QWEN_OAUTH})`,
    );
  });

  it('extracts base model id when string ends with parentheses', () => {
    expect(parseAcpBaseModelId(`qwen3(${AuthType.USE_OPENAI})`)).toBe('qwen3');
  });

  it('does not strip when parentheses are not a trailing suffix', () => {
    expect(parseAcpBaseModelId('qwen3(x) y')).toBe('qwen3(x) y');
  });

  it('parses modelId and validates authType', () => {
    expect(parseAcpModelOption(` qwen3(${AuthType.USE_OPENAI}) `)).toEqual({
      modelId: 'qwen3',
      authType: AuthType.USE_OPENAI,
    });
  });

  it('returns trimmed input as modelId when authType is invalid', () => {
    expect(parseAcpModelOption('qwen3(not-a-real-auth)')).toEqual({
      modelId: 'qwen3(not-a-real-auth)',
    });
  });
});
