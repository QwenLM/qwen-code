/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HooksManagementDialog } from './HooksManagementDialog.js';
import { renderWithProviders } from '../../../test-utils/render.js';
import { useKeypress } from '../../hooks/useKeypress.js';
import { useConfig } from '../../contexts/ConfigContext.js';
import type { Key } from '../../contexts/KeypressContext.js';

vi.mock('../../hooks/useKeypress.js', () => ({
  useKeypress: vi.fn(),
}));

const mockedUseKeypress = vi.mocked(useKeypress);
const mockedUseConfig = vi.mocked(useConfig);

/**
 * Returns a `useConfig` return value with `disableAllHooks` flipped on, while
 * keeping every other method shaped like the default mock at the top of this
 * file. Used with `mockReturnValueOnce` for the initial render — the dialog's
 * navigation stack is seeded in a `useState` initializer that only consults
 * `disableAllHooks` once, so subsequent renders falling back to the default
 * mock is fine.
 */
function disabledHooksConfig(): ReturnType<typeof useConfig> {
  return {
    getExtensions: vi.fn(() => []),
    getDisableAllHooks: vi.fn(() => true),
    getHookSystem: vi.fn(() => ({
      getSessionHooksManager: vi.fn(() => ({
        getAllSessionHooks: vi.fn(() => []),
      })),
    })),
    getSessionId: vi.fn(() => 'test-session-id'),
  } as unknown as ReturnType<typeof useConfig>;
}

vi.mock('../../../i18n/index.js', () => ({
  t: vi.fn((key: string, options?: { count?: string }) => {
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

vi.mock('../../hooks/useTerminalSize.js', () => ({
  useTerminalSize: vi.fn(() => ({ columns: 120, rows: 24 })),
}));

vi.mock('../../contexts/ConfigContext.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../contexts/ConfigContext.js')>();
  return {
    ...actual,
    useConfig: vi.fn(() => ({
      getExtensions: vi.fn(() => []),
      getDisableAllHooks: vi.fn(() => false),
      getHookSystem: vi.fn(() => ({
        getSessionHooksManager: vi.fn(() => ({
          getAllSessionHooks: vi.fn(() => []),
        })),
      })),
      getSessionId: vi.fn(() => 'test-session-id'),
    })),
  };
});

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

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    createDebugLogger: vi.fn(() => ({
      log: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
  };
});

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

    mockedUseKeypress.mockImplementation((handler) => {
      keypressHandler = handler;
    });
  });

  afterEach(() => {
    keypressHandler = null;
  });

  it('should render loading state initially', () => {
    const { lastFrame } = renderWithProviders(
      <HooksManagementDialog onClose={mockOnClose} />,
    );

    expect(lastFrame()).toContain('Loading hooks');
  });

  it('should allow Escape to close during loading state', () => {
    renderWithProviders(<HooksManagementDialog onClose={mockOnClose} />);

    expect(keypressHandler).not.toBeNull();
    keypressHandler!(createKey('escape', '\x1b'));

    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  it('should register the keypress handler with isActive: true', () => {
    renderWithProviders(<HooksManagementDialog onClose={mockOnClose} />);

    expect(mockedUseKeypress).toHaveBeenCalled();
    expect(mockedUseKeypress.mock.calls[0][1]).toEqual({ isActive: true });
  });

  it('should render HOOKS_DISABLED step on first render when disableAllHooks is true', () => {
    // `renderContent` checks the HOOKS_DISABLED branch before the isLoading
    // branch, so the disabled view is visible synchronously on the initial
    // render — no need to wait for the hooks-loading effect.
    mockedUseConfig.mockReturnValueOnce(disabledHooksConfig());

    const { lastFrame } = renderWithProviders(
      <HooksManagementDialog onClose={mockOnClose} />,
    );

    expect(lastFrame()).toContain('Hook Configuration - Disabled');
  });

  it('should close dialog on Escape when disableAllHooks is true', () => {
    mockedUseConfig.mockReturnValueOnce(disabledHooksConfig());

    renderWithProviders(<HooksManagementDialog onClose={mockOnClose} />);

    expect(keypressHandler).not.toBeNull();
    keypressHandler!(createKey('escape', '\x1b'));

    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });
});
