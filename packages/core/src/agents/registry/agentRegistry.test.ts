/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from 'vitest';
import { AgentRegistry } from './agentRegistry.js';
import { makeFakeConfig } from '../../test-utils/config.js';
import {
  RESOLVED_AGENT_REASONING,
  type AgentDefinition,
  type LocalAgentDefinition,
} from '../types.js';
import type { Config, ConfigParameters } from '../../config/config.js';
import { runLogger } from '../../utils/runLogger.js';
import { coreEvents, CoreEvent } from '../../utils/events.js';
import * as tomlLoader from './agentLoader.js';
import type { ToolRegistry } from '../../tools/tool-registry.js';
import type { LoadedPlugin } from '../../plugins/types.js';
import { ModelProviderManager } from '../../provider/impl/modelProviderManager.js';
import { entryToListedModel } from '../../test-utils/listed-model.js';
import type { ListedModelEntryFixture } from '../../test-utils/listed-model-entry.js';
import type { AgentResourceDefinition } from '@qwen-code/resource';
import type { BuiltinPluginContributions } from '../../builtin-plugins/registry.js';
import { ENV_AGENT_SDK_ENTRYPOINT } from '../../config/brand.js';

vi.mock('./agentLoader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agentLoader.js')>();
  return {
    ...actual,
    loadAgentsFromDirectory: vi
      .fn()
      .mockResolvedValue({ agents: [], errors: [] }),
    loadAgentsFromPath: vi.fn().mockResolvedValue(undefined),
  };
});

function makeMockedConfig(params?: Partial<ConfigParameters>): Config {
  const config = makeFakeConfig(params);
  vi.spyOn(config, 'getToolRegistry').mockReturnValue({
    getAllToolNames: () => ['tool1', 'tool2'],
  } as unknown as ToolRegistry);
  vi.spyOn(config, 'getAgentRegistry').mockReturnValue({
    getDirectoryContext: () => 'mock directory context',
    getAllDefinitions: () => [],
  } as unknown as AgentRegistry);
  return config;
}

function makeModelEntry(
  overrides: Partial<ListedModelEntryFixture> = {},
): ListedModelEntryFixture {
  return {
    key: 'test',
    display_name: 'Test Model',
    is_default: false,
    enable: true,
    is_reasoning: true,
    is_vl: false,
    is_new: false,
    max_input_tokens: 100_000,
    max_output_tokens: 32_000,
    source: 'system',
    format: 'openai',
    tags: [],
    efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    supports_disabled: true,
    ...overrides,
  };
}

// A test-only subclass to expose the protected `registerAgent` method.
class TestableAgentRegistry extends AgentRegistry {
  async testRegisterAgent(definition: AgentDefinition): Promise<void> {
    await this.registerAgent(definition);
  }
}

// Define mock agent structures for testing registration logic
const MOCK_AGENT_V1: AgentDefinition = {
  kind: 'local',
  name: 'MockAgent',
  description: 'Mock Description V1',
  inputConfig: { inputSchema: { type: 'object' } },
  modelConfig: {
    model: 'test',
    generateContentConfig: {
      temperature: 0,
      topP: 1,
      thinkingConfig: {
        includeThoughts: true,
        thinkingBudget: -1,
      },
    },
  },
  runConfig: { maxTimeMinutes: 1 },
  promptConfig: { systemPrompt: 'test' },
};

const MOCK_AGENT_V2: AgentDefinition = {
  ...MOCK_AGENT_V1,
  description: 'Mock Description V2 (Updated)',
};

function resourceAgent(
  name: string,
  description: string,
  source: 'user' | 'project',
): AgentResourceDefinition {
  return {
    kind: 'local',
    name,
    description,
    prompt: 'test',
    model: 'test',
    metadata: { filePath: `/${source}/${name}.md`, source },
  };
}

describe('AgentRegistry', () => {
  let mockConfig: Config;
  let registry: TestableAgentRegistry;
  let getModel: MockInstance<ModelProviderManager['getModel']>;
  let listModels: MockInstance<ModelProviderManager['listModels']>;
  const mockListedModel = (entry: ListedModelEntryFixture | undefined) =>
    getModel.mockResolvedValue(entry ? entryToListedModel(entry) : undefined);
  const mockSnapshotListed = (listed: boolean) =>
    listModels.mockResolvedValue(
      listed ? [entryToListedModel(makeModelEntry())] : [],
    );

  beforeEach(() => {
    getModel = vi
      .spyOn(ModelProviderManager.prototype, 'getModel')
      .mockImplementation(async (model) =>
        model === 'test' ? entryToListedModel(makeModelEntry()) : undefined,
      );
    listModels = vi.spyOn(ModelProviderManager.prototype, 'listModels');
    mockSnapshotListed(true);

    // Default configuration (debugMode: false)
    mockConfig = makeMockedConfig();
    registry = new TestableAgentRegistry(mockConfig);
    vi.mocked(tomlLoader.loadAgentsFromDirectory).mockResolvedValue({
      agents: [],
      errors: [],
    });
    vi.mocked(tomlLoader.loadAgentsFromPath).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks(); // Restore spies after each test
  });

  describe('initialize', () => {
    // TODO: Add this test once we actually have a built-in agent configured.
    // it('should load built-in agents upon initialization', async () => {
    //   expect(registry.getAllDefinitions()).toHaveLength(0);

    //   await registry.initialize();

    //   // There are currently no built-in agents.
    //   expect(registry.getAllDefinitions()).toEqual([]);
    // });

    it('should log the count of loaded agents in debug mode', async () => {
      const debugConfig = makeMockedConfig({
        debugMode: true,
        enableAgents: true,
      });
      const debugRegistry = new TestableAgentRegistry(debugConfig);
      const debugLogSpy = vi
        .spyOn(runLogger, 'log')
        .mockImplementation(() => {});

      await debugRegistry.initialize();

      const agentCount = debugRegistry.getAllDefinitions().length;
      expect(debugLogSpy).toHaveBeenCalledWith(
        `[AgentRegistry] Loaded with ${agentCount} agents.`,
      );
    });

    it('should load agents from user and project directories with correct precedence', async () => {
      mockConfig = makeMockedConfig({ enableAgents: true });
      registry = new TestableAgentRegistry(mockConfig);

      vi.spyOn(mockConfig, 'getResourceAgentDefinitions').mockReturnValue([
        resourceAgent('common-agent', 'User version', 'user'),
        resourceAgent('common-agent', 'Project version', 'project'),
        resourceAgent('project-only', 'Project only', 'project'),
      ]);

      await registry.initialize();

      // Project agent should override user agent
      expect(registry.getDefinition('common-agent')?.description).toBe(
        'Project version',
      );
      expect(registry.getDefinition('project-only')).toBeDefined();
      expect(tomlLoader.loadAgentsFromDirectory).not.toHaveBeenCalled();
    });

    it('should NOT load TOML agents when enableAgents is false', async () => {
      const disabledConfig = makeMockedConfig({
        enableAgents: false,
        agents: {
          overrides: {
            'general-purpose': { enabled: false },
            'statusline-setup': { enabled: false },
          },
        },
      });
      const disabledRegistry = new TestableAgentRegistry(disabledConfig);

      await disabledRegistry.initialize();

      // Disabling configurable Agents skips user/project/plugin discovery but
      // intentionally keeps enabled built-ins available.
      expect(
        disabledRegistry
          .getAllDefinitions()
          .every((agent) => agent.metadata?.source === 'built-in'),
      ).toBe(true);
      expect(
        vi.mocked(tomlLoader.loadAgentsFromDirectory),
      ).not.toHaveBeenCalled();
    });

    it('should register general-purpose agent by default', async () => {
      const config = makeMockedConfig();
      const registry = new TestableAgentRegistry(config);

      await registry.initialize();

      expect(registry.getDefinition('general-purpose')).toBeDefined();
    });

    it('registers agents contributed by builtin plugins as built-ins', async () => {
      const config = makeMockedConfig();
      vi.spyOn(config, 'getBuiltinPluginContributions').mockReturnValue({
        isReady: () => true,
        getAgentDefinitions: () => [
          {
            kind: 'local',
            name: 'contributed-agent',
            description: 'Contributed by a product plugin',
            promptConfig: { systemPrompt: 'test' },
            modelConfig: { model: 'inherit' },
          } satisfies LocalAgentDefinition,
        ],
      } as unknown as BuiltinPluginContributions);

      const registry = new TestableAgentRegistry(config);
      await registry.initialize();

      const definition = registry.getDefinition('contributed-agent');
      expect(definition).toBeDefined();
      expect(definition?.metadata?.source).toBe('built-in');
    });

    it('skips skipInSdkMode agents when running as an SDK host', async () => {
      const previous = process.env[ENV_AGENT_SDK_ENTRYPOINT];
      process.env[ENV_AGENT_SDK_ENTRYPOINT] = '1';
      try {
        const config = makeMockedConfig();
        vi.spyOn(config, 'getBuiltinPluginContributions').mockReturnValue({
          isReady: () => true,
          getAgentDefinitions: () => [
            {
              kind: 'local',
              name: 'sdk-skipped',
              description: 'Not registered for SDK hosts',
              promptConfig: { systemPrompt: 'test' },
              modelConfig: { model: 'inherit' },
              skipInSdkMode: true,
            } satisfies LocalAgentDefinition,
            {
              kind: 'local',
              name: 'always-on',
              description: 'Registered everywhere',
              promptConfig: { systemPrompt: 'test' },
              modelConfig: { model: 'inherit' },
            } satisfies LocalAgentDefinition,
          ],
        } as unknown as BuiltinPluginContributions);

        const registry = new TestableAgentRegistry(config);
        await registry.initialize();

        expect(registry.getDefinition('sdk-skipped')).toBeUndefined();
        expect(registry.getDefinition('always-on')).toBeDefined();
        expect(registry.getDefinition('statusline-setup')).toBeUndefined();
      } finally {
        if (previous === undefined) {
          delete process.env[ENV_AGENT_SDK_ENTRYPOINT];
        } else {
          process.env[ENV_AGENT_SDK_ENTRYPOINT] = previous;
        }
      }
    });

    it('skips agent contributions until builtin plugins are ready', async () => {
      const config = makeMockedConfig();
      const getAgentDefinitions = vi.fn(() => []);
      vi.spyOn(config, 'getBuiltinPluginContributions').mockReturnValue({
        isReady: () => false,
        getAgentDefinitions,
      } as unknown as BuiltinPluginContributions);

      const registry = new TestableAgentRegistry(config);
      await registry.initialize();

      expect(getAgentDefinitions).not.toHaveBeenCalled();
      expect(registry.getDefinition('general-purpose')).toBeDefined();
    });

    it('should not register the removed SaveMemory built-in agent', async () => {
      const config = makeMockedConfig();
      const registry = new TestableAgentRegistry(config);

      await registry.initialize();

      expect(registry.getDefinition('SaveMemory')).toBeUndefined();
    });

    it('should register general-purpose agent if explicitly enabled via override', async () => {
      const config = makeMockedConfig({
        agents: {
          overrides: {
            'general-purpose': { enabled: true },
          },
        },
      });
      const registry = new TestableAgentRegistry(config);

      await registry.initialize();

      expect(registry.getDefinition('general-purpose')).toBeDefined();
    });

    it('should respect disabled override over enabled override', async () => {
      const config = makeMockedConfig({
        agents: {
          overrides: {
            'general-purpose': { enabled: false },
          },
        },
      });
      const registry = new TestableAgentRegistry(config);

      await registry.initialize();

      expect(registry.getDefinition('general-purpose')).toBeUndefined();
    });

    it('should load plugin Agents through the shared path dispatcher', async () => {
      const config = makeMockedConfig({ enableAgents: true });
      vi.spyOn(config, 'getEnabledPlugins').mockReturnValue([
        {
          name: 'demo-plugin',
          source: 'local',
          repository: 'local',
          path: '/plugins/demo-plugin',
          enabled: true,
          manifest: { name: 'demo-plugin' },
          agentsPaths: ['/plugins/demo-plugin/agents/reviewer.md'],
        } as LoadedPlugin,
      ]);
      vi.mocked(tomlLoader.loadAgentsFromPath).mockResolvedValue({
        sourceType: 'file',
        agents: [
          {
            ...MOCK_AGENT_V1,
            name: 'demo-plugin:reviewer',
            description: 'Plugin reviewer',
          },
        ],
        errors: [],
      });
      const pluginRegistry = new TestableAgentRegistry(config);

      await pluginRegistry.initialize();

      expect(tomlLoader.loadAgentsFromPath).toHaveBeenCalledWith(
        '/plugins/demo-plugin/agents/reviewer.md',
        {
          pluginName: 'demo-plugin',
        },
      );
      expect(
        pluginRegistry.getDefinition('demo-plugin:reviewer')?.description,
      ).toBe('Plugin reviewer');
    });
  });

  describe('registration logic', () => {
    it.each([
      ['GLM-5.3', 'gm51model', 'GLM-5.3'],
      ['Kimi-K3.1-Pro', 'kmodel_latest', 'Kimi-K3.1-Pro'],
      ['glm-5.3', 'gm51model', 'GLM-5.3'],
    ])(
      'accepts the catalog display name %s with explicit effort',
      async (configuredName, key, displayName) => {
        const model = entryToListedModel(
          makeModelEntry({ key, display_name: displayName }),
        );
        getModel.mockImplementation(async (input) =>
          input === key ? model : undefined,
        );
        listModels.mockResolvedValue([model]);
        const [markdown] = await tomlLoader.parseAgentMarkdown(
          '/agents/display-name.md',
          `---\nname: display-name\ndescription: Display name regression\nmodel: ${configuredName}\neffort: high\n---\nReview the changes.`,
        );
        const agent = tomlLoader.markdownToAgentDefinition(markdown);

        await registry.testRegisterAgent(agent);

        expect(registry.getDefinition(agent.name)).toBeDefined();
        expect(registry.getLoadErrors()).toHaveLength(0);
        // Keep the declaration for UI display and catalog refreshes.
        expect(agent.modelConfig.model).toBe(configuredName);
      },
    );

    it.each([
      [{ enable: false }, 'is disabled'],
      [
        { efforts: ['low'], supports_disabled: false },
        'does not support effort "high"',
      ],
    ])(
      'still validates capabilities after resolving a display name: %s',
      async (overrides, error) => {
        getModel.mockResolvedValue(undefined);
        listModels.mockResolvedValue([
          entryToListedModel(
            makeModelEntry({
              ...overrides,
              key: 'gm51model',
              display_name: 'GLM-5.3',
            }),
          ),
        ]);
        await registry.testRegisterAgent({
          ...MOCK_AGENT_V1,
          effort: 'high',
          modelConfig: { model: 'GLM-5.3' },
        });

        expect(registry.getDefinition(MOCK_AGENT_V1.name)).toBeUndefined();
        expect(registry.getLoadErrors()[0]?.message).toContain(error);
      },
    );

    it('reports ambiguous display names instead of choosing a model', async () => {
      getModel.mockResolvedValue(undefined);
      listModels.mockResolvedValue(
        ['first', 'second'].map((key) =>
          entryToListedModel(
            makeModelEntry({
              key,
              display_name: 'Shared Name',
            }),
          ),
        ),
      );
      await registry.testRegisterAgent({
        ...MOCK_AGENT_V1,
        effort: 'high',
        modelConfig: { model: 'Shared Name' },
      });

      expect(registry.getDefinition(MOCK_AGENT_V1.name)).toBeUndefined();
      expect(registry.getLoadErrors()[0]?.message).toContain('ambiguous');
      expect(registry.getLoadErrors()[0]?.message).toContain('first, second');
    });

    it('rejects an ambiguous model ID even when getModel would choose the first match', async () => {
      const models = ['Target', 'TARGET'].map((key) =>
        entryToListedModel(makeModelEntry({ key })),
      );
      getModel.mockResolvedValue(models[0]);
      listModels.mockResolvedValue(models);

      await registry.testRegisterAgent({
        ...MOCK_AGENT_V1,
        effort: 'high',
        modelConfig: { model: 'target' },
      });

      expect(registry.getDefinition(MOCK_AGENT_V1.name)).toBeUndefined();
      expect(registry.getLoadErrors()[0]?.message).toContain('ambiguous');
      expect(registry.getLoadErrors()[0]?.message).toContain('Target, TARGET');
      expect(getModel).not.toHaveBeenCalled();
    });

    it('should register a valid agent definition', async () => {
      await registry.testRegisterAgent(MOCK_AGENT_V1);
      expect(registry.getDefinition('MockAgent')).toMatchObject(MOCK_AGENT_V1);
    });

    it('should resolve frontmatter effort once during registration', async () => {
      const effortAgent: LocalAgentDefinition = {
        ...MOCK_AGENT_V1,
        name: 'EffortAgent',
        effort: 'low',
        modelConfig: { model: 'test' },
      };

      await registry.testRegisterAgent(effortAgent);

      const registered = registry.getDefinition(
        'EffortAgent',
      ) as LocalAgentDefinition;
      expect(registered).toMatchObject({
        effort: 'low',
        modelConfig: {
          generateContentConfig: {
            thinkingConfig: { thinkingBudget: 1024 },
          },
        },
      });
      expect(registered[RESOLVED_AGENT_REASONING]).toEqual({
        thinkingBudget: 1024,
        reasoningEffort: 'low',
      });
    });

    it('should register a supported explicit effort when the model default is disabled', async () => {
      mockListedModel(
        makeModelEntry({
          key: 'default-disabled',
          efforts: ['high'],
          supports_disabled: true,
          default_effort: 'none',
        }),
      );
      const agent: LocalAgentDefinition = {
        ...MOCK_AGENT_V1,
        name: 'SupportedEffortAgent',
        effort: 'high',
        modelConfig: { model: 'default-disabled' },
      };

      await registry.testRegisterAgent(agent);

      expect(registry.getDefinition(agent.name)).toBeDefined();
      expect(registry.getLoadErrors()).toHaveLength(0);
    });

    it('should allow disabled effort when the explicit model defaults to disabled-only reasoning', async () => {
      mockListedModel(
        makeModelEntry({
          key: 'disabled-only',
          efforts: [],
          supports_disabled: true,
          default_effort: 'none',
        }),
      );
      const agent: LocalAgentDefinition = {
        ...MOCK_AGENT_V1,
        name: 'DisabledEffortAgent',
        effort: 'none',
        modelConfig: { model: 'disabled-only' },
      };

      await registry.testRegisterAgent(agent);

      expect(registry.getDefinition(agent.name)).toBeDefined();
      expect(registry.getLoadErrors()).toHaveLength(0);
    });

    it('should reject an explicit model and effort when the model does not support that effort', async () => {
      mockListedModel(
        makeModelEntry({
          key: 'low-only',
          efforts: ['low'],
          supports_disabled: false,
        }),
      );
      const agent: LocalAgentDefinition = {
        ...MOCK_AGENT_V1,
        name: 'UnsupportedEffortAgent',
        effort: 'high',
        modelConfig: { model: 'low-only' },
      };

      await registry.testRegisterAgent(agent);

      expect(registry.getDefinition(agent.name)).toBeUndefined();
      expect(registry.getLoadErrors()).toContainEqual(
        expect.objectContaining({
          name: agent.name,
          message:
            'Model/effort validation failed: configured model "low-only" does not support effort "high". Supported efforts: low.',
        }),
      );
    });

    it('should reject effort when the explicit model has no configurable reasoning efforts', async () => {
      mockListedModel(
        makeModelEntry({
          key: 'no-effort',
          efforts: [],
          supports_disabled: false,
        }),
      );
      const agent: LocalAgentDefinition = {
        ...MOCK_AGENT_V1,
        name: 'NoEffortAgent',
        effort: 'low',
        modelConfig: { model: 'no-effort' },
      };

      await registry.testRegisterAgent(agent);

      expect(registry.getDefinition(agent.name)).toBeUndefined();
      expect(registry.getLoadErrors()).toContainEqual(
        expect.objectContaining({
          name: agent.name,
          message:
            'Model/effort validation failed: configured model "no-effort" does not support configurable reasoning effort.',
        }),
      );
    });

    it('should reject an explicit model and effort when the ready catalog cannot find the model', async () => {
      mockListedModel(undefined);
      const agent: LocalAgentDefinition = {
        ...MOCK_AGENT_V1,
        name: 'MissingModelAgent',
        effort: 'low',
        modelConfig: { model: 'missing-model' },
      };

      await registry.testRegisterAgent(agent);

      expect(registry.getDefinition(agent.name)).toBeUndefined();
      expect(registry.getLoadErrors()).toContainEqual(
        expect.objectContaining({
          name: agent.name,
          message:
            'Model/effort validation failed: configured model "missing-model" was not found in the current model list.',
        }),
      );
    });

    it('should not validate an explicit model when the subagent does not define effort', async () => {
      mockListedModel(undefined);
      const agent: LocalAgentDefinition = {
        ...MOCK_AGENT_V1,
        name: 'ModelOnlyAgent',
        modelConfig: { model: 'missing-model' },
      };

      await registry.testRegisterAgent(agent);

      expect(registry.getDefinition(agent.name)).toBeDefined();
      expect(registry.getLoadErrors()).toHaveLength(0);
    });

    it('should defer a missing-model effort check until the model catalog is ready', async () => {
      mockSnapshotListed(false);
      mockListedModel(undefined);
      const agent: LocalAgentDefinition = {
        ...MOCK_AGENT_V1,
        name: 'DeferredEffortAgent',
        effort: 'high',
        modelConfig: { model: 'late-model' },
      };

      await registry.testRegisterAgent(agent);

      expect(registry.getDefinition(agent.name)).toBeDefined();
      expect(registry.getLoadErrors()).toHaveLength(0);
    });

    it('should revalidate deferred model effort after the catalog updates', async () => {
      await registry.initialize();
      const feedbackSpy = vi
        .spyOn(coreEvents, 'emitFeedback')
        .mockImplementation(() => {});
      mockSnapshotListed(false);
      mockListedModel(undefined);
      const agent: LocalAgentDefinition = {
        ...MOCK_AGENT_V1,
        name: 'DeferredInvalidEffortAgent',
        effort: 'high',
        modelConfig: { model: 'late-low-model' },
      };
      await registry.testRegisterAgent(agent);
      expect(registry.getDefinition(agent.name)).toBeDefined();

      mockSnapshotListed(true);
      mockListedModel(
        makeModelEntry({
          key: 'late-low-model',
          efforts: ['low'],
          supports_disabled: false,
        }),
      );
      coreEvents.emitModelInfoChanged();

      await vi.waitFor(() => {
        expect(registry.getDefinition(agent.name)).toBeUndefined();
      });
      expect(registry.getLoadErrors()).toContainEqual(
        expect.objectContaining({ name: agent.name }),
      );
      expect(feedbackSpy).toHaveBeenCalledWith(
        'warning',
        '1 error loading agent configs. Use /agents to see details.',
      );
      registry.dispose();
    });

    it('should handle special characters in agent names', async () => {
      const specialAgent = {
        ...MOCK_AGENT_V1,
        name: 'Agent-123_$pecial.v2',
      };
      await registry.testRegisterAgent(specialAgent);
      expect(registry.getDefinition('Agent-123_$pecial.v2')).toMatchObject(
        specialAgent,
      );
    });

    it('should reject an agent definition missing a name', async () => {
      const invalidAgent = { ...MOCK_AGENT_V1, name: '' };
      const debugWarnSpy = vi
        .spyOn(runLogger, 'warn')
        .mockImplementation(() => {});

      await registry.testRegisterAgent(invalidAgent);

      expect(registry.getDefinition('MockAgent')).toBeUndefined();
      expect(debugWarnSpy).toHaveBeenCalledWith(
        '[AgentRegistry] Skipping invalid agent definition. Missing name or description.',
      );
    });

    it('should reject an agent definition missing a description', async () => {
      const invalidAgent = { ...MOCK_AGENT_V1, description: '' };
      const debugWarnSpy = vi
        .spyOn(runLogger, 'warn')
        .mockImplementation(() => {});

      await registry.testRegisterAgent(invalidAgent as AgentDefinition);

      expect(registry.getDefinition('MockAgent')).toBeUndefined();
      expect(debugWarnSpy).toHaveBeenCalledWith(
        '[AgentRegistry] Skipping invalid agent definition. Missing name or description.',
      );
    });

    it('should overwrite an existing agent definition', async () => {
      await registry.testRegisterAgent(MOCK_AGENT_V1);
      expect(registry.getDefinition('MockAgent')?.description).toBe(
        'Mock Description V1',
      );

      await registry.testRegisterAgent(MOCK_AGENT_V2);
      expect(registry.getDefinition('MockAgent')?.description).toBe(
        'Mock Description V2 (Updated)',
      );
      expect(registry.getAllDefinitions()).toHaveLength(1);
    });

    it('should log overwrites when in debug mode', async () => {
      const debugConfig = makeMockedConfig({ debugMode: true });
      const debugRegistry = new TestableAgentRegistry(debugConfig);
      const debugLogSpy = vi
        .spyOn(runLogger, 'log')
        .mockImplementation(() => {});

      await debugRegistry.testRegisterAgent(MOCK_AGENT_V1);
      await debugRegistry.testRegisterAgent(MOCK_AGENT_V2);

      expect(debugLogSpy).toHaveBeenCalledWith(
        `[AgentRegistry] Overriding agent 'MockAgent'`,
      );
    });

    it('should not log overwrites when not in debug mode', async () => {
      const debugLogSpy = vi
        .spyOn(runLogger, 'log')
        .mockImplementation(() => {});

      await registry.testRegisterAgent(MOCK_AGENT_V1);
      await registry.testRegisterAgent(MOCK_AGENT_V2);

      expect(debugLogSpy).not.toHaveBeenCalledWith(
        `[AgentRegistry] Overriding agent 'MockAgent'`,
      );
    });

    it('should handle bulk registrations correctly', async () => {
      const promises = Array.from({ length: 100 }, (_, i) =>
        registry.testRegisterAgent({
          ...MOCK_AGENT_V1,
          name: `Agent${i}`,
        }),
      );

      await Promise.all(promises);
      expect(registry.getAllDefinitions()).toHaveLength(100);
    });
  });

  describe('reload', () => {
    it('should clear existing agents and reload from the resource snapshot', async () => {
      const config = makeMockedConfig({ enableAgents: true });
      const registry = new TestableAgentRegistry(config);

      const initialAgent = { ...MOCK_AGENT_V1, name: 'InitialAgent' };
      await registry.testRegisterAgent(initialAgent);
      expect(registry.getDefinition('InitialAgent')).toBeDefined();

      vi.spyOn(config, 'getResourceAgentDefinitions').mockReturnValue([
        resourceAgent('NewAgent', 'new agent', 'project'),
      ]);

      const emitSpy = vi.spyOn(coreEvents, 'emitAgentsRefreshed');

      await registry.reload();

      expect(registry.getDefinition('InitialAgent')).toBeUndefined();
      expect(registry.getDiscoveredDefinition('InitialAgent')).toBeUndefined();
      expect(registry.getDefinition('NewAgent')).toBeDefined();
      expect(registry.getDiscoveredDefinition('NewAgent')).toBeDefined();
      expect(emitSpy).toHaveBeenCalled();
    });

    it('should not duplicate --agents flag agents across reloads', async () => {
      const config = makeMockedConfig({
        enableAgents: true,
        inlineAgentsJson: JSON.stringify({
          reviewer: {
            description: '检查代码',
            prompt: '你负责检查代码质量',
          },
        }),
      });
      const registry = new TestableAgentRegistry(config);
      await registry.initialize();

      const flagEntries = () =>
        registry
          .getAllDiscoveredDefinitions()
          .filter((agent) => agent.metadata?.source === 'flag');

      expect(flagEntries()).toHaveLength(1);

      await registry.reload();
      await registry.reload();

      expect(flagEntries()).toHaveLength(1);
      expect(registry.getDefinition('reviewer')?.metadata?.source).toBe('flag');
    });

    it('should re-register SDK-injected agents after reload', async () => {
      const config = makeMockedConfig({ enableAgents: true });
      const registry = new TestableAgentRegistry(config);
      await registry.initialize();

      const sdkAgent: AgentDefinition = {
        ...MOCK_AGENT_V1,
        name: 'SdkAgent',
        description: 'SDK injected agent',
      };
      const result = await registry.registerSdkAgents([sdkAgent]);
      expect(result.registered).toEqual(['SdkAgent']);

      await registry.reload();

      expect(registry.getDefinition('SdkAgent')).toBeDefined();
      const sdkEntries = registry
        .getAllDiscoveredDefinitions()
        .filter((agent) => agent.name === 'SdkAgent');
      expect(sdkEntries).toHaveLength(1);
      expect(sdkEntries[0].metadata?.source).toBe('flag');
    });

    it('should preserve the previous SDK agent when a same-name registration throws', async () => {
      const config = makeMockedConfig({ enableAgents: true });
      const registry = new TestableAgentRegistry(config);
      await registry.initialize();
      await registry.registerSdkAgents([MOCK_AGENT_V1]);

      const result = await registry.registerSdkAgents([
        {
          ...MOCK_AGENT_V2,
          modelConfig: undefined,
        } as unknown as AgentDefinition,
      ]);
      expect(result.registered).toEqual([]);
      expect(result.failed).toHaveLength(1);
      expect(registry.getDefinition('MockAgent')?.description).toBe(
        MOCK_AGENT_V1.description,
      );

      await registry.reload();
      await registry.reload();

      expect(registry.getDefinition('MockAgent')?.description).toBe(
        MOCK_AGENT_V1.description,
      );
    });

    it('should preserve same-name SDK definitions in registration order across reloads', async () => {
      const config = makeMockedConfig({ enableAgents: true });
      const registry = new TestableAgentRegistry(config);
      await registry.initialize();
      await registry.registerSdkAgents([MOCK_AGENT_V1]);
      await registry.registerSdkAgents([MOCK_AGENT_V2]);

      const descriptions = () =>
        registry
          .getAllDiscoveredDefinitions()
          .filter((agent) => agent.name === 'MockAgent')
          .map((agent) => agent.description);
      const expected = [MOCK_AGENT_V1.description, MOCK_AGENT_V2.description];
      expect(descriptions()).toEqual(expected);

      await registry.reload();
      expect(descriptions()).toEqual(expected);
      await registry.reload();
      expect(descriptions()).toEqual(expected);
      expect(registry.getDefinition('MockAgent')?.description).toBe(
        MOCK_AGENT_V2.description,
      );
    });

    it('should retain disabled SDK definitions and the enabled same-name fallback across reloads', async () => {
      const config = makeMockedConfig({ enableAgents: true });
      const registry = new TestableAgentRegistry(config);
      await registry.initialize();
      const disabledAgent = { ...MOCK_AGENT_V2, experimental: true };
      const result = await registry.registerSdkAgents([
        MOCK_AGENT_V1,
        disabledAgent,
      ]);
      expect(result.registered).toEqual(['MockAgent']);
      expect(result.failed).toHaveLength(1);

      await registry.reload();
      await registry.reload();

      expect(registry.getDefinition('MockAgent')?.description).toBe(
        MOCK_AGENT_V1.description,
      );
      expect(
        registry
          .getAllDiscoveredDefinitions()
          .filter((agent) => agent.name === 'MockAgent')
          .map((agent) => agent.description),
      ).toEqual([MOCK_AGENT_V1.description, MOCK_AGENT_V2.description]);

      vi.spyOn(config, 'getAgentsSettings').mockReturnValue({
        overrides: { MockAgent: { enabled: true } },
      });
      await registry.reload();
      expect(registry.getDefinition('MockAgent')?.description).toBe(
        MOCK_AGENT_V2.description,
      );
    });
  });

  describe('inheritance and refresh', () => {
    it('should not duplicate discoveredList entries on model change refresh', async () => {
      const config = makeMockedConfig({
        model: 'initial-model',
        enableAgents: true,
      });
      const registry = new TestableAgentRegistry(config);

      // Register a project agent manually (simulating a loaded project agent)
      const projectAgent: AgentDefinition = {
        ...MOCK_AGENT_V1,
        name: 'ProjectAgent',
        description: 'A project agent',
        metadata: { source: 'project' },
      };
      await registry.initialize();
      await registry.testRegisterAgent(projectAgent);

      const countBefore = registry.getAllDiscoveredDefinitions().length;

      // Trigger model change which calls refreshAgents()
      vi.spyOn(config, 'getModel').mockReturnValue('new-model');
      coreEvents.emit(CoreEvent.ModelChanged, {
        sessionId: 'test-session',
        model: 'new-model',
      });

      await vi.waitFor(() => {
        // Wait for the async refreshAgents to complete
        const countAfter = registry.getAllDiscoveredDefinitions().length;
        expect(countAfter).toBe(countBefore);
      });
    });

    it('should preserve shadowed personal agents in discoveredList after model change refresh', async () => {
      const config = makeMockedConfig({
        model: 'initial-model',
        enableAgents: true,
      });
      const registry = new TestableAgentRegistry(config);
      await registry.initialize();

      // Register a user agent, then a project agent with the same name.
      // The project agent overwrites the user one in the active map,
      // but both should appear in discoveredList.
      const personalAgent: AgentDefinition = {
        ...MOCK_AGENT_V1,
        name: 'SameName',
        description: 'Personal version',
        metadata: { source: 'user' },
      };
      const projectAgent: AgentDefinition = {
        ...MOCK_AGENT_V1,
        name: 'SameName',
        description: 'Project version',
        metadata: { source: 'project' },
      };
      await registry.testRegisterAgent(personalAgent);
      await registry.testRegisterAgent(projectAgent);

      // Both versions should be in discoveredList
      const beforeRefresh = registry
        .getAllDiscoveredDefinitions()
        .filter((d) => d.name === 'SameName');
      expect(beforeRefresh).toHaveLength(2);
      expect(beforeRefresh.map((d) => d.metadata?.source)).toEqual([
        'user',
        'project',
      ]);

      // Trigger model change → refreshAgents()
      vi.spyOn(config, 'getModel').mockReturnValue('new-model');
      coreEvents.emit(CoreEvent.ModelChanged, {
        sessionId: 'test-session',
        model: 'new-model',
      });

      await vi.waitFor(() => {
        const sameNameEntries = registry
          .getAllDiscoveredDefinitions()
          .filter((d) => d.name === 'SameName');
        expect(sameNameEntries).toHaveLength(2);
        expect(sameNameEntries.map((d) => d.metadata?.source)).toEqual([
          'user',
          'project',
        ]);
      });

      // The active agent should be the project version (last registered wins)
      expect(registry.getDefinition('SameName')?.metadata?.source).toBe(
        'project',
      );
    });

    it('should keep "inherit" unresolved until agent execution', async () => {
      const config = makeMockedConfig({ model: 'current-model' });
      const registry = new TestableAgentRegistry(config);

      const agent: AgentDefinition = {
        ...MOCK_AGENT_V1,
        modelConfig: { ...MOCK_AGENT_V1.modelConfig, model: 'inherit' },
      };

      await registry.testRegisterAgent(agent);

      expect(registry.getDefinition(agent.name)?.modelConfig.model).toBe(
        'inherit',
      );
    });

    it('should not bind inherited agents to a changed CLI base model', async () => {
      const config = makeMockedConfig({ model: 'initial-model' });
      const registry = new TestableAgentRegistry(config);
      await registry.initialize();

      const agent: AgentDefinition = {
        ...MOCK_AGENT_V1,
        name: 'InheritingAgent',
        modelConfig: { ...MOCK_AGENT_V1.modelConfig, model: 'inherit' },
      };

      await registry.testRegisterAgent(agent);

      // Change model and emit event
      vi.spyOn(config, 'getModel').mockReturnValue('new-model');
      coreEvents.emit(CoreEvent.ModelChanged, {
        sessionId: 'test-session',
        model: 'new-model',
      });

      await vi.waitFor(() => {
        expect(
          registry.getDefinition('InheritingAgent')?.modelConfig.model,
        ).toBe('inherit');
      });
    });
  });

  describe('accessors', () => {
    const ANOTHER_AGENT: AgentDefinition = {
      ...MOCK_AGENT_V1,
      name: 'AnotherAgent',
    };

    beforeEach(async () => {
      await registry.testRegisterAgent(MOCK_AGENT_V1);
      await registry.testRegisterAgent(ANOTHER_AGENT);
    });

    it('getDefinition should return the correct definition', () => {
      expect(registry.getDefinition('MockAgent')).toMatchObject(MOCK_AGENT_V1);
      expect(registry.getDefinition('AnotherAgent')).toMatchObject(
        ANOTHER_AGENT,
      );
    });

    it('getDefinition should return undefined for unknown agents', () => {
      expect(registry.getDefinition('NonExistentAgent')).toBeUndefined();
    });

    it('getAllDefinitions should return all registered definitions', () => {
      const all = registry.getAllDefinitions();
      expect(all).toHaveLength(2);
      expect(all).toEqual(
        expect.arrayContaining([
          expect.objectContaining(MOCK_AGENT_V1),
          expect.objectContaining(ANOTHER_AGENT),
        ]),
      );
    });

    it('getAllDiscoveredAgentNames should return all names including disabled ones', async () => {
      const configWithDisabled = makeMockedConfig({
        agents: {
          overrides: {
            DisabledAgent: { enabled: false },
          },
        },
      });
      const registryWithDisabled = new TestableAgentRegistry(
        configWithDisabled,
      );

      const enabledAgent = { ...MOCK_AGENT_V1, name: 'EnabledAgent' };
      const disabledAgent = { ...MOCK_AGENT_V1, name: 'DisabledAgent' };

      await registryWithDisabled.testRegisterAgent(enabledAgent);
      await registryWithDisabled.testRegisterAgent(disabledAgent);

      const discoveredNames = registryWithDisabled.getAllDiscoveredAgentNames();
      expect(discoveredNames).toContain('EnabledAgent');
      expect(discoveredNames).toContain('DisabledAgent');
      expect(discoveredNames).toHaveLength(2);

      const activeNames = registryWithDisabled.getAllAgentNames();
      expect(activeNames).toContain('EnabledAgent');
      expect(activeNames).not.toContain('DisabledAgent');
      expect(activeNames).toHaveLength(1);
    });

    it('getDiscoveredDefinition should return the definition for a disabled agent', async () => {
      const configWithDisabled = makeMockedConfig({
        agents: {
          overrides: {
            DisabledAgent: { enabled: false },
          },
        },
      });
      const registryWithDisabled = new TestableAgentRegistry(
        configWithDisabled,
      );

      const disabledAgent = {
        ...MOCK_AGENT_V1,
        name: 'DisabledAgent',
        description: 'I am disabled',
      };

      await registryWithDisabled.testRegisterAgent(disabledAgent);

      expect(
        registryWithDisabled.getDefinition('DisabledAgent'),
      ).toBeUndefined();

      const discovered =
        registryWithDisabled.getDiscoveredDefinition('DisabledAgent');
      expect(discovered).toBeDefined();
      expect(discovered?.description).toBe('I am disabled');
    });
  });

  describe('overrides', () => {
    it('should skip registration if agent is disabled in settings', async () => {
      const config = makeMockedConfig({
        agents: {
          overrides: {
            MockAgent: { enabled: false },
          },
        },
      });
      const registry = new TestableAgentRegistry(config);

      await registry.testRegisterAgent(MOCK_AGENT_V1);

      expect(registry.getDefinition('MockAgent')).toBeUndefined();
    });

    it('should merge runConfig overrides', async () => {
      const config = makeMockedConfig({
        agents: {
          overrides: {
            MockAgent: {
              runConfig: { maxTurns: 50 },
            },
          },
        },
      });
      const registry = new TestableAgentRegistry(config);

      await registry.testRegisterAgent(MOCK_AGENT_V1);

      const def = registry.getDefinition('MockAgent') as LocalAgentDefinition;
      expect(def.runConfig?.maxTurns).toBe(50);
      expect(def.runConfig?.maxTimeMinutes).toBe(
        MOCK_AGENT_V1.runConfig?.maxTimeMinutes,
      );
    });

    it('should apply modelConfig overrides', async () => {
      const config = makeMockedConfig({
        agents: {
          overrides: {
            MockAgent: {
              modelConfig: {
                model: 'overridden-model',
                generateContentConfig: {
                  temperature: 0.5,
                },
              },
            },
          },
        },
      });
      const registry = new TestableAgentRegistry(config);

      await registry.testRegisterAgent(MOCK_AGENT_V1);

      const resolved = registry.getDefinition('MockAgent')!.modelConfig;

      expect(resolved.model).toBe('overridden-model');
      expect(resolved.generateContentConfig?.temperature).toBe(0.5);
      // topP should still be MOCK_AGENT_V1.modelConfig.top_p (1) because we merged
      expect(resolved.generateContentConfig?.topP).toBe(1);
    });

    it('should deep merge generateContentConfig (e.g. thinkingConfig)', async () => {
      const config = makeMockedConfig({
        agents: {
          overrides: {
            MockAgent: {
              modelConfig: {
                generateContentConfig: {
                  thinkingConfig: {
                    thinkingBudget: 16384,
                  },
                },
              },
            },
          },
        },
      });
      const registry = new TestableAgentRegistry(config);

      const effortAgent: LocalAgentDefinition = {
        ...MOCK_AGENT_V1,
        effort: 'low',
      };
      await registry.testRegisterAgent(effortAgent);

      const resolved = registry.getDefinition('MockAgent')!.modelConfig;

      expect(resolved.generateContentConfig?.thinkingConfig).toEqual({
        includeThoughts: true, // Preserved from the agent definition
        thinkingBudget: 16384, // Overridden
      });
      const registered = registry.getDefinition(
        'MockAgent',
      ) as LocalAgentDefinition;
      expect(registered).toMatchObject({
        effort: 'low',
      });
      expect(registered[RESOLVED_AGENT_REASONING]).toEqual({
        thinkingBudget: 16384,
        reasoningEffort: 'high',
      });
    });

    it('should preserve lazy getters when applying overrides', async () => {
      let getterCalled = false;
      const agentWithGetter: LocalAgentDefinition = {
        ...MOCK_AGENT_V1,
        name: 'GetterAgent',
        get toolConfig() {
          getterCalled = true;
          return { tools: ['lazy-tool'] };
        },
      };

      const config = makeMockedConfig({
        agents: {
          overrides: {
            GetterAgent: {
              runConfig: { maxTurns: 100 },
            },
          },
        },
      });
      const registry = new TestableAgentRegistry(config);

      await registry.testRegisterAgent(agentWithGetter);

      const registeredDef = registry.getDefinition(
        'GetterAgent',
      ) as LocalAgentDefinition;

      expect(registeredDef.runConfig?.maxTurns).toBe(100);
      expect(getterCalled).toBe(false); // Getter should not have been called yet
      expect(registeredDef.toolConfig?.tools).toEqual(['lazy-tool']);
      expect(getterCalled).toBe(true); // Getter should have been called now
    });
  });
});
