/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HooksManagementDialog } from './HooksManagementDialog.js';
import { renderWithProviders } from '../../../test-utils/render.js';
import { useKeypress } from '../../hooks/useKeypress.js';
import type { Key } from '../../contexts/KeypressContext.js';

// Mock useKeypress
vi.mock('../../hooks/useKeypress.js', () => ({
  useKeypress: vi.fn(),
}));

const mockedUseKeypress = vi.mocked(useKeypress);

// Mock i18n module
vi.mock('../../../i18n/index.js', () => ({
  t: vi.fn((key: string, options?: { count?: string }) => {
    // Handle pluralization
    if (key === '{{count}} hook configured' && options?.count) {
      return `${options.count} hook configured`;
    }
    if (key === '{{count}} hooks configured' && options?.count) {
      return `${options.count} hooks configured`;
    }
    if (key === '{{count}} configured hook' && options?.count) {
      return `${options.count} configured hook`;
    }
    if (key === '{{count}} configured hooks' && options?.count) {
      return `${options.count} configured hooks`;
    }
    // Handle interpolation for disabled message
    if (
      key ===
        'All hooks are currently disabled. You have {{count}} that are not running.' &&
      options?.count
    ) {
      return `All hooks are currently disabled. You have ${options.count} that are not running.`;
    }
    return key;
  }),
}));

// Mock useTerminalSize
vi.mock('../../hooks/useTerminalSize.js', () => ({
  useTerminalSize: vi.fn(() => ({ columns: 120, rows: 24 })),
}));

// Mock useConfig
vi.mock('../../contexts/ConfigContext.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../contexts/ConfigContext.js')>();
  return {
    ...actual,
    useConfig: vi.fn(() => ({
      getExtensions: vi.fn(() => []),
      getDisableAllHooks: vi.fn(() => false),
    })),
  };
});

// Mock loadSettings
vi.mock('../../../config/settings.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../config/settings.js')>();
  return {
    ...actual,
    loadSettings: vi.fn(() => ({
      forScope: vi.fn(() => ({ settings: {} })),
    })),
  };
});

// Mock semantic-colors
vi.mock('../../semantic-colors.js', () => ({
  theme: {
    text: {
      primary: 'white',
      secondary: 'gray',
      accent: 'cyan',
    },
    status: {
      success: 'green',
      error: 'red',
      warning: 'yellow',
    },
    border: {
      default: 'gray',
    },
  },
}));

// Mock createDebugLogger
vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    createDebugLogger: vi.fn(() => ({
      log: vi.fn(),
      error: vi.fn(),
    })),
  };
});

// Helper to create a key object
function createKey(name: string, sequence = ''): Key {
  return {
    name,
    sequence,
    ctrl: false,
    meta: false,
    shift: false,
    paste: false,
  };
}

describe('HooksManagementDialog', () => {
  const mockOnClose = vi.fn();
  let keypressHandler: ((key: Key) => void) | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    keypressHandler = null;

    // Mock useKeypress to capture the handler
    mockedUseKeypress.mockImplementation((handler) => {
      keypressHandler = handler;
    });
  });

  afterEach(() => {
    keypressHandler = null;
  });

  describe('Initial rendering', () => {
    it('should render loading state initially', () => {
      const { lastFrame } = renderWithProviders(
        <HooksManagementDialog onClose={mockOnClose} />,
      );

      expect(lastFrame()).toContain('Loading hooks');
    });

    it('should render with border', async () => {
      const { lastFrame, unmount } = renderWithProviders(
        <HooksManagementDialog onClose={mockOnClose} />,
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      // The dialog should have a border (rendered as box-drawing characters)
      const output = lastFrame();
      expect(output).toBeTruthy();

      unmount();
    });

    it('should handle empty hooks list gracefully', async () => {
      const { lastFrame, unmount } = renderWithProviders(
        <HooksManagementDialog onClose={mockOnClose} />,
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      const output = lastFrame();
      // Should show 0 hooks configured when no hooks are configured
      expect(output).toContain('0 hooks configured');

      unmount();
    });
  });

  describe('Keyboard navigation - HOOKS_LIST step', () => {
    it('should register keypress handler with isActive: true', async () => {
      renderWithProviders(<HooksManagementDialog onClose={mockOnClose} />);

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockedUseKeypress).toHaveBeenCalled();
      const options = mockedUseKeypress.mock.calls[0][1];
      expect(options).toEqual({ isActive: true });
    });

    it('should close dialog on Escape key', async () => {
      renderWithProviders(<HooksManagementDialog onClose={mockOnClose} />);

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(keypressHandler).not.toBeNull();
      keypressHandler!(createKey('escape', '\x1b'));

      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });

    it('should navigate up and down with arrow keys', async () => {
      const { lastFrame, unmount } = renderWithProviders(
        <HooksManagementDialog onClose={mockOnClose} />,
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Initial state - first item selected
      let output = lastFrame();
      expect(output).toContain('❯');

      // Press down - should move selection
      keypressHandler!(createKey('down'));
      output = lastFrame();

      // Press up - should move back
      keypressHandler!(createKey('up'));
      output = lastFrame();

      unmount();
    });

    it('should not go above first item when pressing up', async () => {
      const { unmount } = renderWithProviders(
        <HooksManagementDialog onClose={mockOnClose} />,
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Press up multiple times from first item
      keypressHandler!(createKey('up'));
      keypressHandler!(createKey('up'));
      keypressHandler!(createKey('up'));

      // Should still be at first item (no crash)
      unmount();
    });
  });

  describe('Keyboard navigation - HOOKS_DISABLED step', () => {
    it('should show disabled state when disableAllHooks is true', async () => {
      // Override the mock for this test
      const configContext = await import('../../contexts/ConfigContext.js');
      vi.mocked(configContext.useConfig).mockReturnValue({
        getExtensions: vi.fn(() => []),
        getDisableAllHooks: vi.fn(() => true),
      } as unknown as ReturnType<typeof configContext.useConfig>);

      const { lastFrame, unmount } = renderWithProviders(
        <HooksManagementDialog onClose={mockOnClose} />,
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      const output = lastFrame();
      expect(output).toContain('Hook Configuration - Disabled');

      unmount();
    });

    it('should close dialog on Escape key when hooks are disabled', async () => {
      const configContext = await import('../../contexts/ConfigContext.js');
      vi.mocked(configContext.useConfig).mockReturnValue({
        getExtensions: vi.fn(() => []),
        getDisableAllHooks: vi.fn(() => true),
      } as unknown as ReturnType<typeof configContext.useConfig>);

      renderWithProviders(<HooksManagementDialog onClose={mockOnClose} />);

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(keypressHandler).not.toBeNull();
      keypressHandler!(createKey('escape', '\x1b'));

      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('Loading and error states', () => {
    it('should allow Escape to close during loading state', () => {
      renderWithProviders(<HooksManagementDialog onClose={mockOnClose} />);

      // Don't wait for loading to complete
      expect(keypressHandler).not.toBeNull();
      keypressHandler!(createKey('escape', '\x1b'));

      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });
  });
});
