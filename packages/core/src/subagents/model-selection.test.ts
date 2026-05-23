/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AuthType } from '../core/contentGenerator.js';
import { parseSubagentModelSelection } from './model-selection.js';

describe('parseSubagentModelSelection', () => {
  it('treats omitted models as inherit', () => {
    expect(parseSubagentModelSelection(undefined)).toEqual({
      inherits: true,
    });
  });

  it('treats explicit inherit as inherit', () => {
    expect(parseSubagentModelSelection('inherit')).toEqual({
      inherits: true,
    });
  });

  it('parses bare model IDs', () => {
    expect(parseSubagentModelSelection('glm-5')).toEqual({
      modelId: 'glm-5',
      inherits: false,
    });
  });

  it('parses authType-prefixed model IDs', () => {
    expect(parseSubagentModelSelection('openai:glm-5')).toEqual({
      authType: AuthType.USE_OPENAI,
      modelId: 'glm-5',
      inherits: false,
    });
  });

  it('treats unknown prefix as bare model ID (colon in model ID)', () => {
    expect(parseSubagentModelSelection('invalid:glm-5')).toEqual({
      modelId: 'invalid:glm-5',
      inherits: false,
    });
  });

  it('treats model IDs with colons as bare model IDs', () => {
    expect(parseSubagentModelSelection('gpt-4o:online')).toEqual({
      modelId: 'gpt-4o:online',
      inherits: false,
    });
  });

  it('parses the fast keyword', () => {
    expect(parseSubagentModelSelection('fast')).toEqual({
      inherits: false,
      usesFastModel: true,
    });
  });

  it('parses the fast keyword with surrounding whitespace', () => {
    expect(parseSubagentModelSelection('  fast  ')).toEqual({
      inherits: false,
      usesFastModel: true,
    });
  });

  it('treats model IDs that merely contain "fast" as bare IDs, not the keyword', () => {
    expect(parseSubagentModelSelection('qwen3-coder-flash')).toEqual({
      modelId: 'qwen3-coder-flash',
      inherits: false,
    });
    expect(parseSubagentModelSelection('Fast')).toEqual({
      modelId: 'Fast',
      inherits: false,
    });
  });
});
