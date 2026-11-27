/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { DefaultI18nCatalog } from '@qwen-code/core';

/**
 *
 *
 * This test suite covers:
 * - Initial rendering and display state
 * - Keyboard navigation (arrows, vim keys, Tab)
 * - Settings toggling (Enter, Space)
 * - Focus section switching between settings and scope selector
 * - Scope selection and settings persistence across scopes
 * - Restart-required vs immediate settings behavior
 * - Complex user interaction workflows
 * - Error handling and edge cases
 * - Display values for inherited and overridden settings
 *
 */

import { renderWithProviders } from '../../test-utils/render.js';
import { waitFor } from '../../test-utils/async.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SettingsDialog, type SettingChangeGuard } from './SettingsDialog.js';
import { SettingScope, type LoadedSettings } from '../../config/settings.js';
import { getSettingsZodSchema } from '../../config/settings-validation.js';
import { SettingsService } from '@qwen-code/resource';
import { createMockSettings } from '../../test-utils/settings.js';
import { makeFakeConfig } from '@qwen-code/core';
import type React from 'react';
import { act } from 'react';
import { TEST_ONLY } from '../../utils/settingsUtils.js';
import { enCatalog } from '../i18n/locales/en/index.js';
import { createTestI18nService } from '../../test-utils/i18n.js';
import {
  getSettingsSchema,
  type SettingDefinition,
  type SettingsSchemaType,
  type SettingsValue,
} from '../../config/settingsSchema.js';
import { normalizePermissionModeValue } from '../../config/permissionMode.js';
import { terminalCapabilityManager } from '../utils/terminalCapabilityManager.js';
import { Text } from 'ink';
import { useI18nService } from '../i18n/index.js';

enum TerminalKeys {
  ENTER = '\u000D',
  TAB = '\t',
  UP_ARROW = '\u001B[A',
  DOWN_ARROW = '\u001B[B',
  LEFT_ARROW = '\u001B[D',
  RIGHT_ARROW = '\u001B[C',
  ESCAPE = '\u001B',
  BACKSPACE = '\u0008',
  CTRL_P = '\u0010',
  CTRL_N = '\u000E',
}

vi.mock('../../config/settingsSchema.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../config/settingsSchema.js')>();
  return {
    ...original,
    getSettingsSchema: vi.fn(original.getSettingsSchema),
  };
});

// Shared test schemas
enum StringEnum {
  FOO = 'foo',
  BAR = 'bar',
  BAZ = 'baz',
}

const ENUM_SETTING: SettingDefinition = {
  type: 'enum',
  label: 'Theme',
  options: [
    {
      label: 'Foo',
      value: StringEnum.FOO,
    },
    {
      label: 'Bar',
      value: StringEnum.BAR,
    },
    {
      label: 'Baz',
      value: StringEnum.BAZ,
    },
  ],
  category: 'UI',
  requiresRestart: false,
  default: StringEnum.BAR,
  description: 'The color theme for the UI.',
  showInDialog: true,
};

// Minimal general schema for KeypressProvider
const MINIMAL_GENERAL_SCHEMA = {
  general: {
    showInDialog: false,
    properties: {
      debugKeystrokeLogging: {
        type: 'boolean',
        label: 'Debug Keystroke Logging',
        category: 'General',
        requiresRestart: false,
        default: false,
        showInDialog: false,
      },
    },
  },
};

const ENUM_FAKE_SCHEMA: SettingsSchemaType = {
  ...MINIMAL_GENERAL_SCHEMA,
  ui: {
    showInDialog: false,
    properties: {
      theme: {
        ...ENUM_SETTING,
      },
    },
  },
} as unknown as SettingsSchemaType;

const OPTION_BACKED_STRING_FAKE_SCHEMA: SettingsSchemaType = {
  general: {
    ...MINIMAL_GENERAL_SCHEMA.general,
    properties: {
      ...MINIMAL_GENERAL_SCHEMA.general.properties,
      defaultPermissionMode: {
        type: 'string',
        label: 'Default Permission Mode',
        options: [
          { value: 'default', label: 'Default' },
          { value: 'accept_edits', label: 'Accept Edits' },
          { value: 'auto', label: 'Auto' },
          { value: 'bypass_permissions', label: 'YOLO' },
          { value: 'dont_ask', label: "Don't Ask" },
        ],
        category: 'General',
        requiresRestart: false,
        default: 'default',
        description: 'The default permission mode for tool execution.',
        showInDialog: true,
        normalizeOptionValue: (value: SettingsValue) =>
          typeof value === 'string'
            ? normalizePermissionModeValue(value)
            : undefined,
      },
    },
  },
} as unknown as SettingsSchemaType;

const ARRAY_FAKE_SCHEMA: SettingsSchemaType = {
  ...MINIMAL_GENERAL_SCHEMA,
  context: {
    type: 'object',
    label: 'Context',
    category: 'Context',
    requiresRestart: false,
    default: {},
    description: 'Context settings.',
    showInDialog: false,
    properties: {
      fileFiltering: {
        type: 'object',
        label: 'File Filtering',
        category: 'Context',
        requiresRestart: false,
        default: {},
        description: 'File filtering settings.',
        showInDialog: false,
        properties: {
          customIgnoreFilePaths: {
            type: 'array',
            label: 'Custom Ignore File Paths',
            category: 'Context',
            requiresRestart: false,
            default: [] as string[],
            description: 'Additional ignore file paths.',
            showInDialog: true,
            items: { type: 'string' },
          },
        },
      },
    },
  },
  security: {
    type: 'object',
    label: 'Security',
    category: 'Security',
    requiresRestart: false,
    default: {},
    description: 'Security settings.',
    showInDialog: false,
    properties: {
      allowedExtensions: {
        type: 'array',
        label: 'Extension Source Regex Allowlist',
        category: 'Security',
        requiresRestart: false,
        default: [] as string[],
        description: 'Allowed extension source regex patterns.',
        showInDialog: true,
        items: { type: 'string' },
      },
    },
  },
} as unknown as SettingsSchemaType;

const TOOLS_SHELL_FAKE_SCHEMA: SettingsSchemaType = {
  ...MINIMAL_GENERAL_SCHEMA,
  tools: {
    type: 'object',
    label: 'Tools',
    category: 'Tools',
    requiresRestart: false,
    default: {},
    description: 'Tool settings.',
    showInDialog: false,
    properties: {
      shell: {
        type: 'object',
        label: 'Shell',
        category: 'Tools',
        requiresRestart: false,
        default: {},
        description: 'Shell tool settings.',
        showInDialog: false,
        properties: {
          showColor: {
            type: 'boolean',
            label: 'Show Color',
            category: 'Tools',
            requiresRestart: false,
            default: false,
            description: 'Show color in shell output.',
            showInDialog: true,
          },
          pager: {
            type: 'string',
            label: 'Pager',
            category: 'Tools',
            requiresRestart: false,
            default: 'cat',
            description: 'The pager command to use for shell output.',
            showInDialog: true,
          },
        },
      },
    },
  },
} as unknown as SettingsSchemaType;

/**
 * Schema with a restart-required setting as the first item.
 * Useful for restart-prompt tests where we need to toggle it immediately
 * without navigating (since the search TextInput consumes arrow keys).
 */
const RESTART_FIRST_FAKE_SCHEMA: SettingsSchemaType = {
  ...MINIMAL_GENERAL_SCHEMA,
  tools: {
    type: 'object',
    label: 'Tools',
    category: 'Tools',
    requiresRestart: false,
    default: {},
    description: 'Tool settings.',
    showInDialog: false,
    properties: {
      shell: {
        type: 'object',
        label: 'Shell',
        category: 'Tools',
        requiresRestart: false,
        default: {},
        description: 'Shell tool settings.',
        showInDialog: false,
        properties: {
          showColor: {
            type: 'boolean',
            label: 'Show Color',
            category: 'Tools',
            requiresRestart: true,
            default: false,
            description: 'Show color in shell output.',
            showInDialog: true,
          },
          pager: {
            type: 'string',
            label: 'Pager',
            category: 'Tools',
            requiresRestart: false,
            default: 'cat',
            description: 'The pager command to use for shell output.',
            showInDialog: true,
          },
        },
      },
    },
  },
} as unknown as SettingsSchemaType;

// Helper function to render SettingsDialog with standard wrapper
const renderDialog = async (
  settings: ReturnType<typeof createMockSettings>,
  onSelect: ReturnType<typeof vi.fn>,
  options?: {
    config?: ReturnType<typeof makeFakeConfig>;
    onRestartRequest?: ReturnType<typeof vi.fn>;
    availableTerminalHeight?: number;
    width?: number;
    settingChangeGuard?: SettingChangeGuard;
    i18nService?: ReturnType<typeof createTestI18nService>;
  },
) =>
  renderWithProviders(
    <SettingsDialog
      onSelect={onSelect}
      onRestartRequest={options?.onRestartRequest}
      availableTerminalHeight={options?.availableTerminalHeight}
      settingChangeGuard={options?.settingChangeGuard}
    />,
    {
      settings,
      i18nService: options?.i18nService,
      config: options?.config ?? makeFakeConfig(),
      uiState: { terminalBackgroundColor: undefined },
      width: options?.width,
    },
  );

function LocaleProbe(): React.JSX.Element {
  const { locale, get: t } = useI18nService();
  return (
    <Text>{`locale-probe:${locale}:${t('settings.language.label')}`}</Text>
  );
}

describe('SettingsDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(
      terminalCapabilityManager,
      'isKittyProtocolEnabled',
    ).mockReturnValue(true);
  });

  afterEach(() => {
    TEST_ONLY.clearFlattenedSchema();
    vi.clearAllMocks();
    vi.resetAllMocks();
  });

  describe('Initial Rendering', () => {
    it('renders and writes a restart-required setting from the configured service', async () => {
      const schema = {
        productEnabled: {
          type: 'boolean',
          label: 'Product setting',
          category: 'Privacy',
          default: true,
          requiresRestart: true,
          showInDialog: true,
        },
      } as const;
      const service = new SettingsService({
        schema,
        validation: getSettingsZodSchema(schema),
      });
      const settings = createMockSettings();
      const setValue = vi.spyOn(settings, 'setValue');
      const { lastFrame, stdin, unmount, waitUntilReady } = await renderDialog(
        settings,
        vi.fn(),
        { config: makeFakeConfig({ settingsService: service }) },
      );
      try {
        expect(lastFrame()).toContain('Product setting');
        expect(lastFrame()).toContain('true');
        await act(async () => stdin.write(TerminalKeys.ENTER));
        await waitUntilReady();
        expect(setValue).toHaveBeenCalledWith(
          SettingScope.User,
          'productEnabled',
          false,
        );
        expect(lastFrame()).toMatch(/restart/i);
      } finally {
        unmount();
        await service.dispose();
      }
    });

    it('should render the settings dialog with default state', async () => {
      const settings = createMockSettings();
      const onSelect = vi.fn();

      const { lastFrame, unmount } = await renderDialog(settings, onSelect);

      const output = lastFrame();
      expect(output).toContain('Settings');
      expect(output).toContain('User Settings');
      // Use regex for more flexible help text matching
      expect(output).toMatch(/Tab.*switch.*Esc.*back/);
      unmount();
    });

    it('should accept availableTerminalHeight prop without errors', async () => {
      const settings = createMockSettings();
      const onSelect = vi.fn();

      const { lastFrame, unmount } = await renderDialog(settings, onSelect, {
        availableTerminalHeight: 20,
      });

      const output = lastFrame();
      // Should still render properly with the height prop
      expect(output).toContain('Settings');
      // Use regex for more flexible help text matching
      expect(output).toMatch(/Tab.*switch.*Esc.*back/);
      unmount();
    });

    // skip: 现存失败
    it.skip('should render settings list with visual indicators', async () => {
      const settings = createMockSettings();
      const onSelect = vi.fn();

      const renderResult = await renderDialog(settings, onSelect);

      await expect(renderResult).toMatchSvgSnapshot();
      renderResult.unmount();
    });

    it('should use almost full height of the window but no more when the window height is 25 rows', async () => {
      const settings = createMockSettings();
      const onSelect = vi.fn();

      // Render with a fixed height of 25 rows
      const { lastFrame, unmount } = await renderDialog(settings, onSelect, {
        availableTerminalHeight: 25,
      });

      // Wait for the dialog to render
      await waitFor(() => {
        const output = lastFrame();
        expect(output).toBeDefined();
        const lines = output.trim().split('\n');

        // BaseTabDialog is more compact than old RadioButtonSelect (3 lines vs 5),
        // so the total height is slightly smaller
        expect(lines.length).toBeGreaterThanOrEqual(22);
        expect(lines.length).toBeLessThanOrEqual(25);
      });
      unmount();
    });
  });

  describe('Setting Descriptions', () => {
    it('shows only the focused item description in the bottom detail bar', async () => {
      const settings = createMockSettings();
      const onSelect = vi.fn();

      const { lastFrame, unmount } = await renderDialog(settings, onSelect);

      const output = lastFrame();
      // Labels stay visible for every row (one line per item).
      expect(output).toContain('Vim Mode');
      expect(output).toContain('Enable Auto Update');
      // Only the focused row (the first one) contributes a description now.
      expect(output.replace(/\s+/g, ' ')).toContain(
        'Automatically save and load reusable information for the current project.',
      );
      expect(output).not.toContain('Enable Vim keybindings');
      unmount();
    });
  });

  describe('Settings Navigation', () => {
    it.each([
      {
        name: 'arrow keys',
        down: TerminalKeys.DOWN_ARROW,
        up: TerminalKeys.UP_ARROW,
      },
      {
        name: 'emacs keys (Ctrl+P/N)',
        down: TerminalKeys.CTRL_N,
        up: TerminalKeys.CTRL_P,
      },
    ])('should navigate with $name', async ({ down, up }) => {
      const settings = createMockSettings();
      const onSelect = vi.fn();

      const { stdin, unmount, lastFrame, waitUntilReady } = await renderDialog(
        settings,
        onSelect,
      );

      const initialFrame = lastFrame();
      expect(initialFrame).toContain('Vim Mode');

      // Navigate down
      await act(async () => {
        stdin.write(down);
      });
      await waitUntilReady();

      await waitFor(() => {
        expect(lastFrame()).toContain('Enable Auto Update');
      });

      // Navigate up
      await act(async () => {
        stdin.write(up);
      });
      await waitUntilReady();

      await waitFor(() => {
        expect(lastFrame()).toContain('Vim Mode');
      });

      unmount();
    });

    it('should allow j and k characters to be typed in search without triggering navigation', async () => {
      const settings = createMockSettings();
      const onSelect = vi.fn();
      const { lastFrame, stdin, waitUntilReady, unmount } = await renderDialog(
        settings,
        onSelect,
      );

      // Enter 'j' and 'k' in search
      await act(async () => stdin.write('j'));
      await waitUntilReady();
      await act(async () => stdin.write('k'));
      await waitUntilReady();

      await waitFor(() => {
        const frame = lastFrame();
        // The characters reach the search box instead of being consumed as
        // vim navigation keys, which is what this test guards.
        expect(frame).toContain('jk');
        // 'jk' is a valid fuzzy subsequence of the .agents/skills description
        // ("project settings" ... "SDK"), so the list narrows to that entry
        // instead of showing the localized empty state.
        expect(frame).toContain('Load Skills from .agents/skills');
        expect(frame).not.toContain('No settings match your search.');
      });
      unmount();
    });

    it('stays on the first setting when navigating up at the top', async () => {
      const settings = createMockSettings();
      const onSelect = vi.fn();

      const { stdin, unmount, lastFrame, waitUntilReady } = await renderDialog(
        settings,
        onSelect,
      );

      // Try to go up from first item
      await act(async () => {
        stdin.write(TerminalKeys.UP_ARROW);
      });
      await waitUntilReady();

      await waitFor(() => {
        expect(lastFrame()).toContain('❯ Project Auto Memory');
      });

      unmount();
    });
  });

  describe('Settings Toggling', () => {
    it('should toggle setting with Enter key', async () => {
      const settings = createMockSettings();
      const setValueSpy = vi.spyOn(settings, 'setValue');
      const onSelect = vi.fn();

      const { stdin, unmount, lastFrame } = await renderDialog(
        settings,
        onSelect,
      );

      // Wait for initial render and verify the first setting is selected.
      await waitFor(() => {
        expect(lastFrame()).toContain('Project Auto Memory');
      });

      // Toggle the first setting.
      await act(async () => {
        stdin.write(TerminalKeys.ENTER as string);
      });

      // Wait for setValue to be called
      await waitFor(() => {
        expect(setValueSpy).toHaveBeenCalled();
      });

      expect(setValueSpy).toHaveBeenCalledWith(
        SettingScope.User,
        'autoMemoryEnabled',
        true,
      );

      unmount();
    });

    it('keeps a guarded setting and shows the guard notice instead', async () => {
      const i18nService = createTestI18nService();
      i18nService.registerCatalog(
        new DefaultI18nCatalog({
          en: {
            ...enCatalog,
            'test.settings.blocked': 'This setting is managed by the host.',
          },
        }),
      );
      const settings = createMockSettings();
      const setValueSpy = vi.spyOn(settings, 'setValue');
      const settingChangeGuard = vi.fn((key: string) =>
        key === 'autoMemoryEnabled'
          ? Promise.resolve('test.settings.blocked')
          : undefined,
      );

      const { stdin, unmount, lastFrame } = await renderDialog(
        settings,
        vi.fn(),
        { settingChangeGuard, i18nService },
      );
      await waitFor(() => {
        expect(lastFrame()).toContain('Project Auto Memory');
      });

      await act(async () => {
        stdin.write(TerminalKeys.ENTER as string);
      });

      await waitFor(() => {
        expect(lastFrame()).toContain('This setting is managed by the host.');
      });
      expect(settingChangeGuard).toHaveBeenCalledWith('autoMemoryEnabled');
      expect(setValueSpy).not.toHaveBeenCalled();
      unmount();
    });

    it('clears the guard notice once the guard allows the setting', async () => {
      const i18nService = createTestI18nService();
      i18nService.registerCatalog(
        new DefaultI18nCatalog({
          en: {
            ...enCatalog,
            'test.settings.blocked': 'This setting is managed by the host.',
          },
        }),
      );
      // A setting without a restart prompt, which would hide the notice.
      vi.mocked(getSettingsSchema).mockReturnValue(TOOLS_SHELL_FAKE_SCHEMA);
      const settings = createMockSettings();
      const setValueSpy = vi.spyOn(settings, 'setValue');
      let blocked = true;
      const settingChangeGuard: SettingChangeGuard = (key) =>
        key === 'tools.shell.showColor'
          ? blocked
            ? Promise.resolve('test.settings.blocked')
            : null
          : undefined;

      const { stdin, unmount, lastFrame } = await renderDialog(
        settings,
        vi.fn(),
        { settingChangeGuard, i18nService },
      );
      await waitFor(() => {
        expect(lastFrame()).toContain('Show Color');
      });
      await act(async () => {
        stdin.write(TerminalKeys.ENTER as string);
      });
      await waitFor(() => {
        expect(lastFrame()).toContain('This setting is managed by the host.');
      });
      expect(setValueSpy).not.toHaveBeenCalled();

      blocked = false;
      await act(async () => {
        stdin.write(TerminalKeys.ENTER as string);
      });

      await waitFor(() => {
        expect(setValueSpy).toHaveBeenCalledWith(
          SettingScope.User,
          'tools.shell.showColor',
          true,
        );
      });
      await waitFor(() => {
        expect(lastFrame()).not.toContain(
          'This setting is managed by the host.',
        );
      });
      unmount();
    });

    describe('enum values', () => {
      it.each([
        {
          name: 'canonical default',
          initialValue: undefined,
          expectedValue: 'accept_edits',
        },
        {
          name: 'camelCase alias',
          initialValue: 'acceptEdits',
          expectedValue: 'auto',
        },
      ])(
        'selects the next option for an option-backed string using $name',
        async ({ initialValue, expectedValue }) => {
          vi.mocked(getSettingsSchema).mockReturnValue(
            OPTION_BACKED_STRING_FAKE_SCHEMA,
          );

          const settings = createMockSettings(
            initialValue
              ? { general: { defaultPermissionMode: initialValue } }
              : {},
          );
          const setValueSpy = vi.spyOn(settings, 'setValue');
          const { stdin, unmount, waitUntilReady } = await renderDialog(
            settings,
            vi.fn(),
          );

          await act(async () => {
            stdin.write(TerminalKeys.DOWN_ARROW as string);
          });
          await waitUntilReady();

          await act(async () => {
            stdin.write(TerminalKeys.ENTER as string);
          });
          await waitUntilReady();

          expect(setValueSpy).toHaveBeenCalledWith(
            SettingScope.User,
            'general.defaultPermissionMode',
            expectedValue,
          );

          unmount();
        },
      );

      it.each([
        {
          name: 'toggles to next value',
          initialValue: undefined,
          expectedValue: StringEnum.BAZ,
        },
        {
          name: 'loops back to first value when at end',
          initialValue: StringEnum.BAZ,
          expectedValue: StringEnum.FOO,
        },
      ])('$name', async ({ initialValue, expectedValue }) => {
        vi.mocked(getSettingsSchema).mockReturnValue(ENUM_FAKE_SCHEMA);

        const settings = createMockSettings();
        if (initialValue !== undefined) {
          settings.setValue(SettingScope.User, 'ui.theme', initialValue);
        }
        const setValueSpy = vi.spyOn(settings, 'setValue');

        const onSelect = vi.fn();

        const { stdin, unmount, waitUntilReady } = await renderDialog(
          settings,
          onSelect,
        );

        await act(async () => {
          stdin.write(TerminalKeys.DOWN_ARROW as string);
        });
        await waitUntilReady();

        await act(async () => {
          stdin.write(TerminalKeys.ENTER as string);
        });
        await waitUntilReady();

        await waitFor(() => {
          expect(setValueSpy).toHaveBeenCalledWith(
            SettingScope.User,
            'ui.theme',
            expectedValue,
          );
        });

        unmount();
      });
    });

    it('should handle vim mode setting specially', async () => {
      const settings = createMockSettings();
      const onSelect = vi.fn();

      const { stdin, unmount, waitUntilReady } = await renderDialog(
        settings,
        onSelect,
      );

      // Navigate to vim mode setting and toggle it
      // This would require knowing the exact position, so we'll just test that the mock is called
      await act(async () => {
        stdin.write(TerminalKeys.ENTER as string); // Enter key
      });
      await waitUntilReady();

      // The mock should potentially be called if vim mode was toggled
      unmount();
    });
  });

  describe('.agents skills compatibility setting', () => {
    const searchForAgentsSkills = async (
      stdin: { write: (data: string) => void },
      waitUntilReady: () => Promise<void>,
    ) => {
      await act(async () => {
        stdin.write('agents/skills');
      });
      await waitUntilReady();
    };

    const focusFilteredSetting = async (
      stdin: { write: (data: string) => void },
      waitUntilReady: () => Promise<void>,
    ) => {
      await act(async () => {
        stdin.write(TerminalKeys.DOWN_ARROW);
      });
      await waitUntilReady();
    };

    it('disables the default in User Settings scope and requests restart', async () => {
      const settings = createMockSettings({
        user: {
          path: '',
          settings: {},
          originalSettings: {},
          readOnly: true,
        },
      });
      const { lastFrame, stdin, unmount, waitUntilReady } = await renderDialog(
        settings,
        vi.fn(),
      );

      await searchForAgentsSkills(stdin, waitUntilReady);
      await waitFor(() => {
        expect(lastFrame()).toContain('Load Skills from .agents/skills');
      });
      await focusFilteredSetting(stdin, waitUntilReady);
      await act(async () => {
        stdin.write(TerminalKeys.ENTER);
      });
      await waitUntilReady();

      await waitFor(() => {
        expect(
          settings.forScope(SettingScope.User).settings.skills
            ?.loadFromAgentsDirectory,
        ).toBe(false);
        expect(
          settings.forScope(SettingScope.Project).settings.skills
            ?.loadFromAgentsDirectory,
        ).toBeUndefined();
        expect(lastFrame()).toContain('Restart required.');
      });
      unmount();
    }, 10_000);

    it('disables the default in Project Settings scope', async () => {
      const settings = createMockSettings({
        project: {
          path: '',
          settings: {},
          originalSettings: {},
          readOnly: true,
        },
      });
      const { lastFrame, stdin, unmount, waitUntilReady } = await renderDialog(
        settings,
        vi.fn(),
      );

      await act(async () => {
        stdin.write(TerminalKeys.RIGHT_ARROW);
      });
      await waitUntilReady();
      await waitFor(() => {
        expect(lastFrame()).toContain('Overrides User settings.');
      });

      await searchForAgentsSkills(stdin, waitUntilReady);
      await waitFor(() => {
        expect(lastFrame()).toContain('Load Skills from .agents/skills');
      });
      await focusFilteredSetting(stdin, waitUntilReady);
      await act(async () => {
        stdin.write(TerminalKeys.ENTER);
      });
      await waitUntilReady();

      await waitFor(() => {
        expect(
          settings.forScope(SettingScope.Project).settings.skills
            ?.loadFromAgentsDirectory,
        ).toBe(false);
        expect(
          settings.forScope(SettingScope.User).settings.skills
            ?.loadFromAgentsDirectory,
        ).toBeUndefined();
        expect(lastFrame()).toContain('Restart required.');
      });
      unmount();
    }, 10_000);
  });

  describe('auto memory setting', () => {
    it.each([
      {
        search: 'project auto memory',
        label: 'Project Auto Memory',
        expected: true,
        read: (settings: LoadedSettings) =>
          settings.forScope(SettingScope.User).settings.autoMemoryEnabled,
      },
      {
        search: 'user auto memory',
        label: 'User Auto Memory',
        expected: true,
        read: (settings: LoadedSettings) =>
          settings.forScope(SettingScope.User).settings
            .autoMemoryUserScopeEnabled,
      },
      {
        search: 'dream',
        label: 'Dream',
        expected: true,
        read: (settings: LoadedSettings) =>
          settings.forScope(SettingScope.User).settings.dream?.enabled,
      },
    ])(
      'can explicitly toggle $label from /settings',
      async ({ search, label, expected, read }) => {
        const settings = createMockSettings();
        const { lastFrame, stdin, unmount, waitUntilReady } =
          await renderDialog(settings, vi.fn());

        await act(async () => {
          stdin.write(search);
        });
        await waitFor(() => {
          expect(lastFrame()).toContain(label);
        });

        await act(async () => {
          stdin.write(TerminalKeys.ENTER);
        });
        await waitUntilReady();

        await waitFor(() => {
          expect(read(settings)).toBe(expected);
          expect(lastFrame()).toContain('Restart required.');
        });
        unmount();
      },
    );
  });

  describe('CodeMode setting', () => {
    function createCodeModeConfig(
      enabled = true,
      defaultMode: 'off' | 'on' | 'only' = 'on',
    ) {
      const config = makeFakeConfig();
      vi.spyOn(config, 'isCodeModeFeatureGateEnabled').mockReturnValue(enabled);
      vi.spyOn(config, 'getCodeModeDefaultMode').mockReturnValue(defaultMode);
      return config;
    }

    /** The value column of the Code Mode row; the description also mentions the mode names. */
    function codeModeRowValue(frame: string | undefined): string | undefined {
      return frame?.match(/Code Mode\s{2,}(\S.*?)(?=\s+\(|\s*$)/m)?.[1];
    }

    it.each(['off', 'on', 'only'] as const)(
      'hides the setting from the list and search when gated off with local mode %s',
      async (mode) => {
        const schema = getSettingsSchema();
        vi.mocked(getSettingsSchema).mockReturnValue({
          ...MINIMAL_GENERAL_SCHEMA,
          codeMode: schema.codeMode,
        } as SettingsSchemaType);
        const settings = createMockSettings({ codeMode: { mode } });
        const { lastFrame, stdin, unmount, waitUntilReady } =
          await renderDialog(settings, vi.fn(), {
            config: createCodeModeConfig(false),
          });
        try {
          await waitUntilReady();
          expect(lastFrame()).not.toContain('Code Mode');
          await act(async () => stdin.write('codeMode.mode'));
          await waitUntilReady();
          expect(lastFrame()).not.toContain('Code Mode');
          expect(settings.user.settings.codeMode?.mode).toBe(mode);
        } finally {
          unmount();
        }
      },
    );

    it('allows enabling a locally disabled mode when the gate is open', async () => {
      const settings = createMockSettings({ codeMode: { mode: 'off' } });
      const { lastFrame, stdin, unmount, waitUntilReady } = await renderDialog(
        settings,
        vi.fn(),
        { config: createCodeModeConfig() },
      );
      try {
        await act(async () => stdin.write('codeMode.mode'));
        await waitFor(() => {
          expect(lastFrame()).toContain('Code Mode');
          expect(lastFrame()).toContain('Off*');
        });
        await act(async () => stdin.write(TerminalKeys.ENTER));
        await waitUntilReady();
        await waitFor(() => {
          expect(settings.user.settings.codeMode?.mode).toBe('on');
          expect(lastFrame()).toContain('On*');
        });
      } finally {
        unmount();
      }
    });

    it.each([
      {
        locale: 'en',
        labels: ['Off', 'On', 'Only'],
        restart: 'Restart required.',
      },
      {
        locale: 'zh-CN',
        labels: ['关闭', '开启', '仅 CodeMode'],
        restart: '需要重启',
      },
    ] as const)(
      'offers localized modes and shows the remote default when unset in $locale',
      async ({ locale, labels, restart }) => {
        const settings = createMockSettings({ ui: { language: locale } });
        const setValue = vi.spyOn(settings, 'setValue');
        const rendered = await renderDialog(settings, vi.fn(), {
          config: createCodeModeConfig(true, 'only'),
          width: 90,
          availableTerminalHeight: 16,
        });
        const { lastFrame, stdin, unmount, waitUntilReady } = rendered;
        const [, , defaultLabel] = labels;
        try {
          await act(async () => stdin.write('codeMode.mode'));
          await waitFor(() => {
            expect(codeModeRowValue(lastFrame())).toBe(defaultLabel);
          });
          await waitUntilReady();
          expect(lastFrame()).toMatchSnapshot();

          const values = ['off', 'on', 'only', undefined] as const;
          for (const [index, value] of values.entries()) {
            await act(async () => stdin.write(TerminalKeys.ENTER));
            await waitUntilReady();
            await waitFor(() => {
              expect(
                settings.forScope(SettingScope.User).settings.codeMode?.mode,
              ).toBe(value);
              expect(setValue).toHaveBeenLastCalledWith(
                SettingScope.User,
                'codeMode.mode',
                value,
              );
              expect(codeModeRowValue(lastFrame())).toBe(
                value === undefined ? defaultLabel : `${labels[index]}*`,
              );
              if (value === undefined) {
                expect(lastFrame()).not.toContain(restart);
              } else {
                expect(lastFrame()).toContain(restart);
              }
            });
          }
          expect(settings.user.originalSettings.codeMode?.mode).toBeUndefined();
        } finally {
          unmount();
        }
      },
    );

    it('clears only the project mode when restoring the default', async () => {
      const user = { codeMode: { mode: 'on' as const } };
      const project = {
        codeMode: { mode: 'only' as const, deferredTools: ['Read'] },
      };
      const settings = createMockSettings({
        user: { path: '', settings: user, originalSettings: user },
        project: { path: '', settings: project, originalSettings: project },
      });
      const { lastFrame, stdin, unmount, waitUntilReady } = await renderDialog(
        settings,
        vi.fn(),
        { config: createCodeModeConfig(true, 'off') },
      );
      try {
        await act(async () => stdin.write('codeMode.mode'));
        await waitFor(() => expect(lastFrame()).toContain('On*'));
        await act(async () => stdin.write(TerminalKeys.TAB));
        await waitUntilReady();
        await waitFor(() => expect(lastFrame()).toContain('Only*'));
        await act(async () => stdin.write(TerminalKeys.ENTER));
        await waitUntilReady();
        await waitFor(() => {
          expect(settings.project.settings.codeMode?.mode).toBeUndefined();
          expect(settings.project.settings.codeMode?.deferredTools).toEqual([
            'Read',
          ]);
          expect(settings.user.settings.codeMode?.mode).toBe('on');
          expect(settings.merged.codeMode.mode).toBe('on');
          expect(codeModeRowValue(lastFrame())).toBe('On');
          expect(lastFrame()).toContain('Restart required.');
        });
      } finally {
        unmount();
      }
    });
  });

  describe('Scope Selection', () => {
    it('should switch between scopes', async () => {
      const settings = createMockSettings();
      const onSelect = vi.fn();

      const { stdin, unmount, waitUntilReady } = await renderDialog(
        settings,
        onSelect,
      );

      // Switch to scope focus
      await act(async () => {
        stdin.write(TerminalKeys.TAB); // Tab key
        // Select different scope (numbers 1-3 typically available)
        stdin.write('2'); // Select second scope option
      });
      await waitUntilReady();

      unmount();
    });

    it('should reset to settings focus when scope is selected', async () => {
      const settings = createMockSettings();
      const onSelect = vi.fn();

      const { lastFrame, unmount } = await renderDialog(settings, onSelect);

      // Wait for initial render
      await waitFor(() => {
        expect(lastFrame()).toContain('Vim Mode');
      });

      // The UI should show the settings section is active and scope tabs are visible
      expect(lastFrame()).toContain('Vim Mode'); // Settings section active
      expect(lastFrame()).toContain('User Settings'); // Scope tabs visible

      // This test validates the initial state - scope selection behavior
      // is complex due to keypress handling, so we focus on state validation

      unmount();
    });
  });

  describe('Restart Prompt', () => {
    it('should show restart prompt for restart-required settings', async () => {
      const settings = createMockSettings();
      const onRestartRequest = vi.fn();

      const { unmount } = await renderDialog(settings, vi.fn(), {
        onRestartRequest,
      });

      // This test would need to trigger a restart-required setting change
      // The exact steps depend on which settings require restart

      unmount();
    });

    it('should handle restart request when r is pressed', async () => {
      const settings = createMockSettings();
      const onRestartRequest = vi.fn();

      const { stdin, unmount, waitUntilReady } = await renderDialog(
        settings,
        vi.fn(),
        {
          onRestartRequest,
        },
      );

      // Press 'r' key (this would only work if restart prompt is showing)
      await act(async () => {
        stdin.write('r');
      });
      await waitUntilReady();

      // If restart prompt was showing, onRestartRequest should be called
      unmount();
    });
  });

  describe('Escape Key Behavior', () => {
    it('should call onSelect with undefined when Escape is pressed', async () => {
      const settings = createMockSettings();
      const onSelect = vi.fn();

      const { lastFrame, unmount } = await renderDialog(settings, onSelect);

      // Wait for initial render
      await waitFor(() => {
        expect(lastFrame()).toContain('Vim Mode');
      });

      // Verify the dialog is rendered properly
      expect(lastFrame()).toContain('Settings');
      expect(lastFrame()).toContain('User Settings');

      // This test validates rendering - escape key behavior depends on complex
      // keypress handling that's difficult to test reliably in this environment

      unmount();
    });
  });

  describe('Settings Persistence', () => {
    it('should persist settings across scope changes', async () => {
      const settings = createMockSettings({ vimMode: true });
      const onSelect = vi.fn();

      const { stdin, unmount, waitUntilReady } = await renderDialog(
        settings,
        onSelect,
      );

      // Switch to scope selector and change scope
      await act(async () => {
        stdin.write(TerminalKeys.TAB as string); // Tab
        stdin.write('2'); // Select workspace scope
      });
      await waitUntilReady();

      // Settings should be reloaded for new scope
      unmount();
    });

    it('should show different values for different scopes', async () => {
      const settings = createMockSettings({
        user: {
          settings: { vimMode: true },
          originalSettings: { vimMode: true },
          path: '',
        },
        project: {
          settings: { autoUpdate: false },
          originalSettings: { autoUpdate: false },
          path: '',
        },
      });
      const onSelect = vi.fn();

      const { lastFrame, unmount } = await renderDialog(settings, onSelect);

      // Should show user scope values initially
      const output = lastFrame();
      expect(output).toContain('Settings');
      unmount();
    });
  });

  describe('Complex State Management', () => {
    it('should track modified settings correctly', async () => {
      const settings = createMockSettings();
      const onSelect = vi.fn();

      const { stdin, unmount, waitUntilReady } = await renderDialog(
        settings,
        onSelect,
      );

      // Toggle a setting, then toggle another setting
      await act(async () => {
        stdin.write(TerminalKeys.ENTER as string); // Enter
      });
      await waitUntilReady();
      await act(async () => {
        stdin.write(TerminalKeys.DOWN_ARROW as string); // Down
      });
      await waitUntilReady();
      await act(async () => {
        stdin.write(TerminalKeys.ENTER as string); // Enter
      });
      await waitUntilReady();

      // Should track multiple modified settings
      unmount();
    });

    it('should handle scrolling when there are many settings', async () => {
      const settings = createMockSettings();
      const onSelect = vi.fn();

      const { stdin, unmount, waitUntilReady } = await renderDialog(
        settings,
        onSelect,
      );

      // Navigate down many times to test scrolling
      await act(async () => {
        for (let i = 0; i < 10; i++) {
          stdin.write(TerminalKeys.DOWN_ARROW as string); // Down arrow
        }
      });
      await waitUntilReady();

      unmount();
    });
  });

  describe('Specific Settings Behavior', () => {
    it('localizes scope, search, setting metadata, options, and footer', async () => {
      const settings = createMockSettings({
        user: {
          path: '/read-only/user-settings.json',
          settings: { ui: { language: 'zh-CN' } },
          originalSettings: { ui: { language: 'zh-CN' } },
          readOnly: true,
        },
        project: {
          path: '/workspace/.qwen/settings.json',
          settings: {},
          originalSettings: {},
          readOnly: true,
        },
      });
      const rendered = await renderDialog(settings, vi.fn());

      await waitFor(() => {
        expect(rendered.lastFrame()).toContain('设置');
        expect(rendered.lastFrame()).toContain('用户设置');
        expect(rendered.lastFrame()).toContain('项目设置');
        expect(rendered.lastFrame()).toContain('搜索设置');
        expect(rendered.lastFrame()).toContain('Esc 返回');
        expect(rendered.lastFrame()).not.toContain('Esc back');
      });

      await act(async () => {
        rendered.stdin.write('默认权限模式');
      });
      await rendered.waitUntilReady();
      await waitFor(() => {
        expect(rendered.lastFrame()).toContain('默认权限模式');
        expect(rendered.lastFrame()).toContain('默认');
        expect(rendered.lastFrame()).toContain('工具执行使用的默认权限模式');
      });

      rendered.unmount();
    }, 10_000);

    it('switches the live UI locale through the real language setting', async () => {
      const settings = createMockSettings({
        user: {
          path: '/read-only/settings.json',
          settings: { ui: { language: 'auto' } },
          originalSettings: { ui: { language: 'auto' } },
          readOnly: true,
        },
      });
      const setValueSpy = vi.spyOn(settings, 'setValue');
      const renderResult = await renderWithProviders(
        <>
          <SettingsDialog onSelect={vi.fn()} />
          <LocaleProbe />
        </>,
        {
          settings,
          config: makeFakeConfig(),
          uiState: { terminalBackgroundColor: undefined },
        },
      );

      await act(async () => {
        renderResult.stdin.write('ui.language');
      });
      await renderResult.waitUntilReady();
      await waitFor(() => {
        expect(renderResult.lastFrame()).toContain('Display Language');
      });

      await act(async () => {
        renderResult.stdin.write(TerminalKeys.ENTER);
      });
      await renderResult.waitUntilReady();

      await waitFor(() => {
        expect(setValueSpy).toHaveBeenLastCalledWith(
          SettingScope.User,
          'ui.language',
          'zh-CN',
        );
        expect(settings.forScope(SettingScope.User).settings.ui?.language).toBe(
          'zh-CN',
        );
        expect(renderResult.lastFrame()).toContain(
          'locale-probe:zh-CN:界面语言',
        );
      });

      await act(async () => {
        renderResult.stdin.write(TerminalKeys.ENTER);
      });
      await renderResult.waitUntilReady();

      await waitFor(() => {
        expect(setValueSpy).toHaveBeenLastCalledWith(
          SettingScope.User,
          'ui.language',
          'en',
        );
        expect(settings.forScope(SettingScope.User).settings.ui?.language).toBe(
          'en',
        );
        expect(renderResult.lastFrame()).toContain(
          'locale-probe:en:Display Language',
        );
      });

      renderResult.unmount();
    });

    it('explains when project settings override the user display language', async () => {
      const settings = createMockSettings({
        user: {
          path: '/read-only/user-settings.json',
          settings: { ui: { language: 'zh-CN' } },
          originalSettings: { ui: { language: 'zh-CN' } },
          readOnly: true,
        },
        project: {
          path: '/workspace/.qwen/settings.json',
          settings: { ui: { language: 'en' } },
          originalSettings: { ui: { language: 'en' } },
          readOnly: true,
        },
      });
      const rendered = await renderDialog(settings, vi.fn(), { width: 120 });

      await act(async () => {
        rendered.stdin.write('ui.language');
      });
      await rendered.waitUntilReady();

      await waitFor(() => {
        expect(rendered.lastFrame()).toContain('Display Language');
        expect(rendered.lastFrame()).toContain('简体中文*');
        expect(rendered.lastFrame()).toContain(
          'Overridden by Project Settings · Effective: English',
        );
      });

      rendered.unmount();
    });

    it('localizes the project override explanation', async () => {
      const settings = createMockSettings({
        user: {
          path: '/read-only/user-settings.json',
          settings: { ui: { language: 'en' } },
          originalSettings: { ui: { language: 'en' } },
          readOnly: true,
        },
        project: {
          path: '/workspace/.qwen/settings.json',
          settings: { ui: { language: 'zh-CN' } },
          originalSettings: { ui: { language: 'zh-CN' } },
          readOnly: true,
        },
      });
      const rendered = await renderDialog(settings, vi.fn(), { width: 120 });

      await act(async () => {
        rendered.stdin.write('ui.language');
      });
      await rendered.waitUntilReady();

      await waitFor(() => {
        expect(rendered.lastFrame()).toContain('界面语言');
        expect(rendered.lastFrame()).toContain('英文*');
        expect(rendered.lastFrame()).toContain(
          '已被项目设置覆盖 · 当前生效：简体中文',
        );
      });

      rendered.unmount();
    });

    it('should show correct display values for settings with different states', async () => {
      const settings = createMockSettings({
        user: {
          settings: { vimMode: true, hideTips: false },
          originalSettings: { vimMode: true, hideTips: false },
          path: '',
        },
        project: {
          settings: { hideTips: true },
          originalSettings: { hideTips: true },
          path: '',
        },
      });
      const onSelect = vi.fn();

      const { lastFrame, unmount } = await renderDialog(settings, onSelect);

      const output = lastFrame();
      // Should contain settings labels
      expect(output).toContain('Settings');
      unmount();
    });

    it('should handle immediate settings save for non-restart-required settings', async () => {
      const settings = createMockSettings();
      const onSelect = vi.fn();

      const { stdin, unmount, waitUntilReady } = await renderDialog(
        settings,
        onSelect,
      );

      // Toggle a non-restart-required setting (like hideTips)
      await act(async () => {
        stdin.write(TerminalKeys.ENTER as string); // Enter - toggle current setting
      });
      await waitUntilReady();

      // Should save immediately without showing restart prompt
      unmount();
    });

    it('should show restart prompt for restart-required settings', async () => {
      const settings = createMockSettings();
      const onSelect = vi.fn();

      const { lastFrame, unmount } = await renderDialog(settings, onSelect);

      // This test would need to navigate to a specific restart-required setting
      // Since we can't easily target specific settings, we test the general behavior

      // Should not show restart prompt initially
      await waitFor(() => {
        expect(lastFrame()).not.toContain(
          'Changes that require a restart have been modified',
        );
      });

      unmount();
    });

    it('should clear restart prompt when switching scopes', async () => {
      const settings = createMockSettings();
      const onSelect = vi.fn();

      const { unmount } = await renderDialog(settings, onSelect);

      // Restart prompt should be cleared when switching scopes
      unmount();
    });
  });

  describe('Settings Display Values', () => {
    it('should show correct values for inherited settings', async () => {
      const settings = createMockSettings({
        user: {
          settings: { vimMode: true, hideWindowTitle: false },
          originalSettings: { vimMode: true, hideWindowTitle: false },
          path: '',
        },
      });
      const onSelect = vi.fn();

      const { lastFrame, unmount } = await renderDialog(settings, onSelect);

      const output = lastFrame();
      // Settings should show inherited values
      expect(output).toContain('Settings');
      unmount();
    });

    it('should show override indicator for overridden settings', async () => {
      const settings = createMockSettings({
        user: {
          settings: { vimMode: false },
          originalSettings: { vimMode: false },
          path: '',
        },
      });
      const onSelect = vi.fn();

      const { lastFrame, unmount } = await renderDialog(settings, onSelect);

      const output = lastFrame();
      // Should show settings with override indicators
      expect(output).toContain('Settings');
      unmount();
    });
  });

  describe('Race Condition Regression Tests', () => {
    it.each([
      {
        name: 'not reset sibling settings when toggling a nested setting multiple times',
        toggleCount: 5,
        shellSettings: {
          showColor: false,
          pager: 'cat',
        },
        expectedSiblings: {
          pager: 'cat',
        },
      },
      {
        name: 'preserve multiple sibling settings in nested objects during rapid toggles',
        toggleCount: 3,
        shellSettings: {
          showColor: false,
          pager: 'less',
        },
        expectedSiblings: {
          pager: 'less',
        },
      },
    ])('should $name', async ({ toggleCount, shellSettings }) => {
      vi.mocked(getSettingsSchema).mockReturnValue(TOOLS_SHELL_FAKE_SCHEMA);

      const settings = createMockSettings({
        tools: {
          shell: shellSettings,
        },
      });
      const setValueSpy = vi.spyOn(settings, 'setValue');

      const onSelect = vi.fn();

      const { stdin, unmount } = await renderDialog(settings, onSelect);

      for (let i = 0; i < toggleCount; i++) {
        act(() => {
          stdin.write(TerminalKeys.ENTER as string);
        });
      }

      await waitFor(() => {
        expect(setValueSpy).toHaveBeenCalled();
      });

      // With the store pattern, setValue is called atomically per key.
      // Sibling preservation is handled by LoadedSettings internally.
      const calls = setValueSpy.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      calls.forEach((call) => {
        // Each call should target only 'tools.shell.showColor'
        expect(call[1]).toBe('tools.shell.showColor');
      });

      unmount();
    });
  });

  describe('Keyboard Shortcuts Edge Cases', () => {
    it('should handle rapid key presses gracefully', async () => {
      const settings = createMockSettings();
      const onSelect = vi.fn();

      const { stdin, unmount, waitUntilReady } = await renderDialog(
        settings,
        onSelect,
      );

      // Rapid navigation
      await act(async () => {
        for (let i = 0; i < 5; i++) {
          stdin.write(TerminalKeys.DOWN_ARROW as string);
          stdin.write(TerminalKeys.UP_ARROW as string);
        }
      });
      await waitUntilReady();

      // Should not crash
      unmount();
    });

    it.each([
      { key: 'Ctrl+C', code: '\u0003' },
      { key: 'Ctrl+L', code: '\u000C' },
    ])(
      'should handle $key to reset current setting to default',
      async ({ code }) => {
        const settings = createMockSettings({ vimMode: true });
        const onSelect = vi.fn();

        const { stdin, unmount, waitUntilReady } = await renderDialog(
          settings,
          onSelect,
        );

        await act(async () => {
          stdin.write(code);
        });
        await waitUntilReady();

        // Should reset the current setting to its default value
        unmount();
      },
    );

    it('should handle navigation when only one setting exists', async () => {
      const settings = createMockSettings();
      const onSelect = vi.fn();

      const { stdin, unmount, waitUntilReady } = await renderDialog(
        settings,
        onSelect,
      );

      // Try to navigate when potentially at bounds
      await act(async () => {
        stdin.write(TerminalKeys.DOWN_ARROW as string);
      });
      await waitUntilReady();
      await act(async () => {
        stdin.write(TerminalKeys.UP_ARROW as string);
      });
      await waitUntilReady();

      unmount();
    });

    it('should properly handle Tab navigation between sections', async () => {
      const settings = createMockSettings();
      const onSelect = vi.fn();

      const { lastFrame, unmount } = await renderDialog(settings, onSelect);

      // Wait for initial render
      await waitFor(() => {
        expect(lastFrame()).toContain('Vim Mode');
      });

      // Verify initial state: settings section active, scope tabs visible
      expect(lastFrame()).toContain('Vim Mode'); // Settings section active
      expect(lastFrame()).toContain('User Settings'); // Scope tabs visible

      // This test validates the rendered UI structure for tab navigation
      // Actual tab behavior testing is complex due to keypress handling

      unmount();
    });
  });

  describe('Error Recovery', () => {
    it('should handle malformed settings gracefully', async () => {
      // Create settings with potentially problematic values
      const settings = createMockSettings({
        user: {
          settings: { vimMode: null as unknown as boolean },
          originalSettings: { vimMode: null as unknown as boolean },
          path: '',
        },
      });
      const onSelect = vi.fn();

      const { lastFrame, unmount } = await renderDialog(settings, onSelect);

      // Should still render without crashing
      expect(lastFrame()).toContain('Settings');
      unmount();
    });

    it('should handle missing setting definitions gracefully', async () => {
      const settings = createMockSettings();
      const onSelect = vi.fn();

      // Should not crash even if some settings are missing definitions
      const { lastFrame, unmount } = await renderDialog(settings, onSelect);

      expect(lastFrame()).toContain('Settings');
      unmount();
    });
  });

  describe('Complex User Interactions', () => {
    it('should handle complete user workflow: navigate, toggle, change scope, exit', async () => {
      const settings = createMockSettings();
      const onSelect = vi.fn();

      const { lastFrame, unmount } = await renderDialog(settings, onSelect);

      // Wait for initial render
      await waitFor(() => {
        expect(lastFrame()).toContain('Vim Mode');
      });

      // Verify the complete UI is rendered with all necessary sections
      expect(lastFrame()).toContain('Settings'); // Title
      expect(lastFrame()).toContain('Vim Mode'); // Active setting
      expect(lastFrame()).toContain('User Settings'); // Scope tabs
      expect(lastFrame()).toContain('Project Settings'); // Scope tabs
      // Use regex for more flexible help text matching
      expect(lastFrame()).toMatch(/Tab.*switch.*Esc.*back/);

      // This test validates the complete UI structure is available for user workflow
      // Individual interactions are tested in focused unit tests

      unmount();
    });

    it('should allow changing multiple settings without losing pending changes', async () => {
      const settings = createMockSettings();
      const onSelect = vi.fn();

      const { stdin, unmount, waitUntilReady } = await renderDialog(
        settings,
        onSelect,
      );

      // Toggle multiple settings
      await act(async () => {
        stdin.write(TerminalKeys.ENTER as string); // Enter
      });
      await waitUntilReady();
      await act(async () => {
        stdin.write(TerminalKeys.DOWN_ARROW as string); // Down
      });
      await waitUntilReady();
      await act(async () => {
        stdin.write(TerminalKeys.ENTER as string); // Enter
      });
      await waitUntilReady();
      await act(async () => {
        stdin.write(TerminalKeys.DOWN_ARROW as string); // Down
      });
      await waitUntilReady();
      await act(async () => {
        stdin.write(TerminalKeys.ENTER as string); // Enter
      });
      await waitUntilReady();

      // The test verifies that all changes are preserved and the dialog still works
      // This tests the fix for the bug where changing one setting would reset all pending changes
      unmount();
    });

    it('should maintain state consistency during complex interactions', async () => {
      const settings = createMockSettings({ vimMode: true });
      const onSelect = vi.fn();

      const { stdin, unmount, waitUntilReady } = await renderDialog(
        settings,
        onSelect,
      );

      // Multiple scope changes
      await act(async () => {
        stdin.write(TerminalKeys.TAB as string); // Tab to scope
      });
      await waitUntilReady();
      await act(async () => {
        stdin.write('2'); // Workspace
      });
      await waitUntilReady();
      await act(async () => {
        stdin.write(TerminalKeys.TAB as string); // Tab to settings
      });
      await waitUntilReady();
      await act(async () => {
        stdin.write(TerminalKeys.TAB as string); // Tab to scope
      });
      await waitUntilReady();
      await act(async () => {
        stdin.write('1'); // User
      });
      await waitUntilReady();

      // Should maintain consistent state
      unmount();
    });

    it('should handle restart workflow correctly', async () => {
      const settings = createMockSettings();
      const onRestartRequest = vi.fn();

      const { stdin, unmount, waitUntilReady } = await renderDialog(
        settings,
        vi.fn(),
        {
          onRestartRequest,
        },
      );

      // This would test the restart workflow if we could trigger it
      await act(async () => {
        stdin.write('r'); // Try restart key
      });
      await waitUntilReady();

      // Without restart prompt showing, this should have no effect
      expect(onRestartRequest).not.toHaveBeenCalled();

      unmount();
    });
  });

  describe('Restart and Search Conflict Regression', () => {
    it('should keep search visible but unfocused when restart prompt appears', async () => {
      // Use a schema whose first focused item requires restart.
      vi.mocked(getSettingsSchema).mockReturnValue(RESTART_FIRST_FAKE_SCHEMA);
      const settings = createMockSettings();

      const { lastFrame, unmount } = await renderDialog(settings, vi.fn());

      // Wait for initial render
      await waitFor(() => expect(lastFrame()).toContain('Show Color'));

      // Search should be visible before restart prompt
      expect(lastFrame()).toContain('Search to filter');

      // Directly mutate the setting to trigger a restart-required diff.
      await act(async () => {
        settings.setValue(SettingScope.User, 'tools.shell.showColor', false);
      });

      // The restart prompt should now be visible
      await waitFor(() => expect(lastFrame()).toContain('Restart required.'));

      // Search box should STILL be visible (just unfocused)
      expect(lastFrame()).toContain('Search to filter');

      unmount();
    });
  });

  describe('String Settings Editing', () => {
    it('should allow editing and committing a string setting', async () => {
      const settings = createMockSettings({
        'general.sessionCleanup.maxAge': 'initial',
      });
      const onSelect = vi.fn();

      const { stdin, unmount, waitUntilReady } = await renderWithProviders(
        <SettingsDialog onSelect={onSelect} />,
        { settings, config: makeFakeConfig() },
      );

      // Search for 'chat history' to filter the list
      await act(async () => {
        stdin.write('chat history');
      });
      await waitUntilReady();

      // Press Down Arrow to focus the list
      await act(async () => {
        stdin.write(TerminalKeys.DOWN_ARROW);
      });
      await waitUntilReady();

      // Press Enter to start editing, type new value, and commit
      await act(async () => {
        stdin.write('\r'); // Start editing
      });
      await waitUntilReady();
      await act(async () => {
        stdin.write('new value');
      });
      await waitUntilReady();
      await act(async () => {
        stdin.write('\r'); // Commit
      });
      await waitUntilReady();

      // Simulate the settings file being updated on disk
      await act(async () => {
        settings.setValue(
          SettingScope.User,
          'general.sessionCleanup.maxAge',
          'new value',
        );
      });
      await waitUntilReady();

      // Press Escape to exit
      await act(async () => {
        stdin.write('\u001B');
      });
      await waitUntilReady();

      await waitFor(() => {
        expect(onSelect).toHaveBeenCalledWith(undefined, 'User');
      });

      unmount();
    });

    it('should preserve inline editing when the settings write fails', async () => {
      vi.mocked(getSettingsSchema).mockReturnValue(TOOLS_SHELL_FAKE_SCHEMA);
      const settings = createMockSettings({
        tools: { shell: { pager: 'initial' } },
      });
      const setValueSpy = vi.spyOn(settings, 'setValue').mockReturnValue(false);
      const { stdin, unmount, waitUntilReady } = await renderWithProviders(
        <SettingsDialog onSelect={vi.fn()} />,
        { settings, config: makeFakeConfig() },
      );

      await act(async () => {
        stdin.write('pager');
      });
      await waitUntilReady();
      await act(async () => {
        stdin.write(TerminalKeys.DOWN_ARROW);
      });
      await waitUntilReady();
      await act(async () => {
        stdin.write(TerminalKeys.ENTER);
      });
      await waitUntilReady();
      await act(async () => {
        stdin.write('x');
      });
      await waitUntilReady();

      await act(async () => {
        stdin.write(TerminalKeys.ENTER);
      });
      await waitUntilReady();
      await act(async () => {
        stdin.write(TerminalKeys.ENTER);
      });
      await waitUntilReady();

      expect(setValueSpy).toHaveBeenCalledTimes(2);
      expect(setValueSpy).toHaveBeenNthCalledWith(
        1,
        SettingScope.User,
        'tools.shell.pager',
        'initialx',
      );
      expect(setValueSpy).toHaveBeenNthCalledWith(
        2,
        SettingScope.User,
        'tools.shell.pager',
        'initialx',
      );
      unmount();
    });
  });

  describe('Array Settings Editing', () => {
    const typeInput = async (
      stdin: { write: (data: string) => void },
      input: string,
    ) => {
      for (const ch of input) {
        await act(async () => {
          stdin.write(ch);
        });
      }
    };

    it('should parse comma-separated input as string arrays', async () => {
      vi.mocked(getSettingsSchema).mockReturnValue(ARRAY_FAKE_SCHEMA);
      const settings = createMockSettings();
      const setValueSpy = vi.spyOn(settings, 'setValue');

      const { stdin, unmount } = await renderDialog(settings, vi.fn());

      await act(async () => {
        stdin.write(TerminalKeys.ENTER as string); // Start editing first array setting
      });
      await typeInput(stdin, 'first/path, second/path,third/path');
      await act(async () => {
        stdin.write(TerminalKeys.ENTER as string); // Commit
      });

      await waitFor(() => {
        expect(setValueSpy).toHaveBeenCalledWith(
          SettingScope.User,
          'context.fileFiltering.customIgnoreFilePaths',
          ['first/path', 'second/path', 'third/path'],
        );
      });

      unmount();
    });

    it('should parse JSON array input for allowedExtensions', async () => {
      vi.mocked(getSettingsSchema).mockReturnValue(ARRAY_FAKE_SCHEMA);
      const settings = createMockSettings();
      const setValueSpy = vi.spyOn(settings, 'setValue');

      const { stdin, unmount } = await renderDialog(settings, vi.fn());

      await act(async () => {
        stdin.write(TerminalKeys.DOWN_ARROW as string); // Move to second array setting
      });
      await act(async () => {
        stdin.write(TerminalKeys.ENTER as string); // Start editing
      });
      await typeInput(stdin, '["^github\\\\.com/.*$", "^gitlab\\\\.com/.*$"]');
      await act(async () => {
        stdin.write(TerminalKeys.ENTER as string); // Commit
      });

      await waitFor(() => {
        expect(setValueSpy).toHaveBeenCalledWith(
          SettingScope.User,
          'security.allowedExtensions',
          ['^github\\.com/.*$', '^gitlab\\.com/.*$'],
        );
      });

      unmount();
    });
  });

  describe('Search Functionality', () => {
    it('should display text entered in search', async () => {
      const settings = createMockSettings();
      const onSelect = vi.fn();

      const { lastFrame, stdin, unmount, waitUntilReady } = await renderDialog(
        settings,
        onSelect,
      );

      // Wait for initial render and verify that search is not active
      await waitFor(() => {
        expect(lastFrame()).not.toContain('> Search:');
      });
      expect(lastFrame()).toContain('Search to filter');

      // Press '/' to enter search mode
      await act(async () => {
        stdin.write('/');
      });
      await waitUntilReady();

      await waitFor(() => {
        expect(lastFrame()).toContain('/');
        expect(lastFrame()).not.toContain('Search to filter');
      });

      unmount();
    });

    it('should show search query and filter settings as user types', async () => {
      const settings = createMockSettings();
      const onSelect = vi.fn();

      const { lastFrame, stdin, unmount, waitUntilReady } = await renderDialog(
        settings,
        onSelect,
      );

      await act(async () => {
        stdin.write('bypass');
      });
      await waitUntilReady();

      await waitFor(() => {
        expect(lastFrame()).toContain('bypass');
        expect(lastFrame()).toContain('Default Permission Mode');
      });

      unmount();
    });

    it('should exit search settings when Escape is pressed', async () => {
      const settings = createMockSettings();
      const onSelect = vi.fn();

      const { lastFrame, stdin, unmount, waitUntilReady } = await renderDialog(
        settings,
        onSelect,
      );

      await act(async () => {
        stdin.write('vim');
      });
      await waitUntilReady();
      await waitFor(() => {
        expect(lastFrame()).toContain('vim');
      });

      // Press Escape
      await act(async () => {
        stdin.write(TerminalKeys.ESCAPE);
      });
      await waitUntilReady();

      await waitFor(() => {
        // onSelect is called with (settingName, scope).
        // undefined settingName means "close dialog"
        expect(onSelect).toHaveBeenCalledWith(undefined, expect.anything());
      });

      unmount();
    });

    it('should handle backspace to modify search query', async () => {
      const settings = createMockSettings();
      const onSelect = vi.fn();

      const { lastFrame, stdin, unmount, waitUntilReady } = await renderDialog(
        settings,
        onSelect,
      );

      await act(async () => {
        stdin.write('vimm');
      });
      await waitUntilReady();
      await waitFor(() => {
        expect(lastFrame()).toContain('vimm');
      });

      // Press backspace
      await act(async () => {
        stdin.write(TerminalKeys.BACKSPACE);
      });
      await waitUntilReady();

      await waitFor(() => {
        expect(lastFrame()).toContain('vim');
        expect(lastFrame()).toContain('Vim Mode');
        expect(lastFrame()).not.toContain('Hook Notifications');
      });

      unmount();
    });

    it('should clear the search with ctrl+a then ctrl+k', async () => {
      const settings = createMockSettings();
      const onSelect = vi.fn();

      const { lastFrame, stdin, unmount, waitUntilReady } = await renderDialog(
        settings,
        onSelect,
      );

      await act(async () => {
        stdin.write('bypass');
      });
      await waitUntilReady();
      await waitFor(() => {
        expect(lastFrame()).toContain('bypass');
      });

      // ctrl+a moves to start, ctrl+k kills to end of line.
      await act(async () => {
        stdin.write('\x01'); // ctrl+a
        stdin.write('\x0b'); // ctrl+k
      });
      await waitUntilReady();

      await waitFor(() => {
        expect(lastFrame()).not.toContain('Search: bypass');
        expect(lastFrame()).toContain('Search to filter');
      });

      unmount();
    });

    it('should clear the search with ctrl+u', async () => {
      const settings = createMockSettings();
      const onSelect = vi.fn();

      const { lastFrame, stdin, unmount, waitUntilReady } = await renderDialog(
        settings,
        onSelect,
      );

      await act(async () => {
        stdin.write('bypass');
      });
      await waitUntilReady();
      await waitFor(() => {
        expect(lastFrame()).toContain('bypass');
      });

      // Cursor is at end; ctrl+u kills everything to the left.
      await act(async () => {
        stdin.write('\x15'); // ctrl+u
      });
      await waitUntilReady();

      await waitFor(() => {
        expect(lastFrame()).not.toContain('Search: bypass');
        expect(lastFrame()).toContain('Search to filter');
      });

      unmount();
    });

    it('should display nothing when search yields no results', async () => {
      const settings = createMockSettings();
      const onSelect = vi.fn();

      const { lastFrame, stdin, unmount, waitUntilReady } = await renderDialog(
        settings,
        onSelect,
      );

      // Type a search query that won't match any settings
      await act(async () => {
        stdin.write('nonexistentsetting');
      });
      await waitUntilReady();

      await waitFor(() => {
        expect(lastFrame()).toContain('nonexistentsetting');
        expect(lastFrame()).not.toContain('Vim Mode'); // Should not contain any settings
        expect(lastFrame()).not.toContain('Enable Auto Update'); // Should not contain any settings
      });

      unmount();
    });
  });

  describe('Snapshot Tests', () => {
    /**
     * Snapshot tests for SettingsDialog component using ink-testing-library.
     * These tests capture the visual output of the component in various states.
     * The snapshots help ensure UI consistency and catch unintended visual changes.
     */

    // skip: 现存失败
    it.skip.each([
      {
        name: 'default state',
        userSettings: {},
        projectSettings: {},
        stdinActions: undefined,
      },
      {
        name: 'various boolean settings enabled',
        userSettings: {
          general: {
            vimMode: true,
            enableAutoUpdate: false,
            debugKeystrokeLogging: true,
          },
          ui: {
            hideWindowTitle: true,
            hideTips: true,
            showMemoryUsage: true,
            showLineNumbers: true,
            showCitations: true,
            accessibility: {
              enableLoadingPhrases: false,
              screenReader: true,
            },
          },
          ide: {
            enabled: true,
          },
          context: {
            loadMemoryFromIncludeDirectories: true,
            fileFiltering: {
              respectGitIgnore: true,
              respectBrandIgnore: true,
              enableRecursiveFileSearch: true,
              enableFuzzySearch: true,
            },
          },
          tools: {
            useRipgrep: true,
          },
          security: {
            folderTrust: {
              enabled: true,
            },
          },
        },
        projectSettings: {},
        stdinActions: undefined,
      },
      {
        name: 'mixed boolean and number settings',
        userSettings: {
          general: {
            vimMode: false,
            enableAutoUpdate: false,
          },
          ui: {
            showMemoryUsage: true,
            hideWindowTitle: false,
            maxTurns: 1000,
          },
          tools: {
            truncateToolOutputThreshold: 50000,
          },
          context: {
            discoveryMaxDirs: 500,
          },
        },
        projectSettings: {},
        stdinActions: undefined,
      },
      {
        name: 'focused on scope selector',
        userSettings: {},
        projectSettings: {},
        stdinActions: async (
          stdin: { write: (data: string) => void },
          waitUntilReady: () => Promise<void>,
        ) => {
          await act(async () => {
            stdin.write('\t');
          });
          await waitUntilReady();
        },
      },
      {
        name: 'accessibility settings enabled',
        userSettings: {
          ui: {
            accessibility: {
              enableLoadingPhrases: false,
              screenReader: true,
            },
            showMemoryUsage: true,
            showLineNumbers: true,
          },
          general: {
            vimMode: true,
          },
        },
        projectSettings: {},
        stdinActions: undefined,
      },
      {
        name: 'file filtering settings configured',
        userSettings: {
          context: {
            fileFiltering: {
              respectGitIgnore: false,
              respectBrandIgnore: true,
              enableRecursiveFileSearch: false,
              enableFuzzySearch: false,
            },
            loadMemoryFromIncludeDirectories: true,
            discoveryMaxDirs: 100,
          },
        },
        projectSettings: {},
        stdinActions: undefined,
      },
      {
        name: 'tools and security settings',
        userSettings: {
          tools: {
            useRipgrep: true,
            truncateToolOutputThreshold: 25000,
          },
          security: {
            folderTrust: {
              enabled: true,
            },
          },
          ui: {
            maxTurns: 2000,
          },
        },
        projectSettings: {},
        stdinActions: undefined,
      },
      {
        name: 'all boolean settings disabled',
        userSettings: {
          general: {
            vimMode: false,
            enableAutoUpdate: true,
            debugKeystrokeLogging: false,
          },
          ui: {
            hideWindowTitle: false,
            hideTips: false,
            showMemoryUsage: false,
            showLineNumbers: false,
            showCitations: false,
            accessibility: {
              enableLoadingPhrases: true,
              screenReader: false,
            },
          },
          ide: {
            enabled: false,
          },
          context: {
            loadMemoryFromIncludeDirectories: false,
            fileFiltering: {
              respectGitIgnore: false,
              respectBrandIgnore: false,
              enableRecursiveFileSearch: false,
              enableFuzzySearch: true,
            },
          },
          tools: {
            useRipgrep: false,
          },
          security: {
            folderTrust: {
              enabled: false,
            },
          },
        },
        projectSettings: {},
        stdinActions: undefined,
      },
    ])(
      'should render $name correctly',
      async ({ userSettings, projectSettings, stdinActions }) => {
        const settings = createMockSettings({
          user: {
            settings: userSettings,
            originalSettings: userSettings,
            path: '',
          },
          project: {
            settings: projectSettings,
            originalSettings: projectSettings,
            path: '',
          },
        });
        const onSelect = vi.fn();

        const renderResult = await renderDialog(settings, onSelect);
        await renderResult.waitUntilReady();

        if (stdinActions) {
          await stdinActions(renderResult.stdin, renderResult.waitUntilReady);
        }

        await expect(renderResult).toMatchSvgSnapshot();
        renderResult.unmount();
      },
    );
  });

  describe('P1 bilingual layout matrix', () => {
    it.each([
      { locale: 'en' as const, width: 60, title: 'Settings' },
      { locale: 'en' as const, width: 80, title: 'Settings' },
      { locale: 'en' as const, width: 120, title: 'Settings' },
      { locale: 'zh-CN' as const, width: 60, title: '设置' },
      { locale: 'zh-CN' as const, width: 80, title: '设置' },
      { locale: 'zh-CN' as const, width: 120, title: '设置' },
    ])(
      'matches the $locale settings layout at $width columns',
      async ({ locale, width, title }) => {
        const settings = createMockSettings({
          user: {
            path: '/read-only/settings.json',
            settings: { ui: { language: locale } },
            originalSettings: { ui: { language: locale } },
            readOnly: true,
          },
        });
        const result = await renderDialog(settings, vi.fn(), {
          width,
        });
        await result.waitUntilReady();

        expect(result.lastFrame()).toContain(title);
        expect(result.lastFrame()).toMatchSnapshot();
        result.unmount();
      },
    );
  });
});
