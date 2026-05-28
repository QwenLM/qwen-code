import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComputerUseTool } from './tool.js';
import { ComputerUseClient } from './client.js';
import { COMPUTER_USE_SCHEMAS } from './schemas.js';

function makeFakeClient(
  callToolImpl: (name: string, args: unknown) => Promise<unknown>,
) {
  const fake = {
    isStarted: () => true,
    start: vi.fn(async () => {}),
    callTool: vi.fn(callToolImpl),
    stop: vi.fn(async () => {}),
  };
  return fake as unknown as ComputerUseClient;
}

describe('ComputerUseTool', () => {
  beforeEach(() => {
    ComputerUseClient.setSharedForTest(undefined);
  });

  it('exposes qwen-facing name with computer_use__ prefix', () => {
    const tool = new ComputerUseTool('click', COMPUTER_USE_SCHEMAS.click);
    expect(tool.name).toBe('computer_use__click');
    expect(tool.displayName).toBe('computer_use__click');
  });

  it('marks itself as deferred', () => {
    const tool = new ComputerUseTool(
      'list_apps',
      COMPUTER_USE_SCHEMAS.list_apps,
    );
    expect(tool.shouldDefer).toBe(true);
    expect(tool.alwaysLoad).toBe(false);
  });

  it('forwards execute() to the shared client with the upstream name', async () => {
    const fake = makeFakeClient(async () => ({
      content: [{ type: 'text', text: '[]' }],
      isError: false,
    }));
    ComputerUseClient.setSharedForTest(fake);

    const tool = new ComputerUseTool(
      'list_apps',
      COMPUTER_USE_SCHEMAS.list_apps,
    );
    const invocation = tool.build({});
    const result = await invocation.execute(new AbortController().signal);

    expect(result.error).toBeUndefined();
    expect(fake.callTool).toHaveBeenCalledWith('list_apps', {});
  });

  it('returns an error result when client returns isError=true', async () => {
    const fake = makeFakeClient(async () => ({
      content: [{ type: 'text', text: 'something went wrong' }],
      isError: true,
    }));
    ComputerUseClient.setSharedForTest(fake);

    const tool = new ComputerUseTool('click', COMPUTER_USE_SCHEMAS.click);
    const invocation = tool.build({ app: 'TextEdit' });
    const result = await invocation.execute(new AbortController().signal);

    expect(result.error).toBeDefined();
    expect(String(result.llmContent)).toContain('something went wrong');
  });
});
