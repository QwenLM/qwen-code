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

  it('rejects invalid authType prefixes', () => {
    expect(() => parseSubagentModelSelection('invalid:glm-5')).toThrow(
      /Invalid authType prefix/,
    );
  });
});
