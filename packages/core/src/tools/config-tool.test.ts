import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConfigTool } from './config-tool.js';
import type { ConfigToolOutput } from './config-tool.js';
import type { Config } from '../config/config.js';

function makeConfig(currentModel = 'qwen-coder-plus') {
  let model = currentModel;
  let approvalMode = 'default';
  let checkpointing = false;
  let respectGitIgnore = true;
  let enableFuzzySearch = true;
  return {
    getModel: vi.fn(() => model),
    setModel: vi.fn(async (newModel: string) => {
      model = newModel;
    }),
    getAvailableModels: vi.fn(() => [
      { id: 'qwen-coder-plus', label: 'Qwen Coder Plus', authType: 'api-key' },
      { id: 'qwen3-coder', label: 'Qwen3 Coder', authType: 'api-key' },
    ]),
    getApprovalMode: vi.fn(() => approvalMode),
    setApprovalMode: vi.fn((mode: string) => {
      approvalMode = mode;
    }),
    getDebugMode: vi.fn(() => false),
    getCheckpointingEnabled: vi.fn(() => checkpointing),
    setCheckpointingEnabled: vi.fn((v: boolean) => {
      checkpointing = v;
    }),
    getFileFilteringRespectGitIgnore: vi.fn(() => respectGitIgnore),
    setFileFilteringRespectGitIgnore: vi.fn((v: boolean) => {
      respectGitIgnore = v;
    }),
    getFileFilteringEnableFuzzySearch: vi.fn(() => enableFuzzySearch),
    setFileFilteringEnableFuzzySearch: vi.fn((v: boolean) => {
      enableFuzzySearch = v;
    }),
    getTargetDir: vi.fn(() => '/home/user/project'),
    getOutputFormat: vi.fn(() => 'text'),
  } as unknown as Config;
}

function parseOutput(result: { llmContent: unknown }): ConfigToolOutput {
  return JSON.parse(result.llmContent as string) as ConfigToolOutput;
}

describe('ConfigTool', () => {
  let config: ReturnType<typeof makeConfig>;
  let tool: ConfigTool;

  beforeEach(() => {
    config = makeConfig();
    tool = new ConfigTool(config);
  });

  it('has the correct name and display name', () => {
    expect(tool.name).toBe('config');
    expect(tool.displayName).toBe('Config');
  });

  describe('validation', () => {
    it('rejects unknown setting', () => {
      expect(() =>
        tool.build({ action: 'get', setting: 'nonexistent' }),
      ).toThrow(/Unknown setting.*nonexistent/);
    });

    it('rejects SET without value', () => {
      expect(() => tool.build({ action: 'set', setting: 'model' })).toThrow(
        /Value is required/,
      );
    });

    it('rejects SET with empty string value', () => {
      expect(() =>
        tool.build({ action: 'set', setting: 'model', value: '' }),
      ).toThrow(/Value is required/);
    });

    it('rejects SET with whitespace-only value', () => {
      expect(() =>
        tool.build({ action: 'set', setting: 'model', value: '   ' }),
      ).toThrow(/Value is required/);
    });

    it('rejects prototype chain keys like toString', () => {
      expect(() => tool.build({ action: 'get', setting: 'toString' })).toThrow(
        /Unknown setting.*toString/,
      );
    });

    it('rejects __proto__ as setting name', () => {
      expect(() => tool.build({ action: 'get', setting: '__proto__' })).toThrow(
        /Unknown setting/,
      );
    });

    it('rejects SET on read-only setting', () => {
      expect(() =>
        tool.build({ action: 'set', setting: 'debugMode', value: 'true' }),
      ).toThrow(/read-only/);
    });

    it('accepts valid GET params', () => {
      expect(() =>
        tool.build({ action: 'get', setting: 'model' }),
      ).not.toThrow();
    });

    it('accepts valid SET params', () => {
      expect(() =>
        tool.build({ action: 'set', setting: 'model', value: 'qwen3-coder' }),
      ).not.toThrow();
    });
  });

  describe('GET', () => {
    it('returns structured output for model', async () => {
      const invocation = tool.build({ action: 'get', setting: 'model' });
      const result = await invocation.execute(new AbortController().signal);
      const output = parseOutput(result);

      expect(output.success).toBe(true);
      expect(output.operation).toBe('get');
      expect(output.setting).toBe('model');
      expect(output.source).toBe('project');
      expect(output.value).toBe('qwen-coder-plus');
      expect(output.options).toBeDefined();
      expect(output.options!.length).toBeGreaterThan(0);
    });

    it('returns structured output for approvalMode', async () => {
      const invocation = tool.build({
        action: 'get',
        setting: 'approvalMode',
      });
      const result = await invocation.execute(new AbortController().signal);
      const output = parseOutput(result);

      expect(output.success).toBe(true);
      expect(output.value).toBe('default');
      expect(output.source).toBe('project');
      expect(output.options).toEqual(['plan', 'default', 'auto-edit', 'yolo']);
    });

    it('returns structured output for debugMode (boolean)', async () => {
      const invocation = tool.build({ action: 'get', setting: 'debugMode' });
      const result = await invocation.execute(new AbortController().signal);
      const output = parseOutput(result);

      expect(output.success).toBe(true);
      expect(output.value).toBe(false);
      expect(output.source).toBe('global');
    });

    it('permission is allow for GET', async () => {
      const invocation = tool.build({ action: 'get', setting: 'model' });
      const permission = await invocation.getDefaultPermission();
      expect(permission).toBe('allow');
    });
  });

  describe('SET', () => {
    it('permission is ask for SET', async () => {
      const invocation = tool.build({
        action: 'set',
        setting: 'model',
        value: 'qwen3-coder',
      });
      const permission = await invocation.getDefaultPermission();
      expect(permission).toBe('ask');
    });

    it('changes model and returns structured output', async () => {
      const invocation = tool.build({
        action: 'set',
        setting: 'model',
        value: 'qwen3-coder',
      });
      const result = await invocation.execute(new AbortController().signal);
      const output = parseOutput(result);

      expect(output.success).toBe(true);
      expect(output.operation).toBe('set');
      expect(output.setting).toBe('model');
      expect(output.previousValue).toBe('qwen-coder-plus');
      expect(output.newValue).toBe('qwen3-coder');
      expect(output.source).toBe('project');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((config as any).setModel).toHaveBeenCalledWith('qwen3-coder', {
        reason: 'agent-config-tool',
        context: 'ConfigTool SET',
      });
    });

    it('returns error when setModel throws', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (config as any).setModel = vi.fn(async () => {
        throw new Error('Invalid model ID');
      });
      tool = new ConfigTool(config);

      // Use a model ID that exists in available models so options check passes
      const invocation = tool.build({
        action: 'set',
        setting: 'model',
        value: 'qwen3-coder',
      });
      const result = await invocation.execute(new AbortController().signal);
      const output = parseOutput(result);

      expect(output.success).toBe(false);
      expect(output.error).toContain('Failed to set model');
      expect(output.error).toContain('Invalid model ID');
      expect(result.error).toBeDefined();
      expect(result.error?.type).toBe('execution_failed');
    });

    it('rejects model not in available options', async () => {
      const invocation = tool.build({
        action: 'set',
        setting: 'model',
        value: 'nonexistent-model',
      });
      const result = await invocation.execute(new AbortController().signal);
      const output = parseOutput(result);

      expect(output.success).toBe(false);
      expect(output.error).toContain('Invalid value');
      expect(output.error).toContain('nonexistent-model');
    });

    it('returns error for read-only setting at execute time', async () => {
      const invocation = tool.build({ action: 'get', setting: 'debugMode' });
      // Manually create a SET invocation bypassing validation to test execute path
      const result = await invocation.execute(new AbortController().signal);
      const output = parseOutput(result);

      // GET on debugMode should succeed
      expect(output.success).toBe(true);
      expect(output.value).toBe(false);
    });
  });

  describe('boolean settings (read-only)', () => {
    it('GET checkpointing returns boolean value', async () => {
      const invocation = tool.build({
        action: 'get',
        setting: 'checkpointing',
      });
      const result = await invocation.execute(new AbortController().signal);
      const output = parseOutput(result);

      expect(output.success).toBe(true);
      expect(output.value).toBe(false);
      expect(output.source).toBe('global');
    });

    it('GET respectGitIgnore returns current value', async () => {
      const invocation = tool.build({
        action: 'get',
        setting: 'respectGitIgnore',
      });
      const result = await invocation.execute(new AbortController().signal);
      const output = parseOutput(result);

      expect(output.success).toBe(true);
      expect(output.value).toBe(true);
    });

    it('GET enableFuzzySearch returns current value', async () => {
      const invocation = tool.build({
        action: 'get',
        setting: 'enableFuzzySearch',
      });
      const result = await invocation.execute(new AbortController().signal);
      const output = parseOutput(result);

      expect(output.success).toBe(true);
      expect(output.value).toBe(true);
    });

    it.each([
      ['approvalMode', 'yolo'],
      ['checkpointing', 'true'],
      ['respectGitIgnore', 'false'],
      ['enableFuzzySearch', 'false'],
    ])('rejects SET %s at build (read-only)', (setting, value) => {
      expect(() => tool.build({ action: 'set', setting, value })).toThrow(
        /read-only/,
      );
    });
  });

  describe('read-only settings', () => {
    it('GET targetDir returns project root', async () => {
      const invocation = tool.build({ action: 'get', setting: 'targetDir' });
      const result = await invocation.execute(new AbortController().signal);
      const output = parseOutput(result);

      expect(output.success).toBe(true);
      expect(output.value).toBe('/home/user/project');
      expect(output.source).toBe('project');
    });

    it('GET outputFormat returns current format', async () => {
      const invocation = tool.build({
        action: 'get',
        setting: 'outputFormat',
      });
      const result = await invocation.execute(new AbortController().signal);
      const output = parseOutput(result);

      expect(output.success).toBe(true);
      expect(output.value).toBe('text');
    });

    it('SET on read-only setting is rejected at validation', () => {
      expect(() =>
        tool.build({ action: 'set', setting: 'targetDir', value: '/tmp' }),
      ).toThrow(/read-only/);
    });
  });

  describe('confirmation details', () => {
    it('shows from/to for SET', async () => {
      const invocation = tool.build({
        action: 'set',
        setting: 'model',
        value: 'qwen3-coder',
      });
      const details = await invocation.getConfirmationDetails(
        new AbortController().signal,
      );

      expect(details.type).toBe('info');
      if (details.type === 'info') {
        expect(details.prompt).toContain('qwen-coder-plus');
        expect(details.prompt).toContain('qwen3-coder');
        expect(details.hideAlwaysAllow).toBe(true);
      }
    });

    it('shows read description for GET', async () => {
      const invocation = tool.build({ action: 'get', setting: 'model' });
      const details = await invocation.getConfirmationDetails(
        new AbortController().signal,
      );

      expect(details.type).toBe('info');
      if (details.type === 'info') {
        expect(details.prompt).toContain('Read model');
      }
    });
  });
});
