/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup } from 'ink-testing-library';
import { HookEventName } from '@qwen-code/qwen-code-core';
import { HooksManagementDialog } from './HooksManagementDialog.js';
import { renderWithProviders } from '../../../test-utils/render.js';
import { useKeypress } from '../../hooks/useKeypress.js';
import { useConfig } from '../../contexts/ConfigContext.js';
import { loadSettings, SettingScope } from '../../../config/settings.js';
import type { Key } from '../../contexts/KeypressContext.js';
import { DISPLAY_HOOK_EVENTS } from './constants.js';

vi.mock('../../hooks/useKeypress.js', () => ({
  useKeypress: vi.fn(),
}));

const mockedUseKeypress = vi.mocked(useKeypress);
const mockedUseConfig = vi.mocked(useConfig);
const mockedLoadSettings = vi.mocked(loadSettings);
let keypressHandler: ((key: Key) => void) | null = null;

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

function mockSettingsHooks(userHooks: Record<string, unknown>): void {
  mockedLoadSettings.mockReturnValue({
    forScope: vi.fn((scope: SettingScope) => ({
      settings:
        scope === SettingScope.User ? { hooks: userHooks } : { hooks: {} },
    })),
  } as unknown as ReturnType<typeof loadSettings>);
}

function pressKey(name: string, sequence = ''): void {
  const latestHandler = mockedUseKeypress.mock.calls.at(-1)?.[0];
  expect(latestHandler).toBeDefined();
  latestHandler!(createKey(name, sequence));
}

describe('HooksManagementDialog', () => {
  const mockOnClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    keypressHandler = null;

    mockedUseKeypress.mockImplementation((handler) => {
      keypressHandler = handler;
    });
  });

  afterEach(() => {
    keypressHandler = null;
    cleanup();
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

  it('should navigate from a matcher hook to matcher detail', async () => {
    mockSettingsHooks({
      PreToolUse: [
        {
          matcher: 'Read',
          hooks: [{ type: 'command', command: 'echo read' }],
        },
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: 'echo bash' }],
        },
      ],
    });

    const { lastFrame } = renderWithProviders(
      <HooksManagementDialog onClose={mockOnClose} />,
    );

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Hooks');
    });

    pressKey('return');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('[User] Read');
    });

    pressKey('down');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('❯ 2. [User] Bash');
    });
    pressKey('return');

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('PreToolUse - Matcher: Bash');
      expect(lastFrame()).toContain('echo bash');
    });

    pressKey('escape', '\x1b');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('PreToolUse - Matchers');
    });
  });

  it('should navigate from matcher detail to config detail', async () => {
    mockSettingsHooks({
      PreToolUse: [
        {
          matcher: 'Read',
          hooks: [{ type: 'command', command: 'echo read' }],
        },
        {
          matcher: 'Bash',
          hooks: [
            { type: 'command', command: 'echo first' },
            { type: 'command', command: 'echo second' },
          ],
        },
      ],
    });

    const { lastFrame } = renderWithProviders(
      <HooksManagementDialog onClose={mockOnClose} />,
    );

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Hooks');
    });

    pressKey('return');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('[User] Read');
    });
    pressKey('down');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('❯ 2. [User] Bash');
    });
    pressKey('return');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('PreToolUse - Matcher: Bash');
    });

    pressKey('down');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('❯ 2. [command] echo second');
    });
    pressKey('return');

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Hook details');
      expect(lastFrame()).toContain('echo second');
    });
  });

  it('should navigate directly from a non-matcher hook to config detail', async () => {
    mockSettingsHooks({
      Stop: [
        {
          hooks: [{ type: 'command', command: 'echo stop one' }],
        },
        {
          hooks: [{ type: 'command', command: 'echo stop two' }],
        },
      ],
    });

    const { lastFrame } = renderWithProviders(
      <HooksManagementDialog onClose={mockOnClose} />,
    );

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Hooks');
    });

    const stopEventIndex = DISPLAY_HOOK_EVENTS.indexOf(HookEventName.Stop);
    for (let i = 0; i < stopEventIndex; i++) {
      pressKey('down');
      await vi.waitFor(() => {
        expect(lastFrame()).toContain(`❯  ${i + 2}.`);
      });
    }
    await vi.waitFor(() => {
      expect(lastFrame()).toContain(`❯  ${stopEventIndex + 1}. Stop`);
    });
    pressKey('return');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Stop');
      expect(lastFrame()).toContain('echo stop one');
    });

    pressKey('down');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('❯ 2. [command] echo stop two');
    });
    pressKey('return');

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Hook details');
      expect(lastFrame()).toContain('echo stop two');
    });
  });
});
