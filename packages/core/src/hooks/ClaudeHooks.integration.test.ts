import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { HookService } from './HookService.js';
import { HookType } from './HookManager.js';
import type { Config } from '../config/config.js';

// Mock config object for testing
const createMockConfig = (): Config =>
  ({
    getTargetDir: () => '/tmp',
    getProjectRoot: () => '/tmp/test-project',
    storage: {
      getProjectTempDir: () => '/tmp/test-project/.qwen',
    },
    getSessionId: () => 'test-session-123',
    getHooksSettings: () => ({
      enabled: true,
      hooks: [],
      claudeHooks: [],
    }),
  }) as unknown as Config;

describe('ClaudeHooks Integration Tests', () => {
  let mockConfig: Config;

  beforeEach(() => {
    mockConfig = createMockConfig();
  });

  afterEach(() => {
    // Clean up any temporary files created during tests
    vi.clearAllMocks();
  });

  it('should convert Qwen payload to Claude-compatible format', () => {
    const hookServiceInstance = new HookService(mockConfig);

    // Create a test payload similar to what would come from Qwen tool execution
    const qwenPayload = {
      id: 'test-payload-1',
      timestamp: Date.now(),
      toolName: 'Write',
      params: {
        file_path: '/path/to/file.txt',
        content: 'test content',
      },
    };

    // Test conversion to Claude format
    const claudePayload = hookServiceInstance['convertToClaudeFormat'](
      qwenPayload,
      { config: mockConfig },
      HookType.BEFORE_TOOL_USE,
    );

    // Verify Claude-compatible fields are present
    expect(claudePayload['session_id']).toBe('test-session-123');
    expect(claudePayload['hook_event_name']).toBe('PreToolUse'); // Should map BEFORE_TOOL_USE to PreToolUse
    expect(claudePayload['tool_name']).toBe('write_file'); // Should map Write to write_file
    expect(claudePayload['tool_input']).toBeDefined();
    expect(claudePayload['tool_input']).toHaveProperty('file_path');
    expect(claudePayload['tool_input']).toHaveProperty('content');
    expect(claudePayload['timestamp']).toBe(qwenPayload.timestamp);
  });

  it('should handle Claude hook responses correctly', () => {
    // Test the response processing function with a sample Claude response
    const hookServiceInstance = new HookService(mockConfig);

    // Create a mock response string from a Claude hook script
    const mockResponseStr = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason:
          'Auto-approved read file operation for testing',
      },
    });

    // Mock console.log to capture output
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Process the response
    hookServiceInstance['processClaudeHookResponse'](
      mockResponseStr,
      HookType.BEFORE_TOOL_USE,
    );

    // Verify that the response was processed
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('PreToolUse hook decision: allow'),
    );

    consoleSpy.mockRestore();
  });

  it('should handle PreToolUse hook responses with updated input', () => {
    const hookServiceInstance = new HookService(mockConfig);

    // Create a mock response string with updated input from a Claude hook script
    const mockResponseStr = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'Auto-approved with updates',
        updatedInput: {
          file_path: '/updated/path.txt',
          content: 'updated content',
        },
      },
    });

    // Mock console.log to capture output
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Process the response
    hookServiceInstance['processClaudeHookResponse'](
      mockResponseStr,
      HookType.BEFORE_TOOL_USE,
    );

    // Verify that the response was processed including updated input info
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('PreToolUse hook decision: allow'),
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('updated input:'),
    );

    consoleSpy.mockRestore();
  });

  it('should handle PostToolUse hook responses', () => {
    const hookServiceInstance = new HookService(mockConfig);

    // Create a mock response string from a Claude hook script
    const mockResponseStr = JSON.stringify({
      decision: 'block',
      reason: 'Post-tool use validation failed',
      hookSpecificOutput: {
        additionalContext: 'Additional context for Claude',
      },
    });

    // Mock console.log to capture output
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Process the response
    hookServiceInstance['processClaudeHookResponse'](
      mockResponseStr,
      HookType.AFTER_TOOL_USE,
    );

    // Verify that the response was processed
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('PostToolUse hook: block decision'),
    );

    consoleSpy.mockRestore();
  });

  it('should handle Stop hook responses', () => {
    const hookServiceInstance = new HookService(mockConfig);

    // Create a mock response string from a Claude hook script
    const mockResponseStr = JSON.stringify({
      decision: 'block',
      reason: 'Testing: Stop operation blocked for testing purposes',
    });

    // Mock console.log to capture output
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Process the response
    hookServiceInstance['processClaudeHookResponse'](
      mockResponseStr,
      HookType.SESSION_END,
    );

    // Verify that the response was processed
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Stop/SubagentStop hook: block decision'),
    );

    consoleSpy.mockRestore();
  });

  it('should handle UserPromptSubmit hook responses', () => {
    const hookServiceInstance = new HookService(mockConfig);

    // Create a mock response string from a Claude hook script
    const mockResponseStr = JSON.stringify({
      decision: 'block',
      reason: 'Prompt contains potential sensitive information',
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'Additional context for Claude',
      },
    });

    // Mock console.log to capture output
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Process the response
    hookServiceInstance['processClaudeHookResponse'](
      mockResponseStr,
      HookType.INPUT_RECEIVED,
    );

    // Verify that the response was processed
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('UserPromptSubmit hook: block decision'),
    );

    consoleSpy.mockRestore();
  });

  it('should handle error responses from Claude hooks', () => {
    const hookServiceInstance = new HookService(mockConfig);

    // Test with malformed JSON
    const malformedResponseStr =
      '{"malformed": "json", "missing": "closing brace"';

    // Mock console.error to capture output
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Process the malformed response
    hookServiceInstance['processClaudeHookResponse'](
      malformedResponseStr,
      HookType.BEFORE_TOOL_USE,
    );

    // Verify that the error was handled
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Error processing Claude hook response'),
    );

    consoleSpy.mockRestore();
  });

  it('should properly map Claude events to Qwen hook types', () => {
    const hookServiceInstance = new HookService(mockConfig);

    // Test various Claude event mappings
    expect(
      hookServiceInstance['convertClaudeEventToHookType']('PreToolUse'),
    ).toBe(HookType.BEFORE_TOOL_USE);
    expect(
      hookServiceInstance['convertClaudeEventToHookType']('PostToolUse'),
    ).toBe(HookType.AFTER_TOOL_USE);
    expect(hookServiceInstance['convertClaudeEventToHookType']('Stop')).toBe(
      HookType.SESSION_END,
    );
    expect(
      hookServiceInstance['convertClaudeEventToHookType']('SubagentStop'),
    ).toBe(HookType.SESSION_END);
    expect(
      hookServiceInstance['convertClaudeEventToHookType']('UserPromptSubmit'),
    ).toBe(HookType.INPUT_RECEIVED);
    expect(
      hookServiceInstance['convertClaudeEventToHookType']('SessionStart'),
    ).toBe(HookType.SESSION_START);
    expect(
      hookServiceInstance['convertClaudeEventToHookType']('SessionEnd'),
    ).toBe(HookType.SESSION_END);
    expect(
      hookServiceInstance['convertClaudeEventToHookType']('PreCompact'),
    ).toBe(HookType.BEFORE_COMPACT);
    expect(
      hookServiceInstance['convertClaudeEventToHookType']('Notification'),
    ).toBe(HookType.SESSION_NOTIFICATION);
  });

  it('should convert Qwen tool names to Claude tool names', () => {
    const hookServiceInstance = new HookService(mockConfig);

    // Test tool name mappings
    expect(hookServiceInstance['mapQwenToClaudeToolName']('Write')).toBe(
      'write_file',
    );
    expect(hookServiceInstance['mapQwenToClaudeToolName']('Edit')).toBe(
      'replace',
    );
    expect(hookServiceInstance['mapQwenToClaudeToolName']('Bash')).toBe(
      'run_shell_command',
    );
    expect(hookServiceInstance['mapQwenToClaudeToolName']('Read')).toBe(
      'read_file',
    );
    expect(hookServiceInstance['mapQwenToClaudeToolName']('Grep')).toBe('grep');
    expect(hookServiceInstance['mapQwenToClaudeToolName']('Glob')).toBe('glob');
    expect(hookServiceInstance['mapQwenToClaudeToolName']('TodoWrite')).toBe(
      'todo_write',
    );
  });

  it('should convert tool input formats for Claude compatibility', () => {
    const hookServiceInstance = new HookService(mockConfig);

    // Test with a Write tool payload
    const writePayload = {
      id: 'test',
      timestamp: Date.now(),
      toolName: 'Write',
      params: {
        file_path: '/test/path.txt',
        content: 'test content',
      },
    };

    const converted = hookServiceInstance['convertToolInputFormat'](
      writePayload,
      HookType.BEFORE_TOOL_USE,
    );

    // Should have tool_name and tool_input in Claude format
    expect(converted['tool_name']).toBe('write_file');
    expect(converted['tool_input']).toBeDefined();
    expect(converted['tool_input']).toEqual({
      file_path: '/test/path.txt',
      content: 'test content',
    });
  });
});
