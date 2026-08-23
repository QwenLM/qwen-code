/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  // Schema utilities
  getSettingDefinition,
  requiresRestart,
  getDefaultValue,
  getRestartRequiredSettings,
  getEffectiveValue,
  getAllSettingKeys,
  getDialogSettingKeys,
  WORKSPACE_RESTRICTED_SETTING_KEYS,
  // Business logic utilities
  TEST_ONLY,
  settingExistsInScope,
  setPendingSettingValue,
  getRestartRequiredFromModified,
  getDisplayValue,
  isDefaultValue,
  setNestedPropertySafe,
  setNestedPropertyForce,
  validateSettingValue,
} from './settingsUtils.js';
import {
  getSettingsSchema,
  type SettingDefinition,
  type Settings,
  type SettingsSchema,
  type SettingsSchemaType,
} from './settingsSchema.js';

vi.mock('./settingsSchema.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./settingsSchema.js')>();
  return {
    ...original,
    getSettingsSchema: vi.fn(),
  };
});

function makeMockSettings(settings: unknown): Settings {
  return settings as Settings;
}

describe('SettingsUtils', () => {
  beforeEach(() => {
    const SETTINGS_SCHEMA = {
      mcpServers: {
        type: 'object',
        label: 'MCP Servers',
        category: 'Advanced',
        requiresRestart: true,
        default: {} as Record<string, string>,
        description: 'Configuration for MCP servers.',
        showInDialog: false,
      },
      test: {
        type: 'string',
        label: 'Test',
        category: 'Basic',
        requiresRestart: false,
        default: 'hello',
        description: 'A test field',
        showInDialog: true,
      },
      numberWithMinimum: {
        type: 'number',
        label: 'Number With Minimum',
        category: 'Basic',
        requiresRestart: false,
        default: 0,
        minimum: 0,
        description: 'A number field with a minimum.',
        showInDialog: true,
      },
      numberWithMaximum: {
        type: 'number',
        label: 'Number With Maximum',
        category: 'Basic',
        requiresRestart: false,
        default: 10,
        maximum: 10,
        description: 'A number field with a maximum.',
        showInDialog: true,
      },
      integerWithBounds: {
        type: 'integer',
        label: 'Integer With Bounds',
        category: 'Basic',
        requiresRestart: false,
        default: 1,
        minimum: 1,
        maximum: 10,
        description: 'An integer field with bounds.',
        showInDialog: true,
      },
      advanced: {
        type: 'object',
        label: 'Advanced',
        category: 'Advanced',
        requiresRestart: true,
        default: {},
        description: 'Advanced settings for power users.',
        showInDialog: false,
      },
      ui: {
        type: 'object',
        label: 'UI',
        category: 'UI',
        requiresRestart: false,
        default: {},
        description: 'User interface settings.',
        showInDialog: false,
        properties: {
          theme: {
            type: 'string',
            label: 'Theme',
            category: 'UI',
            requiresRestart: false,
            default: undefined as string | undefined,
            description: 'The color theme for the UI.',
            showInDialog: false,
          },
          requiresRestart: {
            type: 'boolean',
            label: 'Requires Restart',
            category: 'UI',
            default: false,
            requiresRestart: true,
            showInDialog: true,
          },
          accessibility: {
            type: 'object',
            label: 'Accessibility',
            category: 'UI',
            requiresRestart: true,
            default: {},
            description: 'Accessibility settings.',
            showInDialog: false,
            properties: {
              enableLoadingPhrases: {
                type: 'boolean',
                label: 'Disable Loading Phrases',
                category: 'UI',
                requiresRestart: true,
                default: false,
                description: 'Disable loading phrases for accessibility',
                showInDialog: true,
              },
            },
          },
        },
      },
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
              pager: {
                type: 'string',
                label: 'Pager',
                category: 'Tools',
                requiresRestart: false,
                default: 'less',
                description: 'The pager to use for long output.',
                showInDialog: true,
              },
            },
          },
        },
      },
    } as const satisfies SettingsSchema;

    vi.mocked(getSettingsSchema).mockReturnValue(
      SETTINGS_SCHEMA as unknown as SettingsSchemaType,
    );
  });
  afterEach(() => {
    TEST_ONLY.clearFlattenedSchema();
    vi.clearAllMocks();
    vi.resetAllMocks();
  });

  describe('Schema Utilities', () => {
    describe('getSettingDefinition', () => {
      it('should return definition for valid setting', () => {
        const definition = getSettingDefinition('ui.theme');
        expect(definition).toBeDefined();
        expect(definition?.label).toBe('Theme');
      });

      it('should return undefined for invalid setting', () => {
        const definition = getSettingDefinition('invalidSetting');
        expect(definition).toBeUndefined();
      });
    });

    describe('validateSettingValue', () => {
      it('accepts finite numbers at the configured minimum', () => {
        const definition = getSettingDefinition('numberWithMinimum');
        expect(definition).toBeDefined();

        expect(validateSettingValue(definition!, 0)).toBeUndefined();
        expect(validateSettingValue(definition!, 1)).toBeUndefined();
      });

      it('rejects numbers below the configured minimum', () => {
        const definition = getSettingDefinition('numberWithMinimum');
        expect(definition).toBeDefined();

        expect(validateSettingValue(definition!, -1)).toBe(
          'Value must be >= 0',
        );
      });

      it('rejects numbers above the configured maximum', () => {
        const definition = getSettingDefinition('numberWithMaximum');
        expect(definition).toBeDefined();

        expect(validateSettingValue(definition!, 11)).toBe(
          'Value must be <= 10',
        );
      });

      it('validates integer settings', () => {
        const definition = getSettingDefinition('integerWithBounds');
        expect(definition).toBeDefined();

        expect(validateSettingValue(definition!, 1)).toBeUndefined();
        expect(validateSettingValue(definition!, 10)).toBeUndefined();
        expect(validateSettingValue(definition!, 1.5)).toBe(
          'Value must be an integer',
        );
        expect(validateSettingValue(definition!, 0)).toBe('Value must be >= 1');
        expect(validateSettingValue(definition!, 11)).toBe(
          'Value must be <= 10',
        );
      });
    });

    describe('requiresRestart', () => {
      it('should return true for settings that require restart', () => {
        expect(requiresRestart('ui.requiresRestart')).toBe(true);
      });

      it('should return false for settings that do not require restart', () => {
        expect(requiresRestart('ui.theme')).toBe(false);
      });

      it('should return false for invalid settings', () => {
        expect(requiresRestart('invalidSetting')).toBe(false);
      });
    });

    describe('getDefaultValue', () => {
      it('should return correct default values', () => {
        expect(getDefaultValue('test')).toBe('hello');
        expect(getDefaultValue('ui.requiresRestart')).toBe(false);
      });

      it('should return undefined for invalid settings', () => {
        expect(getDefaultValue('invalidSetting')).toBeUndefined();
      });
    });

    describe('getRestartRequiredSettings', () => {
      it('should return all settings that require restart', () => {
        const restartSettings = getRestartRequiredSettings();
        expect(restartSettings).toContain('mcpServers');
        expect(restartSettings).toContain('ui.requiresRestart');
      });
    });

    describe('getEffectiveValue', () => {
      it('should return value from settings when set', () => {
        const settings = makeMockSettings({ ui: { requiresRestart: true } });
        const mergedSettings = makeMockSettings({
          ui: { requiresRestart: false },
        });

        const value = getEffectiveValue(
          'ui.requiresRestart',
          settings,
          mergedSettings,
        );
        expect(value).toBe(true);
      });

      it('should return value from merged settings when not set in current scope', () => {
        const settings = makeMockSettings({});
        const mergedSettings = makeMockSettings({
          ui: { requiresRestart: true },
        });

        const value = getEffectiveValue(
          'ui.requiresRestart',
          settings,
          mergedSettings,
        );
        expect(value).toBe(true);
      });

      it('should return default value when not set anywhere', () => {
        const settings = makeMockSettings({});
        const mergedSettings = makeMockSettings({});

        const value = getEffectiveValue(
          'ui.requiresRestart',
          settings,
          mergedSettings,
        );
        expect(value).toBe(false); // default value
      });

      it('should handle nested settings correctly', () => {
        const settings = makeMockSettings({
          ui: { accessibility: { enableLoadingPhrases: true } },
        });
        const mergedSettings = makeMockSettings({
          ui: { accessibility: { enableLoadingPhrases: false } },
        });

        const value = getEffectiveValue(
          'ui.accessibility.enableLoadingPhrases',
          settings,
          mergedSettings,
        );
        expect(value).toBe(true);
      });

      it('should return undefined for invalid settings', () => {
        const settings = makeMockSettings({});
        const mergedSettings = makeMockSettings({});

        const value = getEffectiveValue(
          'invalidSetting',
          settings,
          mergedSettings,
        );
        expect(value).toBeUndefined();
      });
    });

    describe('getAllSettingKeys', () => {
      it('should return all setting keys', () => {
        const keys = getAllSettingKeys();
        expect(keys).toContain('test');
        expect(keys).toContain('ui.accessibility.enableLoadingPhrases');
      });
    });

    describe('getDialogSettingKeys', () => {
      // R4-2: Workspace scope strips these before the merge, so listing them
      // there lets a user toggle a setting that silently never takes effect
      // and writes a dead entry into the repo's .qwen/settings.json.
      describe('workspace-restricted filtering', () => {
        const restrictedKey = WORKSPACE_RESTRICTED_SETTING_KEYS[0]!;
        const [section, leaf] = restrictedKey.split('.') as [string, string];

        beforeEach(() => {
          vi.mocked(getSettingsSchema).mockReturnValue({
            [section]: {
              type: 'object',
              label: section,
              category: 'General',
              requiresRestart: false,
              default: {},
              description: 'section',
              showInDialog: false,
              properties: {
                [leaf]: {
                  type: 'boolean',
                  label: leaf,
                  category: 'General',
                  requiresRestart: true,
                  default: false,
                  description: 'restricted',
                  showInDialog: true,
                },
                unrestricted: {
                  type: 'boolean',
                  label: 'Unrestricted',
                  category: 'General',
                  requiresRestart: false,
                  default: false,
                  description: 'plain',
                  showInDialog: true,
                },
              },
            },
          } as unknown as ReturnType<typeof getSettingsSchema>);
        });

        it('drops the restricted key when asked to, and nothing else', () => {
          // Guard against a vacuous pass: it must be dialog-visible first.
          expect(getDialogSettingKeys()).toContain(restrictedKey);

          const workspaceKeys = getDialogSettingKeys({
            excludeWorkspaceRestricted: true,
          });
          expect(workspaceKeys).not.toContain(restrictedKey);
          expect(workspaceKeys).toContain(`${section}.unrestricted`);
        });

        it('keeps it when the option is absent or false', () => {
          const allKeys = getDialogSettingKeys();
          expect(getDialogSettingKeys({})).toEqual(allKeys);
          expect(
            getDialogSettingKeys({ excludeWorkspaceRestricted: false }),
          ).toEqual(allKeys);
          expect(allKeys).toContain(restrictedKey);
        });
      });

      it('should return only settings marked for dialog display', () => {
        const dialogKeys = getDialogSettingKeys();

        // Should include settings marked for dialog
        expect(dialogKeys).toContain('ui.requiresRestart');

        // Should include nested settings marked for dialog
        expect(dialogKeys).toContain('ui.accessibility.enableLoadingPhrases');

        // Should NOT include settings marked as hidden
        expect(dialogKeys).not.toContain('ui.theme'); // Hidden
      });

      it('should return fewer keys than getAllSettingKeys', () => {
        const allKeys = getAllSettingKeys();
        const dialogKeys = getDialogSettingKeys();

        expect(dialogKeys.length).toBeLessThan(allKeys.length);
        expect(dialogKeys.length).toBeGreaterThan(0);
      });

      it('should handle nested settings display correctly', () => {
        vi.mocked(getSettingsSchema).mockReturnValue({
          context: {
            type: 'object',
            label: 'Context',
            category: 'Context',
            requiresRestart: false,
            default: {},
            description: 'Settings for managing context provided to the model.',
            showInDialog: false,
            properties: {
              fileFiltering: {
                type: 'object',
                label: 'File Filtering',
                category: 'Context',
                requiresRestart: true,
                default: {},
                description: 'Settings for git-aware file filtering.',
                showInDialog: false,
                properties: {
                  respectGitIgnore: {
                    type: 'boolean',
                    label: 'Respect .gitignore',
                    category: 'Context',
                    requiresRestart: true,
                    default: true,
                    description: 'Respect .gitignore files when searching',
                    showInDialog: true,
                  },
                },
              },
            },
          },
        } as unknown as SettingsSchemaType);

        // Test the specific issue with fileFiltering.respectGitIgnore
        const key = 'context.fileFiltering.respectGitIgnore';
        const initialSettings = makeMockSettings({});
        const pendingSettings = makeMockSettings({});

        // Set the nested setting to true
        const updatedPendingSettings = setPendingSettingValue(
          key,
          true,
          pendingSettings,
        );

        // Check if the setting exists in pending settings
        const existsInPending = settingExistsInScope(
          key,
          updatedPendingSettings,
        );
        expect(existsInPending).toBe(true);

        // Get the value from pending settings
        const valueFromPending = getEffectiveValue(
          key,
          updatedPendingSettings,
          {},
        );
        expect(valueFromPending).toBe(true);

        // Test getDisplayValue should show the pending change
        const displayValue = getDisplayValue(
          key,
          initialSettings,
          {},
          new Set(),
          updatedPendingSettings,
        );
        expect(displayValue).toBe('true'); // Should show true (no * since value matches default)

        // Test that modified settings also show the * indicator
        const modifiedSettings = new Set([key]);
        const displayValueWithModified = getDisplayValue(
          key,
          initialSettings,
          {},
          modifiedSettings,
          {},
        );
        expect(displayValueWithModified).toBe('true*'); // Should show true* because it's in modified settings and default is true
      });
    });
  });

  describe('Business Logic Utilities', () => {
    describe('settingExistsInScope', () => {
      it('should return true for top-level settings that exist', () => {
        const settings = makeMockSettings({ ui: { requiresRestart: true } });
        expect(settingExistsInScope('ui.requiresRestart', settings)).toBe(true);
      });

      it('should return false for top-level settings that do not exist', () => {
        const settings = makeMockSettings({});
        expect(settingExistsInScope('ui.requiresRestart', settings)).toBe(
          false,
        );
      });

      it('should return true for nested settings that exist', () => {
        const settings = makeMockSettings({
          ui: { accessibility: { enableLoadingPhrases: true } },
        });
        expect(
          settingExistsInScope(
            'ui.accessibility.enableLoadingPhrases',
            settings,
          ),
        ).toBe(true);
      });

      it('should return false for nested settings that do not exist', () => {
        const settings = makeMockSettings({});
        expect(
          settingExistsInScope(
            'ui.accessibility.enableLoadingPhrases',
            settings,
          ),
        ).toBe(false);
      });

      it('should return false when parent exists but child does not', () => {
        const settings = makeMockSettings({ ui: { accessibility: {} } });
        expect(
          settingExistsInScope(
            'ui.accessibility.enableLoadingPhrases',
            settings,
          ),
        ).toBe(false);
      });
    });

    describe('setPendingSettingValue', () => {
      it('should set top-level setting value', () => {
        const pendingSettings = makeMockSettings({});
        const result = setPendingSettingValue(
          'ui.hideWindowTitle',
          true,
          pendingSettings,
        );

        expect(result.ui?.hideWindowTitle).toBe(true);
      });

      it('should set nested setting value', () => {
        const pendingSettings = makeMockSettings({});
        const result = setPendingSettingValue(
          'ui.accessibility.enableLoadingPhrases',
          true,
          pendingSettings,
        );

        expect(result.ui?.accessibility?.enableLoadingPhrases).toBe(true);
      });

      it('should preserve existing nested settings', () => {
        const pendingSettings = makeMockSettings({
          ui: { accessibility: { enableLoadingPhrases: false } },
        });
        const result = setPendingSettingValue(
          'ui.accessibility.enableLoadingPhrases',
          true,
          pendingSettings,
        );

        expect(result.ui?.accessibility?.enableLoadingPhrases).toBe(true);
      });

      it('should not mutate original settings', () => {
        const pendingSettings = makeMockSettings({});
        setPendingSettingValue('ui.requiresRestart', true, pendingSettings);

        expect(pendingSettings).toEqual({});
      });
    });

    describe('getRestartRequiredFromModified', () => {
      it('should return only settings that require restart', () => {
        const modifiedSettings = new Set<string>([
          'ui.requiresRestart',
          'test',
        ]);
        const result = getRestartRequiredFromModified(modifiedSettings);

        expect(result).toContain('ui.requiresRestart');
        expect(result).not.toContain('test');
      });

      it('should return empty array when no settings require restart', () => {
        const modifiedSettings = new Set<string>([
          'requiresRestart',
          'hideTips',
        ]);
        const result = getRestartRequiredFromModified(modifiedSettings);

        expect(result).toEqual([]);
      });
    });

    describe('getDisplayValue', () => {
      describe('enum behavior', () => {
        enum StringEnum {
          FOO = 'foo',
          BAR = 'bar',
          BAZ = 'baz',
        }

        enum NumberEnum {
          ONE = 1,
          TWO = 2,
          THREE = 3,
        }

        const SETTING: SettingDefinition = {
          type: 'enum',
          label: 'Theme',
          options: [
            {
              value: StringEnum.FOO,
              label: 'Foo',
            },
            {
              value: StringEnum.BAR,
              label: 'Bar',
            },
            {
              value: StringEnum.BAZ,
              label: 'Baz',
            },
          ],
          category: 'UI',
          requiresRestart: false,
          default: StringEnum.BAR,
          description: 'The color theme for the UI.',
          showInDialog: false,
        };

        it('handles display of number-based enums', () => {
          vi.mocked(getSettingsSchema).mockReturnValue({
            ui: {
              properties: {
                theme: {
                  ...SETTING,
                  options: [
                    {
                      value: NumberEnum.ONE,
                      label: 'One',
                    },
                    {
                      value: NumberEnum.TWO,
                      label: 'Two',
                    },
                    {
                      value: NumberEnum.THREE,
                      label: 'Three',
                    },
                  ],
                },
              },
            },
          } as unknown as SettingsSchemaType);

          const settings = makeMockSettings({
            ui: { theme: NumberEnum.THREE },
          });
          const mergedSettings = makeMockSettings({
            ui: { theme: NumberEnum.THREE },
          });
          const modifiedSettings = new Set<string>();

          const result = getDisplayValue(
            'ui.theme',
            settings,
            mergedSettings,
            modifiedSettings,
          );

          expect(result).toBe('Three*');
        });

        it('handles default values for number-based enums', () => {
          vi.mocked(getSettingsSchema).mockReturnValue({
            ui: {
              properties: {
                theme: {
                  ...SETTING,
                  default: NumberEnum.THREE,
                  options: [
                    {
                      value: NumberEnum.ONE,
                      label: 'One',
                    },
                    {
                      value: NumberEnum.TWO,
                      label: 'Two',
                    },
                    {
                      value: NumberEnum.THREE,
                      label: 'Three',
                    },
                  ],
                },
              },
            },
          } as unknown as SettingsSchemaType);
          const modifiedSettings = new Set<string>();

          const result = getDisplayValue(
            'ui.theme',
            makeMockSettings({}),
            makeMockSettings({}),
            modifiedSettings,
          );
          expect(result).toBe('Three');
        });

        it('shows the enum display value', () => {
          vi.mocked(getSettingsSchema).mockReturnValue({
            ui: { properties: { theme: { ...SETTING } } },
          } as unknown as SettingsSchemaType);
          const settings = makeMockSettings({ ui: { theme: StringEnum.BAR } });
          const mergedSettings = makeMockSettings({
            ui: { theme: StringEnum.BAR },
          });
          const modifiedSettings = new Set<string>();

          const result = getDisplayValue(
            'ui.theme',
            settings,
            mergedSettings,
            modifiedSettings,
          );
          expect(result).toBe('Bar*');
        });

        it('passes through unknown values verbatim', () => {
          vi.mocked(getSettingsSchema).mockReturnValue({
            ui: {
              properties: {
                theme: { ...SETTING },
              },
            },
          } as unknown as SettingsSchemaType);
          const settings = makeMockSettings({ ui: { theme: 'xyz' } });
          const mergedSettings = makeMockSettings({ ui: { theme: 'xyz' } });
          const modifiedSettings = new Set<string>();

          const result = getDisplayValue(
            'ui.theme',
            settings,
            mergedSettings,
            modifiedSettings,
          );
          expect(result).toBe('xyz*');
        });

        it('shows the default value for string enums', () => {
          vi.mocked(getSettingsSchema).mockReturnValue({
            ui: {
              properties: {
                theme: { ...SETTING, default: StringEnum.BAR },
              },
            },
          } as unknown as SettingsSchemaType);
          const modifiedSettings = new Set<string>();

          const result = getDisplayValue(
            'ui.theme',
            makeMockSettings({}),
            makeMockSettings({}),
            modifiedSettings,
          );
          expect(result).toBe('Bar');
        });
      });

      it('should show value without * when setting matches default', () => {
        const settings = makeMockSettings({
          ui: { requiresRestart: false },
        }); // false matches default, so no *
        const mergedSettings = makeMockSettings({
          ui: { requiresRestart: false },
        });
        const modifiedSettings = new Set<string>();

        const result = getDisplayValue(
          'ui.requiresRestart',
          settings,
          mergedSettings,
          modifiedSettings,
        );
        expect(result).toBe('false*');
      });

      it('should show default value when setting is not in scope', () => {
        const settings = makeMockSettings({}); // no setting in scope
        const mergedSettings = makeMockSettings({
          ui: { requiresRestart: false },
        });
        const modifiedSettings = new Set<string>();

        const result = getDisplayValue(
          'ui.requiresRestart',
          settings,
          mergedSettings,
          modifiedSettings,
        );
        expect(result).toBe('false'); // shows default value
      });

      it('should show value with * when changed from default', () => {
        const settings = makeMockSettings({ ui: { requiresRestart: true } }); // true is different from default (false)
        const mergedSettings = makeMockSettings({
          ui: { requiresRestart: true },
        });
        const modifiedSettings = new Set<string>();

        const result = getDisplayValue(
          'ui.requiresRestart',
          settings,
          mergedSettings,
          modifiedSettings,
        );
        expect(result).toBe('true*');
      });

      it('should show default value without * when setting does not exist in scope', () => {
        const settings = makeMockSettings({}); // setting doesn't exist in scope, show default
        const mergedSettings = makeMockSettings({
          ui: { requiresRestart: false },
        });
        const modifiedSettings = new Set<string>();

        const result = getDisplayValue(
          'ui.requiresRestart',
          settings,
          mergedSettings,
          modifiedSettings,
        );
        expect(result).toBe('false'); // default value (false) without *
      });

      it('should show value with * when user changes from default', () => {
        const settings = makeMockSettings({}); // setting doesn't exist in scope originally
        const mergedSettings = makeMockSettings({
          ui: { requiresRestart: false },
        });
        const modifiedSettings = new Set<string>(['ui.requiresRestart']);
        const pendingSettings = makeMockSettings({
          ui: { requiresRestart: true },
        }); // user changed to true

        const result = getDisplayValue(
          'ui.requiresRestart',
          settings,
          mergedSettings,
          modifiedSettings,
          pendingSettings,
        );
        expect(result).toBe('true*'); // changed from default (false) to true
      });

      it('should display auto output language as following user input', () => {
        vi.mocked(getSettingsSchema).mockReturnValue({
          general: {
            type: 'object',
            label: 'General',
            category: 'General',
            requiresRestart: false,
            default: {},
            description: 'General settings.',
            showInDialog: false,
            properties: {
              outputLanguage: {
                type: 'string',
                label: 'Output Language',
                category: 'General',
                requiresRestart: false,
                default: 'auto',
                description: 'LLM output language.',
                showInDialog: true,
              },
            },
          },
        } as unknown as SettingsSchemaType);

        const result = getDisplayValue(
          'general.outputLanguage',
          makeMockSettings({ general: { outputLanguage: 'auto' } }),
          makeMockSettings({ general: { outputLanguage: 'auto' } }),
          new Set<string>(),
        );

        expect(result).toBe('Auto (follow user input)*');
      });
    });

    describe('isDefaultValue', () => {
      it('should return true when setting does not exist in scope', () => {
        const settings = makeMockSettings({}); // setting doesn't exist

        const result = isDefaultValue('ui.requiresRestart', settings);
        expect(result).toBe(true);
      });

      it('should return false when setting exists in scope', () => {
        const settings = makeMockSettings({ ui: { requiresRestart: true } }); // setting exists

        const result = isDefaultValue('ui.requiresRestart', settings);
        expect(result).toBe(false);
      });

      it('should return true when nested setting does not exist in scope', () => {
        const settings = makeMockSettings({}); // nested setting doesn't exist

        const result = isDefaultValue(
          'ui.accessibility.enableLoadingPhrases',
          settings,
        );
        expect(result).toBe(true);
      });

      it('should return false when nested setting exists in scope', () => {
        const settings = makeMockSettings({
          ui: { accessibility: { enableLoadingPhrases: true } },
        }); // nested setting exists

        const result = isDefaultValue(
          'ui.accessibility.enableLoadingPhrases',
          settings,
        );
        expect(result).toBe(false);
      });
    });
  });
});

describe('setNestedProperty prototype-pollution guards', () => {
  // After each test, assert global Object.prototype was not polluted.
  const assertNoPollution = () => {
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(
      (Object.prototype as Record<string, unknown>)['polluted'],
    ).toBeUndefined();
  };

  describe('setNestedPropertySafe', () => {
    it('writes a normal dotted path', () => {
      const obj: Record<string, unknown> = {};
      setNestedPropertySafe(obj, 'a.b.c', 1);
      const a = obj['a'] as Record<string, Record<string, unknown>>;
      expect(a['b']['c']).toBe(1);
    });

    it('refuses a __proto__ segment (no pollution, no write)', () => {
      const obj: Record<string, unknown> = {};
      setNestedPropertySafe(obj, '__proto__.polluted', 'yes');
      assertNoPollution();
      expect(Object.keys(obj)).toEqual([]);
    });

    it('refuses constructor / prototype segments', () => {
      const obj: Record<string, unknown> = {};
      setNestedPropertySafe(obj, 'constructor.prototype.polluted', 'yes');
      setNestedPropertySafe(obj, 'foo.prototype.polluted', 'yes');
      assertNoPollution();
    });
  });

  describe('setNestedPropertyForce', () => {
    it('writes a normal dotted path', () => {
      const obj: Record<string, unknown> = {};
      setNestedPropertyForce(obj, 'x.y', 2);
      expect((obj['x'] as Record<string, unknown>)['y']).toBe(2);
    });

    it('refuses a __proto__ segment (no pollution, no write)', () => {
      const obj: Record<string, unknown> = {};
      setNestedPropertyForce(obj, '__proto__.polluted', 'yes');
      assertNoPollution();
      expect(Object.keys(obj)).toEqual([]);
    });
  });
});
