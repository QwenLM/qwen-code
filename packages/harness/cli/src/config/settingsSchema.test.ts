/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  getSettingsSchema,
  SETTINGS_SCHEMA_DEFINITIONS,
  type SettingCollectionDefinition,
  type SettingDefinition,
  type Settings,
  type SettingsSchema,
} from './settingsSchema.js';
import { getDialogSettingKeys } from '../utils/settingsUtils.js';

describe('SettingsSchema', () => {
  it('leaves CodeMode unset for the remote default and offers off, on and only exposure', () => {
    const properties = getSettingsSchema().codeMode.properties!;
    expect(properties.mode.default).toBeUndefined();
    expect(properties.mode.options?.map((option) => option.value)).toEqual([
      'off',
      'on',
      'only',
    ]);
    expect(properties.mode.requiresRestart).toBe(true);
    expect(properties.mode.unsetOptionLabel).toBe('Follow default');
    expect(getDialogSettingKeys()).toContain('codeMode.mode');
    expect(getDialogSettingKeys()).not.toContain('codeMode');
    expect(getDialogSettingKeys()).not.toContain('codeMode.deferredTools');
  });
  describe('getSettingsSchema', () => {
    it('should contain all expected top-level settings', () => {
      const expectedSettings: Array<keyof Settings> = [
        'mcpServers',
        'general',
        'ui',
        'model',
        'context',
        'tools',
        'mcp',
        'security',
        'advanced',
      ];

      expectedSettings.forEach((setting) => {
        expect(getSettingsSchema()[setting]).toBeDefined();
      });
    });

    it('should have correct structure for each setting', () => {
      Object.entries(getSettingsSchema()).forEach(([_key, definition]) => {
        expect(definition).toHaveProperty('type');
        expect(definition).toHaveProperty('label');
        expect(definition).toHaveProperty('category');
        expect(definition).toHaveProperty('requiresRestart');
        expect(definition).toHaveProperty('default');
        expect(typeof definition.type).toBe('string');
        expect(typeof definition.label).toBe('string');
        expect(typeof definition.category).toBe('string');
        expect(typeof definition.requiresRestart).toBe('boolean');
      });
    });

    it('should have correct nested setting structure', () => {
      const nestedSettings: Array<keyof Settings> = [
        'general',
        'ui',
        'model',
        'context',
        'tools',
        'mcp',
        'security',
        'advanced',
      ];

      nestedSettings.forEach((setting) => {
        const definition = getSettingsSchema()[setting] as SettingDefinition;
        expect(definition.type).toBe('object');
        expect(definition.properties).toBeDefined();
        expect(typeof definition.properties).toBe('object');
      });
    });

    it('defines Custom Providers with one default model and optional semantic routing', () => {
      const providers = getSettingsSchema().providers;
      const provider =
        providers.additionalProperties as SettingCollectionDefinition;
      const properties = provider.properties ?? {};

      expect(properties['model']).toBeDefined();
      expect(
        properties['protocol']?.options?.map((option) => option.value),
      ).toEqual(['openai', 'openai-responses', 'anthropic']);
      expect(
        properties['type']?.options?.map((option) => option.value),
      ).toEqual(['openai-compatible', 'alibaba', 'aliyun-bailian']);
      expect(
        properties['authType']?.options?.map((option) => option.value),
      ).toEqual(['bearer', 'api-key']);
      expect(properties['image']).toBeUndefined();
      expect(provider.forbiddenProperties).toContain('image');
      expect(
        SETTINGS_SCHEMA_DEFINITIONS['CustomProviderImageConfig'],
      ).toBeUndefined();
      const anthropic = properties['anthropic'] as SettingCollectionDefinition;
      expect(anthropic.properties).toMatchObject({
        version: { ref: 'StringOrFalse' },
        betas: { type: 'array' },
        queryParams: { type: 'object' },
        cache: { type: 'object' },
      });
      const anthropicCache = anthropic.properties?.['cache'];
      expect(anthropicCache?.default).toEqual({ mode: 'auto', ttl: '5m' });
      expect(anthropicCache?.properties?.['mode']?.default).toBe('auto');
      expect(properties).not.toHaveProperty('temperature');
      expect(properties).not.toHaveProperty('top_p');
      expect(properties).not.toHaveProperty('top_k');
      expect(properties).not.toHaveProperty('thinking');
      expect(properties).not.toHaveProperty('preserve_thinking');
      expect(properties).not.toHaveProperty('defaultSmallModel');
      expect(properties).not.toHaveProperty('defaultMediumModel');
      expect(properties).not.toHaveProperty('defaultLargeModel');
      expect(
        Object.keys(
          (properties['routing'] as SettingCollectionDefinition).properties ??
            {},
        ),
      ).toEqual(['utility', 'session_title', 'summary', 'compact', 'subagent']);
    });

    it('requires agent maxTurns overrides to be positive integers', () => {
      const agentOverride = SETTINGS_SCHEMA_DEFINITIONS[
        'AgentOverride'
      ] as unknown as SettingCollectionDefinition;
      const runConfig = agentOverride.properties?.[
        'runConfig'
      ] as SettingCollectionDefinition;

      expect(runConfig.properties?.['maxTurns']).toMatchObject({
        type: 'integer',
        minimum: 1,
      });
    });

    it('should have accessibility nested properties', () => {
      expect(
        getSettingsSchema().ui?.properties?.accessibility?.properties,
      ).toBeDefined();
      expect(
        getSettingsSchema().ui?.properties?.accessibility.properties
          ?.enableLoadingPhrases.type,
      ).toBe('boolean');
    });

    it('should have loadingPhrases enum property', () => {
      const definition = getSettingsSchema().ui?.properties?.loadingPhrases;
      expect(definition).toBeDefined();
      expect(definition?.type).toBe('enum');
      expect(definition?.default).toBe('off');
      expect(definition?.options?.map((o) => o.value)).toEqual([
        'tips',
        'witty',
        'all',
        'off',
      ]);
    });

    it('leaves all TUI memory defaults to QCS unless explicitly set', () => {
      const schema = getSettingsSchema();

      expect(schema.autoMemoryEnabled.default).toBeUndefined();
      expect(schema.autoMemoryUserScopeEnabled.default).toBeUndefined();
      expect(schema.dream.properties.enabled.default).toBeUndefined();
      expect(schema.autoMemoryEnabled.runtimeDefaultSource).toBe(
        'autoMemoryProject',
      );
      expect(schema.autoMemoryUserScopeEnabled.runtimeDefaultSource).toBe(
        'autoMemoryUser',
      );
      expect(schema.dream.properties.enabled.runtimeDefaultSource).toBe(
        'autoDream',
      );
      expect(getDialogSettingKeys()).toEqual(
        expect.arrayContaining([
          'autoMemoryEnabled',
          'autoMemoryUserScopeEnabled',
          'dream.enabled',
        ]),
      );
    });

    it('should expose only permission modes in the default permission mode options', () => {
      const definition =
        getSettingsSchema().general.properties.defaultPermissionMode;

      expect(definition.options.map((option) => option.value)).toEqual([
        'default',
        'accept_edits',
        'auto',
        'bypass_permissions',
        'dont_ask',
      ]);
    });

    it('disables model responses to shell-mode commands by default', () => {
      const definition = getSettingsSchema().respondToBashCommands;

      expect(definition).toMatchObject({
        type: 'boolean',
        default: false,
        requiresRestart: false,
        showInDialog: true,
      });
    });

    it('keeps terminalBuffer enabled by default during the renderer migration', () => {
      expect(getSettingsSchema().ui.properties.terminalBuffer.default).toBe(
        true,
      );
      expect(getSettingsSchema().ui.properties.useAlternateBuffer.default).toBe(
        false,
      );
    });

    it('should have errorVerbosity enum property', () => {
      const definition = getSettingsSchema().ui?.properties?.errorVerbosity;
      expect(definition).toBeDefined();
      expect(definition?.type).toBe('enum');
      expect(definition?.default).toBe('low');
      expect(definition?.options?.map((o) => o.value)).toEqual(['low', 'full']);
    });

    it('defines the interactive UI language without changing the AI response language', () => {
      const definition = getSettingsSchema().ui.properties.language;

      expect(definition).toMatchObject({
        type: 'enum',
        default: 'en',
        requiresRestart: false,
        showInDialog: true,
      });
      expect(definition.options?.map((option) => option.value)).toEqual([
        'auto',
        'zh-CN',
        'en',
      ]);
      expect(getSettingsSchema().language).toBeDefined();
      expect(getDialogSettingKeys()).toContain('ui.language');
    });

    it('defines a TUI-only per-run turn limit', () => {
      const definition = getSettingsSchema().ui.properties.maxTurns;

      expect(definition).toMatchObject({
        type: 'enum',
        default: 1000,
        requiresRestart: false,
        showInDialog: true,
      });
      expect(definition.options?.map((option) => option.value)).toEqual([
        1000,
        2000,
        3000,
        'unlimited',
      ]);
      expect(definition.description).toContain('interactive TUI');
      expect(definition.description).toContain('-p/--print');
      expect(getDialogSettingKeys()).toContain('ui.maxTurns');
    });

    it('does not expose the unsupported max session turns setting', () => {
      expect(getSettingsSchema().model.properties).not.toHaveProperty(
        'maxSessionTurns',
      );
    });

    it('does not expose the removed user input display format setting', () => {
      expect(getSettingsSchema().ui.properties).not.toHaveProperty(
        'userInputDisplayFormat',
      );
    });

    it('should have fileCheckpointing nested properties', () => {
      expect(
        getSettingsSchema().general?.properties?.fileCheckpointing.properties
          ?.enabled,
      ).toBeDefined();
      expect(
        getSettingsSchema().general?.properties?.fileCheckpointing.properties
          ?.enabled.type,
      ).toBe('boolean');
    });

    it('should have plan nested properties', () => {
      expect(
        getSettingsSchema().general?.properties?.plan?.properties?.directory,
      ).toBeDefined();
      expect(
        getSettingsSchema().general?.properties?.plan?.properties?.directory
          .type,
      ).toBe('string');
    });

    it('should have fileFiltering nested properties', () => {
      expect(
        getSettingsSchema().context.properties.fileFiltering.properties
          ?.respectGitIgnore,
      ).toBeDefined();
      expect(
        getSettingsSchema().context.properties.fileFiltering.properties
          ?.respectBrandIgnore,
      ).toBeDefined();
      expect(
        getSettingsSchema().context.properties.fileFiltering.properties
          ?.enableRecursiveFileSearch,
      ).toBeDefined();
      expect(
        getSettingsSchema().context.properties.fileFiltering.properties
          ?.customIgnoreFilePaths,
      ).toBeDefined();
      expect(
        getSettingsSchema().context.properties.fileFiltering.properties
          ?.customIgnoreFilePaths.type,
      ).toBe('array');
    });

    it('should have unique categories', () => {
      const categories = new Set();

      // Collect categories from top-level settings
      Object.values(getSettingsSchema()).forEach((definition) => {
        categories.add(definition.category);
        // Also collect from nested properties
        const defWithProps = definition as typeof definition & {
          properties?: Record<string, unknown>;
        };
        if (defWithProps.properties) {
          Object.values(defWithProps.properties).forEach(
            (nestedDef: unknown) => {
              const nestedDefTyped = nestedDef as { category?: string };
              if (nestedDefTyped.category) {
                categories.add(nestedDefTyped.category);
              }
            },
          );
        }
      });

      expect(categories.size).toBeGreaterThan(0);
      expect(categories).toContain('General');
      expect(categories).toContain('UI');
      expect(categories).toContain('Advanced');
    });

    it('should have consistent default values for boolean settings', () => {
      const checkBooleanDefaults = (schema: SettingsSchema) => {
        Object.entries(schema).forEach(([, definition]) => {
          const def = definition;
          if (def.type === 'boolean') {
            // Boolean settings can have boolean or undefined defaults (for optional settings)
            expect(['boolean', 'undefined']).toContain(typeof def.default);
          }
          if (def.properties) {
            checkBooleanDefaults(def.properties);
          }
        });
      };

      checkBooleanDefaults(getSettingsSchema() as SettingsSchema);
    });

    it('should have showInDialog property configured', () => {
      // Check that user-facing settings are marked for dialog display
      expect(
        getSettingsSchema().ui.properties.showMemoryUsage.showInDialog,
      ).toBe(false);
      expect(
        getSettingsSchema().ui.properties.footer.properties
          .hideContextPercentage.showInDialog,
      ).toBe(false);
      expect(getSettingsSchema().general.properties.vimMode.showInDialog).toBe(
        true,
      );
      expect(
        getSettingsSchema().general.properties.enableAutoUpdate.showInDialog,
      ).toBe(true);
      expect(
        getSettingsSchema().ui.properties.hideWindowTitle.showInDialog,
      ).toBe(false);
      expect(getSettingsSchema().ui.properties.hideTips.showInDialog).toBe(
        false,
      );
      expect(
        getSettingsSchema().ui.properties.showShortcutsHint.showInDialog,
      ).toBe(true);
      expect(getSettingsSchema().ui.properties.hideBanner.showInDialog).toBe(
        false,
      );

      // Check that advanced settings are hidden from dialog
      expect(getSettingsSchema().security.properties.auth.showInDialog).toBe(
        false,
      );
      expect(getSettingsSchema().tools.properties.core.showInDialog).toBe(
        false,
      );
      expect(getSettingsSchema().mcpServers.showInDialog).toBe(false);

      // Check that some settings are appropriately hidden
      expect(getSettingsSchema().ui.properties.theme.showInDialog).toBe(false); // Changed to false
      expect(getSettingsSchema().ui.properties.customThemes.showInDialog).toBe(
        false,
      ); // Managed via theme editor
      expect(
        getSettingsSchema().general.properties.fileCheckpointing.showInDialog,
      ).toBe(false); // Experimental feature
      expect(getSettingsSchema().ui.properties.accessibility.showInDialog).toBe(
        false,
      ); // Changed to false
      expect(
        getSettingsSchema().context.properties.fileFiltering.showInDialog,
      ).toBe(false); // Changed to false
      expect(
        getSettingsSchema().general.properties.preferredEditor.showInDialog,
      ).toBe(false); // Changed to false
      expect(
        getSettingsSchema().advanced.properties.autoConfigureMemory
          .showInDialog,
      ).toBe(false);
      expect(
        getSettingsSchema().advanced.properties.useProxyFromEnvironment
          .showInDialog,
      ).toBe(true);
    });

    it('should enable proxy environment variables by default', () => {
      const setting =
        getSettingsSchema().advanced.properties.useProxyFromEnvironment;

      expect(setting.type).toBe('boolean');
      expect(setting.default).toBe(true);
      expect(setting.requiresRestart).toBe(true);
      expect(setting.showInDialog).toBe(true);
      expect(getDialogSettingKeys()).toContain(
        'advanced.useProxyFromEnvironment',
      );
    });

    it('should infer Settings type correctly', () => {
      // This test ensures that the Settings type is properly inferred from the schema
      const settings: Settings = {
        ui: {
          theme: 'dark',
        },
        context: {
          loadMemoryFromIncludeDirectories: true,
        },
      };

      // TypeScript should not complain about these properties
      expect(settings.ui?.theme).toBe('dark');
      expect(settings.context?.loadMemoryFromIncludeDirectories).toBe(true);
    });

    it('should have loadMemoryFromIncludeDirectories setting in schema', () => {
      expect(
        getSettingsSchema().context?.properties
          .loadMemoryFromIncludeDirectories,
      ).toBeDefined();
      expect(
        getSettingsSchema().context?.properties.loadMemoryFromIncludeDirectories
          .type,
      ).toBe('boolean');
      expect(
        getSettingsSchema().context?.properties.loadMemoryFromIncludeDirectories
          .category,
      ).toBe('Context');
      expect(
        getSettingsSchema().context?.properties.loadMemoryFromIncludeDirectories
          .default,
      ).toBe(false);
    });

    it('should have folderTrustFeature setting in schema', () => {
      expect(
        getSettingsSchema().security.properties.folderTrust.properties.enabled,
      ).toBeDefined();
      expect(
        getSettingsSchema().security.properties.folderTrust.properties.enabled
          .type,
      ).toBe('boolean');
      expect(
        getSettingsSchema().security.properties.folderTrust.properties.enabled
          .category,
      ).toBe('Security');
      expect(
        getSettingsSchema().security.properties.folderTrust.properties.enabled
          .default,
      ).toBe(true);
      expect(
        getSettingsSchema().security.properties.folderTrust.properties.enabled
          .showInDialog,
      ).toBe(true);
    });

    it('defines allowedHttpHookUrls as a hidden URL pattern array', () => {
      const setting = getSettingsSchema().allowedHttpHookUrls;
      expect(setting.type).toBe('array');
      expect(setting.default).toBeUndefined();
      expect(setting.items).toEqual({ type: 'string' });
      expect(setting.showInDialog).toBe(false);
    });

    it('should have debugKeystrokeLogging setting in schema', () => {
      expect(
        getSettingsSchema().general.properties.debugKeystrokeLogging,
      ).toBeDefined();
      expect(
        getSettingsSchema().general.properties.debugKeystrokeLogging.type,
      ).toBe('boolean');
      expect(
        getSettingsSchema().general.properties.debugKeystrokeLogging.category,
      ).toBe('General');
      expect(
        getSettingsSchema().general.properties.debugKeystrokeLogging.default,
      ).toBe(false);
      expect(
        getSettingsSchema().general.properties.debugKeystrokeLogging
          .requiresRestart,
      ).toBe(false);
      expect(
        getSettingsSchema().general.properties.debugKeystrokeLogging
          .showInDialog,
      ).toBe(false);
      expect(
        getSettingsSchema().general.properties.debugKeystrokeLogging
          .description,
      ).toBe('Enable debug logging of keystrokes to the console.');
    });

    it('should have showShortcutsHint setting in schema', () => {
      expect(getSettingsSchema().ui.properties.showShortcutsHint).toBeDefined();
      expect(getSettingsSchema().ui.properties.showShortcutsHint.type).toBe(
        'boolean',
      );
      expect(getSettingsSchema().ui.properties.showShortcutsHint.category).toBe(
        'UI',
      );
      expect(getSettingsSchema().ui.properties.showShortcutsHint.default).toBe(
        true,
      );
      expect(
        getSettingsSchema().ui.properties.showShortcutsHint.requiresRestart,
      ).toBe(false);
      expect(
        getSettingsSchema().ui.properties.showShortcutsHint.showInDialog,
      ).toBe(true);
      expect(
        getSettingsSchema().ui.properties.showShortcutsHint.description,
      ).toBe('Show the "? for shortcuts" hint above the input.');
    });

    it('defines prompt suggestions as enabled by default', () => {
      const setting = getSettingsSchema().promptSuggestionEnabled;
      expect(setting).toBeDefined();
      expect(setting.type).toBe('boolean');
      expect(setting.category).toBe('UI');
      expect(setting.default).toBe(true);
      expect(setting.requiresRestart).toBe(false);
      expect(setting.showInDialog).toBe(true);
      expect(setting.description).toBe(
        'Show suggested next actions after a completed turn.',
      );
    });

    it('should have enableNotifications setting in schema', () => {
      const setting =
        getSettingsSchema().general.properties.enableNotifications;
      expect(setting).toBeDefined();
      expect(setting.type).toBe('boolean');
      expect(setting.category).toBe('General');
      expect(setting.default).toBe(false);
      expect(setting.requiresRestart).toBe(false);
      expect(setting.showInDialog).toBe(false);
    });

    it('should have enableAgents setting in schema', () => {
      const setting = getSettingsSchema().experimental.properties.enableAgents;
      expect(setting).toBeDefined();
      expect(setting.type).toBe('boolean');
      expect(setting.category).toBe('Experimental');
      expect(setting.default).toBe(true);
      expect(setting.requiresRestart).toBe(true);
      expect(setting.showInDialog).toBe(false);
      expect(setting.description).toBe('Enable subagents.');
    });

    it('should have skills setting enabled by default', () => {
      const setting = getSettingsSchema().skills.properties.enabled;
      expect(setting).toBeDefined();
      expect(setting.type).toBe('boolean');
      expect(setting.category).toBe('Advanced');
      expect(setting.default).toBe(true);
      expect(setting.requiresRestart).toBe(true);
      expect(setting.showInDialog).toBe(false);
      expect(setting.description).toBe('Enable Agent Skills.');
    });

    it('leaves skill listing defaults to the runtime entry point', () => {
      const schema = getSettingsSchema();
      expect(schema.skillListingMaxDescChars.default).toBeUndefined();
      expect(schema.skillListingBudgetFraction.default).toBeUndefined();
    });

    it('exposes the .agents skills compatibility switch in settings', () => {
      const setting =
        getSettingsSchema().skills.properties.loadFromAgentsDirectory;

      expect(setting).toBeDefined();
      expect(setting.type).toBe('boolean');
      expect(setting.label).toBe('Load Skills from .agents/skills');
      expect(setting.category).toBe('Advanced');
      expect(setting.default).toBe(true);
      expect(setting.requiresRestart).toBe(true);
      expect(setting.showInDialog).toBe(true);
      expect(setting.description).toContain('SDK mode defaults this off');
      expect(getDialogSettingKeys()).toContain(
        'skills.loadFromAgentsDirectory',
      );
    });

    it('should have plan setting in schema', () => {
      const setting =
        getSettingsSchema().general.properties.plan.properties.enabled;
      expect(setting).toBeDefined();
      expect(setting.type).toBe('boolean');
      expect(setting.category).toBe('General');
      expect(setting.default).toBe(true);
      expect(setting.requiresRestart).toBe(true);
      expect(setting.showInDialog).toBe(true);
      expect(setting.description).toBe(
        'Enable Plan Mode for read-only safety during planning. When disabled, /plan command and --permission-mode plan are both rejected.',
      );
    });

    it('should have hooksConfig.notifications setting in schema', () => {
      const setting = getSettingsSchema().hooksConfig?.properties.notifications;
      expect(setting).toBeDefined();
      expect(setting.type).toBe('boolean');
      expect(setting.category).toBe('Advanced');
      expect(setting.default).toBe(false);
      expect(setting.showInDialog).toBe(false);
    });

    it('should have name and type in hook definitions', () => {
      const hookDef = SETTINGS_SCHEMA_DEFINITIONS['HookDefinitionArray'];
      expect(hookDef).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const hookItemProperties = (hookDef as any).items.properties.hooks.items
        .properties;
      expect(hookItemProperties.name).toBeDefined();
      expect(hookItemProperties.name.type).toBe('string');
      expect(hookItemProperties.type).toBeDefined();
      expect(hookItemProperties.type.type).toBe('string');
    });

    it('should have adk setting in schema', () => {
      const adk = getSettingsSchema().experimental.properties.adk;
      expect(adk).toBeDefined();
      expect(adk.type).toBe('object');
      expect(adk.category).toBe('Experimental');
      expect(adk.default).toEqual({});
      expect(adk.requiresRestart).toBe(true);
      expect(adk.showInDialog).toBe(false);
      expect(adk.description).toBe(
        'Settings for the Agent Development Kit (ADK).',
      );

      const agentSessionNoninteractiveEnabled =
        adk.properties.agentSessionNoninteractiveEnabled;
      expect(agentSessionNoninteractiveEnabled).toBeDefined();
      expect(agentSessionNoninteractiveEnabled.type).toBe('boolean');
      expect(agentSessionNoninteractiveEnabled.category).toBe('Experimental');
      expect(agentSessionNoninteractiveEnabled.default).toBe(false);
      expect(agentSessionNoninteractiveEnabled.requiresRestart).toBe(true);
      expect(agentSessionNoninteractiveEnabled.showInDialog).toBe(false);
      expect(agentSessionNoninteractiveEnabled.description).toBe(
        'Enable non-interactive agent sessions.',
      );
    });
  });

  it('has JSON schema definitions for every referenced ref, and no unreferenced ones', () => {
    const schema = getSettingsSchema();
    const referenced = new Set<string>();

    const visitDefinition = (definition: SettingDefinition) => {
      if (definition.ref) {
        referenced.add(definition.ref);
        expect(SETTINGS_SCHEMA_DEFINITIONS).toHaveProperty(definition.ref);
      }
      if (definition.properties) {
        Object.values(definition.properties).forEach(visitDefinition);
      }
      if (definition.items) {
        visitCollection(definition.items);
      }
      if (definition.additionalProperties) {
        visitCollection(definition.additionalProperties);
      }
    };

    const visitCollection = (collection: SettingCollectionDefinition) => {
      if (collection.ref) {
        referenced.add(collection.ref);
        expect(SETTINGS_SCHEMA_DEFINITIONS).toHaveProperty(collection.ref);
        return;
      }
      if (collection.properties) {
        Object.values(collection.properties).forEach(visitDefinition);
      }
      if (collection.type === 'array' && collection.properties) {
        Object.values(collection.properties).forEach(visitDefinition);
      }
    };

    // A definition may be reachable only through another definition, so the
    // $defs bodies are walked too before anything is called unreferenced.
    const visitJsonSchema = (jsonSchema: Record<string, unknown>) => {
      const ref = jsonSchema['ref'];
      if (typeof ref === 'string') {
        referenced.add(ref);
      }
      const properties = jsonSchema['properties'];
      if (
        properties &&
        typeof properties === 'object' &&
        !Array.isArray(properties)
      ) {
        Object.values(properties as Record<string, unknown>).forEach((prop) =>
          visitJsonSchema(prop as Record<string, unknown>),
        );
      }
      const items = jsonSchema['items'];
      if (items && typeof items === 'object' && !Array.isArray(items)) {
        visitJsonSchema(items as Record<string, unknown>);
      }
      const additional = jsonSchema['additionalProperties'];
      if (
        additional &&
        typeof additional === 'object' &&
        !Array.isArray(additional)
      ) {
        visitJsonSchema(additional as Record<string, unknown>);
      }
    };

    Object.values(schema).forEach(visitDefinition);
    Object.values(SETTINGS_SCHEMA_DEFINITIONS).forEach(visitJsonSchema);

    // Ensure definitions map doesn't accumulate stale entries.
    Object.keys(SETTINGS_SCHEMA_DEFINITIONS).forEach((key) => {
      if (!referenced.has(key)) {
        throw new Error(
          `Definition "${key}" is exported but never referenced in the schema`,
        );
      }
    });
  });
});
