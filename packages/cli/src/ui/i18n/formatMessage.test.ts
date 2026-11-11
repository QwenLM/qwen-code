/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  formatMessage,
  getPlaceholderNames,
  tokenizeMessage,
} from './formatMessage.js';

describe('formatMessage', () => {
  it('replaces named string and number parameters', () => {
    expect(
      formatMessage('{count} settings are saved to {path}', {
        count: 2,
        path: '/tmp/settings.json',
      }),
    ).toBe('2 settings are saved to /tmp/settings.json');
  });

  it('leaves missing parameters visible', () => {
    expect(formatMessage('Open {path}')).toBe('Open {path}');
  });

  it('tokenizes only supported named placeholders', () => {
    expect(tokenizeMessage('Open {path}; keep {{raw}}')).toEqual([
      { kind: 'text', value: 'Open ' },
      { kind: 'placeholder', name: 'path' },
      { kind: 'text', value: '; keep {' },
      { kind: 'placeholder', name: 'raw' },
      { kind: 'text', value: '}' },
    ]);
    expect(getPlaceholderNames('{path} {count}')).toEqual(['path', 'count']);
  });
});
