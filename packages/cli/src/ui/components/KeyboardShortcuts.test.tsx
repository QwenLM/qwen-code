/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import { KeyboardShortcuts } from './KeyboardShortcuts.js';

// A narrow width forces the single-column layout so each shortcut renders on
// its own line. ink-testing-library hard-codes stdout to 100 columns, so a
// multi-column layout chosen from a wider mock can still wrap physically and
// break these assertions for reasons unrelated to the hint text.
vi.mock('../hooks/useTerminalSize.js', () => ({
  useTerminalSize: vi.fn(() => ({ columns: 40, rows: 24 })),
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
    ['darwin', 'ctrl+v / option+v to paste images', ['alt+v']],
    ['win32', 'alt+v to paste images', ['option+v']],
    ['linux', 'ctrl+v to paste images', ['option+v', 'alt+v']],
  ] as const)(
    'advertises the %s image-paste key',
    (platform, expectedPasteCell, absentKeys) => {
      stubPlatform(platform);
      const { lastFrame } = render(<KeyboardShortcuts />);
      const frame = lastFrame() ?? '';
      expect(frame).toContain(expectedPasteCell);
      for (const absent of absentKeys) {
        expect(frame).not.toContain(absent);
      }
    },
  );
});
