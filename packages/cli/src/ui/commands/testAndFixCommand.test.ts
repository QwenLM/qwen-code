import { describe, it, expect } from 'vitest';
import { testAndFixCommand } from './testAndFixCommand.js';
import { CommandContext, ToolActionReturn } from './types.js';

describe('testAndFixCommand', () => {
  it('should return a ToolActionReturn to run the shell command', async () => {
    const mockContext = {} as CommandContext; // The action doesn't use the context, so we can pass a dummy object.

    const result = await testAndFixCommand.action?.(mockContext, '');

    expect(result).toBeDefined();
    expect(result?.type).toBe('tool');

    const toolResult = result as ToolActionReturn;
    expect(toolResult.toolName).toBe('run_shell_command');
    expect(toolResult.toolArgs).toEqual({
      command: 'npm test',
      is_background: false,
    });
  });
});
