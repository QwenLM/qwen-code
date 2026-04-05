import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConfigTool } from './config-tool.js';
import type { Config } from '../config/config.js';

function makeConfig(currentModel = 'qwen-coder-plus') {
  let model = currentModel;
  return {
    getModel: vi.fn(() => model),
    setModel: vi.fn(async (newModel: string) => {
      model = newModel;
    }),
    getAvailableModels: vi.fn(() => [
      { id: 'qwen-coder-plus', label: 'Qwen Coder Plus', authType: 'api-key' },
      { id: 'qwen3-coder', label: 'Qwen3 Coder', authType: 'api-key' },
    ]),
  } as unknown as Config;
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
    it('returns current model value and available models', async () => {
      const invocation = tool.build({ action: 'get', setting: 'model' });
      const result = await invocation.execute(new AbortController().signal);

      expect(result.llmContent).toContain('model = qwen-coder-plus');
      expect(result.llmContent).toContain('Available models:');
      expect(result.llmContent).toContain('qwen-coder-plus');
      expect(result.llmContent).toContain('qwen3-coder');
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

    it('changes model on success', async () => {
      const invocation = tool.build({
        action: 'set',
        setting: 'model',
        value: 'qwen3-coder',
      });
      const result = await invocation.execute(new AbortController().signal);

      expect(result.llmContent).toContain("changed from 'qwen-coder-plus'");
      expect(result.llmContent).toContain("to 'qwen3-coder'");
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

      const invocation = tool.build({
        action: 'set',
        setting: 'model',
        value: 'nonexistent-model',
      });
      const result = await invocation.execute(new AbortController().signal);

      expect(result.llmContent).toContain('Failed to set model');
      expect(result.llmContent).toContain('Invalid model ID');
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
        expect(details.permissionRules).toEqual(['Config(set:model)']);
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
