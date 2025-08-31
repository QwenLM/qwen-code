import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SpyInstance } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { promises as fsPromises } from 'node:fs';
import { ToolRegistry } from './tool-registry.js';
import * as ToolRegistryModule from './tool-registry.js';
import { Config, ConfigParameters, ApprovalMode } from '../config/config.js';
import { PromptRegistry } from '../prompts/prompt-registry.js';

const baseConfigParams: ConfigParameters = {
  cwd: '/app',
  model: 'test-model',
  embeddingModel: 'test-embedding-model',
  sandbox: undefined,
  targetDir: '/app',
  debugMode: false,
  userMemory: '',
  geminiMdFileCount: 0,
  approvalMode: ApprovalMode.DEFAULT,
  sessionId: 'test-session-id',
};

// Define mock tool content
const validToolModule = {
  default: {
    name: 'valid_tool',
    description: 'A valid test tool.',
    build: (params: unknown) => ({
      params,
      execute: () => Promise.resolve({ llmContent: 'test' }),
    }),
  },
};

const invalidToolModule = {
  default: {
    description: 'An invalid test tool.',
    build: () => {},
  },
};

describe('Custom Tool Loading', () => {
  let config: Config;
  let toolRegistry: ToolRegistry;
  let importSpy: SpyInstance;

  beforeEach(() => {
    config = new Config(baseConfigParams);
    toolRegistry = new ToolRegistry(config);
    const mockPromptRegistry: Partial<PromptRegistry> = {
      clear: vi.fn(),
    };
    vi.spyOn(config, 'getPromptRegistry').mockReturnValue(
      mockPromptRegistry as PromptRegistry,
    );
    vi.spyOn(config, 'getToolDiscoveryCommand').mockReturnValue(undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // Mock fs promises functions
    vi.spyOn(fsPromises, 'access').mockRejectedValue(new Error('ENOENT'));
    vi.spyOn(fsPromises, 'readdir').mockResolvedValue([]);

    // Spy on the extracted import function
    importSpy = vi.spyOn(ToolRegistryModule, 'importCustomTool');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should load a valid custom tool from the file system', async () => {
    vi.mocked(fsPromises.access).mockResolvedValue(undefined);
    vi.mocked(fsPromises.readdir).mockResolvedValue(['valid-tool.js']);
    importSpy.mockResolvedValue(validToolModule);

    await toolRegistry.discoverAllTools();
    const loadedTool = toolRegistry.getTool('valid_tool');

    expect(loadedTool).toBeDefined();
    expect(loadedTool?.name).toBe('valid_tool');
    expect(importSpy).toHaveBeenCalledWith(
      path.join(os.homedir(), '.qwen', 'tools', 'valid-tool.js'),
    );
  });

  it('should not load an invalid tool and should log an error', async () => {
    vi.mocked(fsPromises.access).mockResolvedValue(undefined);
    vi.mocked(fsPromises.readdir).mockResolvedValue(['invalid-tool.js']);
    importSpy.mockResolvedValue(invalidToolModule);

    await toolRegistry.discoverAllTools();

    expect(toolRegistry.getTool('invalid_tool')).toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Error validating custom tool'),
      expect.any(Error),
    );
  });

  it('should handle the tools directory not existing', async () => {
    // The default mock in beforeEach handles this
    await toolRegistry.discoverAllTools();
    expect(importSpy).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('should handle a tool file that fails to import', async () => {
    vi.mocked(fsPromises.access).mockResolvedValue(undefined);
    vi.mocked(fsPromises.readdir).mockResolvedValue(['bad-import.js']);
    importSpy.mockRejectedValue(new Error('Syntax Error'));

    await toolRegistry.discoverAllTools();

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to load custom tool'),
      expect.any(Error),
    );
  });
});
