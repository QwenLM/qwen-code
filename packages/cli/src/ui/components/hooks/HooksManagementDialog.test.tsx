/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup } from 'ink-testing-library';
import {
  HookEventName,
  HookType,
  HooksConfigSource,
  type HookRegistryEntry,
  type HookDefinition,
} from '@qwen-code/qwen-code-core';
import { HooksManagementDialog } from './HooksManagementDialog.js';
import { renderWithProviders } from '../../../test-utils/render.js';
import { useKeypress } from '../../hooks/useKeypress.js';
import { useConfig } from '../../contexts/ConfigContext.js';
import { useSettings } from '../../contexts/SettingsContext.js';
import { loadSettings, SettingScope } from '../../../config/settings.js';
import type { Key } from '../../contexts/KeypressContext.js';
import { DISPLAY_HOOK_EVENTS } from './constants.js';

vi.mock('../../hooks/useKeypress.js', () => ({
  useKeypress: vi.fn(),
}));

const mockedUseKeypress = vi.mocked(useKeypress);
const mockedUseConfig = vi.mocked(useConfig);
const mockedUseSettings = vi.mocked(useSettings);
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
    isSafeMode: () => false,
    getBareMode: () => false,
    getHookSystem: vi.fn(() => ({
      getAllHooks: () => [],
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
      isSafeMode: () => false,
      getBareMode: () => false,
      getDisableAllHooks: vi.fn(() => false),
      getHookSystem: vi.fn(() => ({
        getAllHooks: () => [],
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

vi.mock('../../contexts/SettingsContext.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../contexts/SettingsContext.js')>();
  return { ...actual, useSettings: vi.fn() };
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

function mockRegistryHooks(entries: HookRegistryEntry[]): void {
  const config = mockedUseConfig()!;
  vi.mocked(config.getHookSystem).mockReturnValue({
    getAllHooks: () => entries,
    getSessionHooksManager: () => ({ getAllSessionHooks: () => [] }),
  } as unknown as ReturnType<typeof config.getHookSystem>);
  mockedUseConfig.mockReturnValue(config);
}

function mockSettingsHooks(userHooks: Record<string, HookDefinition[]>): void {
  mockRegistryHooks(
    Object.entries(userHooks).flatMap(([eventName, definitions]) =>
      definitions.flatMap((definition) =>
        definition.hooks.map((config) => ({
          config,
          eventName: eventName as HookEventName,
          matcher: definition.matcher,
          sequential: definition.sequential,
          enabled: true,
          source: HooksConfigSource.User,
        })),
      ),
    ),
  );

  mockedUseSettings.mockReturnValue({
    forScope: vi.fn((scope: SettingScope) => ({
      settings:
        scope === SettingScope.User ? { hooks: userHooks } : { hooks: {} },
    })),
  } as unknown as ReturnType<typeof useSettings>);
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
    mockedUseConfig.mockReset();
    mockedUseConfig.mockReturnValue({
      getExtensions: () => [],
      getDisableAllHooks: () => false,
      isSafeMode: () => false,
      getBareMode: () => false,
      getSessionId: () => 'test-session-id',
      getHookSystem: vi.fn(),
    } as unknown as ReturnType<typeof useConfig>);
    mockSettingsHooks({});
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

  it('reads registry hooks without reading settings files or scopes', async () => {
    mockSettingsHooks({
      PreToolUse: [
        {
          matcher: 'Read',
          hooks: [{ type: HookType.Command, command: 'echo session-settings' }],
        },
      ],
    });
    const { lastFrame } = renderWithProviders(
      <HooksManagementDialog onClose={mockOnClose} />,
    );

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('1 hook configured');
    });
    expect(mockedLoadSettings).not.toHaveBeenCalled();
    expect(mockedUseSettings).not.toHaveBeenCalled();
    expect(mockedUseSettings().forScope).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'shows the actual registry enabled state %s in list and detail',
    async (enabled) => {
      mockRegistryHooks([
        {
          eventName: HookEventName.PreToolUse,
          matcher: 'Read',
          source: HooksConfigSource.User,
          enabled,
          config: {
            type: HookType.Command,
            command: 'echo state',
            timeout: 1500,
            statusMessage: 'Checking files',
            async: true,
          },
          sequential: true,
        },
      ]);
      const { lastFrame } = renderWithProviders(
        <HooksManagementDialog onClose={mockOnClose} />,
      );
      await vi.waitFor(() =>
        expect(lastFrame()).toContain('1 hook configured'),
      );
      pressKey('return');
      await vi.waitFor(() => expect(lastFrame()).toContain('[User] Read'));
      pressKey('return');
      await vi.waitFor(() => expect(lastFrame()).toContain('echo state'));
      if (enabled) expect(lastFrame()).not.toContain('disabled');
      else expect(lastFrame()).toContain('disabled');
      pressKey('return');
      await vi.waitFor(() => expect(lastFrame()).toContain('Hook details'));
      expect(lastFrame()).toMatch(
        new RegExp(`Status:\\s+${enabled ? 'enabled' : 'disabled'}`),
      );
      expect(lastFrame()).toContain('1500 ms');
      expect(lastFrame()).toContain('Checking files');
      expect(lastFrame()).toContain('runs in background, sequential');
    },
  );

  it('preserves extension annotation in the registry detail', async () => {
    mockRegistryHooks([
      {
        eventName: HookEventName.PreToolUse,
        matcher: 'Read',
        source: HooksConfigSource.Extensions,
        enabled: true,
        config: {
          type: HookType.Command,
          name: 'ext-hook',
          command: 'echo extension',
        },
      },
    ]);
    const config = mockedUseConfig()!;
    config.getExtensions = () =>
      [
        {
          name: 'my-extension',
          path: '/extensions/my-extension',
          isActive: true,
          hooks: {
            PreToolUse: [
              {
                matcher: 'Read',
                hooks: [
                  {
                    type: HookType.Command,
                    name: 'ext-hook',
                    command: 'echo extension',
                  },
                ],
              },
            ],
          },
        },
      ] as ReturnType<typeof config.getExtensions>;
    const { lastFrame } = renderWithProviders(
      <HooksManagementDialog onClose={mockOnClose} />,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain('1 hook configured'));
    pressKey('return');
    await vi.waitFor(() => expect(lastFrame()).toContain('Read'));
    pressKey('return');
    await vi.waitFor(() =>
      expect(lastFrame()).toContain('Extensions (my-extension)'),
    );
    pressKey('return');
    await vi.waitFor(() => expect(lastFrame()).toContain('Hook details'));
    expect(lastFrame()).toMatch(/Extension:\s+my-extension/);
    expect(lastFrame()).toContain('/extensions/my-extension');
  });

  it('includes session hooks in matcher rows', async () => {
    const config = mockedUseConfig()!;
    vi.mocked(config.getHookSystem).mockReturnValue({
      getAllHooks: () => [],
      getSessionHooksManager: () => ({
        getAllSessionHooks: () => [
          {
            eventName: HookEventName.PreToolUse,
            matcher: 'Read',
            config: { type: HookType.Command, command: 'echo temporary' },
            hookId: 'session-hook',
            skillRoot: '/skills/test',
          },
        ],
      }),
    } as unknown as ReturnType<typeof config.getHookSystem>);
    const { lastFrame } = renderWithProviders(
      <HooksManagementDialog onClose={mockOnClose} />,
    );
    await vi.waitFor(() => expect(lastFrame()).toContain('1 hook configured'));
    pressKey('return');
    await vi.waitFor(() => expect(lastFrame()).toContain('Read'));
    pressKey('return');
    await vi.waitFor(() =>
      expect(lastFrame()).toContain('Session (temporary)'),
    );
    expect(lastFrame()).toContain('echo temporary');
    pressKey('return');
    await vi.waitFor(() => expect(lastFrame()).toContain('Hook details'));
    expect(lastFrame()).toMatch(/Skill:\s+\/skills\/test/);
  });

  it('does not invent a configured count when disabled without a hook system', async () => {
    const config = disabledHooksConfig()!;
    vi.mocked(config.getHookSystem).mockReturnValue(undefined);
    mockedUseConfig.mockReturnValue(config);
    const { lastFrame } = renderWithProviders(
      <HooksManagementDialog onClose={mockOnClose} />,
    );
    await vi.waitFor(() =>
      expect(lastFrame()).toContain('Hook Configuration - Disabled'),
    );
    expect(lastFrame()).not.toContain('0 configured hooks');
  });

  it('renders an absent config as an empty list', async () => {
    mockedUseConfig.mockReturnValue(
      undefined as unknown as ReturnType<typeof useConfig>,
    );
    const { lastFrame } = renderWithProviders(
      <HooksManagementDialog onClose={mockOnClose} />,
    );
    await vi.waitFor(() => expect(lastFrame()).not.toContain('Loading hooks'));
    expect(lastFrame()).not.toContain('Error loading hooks:');
    expect(lastFrame()).toContain('No hook events found.');
  });

  it('should allow Escape to close during loading state', () => {
    renderWithProviders(<HooksManagementDialog onClose={mockOnClose} />);

    expect(keypressHandler).not.toBeNull();
    keypressHandler!(createKey('escape', '\x1b'));

    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  it('does not advertise reload when the session has no hook system', async () => {
    const config = mockedUseConfig()!;
    vi.mocked(config.getHookSystem).mockReturnValue(undefined);
    await mockedUseConfig.withImplementation(
      () => config,
      async () => {
        const { lastFrame } = renderWithProviders(
          <HooksManagementDialog onClose={mockOnClose} />,
        );

        await vi.waitFor(() => {
          expect(lastFrame()).toContain('This menu is read-only.');
        });
        expect(lastFrame()).not.toContain('Reopen this menu');
      },
    );
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
          hooks: [{ type: HookType.Command, command: 'echo read' }],
        },
        {
          matcher: 'Bash',
          hooks: [{ type: HookType.Command, command: 'echo bash' }],
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
          hooks: [{ type: HookType.Command, command: 'echo read' }],
        },
        {
          matcher: 'Bash',
          hooks: [
            { type: HookType.Command, command: 'echo first' },
            { type: HookType.Command, command: 'echo second' },
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
          hooks: [{ type: HookType.Command, command: 'echo stop one' }],
        },
        {
          hooks: [{ type: HookType.Command, command: 'echo stop two' }],
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
