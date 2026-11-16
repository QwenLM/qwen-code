/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { ShellExecutionService } from '@qwen-code/qwen-code-core/services/shellExecutionService.js';
import { useKeypress, type Key } from '../hooks/useKeypress.js';
import { ShellInputPrompt } from './ShellInputPrompt.js';

vi.mock('../hooks/useKeypress.js', () => ({
  useKeypress: vi.fn(),
}));

vi.mock('@qwen-code/qwen-code-core/services/shellExecutionService.js', () => ({
  ShellExecutionService: {
    writeToPty: vi.fn(),
    scrollPty: vi.fn(),
  },
}));

const key = (overrides: Partial<Key>): Key => ({
  name: '',
  ctrl: false,
  meta: false,
  shift: false,
  paste: false,
  sequence: '',
  ...overrides,
});

describe('ShellInputPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not write the application-owned Ctrl+C byte to a focused shell', () => {
    const { unmount } = render(
      <ShellInputPrompt activeShellPtyId={123} focus={true} />,
    );
    try {
      const handleKey = vi.mocked(useKeypress).mock.calls.at(-1)?.[0];
      expect(handleKey).toBeDefined();
      for (const char of 'FOCUS_C') {
        handleKey!(key({ name: char.toLowerCase(), sequence: char }));
      }
      const bytes = () =>
        Buffer.from(
          vi
            .mocked(ShellExecutionService.writeToPty)
            .mock.calls.map(([, input]) => input)
            .join(''),
        ).toString('hex');
      expect(bytes()).toBe('464f4355535f43');

      handleKey!(key({ name: 'c', ctrl: true, sequence: '\x03' }));

      expect(bytes()).toBe('464f4355535f43');

      handleKey!(key({ name: 'd', ctrl: true, sequence: '\x04' }));

      expect(bytes()).toBe('464f4355535f4304');
    } finally {
      unmount();
    }
  });
});
