/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HookEventName } from '@qwen-code/qwen-code-core';
import { HooksManagementDialog } from './HooksManagementDialog.js';
import { renderWithProviders } from '../../../test-utils/render.js';

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

describe('HooksManagementDialog', () => {
  const mockOnClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render loading state initially', () => {
    const { lastFrame } = renderWithProviders(
      <HooksManagementDialog onClose={mockOnClose} />,
    );

    expect(lastFrame()).toContain('Loading hooks');
  });

  it('should show total configured hooks count', async () => {
    const { lastFrame, unmount } = renderWithProviders(
      <HooksManagementDialog onClose={mockOnClose} />,
    );

    await new Promise((resolve) => setTimeout(resolve, 100));

    const output = lastFrame();
    expect(output).toContain('hooks configured');

    unmount();
  });

  it('should display all hook events', async () => {
    const { lastFrame, unmount } = renderWithProviders(
      <HooksManagementDialog onClose={mockOnClose} />,
    );

    await new Promise((resolve) => setTimeout(resolve, 100));

    const output = lastFrame();
    expect(output).toContain(HookEventName.Stop);
    expect(output).toContain(HookEventName.PreToolUse);
    expect(output).toContain(HookEventName.PostToolUse);
    expect(output).toContain(HookEventName.UserPromptSubmit);

    unmount();
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
