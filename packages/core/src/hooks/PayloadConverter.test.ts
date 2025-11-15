import { describe, it, expect, beforeEach } from 'vitest';
import type { Config } from '../config/config.js';
import { HookType } from './HookManager.js';
import { PayloadConverter } from './PayloadConverter.js';
import { HookConfigLoader } from './HookConfigLoader.js';

// Mock Config interface for testing
const mockConfig: Config = {
  storage: {
    getProjectTempDir: () => '/tmp/test-temp',
  },
  getSessionId: () => 'test-session-123',
} as Config;

describe('PayloadConverter', () => {
  let mockConfigLoader: HookConfigLoader;
  let payloadConverter: PayloadConverter;

  beforeEach(() => {
    mockConfigLoader = new HookConfigLoader();
    payloadConverter = new PayloadConverter(mockConfig, mockConfigLoader);
  });

  describe('Conversion', () => {
    it('should convert Qwen payload to Claude format', () => {
      const qwenPayload = {
        id: 'test-id',
        timestamp: 1234567890,
        params: {
          file_path: 'test.txt',
          content: 'Hello World',
        },
        toolName: 'Write',
      };

      const mockContext = {
        config: mockConfig,
      };

      const claudeFormat = payloadConverter.convertToClaudeFormat(
        qwenPayload,
        mockContext,
        HookType.BEFORE_TOOL_USE,
      );

      expect(claudeFormat).toHaveProperty('session_id', 'test-session-123');
      expect(claudeFormat).toHaveProperty('hook_event_name');
      expect(claudeFormat).toHaveProperty('timestamp', 1234567890);
      expect(claudeFormat).toHaveProperty('tool_name');
      expect(claudeFormat).toHaveProperty('tool_input');
    });

    it('should handle different hook types for conversion', () => {
      const qwenPayload = {
        id: 'test-id',
        timestamp: 1234567890,
        data: 'test-data',
      };

      const mockContext = {
        config: mockConfig,
      };

      const inputReceivedFormat = payloadConverter.convertToClaudeFormat(
        qwenPayload,
        mockContext,
        HookType.INPUT_RECEIVED,
      );

      expect(inputReceivedFormat).toHaveProperty('session_id');
      expect(inputReceivedFormat).toHaveProperty('hook_event_name');
      // Should not have tool-specific properties for non-tool hooks
      expect(inputReceivedFormat).not.toHaveProperty('tool_name');
    });

    it('should convert tool input formats', () => {
      const toolPayload = {
        id: 'test-id',
        timestamp: 1234567890,
        params: {
          file_path: 'test.txt',
          content: 'Hello World',
        },
        toolName: 'Write',
      };

      const result = payloadConverter.convertToolInputFormat(
        toolPayload,
        HookType.BEFORE_TOOL_USE,
      );

      // Should return tool-specific format for BEFORE_TOOL_USE
      expect(result).toHaveProperty('tool_name');
      expect(result).toHaveProperty('tool_input');
    });
  });

  describe('processClaudeHookResponse', () => {
    it('should process PreToolUse hook response with decision', () => {
      const responseJson = JSON.stringify({
        decision: 'allow',
        reason: 'Tool is safe to execute',
        systemMessage: 'Tool approved by hook',
      });

      const result = payloadConverter.processClaudeHookResponse(
        responseJson,
        HookType.BEFORE_TOOL_USE,
      );

      expect(result).toHaveProperty('decision', 'allow');
      expect(result).toHaveProperty('reason', 'Tool is safe to execute');
      expect(result).toHaveProperty('systemMessage', 'Tool approved by hook');
    });

    it('should process PreToolUse hook response with hookSpecificOutput', () => {
      const responseJson = JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'Tool not allowed in this context',
        },
        systemMessage: 'Tool blocked by hook',
      });

      const result = payloadConverter.processClaudeHookResponse(
        responseJson,
        HookType.BEFORE_TOOL_USE,
      );

      expect(result).toHaveProperty('permissionDecision', 'deny');
      expect(result).toHaveProperty(
        'permissionDecisionReason',
        'Tool not allowed in this context',
      );
      expect(result).toHaveProperty('systemMessage', 'Tool blocked by hook');
      expect(result).toHaveProperty('hookSpecificOutput');
    });

    it('should handle malformed response JSON', () => {
      const result = payloadConverter.processClaudeHookResponse(
        'invalid json {',
        HookType.BEFORE_TOOL_USE,
      );

      expect(result).toEqual({});
    });
  });
});
