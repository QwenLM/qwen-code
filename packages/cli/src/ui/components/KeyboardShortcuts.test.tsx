/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import { KeyboardShortcuts } from './KeyboardShortcuts.js';

vi.mock('../hooks/useTerminalSize.js', () => ({
  useTerminalSize: vi.fn(() => ({ columns: 120, rows: 24 })),
}));

const originalPlatform = process.platform;

function stubPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
}

describe('KeyboardShortcuts', () => {
  afterEach(() => {
    stubPlatform(originalPlatform);
  });

  it.each([
    ['darwin', 'ctrl+v / option+v'],
    ['win32', 'alt+v'],
    ['linux', 'ctrl+v'],
  ] as const)(
    'advertises the %s image-paste key',
    (platform, expectedPasteKey) => {
      stubPlatform(platform);
      const { lastFrame } = render(<KeyboardShortcuts />);
      const frame = lastFrame() ?? '';
      expect(frame).toContain(expectedPasteKey);
      if (platform !== 'darwin') {
        expect(frame).not.toContain('option+v');
      }
      if (platform !== 'win32') {
        expect(frame).not.toContain('alt+v');
      }
    },
  );
});
