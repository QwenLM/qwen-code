/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  HookAggregator,
  aggregateHookResults,
  DEFAULT_AGGREGATION_CONFIG,
  EVENT_AGGREGATION_CONFIGS,
} from './aggregator.js';
import type { HookExecutionResult } from './types.js';
import {
  HookEventName,
  HookType,
  DefaultHookOutput,
  PreToolUseHookOutput,
} from './types.js';

describe('HookAggregator', () => {
  // Helper function to create a mock execution result
  const createMockResult = (
    success: boolean,
    output?: DefaultHookOutput,
    overrides?: Partial<HookExecutionResult>,
  ): HookExecutionResult => ({
    hookConfig: { type: HookType.Command, command: 'test-hook' },
    eventName: HookEventName.PreToolUse,
    success,
    output,
    stdout: '',
    stderr: '',
    exitCode: success ? 0 : 1,
    duration: 100,
    ...overrides,
  });

  describe('DEFAULT_AGGREGATION_CONFIG', () => {
    it('should have correct default values', () => {
      expect(DEFAULT_AGGREGATION_CONFIG.decisionStrategy).toBe(
        'block-priority',
      );
      expect(DEFAULT_AGGREGATION_CONFIG.systemMessageStrategy).toBe(
        'concatenate',
      );
      expect(DEFAULT_AGGREGATION_CONFIG.reasonStrategy).toBe('concatenate');
      expect(DEFAULT_AGGREGATION_CONFIG.contextStrategy).toBe('concatenate');
      expect(DEFAULT_AGGREGATION_CONFIG.mergeUpdatedInputs).toBe(true);
      expect(DEFAULT_AGGREGATION_CONFIG.separator).toBe('\n\n');
    });
  });

  describe('EVENT_AGGREGATION_CONFIGS', () => {
    it('should have PreToolUse config with block-priority', () => {
      const config = EVENT_AGGREGATION_CONFIGS[HookEventName.PreToolUse];
      expect(config?.decisionStrategy).toBe('block-priority');
      expect(config?.mergeUpdatedInputs).toBe(true);
    });

    it('should have PermissionRequest config with block-priority', () => {
      const config = EVENT_AGGREGATION_CONFIGS[HookEventName.PermissionRequest];
      expect(config?.decisionStrategy).toBe('block-priority');
      expect(config?.mergeUpdatedInputs).toBe(true);
    });

    it('should have PostToolUse config', () => {
      const config = EVENT_AGGREGATION_CONFIGS[HookEventName.PostToolUse];
      expect(config?.contextStrategy).toBe('concatenate');
    });

    it('should have UserPromptSubmit config', () => {
      const config = EVENT_AGGREGATION_CONFIGS[HookEventName.UserPromptSubmit];
      expect(config?.contextStrategy).toBe('concatenate');
    });

    it('should have Stop config with block-priority', () => {
      const config = EVENT_AGGREGATION_CONFIGS[HookEventName.Stop];
      expect(config?.decisionStrategy).toBe('block-priority');
    });

    it('should have SubagentStop config with block-priority', () => {
      const config = EVENT_AGGREGATION_CONFIGS[HookEventName.SubagentStop];
      expect(config?.decisionStrategy).toBe('block-priority');
    });
  });

  describe('aggregate', () => {
    it('should handle empty results array', () => {
      const aggregator = new HookAggregator(HookEventName.PreToolUse);
      const result = aggregator.aggregate([]);

      expect(result.success).toBe(true);
      expect(result.isBlocking).toBe(false);
      expect(result.individualResults).toHaveLength(0);
      expect(result.reasons).toHaveLength(0);
    });

    it('should handle single successful result', () => {
      const output = new DefaultHookOutput({
        decision: 'allow',
        reason: 'Allowed',
      });
      const hookResult = createMockResult(true, output);

      const aggregator = new HookAggregator(HookEventName.PreToolUse);
      const result = aggregator.aggregate([hookResult]);

      expect(result.success).toBe(true);
      expect(result.output.decision).toBe('allow');
      expect(result.isBlocking).toBe(false);
      expect(result.reasons).toContain('Allowed');
    });

    it('should handle single failed result', () => {
      const output = new DefaultHookOutput({
        decision: 'block',
        reason: 'Blocked',
      });
      const hookResult = createMockResult(false, output);

      const aggregator = new HookAggregator(HookEventName.PreToolUse);
      const result = aggregator.aggregate([hookResult]);

      expect(result.success).toBe(false);
      expect(result.output.decision).toBe('block');
      expect(result.isBlocking).toBe(true);
    });

    it('should return isBlocking=false when all hooks allow', () => {
      const results = [
        createMockResult(true, new DefaultHookOutput({ decision: 'allow' })),
        createMockResult(true, new DefaultHookOutput({ decision: 'allow' })),
        createMockResult(true, new DefaultHookOutput({ decision: 'approve' })),
      ];

      const aggregator = new HookAggregator(HookEventName.PreToolUse);
      const result = aggregator.aggregate(results);

      expect(result.isBlocking).toBe(false);
      expect(result.output.decision).toBe('allow');
    });

    it('should return isBlocking=true when any hook blocks (block-priority)', () => {
      const results = [
        createMockResult(true, new DefaultHookOutput({ decision: 'allow' })),
        createMockResult(true, new DefaultHookOutput({ decision: 'block' })),
        createMockResult(true, new DefaultHookOutput({ decision: 'allow' })),
      ];

      const aggregator = new HookAggregator(HookEventName.PreToolUse);
      const result = aggregator.aggregate(results);

      expect(result.isBlocking).toBe(true);
      expect(result.output.decision).toBe('block');
    });

    it('should return isBlocking=true when any hook denies', () => {
      const results = [
        createMockResult(true, new DefaultHookOutput({ decision: 'allow' })),
        createMockResult(true, new DefaultHookOutput({ decision: 'deny' })),
      ];

      const aggregator = new HookAggregator(HookEventName.PreToolUse);
      const result = aggregator.aggregate(results);

      expect(result.isBlocking).toBe(true);
      expect(result.output.decision).toBe('block');
    });

    it('should return ask when any hook asks and none block', () => {
      const results = [
        createMockResult(true, new DefaultHookOutput({ decision: 'allow' })),
        createMockResult(true, new DefaultHookOutput({ decision: 'ask' })),
      ];

      const aggregator = new HookAggregator(HookEventName.PreToolUse);
      const result = aggregator.aggregate(results);

      expect(result.output.decision).toBe('ask');
    });
  });

  describe('decision merging strategies', () => {
    it('should use allow-priority strategy when configured', () => {
      const results = [
        createMockResult(true, new DefaultHookOutput({ decision: 'block' })),
        createMockResult(true, new DefaultHookOutput({ decision: 'allow' })),
      ];

      const aggregator = new HookAggregator(HookEventName.PreToolUse, {
        decisionStrategy: 'allow-priority',
      });
      const result = aggregator.aggregate(results);

      expect(result.output.decision).toBe('allow');
      expect(result.isBlocking).toBe(false);
    });

    it('should use first-wins strategy when configured', () => {
      const results = [
        createMockResult(true, new DefaultHookOutput({ decision: 'block' })),
        createMockResult(true, new DefaultHookOutput({ decision: 'allow' })),
      ];

      const aggregator = new HookAggregator(HookEventName.PreToolUse, {
        decisionStrategy: 'first-wins',
      });
      const result = aggregator.aggregate(results);

      expect(result.output.decision).toBe('block');
    });

    it('should use last-wins strategy when configured', () => {
      const results = [
        createMockResult(true, new DefaultHookOutput({ decision: 'block' })),
        createMockResult(true, new DefaultHookOutput({ decision: 'allow' })),
      ];

      const aggregator = new HookAggregator(HookEventName.PreToolUse, {
        decisionStrategy: 'last-wins',
      });
      const result = aggregator.aggregate(results);

      expect(result.output.decision).toBe('allow');
    });
  });

  describe('reason merging', () => {
    it('should concatenate reasons by default', () => {
      const results = [
        createMockResult(true, new DefaultHookOutput({ reason: 'Reason 1' })),
        createMockResult(true, new DefaultHookOutput({ reason: 'Reason 2' })),
      ];

      const aggregator = new HookAggregator(HookEventName.PreToolUse);
      const result = aggregator.aggregate(results);

      expect(result.output.reason).toBe('Reason 1\n\nReason 2');
      expect(result.reasons).toContain('Reason 1');
      expect(result.reasons).toContain('Reason 2');
    });

    it('should use first-only strategy for reasons when configured', () => {
      const results = [
        createMockResult(
          true,
          new DefaultHookOutput({ reason: 'First reason' }),
        ),
        createMockResult(
          true,
          new DefaultHookOutput({ reason: 'Second reason' }),
        ),
      ];

      const aggregator = new HookAggregator(HookEventName.PreToolUse, {
        reasonStrategy: 'first-only',
      });
      const result = aggregator.aggregate(results);

      expect(result.output.reason).toBe('First reason');
    });

    it('should use last-only strategy for reasons when configured', () => {
      const results = [
        createMockResult(
          true,
          new DefaultHookOutput({ reason: 'First reason' }),
        ),
        createMockResult(
          true,
          new DefaultHookOutput({ reason: 'Last reason' }),
        ),
      ];

      const aggregator = new HookAggregator(HookEventName.PreToolUse, {
        reasonStrategy: 'last-only',
      });
      const result = aggregator.aggregate(results);

      expect(result.output.reason).toBe('Last reason');
    });
  });

  describe('system message merging', () => {
    it('should concatenate system messages', () => {
      const results = [
        createMockResult(
          true,
          new DefaultHookOutput({ systemMessage: 'Message 1' }),
        ),
        createMockResult(
          true,
          new DefaultHookOutput({ systemMessage: 'Message 2' }),
        ),
      ];

      const aggregator = new HookAggregator(HookEventName.PreToolUse);
      const result = aggregator.aggregate(results);

      expect(result.output.systemMessage).toBe('Message 1\n\nMessage 2');
    });

    it('should use custom separator', () => {
      const results = [
        createMockResult(true, new DefaultHookOutput({ systemMessage: 'A' })),
        createMockResult(true, new DefaultHookOutput({ systemMessage: 'B' })),
      ];

      const aggregator = new HookAggregator(HookEventName.PreToolUse, {
        separator: ' | ',
      });
      const result = aggregator.aggregate(results);

      expect(result.output.systemMessage).toBe('A | B');
    });
  });

  describe('continue flag merging', () => {
    it('should continue=true if all hooks want to continue', () => {
      const results = [
        createMockResult(true, new DefaultHookOutput({ continue: true })),
        createMockResult(true, new DefaultHookOutput({ continue: true })),
      ];

      const aggregator = new HookAggregator(HookEventName.PreToolUse);
      const result = aggregator.aggregate(results);

      expect(result.output.continue).toBe(true);
    });

    it('should continue=false if any hook wants to stop', () => {
      const results = [
        createMockResult(true, new DefaultHookOutput({ continue: true })),
        createMockResult(true, new DefaultHookOutput({ continue: false })),
      ];

      const aggregator = new HookAggregator(HookEventName.PreToolUse);
      const result = aggregator.aggregate(results);

      expect(result.output.continue).toBe(false);
    });
  });

  describe('suppressOutput merging', () => {
    it('should suppress if any hook wants to suppress', () => {
      const results = [
        createMockResult(
          true,
          new DefaultHookOutput({ suppressOutput: false }),
        ),
        createMockResult(true, new DefaultHookOutput({ suppressOutput: true })),
      ];

      const aggregator = new HookAggregator(HookEventName.PreToolUse);
      const result = aggregator.aggregate(results);

      expect(result.output.suppressOutput).toBe(true);
    });

    it('should not suppress if all hooks do not want to suppress', () => {
      const results = [
        createMockResult(
          true,
          new DefaultHookOutput({ suppressOutput: false }),
        ),
        createMockResult(
          true,
          new DefaultHookOutput({ suppressOutput: false }),
        ),
      ];

      const aggregator = new HookAggregator(HookEventName.PreToolUse);
      const result = aggregator.aggregate(results);

      expect(result.output.suppressOutput).toBe(false);
    });
  });

  describe('updatedInput merging (PreToolUse)', () => {
    it('should merge updated inputs from PreToolUseHookOutput', () => {
      const results = [
        createMockResult(
          true,
          new PreToolUseHookOutput({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              updatedInput: { path: '/test', extra: 'value1' },
            },
          }),
        ),
        createMockResult(
          true,
          new PreToolUseHookOutput({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              updatedInput: { extra: 'value2', newField: 'added' },
            },
          }),
        ),
      ];

      const aggregator = new HookAggregator(HookEventName.PreToolUse);
      const result = aggregator.aggregate(results);

      const updatedInput = (
        result.output.hookSpecificOutput as {
          updatedInput?: Record<string, unknown>;
        }
      )?.updatedInput;
      expect(updatedInput).toEqual({
        path: '/test',
        extra: 'value2', // Last value wins
        newField: 'added',
      });
    });

    it('should merge PermissionRequest style updatedInput', () => {
      const results = [
        createMockResult(
          true,
          new PreToolUseHookOutput({
            hookSpecificOutput: {
              hookEventName: 'PermissionRequest',
              decision: {
                behavior: 'allow' as const,
                updatedInput: { command: 'ls' },
              },
            },
          }),
        ),
        createMockResult(
          true,
          new PreToolUseHookOutput({
            hookSpecificOutput: {
              hookEventName: 'PermissionRequest',
              decision: {
                behavior: 'allow' as const,
                updatedInput: { flags: '-la' },
              },
            },
          }),
        ),
      ];

      const aggregator = new HookAggregator(HookEventName.PermissionRequest);
      const result = aggregator.aggregate(results);

      const updatedInput = (
        result.output.hookSpecificOutput as {
          updatedInput?: Record<string, unknown>;
        }
      )?.updatedInput;
      expect(updatedInput).toEqual({
        command: 'ls',
        flags: '-la',
      });
    });

    it('should deep merge nested updated inputs', () => {
      const results = [
        createMockResult(
          true,
          new PreToolUseHookOutput({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              updatedInput: { config: { timeout: 30, retries: 3 } },
            },
          }),
        ),
        createMockResult(
          true,
          new PreToolUseHookOutput({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              updatedInput: { config: { retries: 5, enabled: true } },
            },
          }),
        ),
      ];

      const aggregator = new HookAggregator(HookEventName.PreToolUse);
      const result = aggregator.aggregate(results);

      const updatedInput = (
        result.output.hookSpecificOutput as {
          updatedInput?: { config?: Record<string, unknown> };
        }
      )?.updatedInput;
      expect(updatedInput?.config).toEqual({
        timeout: 30,
        retries: 5, // Last value wins at nested level
        enabled: true,
      });
    });
  });

  describe('additionalContext merging', () => {
    it('should merge additionalContext for PostToolUse', () => {
      const results = [
        createMockResult(
          true,
          new DefaultHookOutput({
            hookSpecificOutput: {
              hookEventName: 'PostToolUse',
              additionalContext: 'Context from hook 1',
            },
          }),
        ),
        createMockResult(
          true,
          new DefaultHookOutput({
            hookSpecificOutput: {
              hookEventName: 'PostToolUse',
              additionalContext: 'Context from hook 2',
            },
          }),
        ),
      ];

      const aggregator = new HookAggregator(HookEventName.PostToolUse);
      const result = aggregator.aggregate(results);

      expect(result.output.hookSpecificOutput?.['additionalContext']).toBe(
        'Context from hook 1\n\nContext from hook 2',
      );
    });

    it('should merge additionalContext for UserPromptSubmit', () => {
      const results = [
        createMockResult(
          true,
          new DefaultHookOutput({
            hookSpecificOutput: {
              hookEventName: 'UserPromptSubmit',
              additionalContext: 'User context 1',
            },
          }),
        ),
        createMockResult(
          true,
          new DefaultHookOutput({
            hookSpecificOutput: {
              hookEventName: 'UserPromptSubmit',
              additionalContext: 'User context 2',
            },
          }),
        ),
      ];

      const aggregator = new HookAggregator(HookEventName.UserPromptSubmit);
      const result = aggregator.aggregate(results);

      expect(result.output.hookSpecificOutput?.['additionalContext']).toBe(
        'User context 1\n\nUser context 2',
      );
    });
  });

  describe('permissionDecision merging', () => {
    it('should detect blocking from permissionDecision field', () => {
      const results = [
        createMockResult(
          true,
          new PreToolUseHookOutput({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: 'Denied by policy',
            },
          }),
        ),
      ];

      const aggregator = new HookAggregator(HookEventName.PreToolUse);
      const result = aggregator.aggregate(results);

      expect(result.isBlocking).toBe(true);
      expect(result.reasons).toContain('Denied by policy');
    });

    it('should handle mixed decision styles', () => {
      const results = [
        createMockResult(true, new DefaultHookOutput({ decision: 'allow' })),
        createMockResult(
          true,
          new PreToolUseHookOutput({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
            },
          }),
        ),
      ];

      const aggregator = new HookAggregator(HookEventName.PreToolUse);
      const result = aggregator.aggregate(results);

      expect(result.isBlocking).toBe(true);
      expect(result.output.decision).toBe('block');
    });
  });

  describe('success tracking', () => {
    it('should return success=true when all hooks succeed', () => {
      const results = [
        createMockResult(true),
        createMockResult(true),
        createMockResult(true),
      ];

      const aggregator = new HookAggregator(HookEventName.PreToolUse);
      const result = aggregator.aggregate(results);

      expect(result.success).toBe(true);
    });

    it('should return success=false when any hook fails', () => {
      const results = [
        createMockResult(true),
        createMockResult(false),
        createMockResult(true),
      ];

      const aggregator = new HookAggregator(HookEventName.PreToolUse);
      const result = aggregator.aggregate(results);

      expect(result.success).toBe(false);
    });

    it('should preserve all individual results', () => {
      const results = [
        createMockResult(true),
        createMockResult(false),
        createMockResult(true),
      ];

      const aggregator = new HookAggregator(HookEventName.PreToolUse);
      const result = aggregator.aggregate(results);

      expect(result.individualResults).toHaveLength(3);
      expect(result.individualResults[0].success).toBe(true);
      expect(result.individualResults[1].success).toBe(false);
      expect(result.individualResults[2].success).toBe(true);
    });
  });

  describe('event-specific behavior', () => {
    it('should not merge updatedInput for non-PreToolUse events when multiple results', () => {
      const results = [
        createMockResult(
          true,
          new DefaultHookOutput({
            hookSpecificOutput: {
              updatedInput: { should: 'not be merged' },
              otherField: 'should be kept',
            },
          }),
        ),
        createMockResult(
          true,
          new DefaultHookOutput({
            hookSpecificOutput: {
              anotherField: 'also kept',
            },
          }),
        ),
      ];

      const aggregator = new HookAggregator(HookEventName.PostToolUse);
      const result = aggregator.aggregate(results);

      // For PostToolUse with multiple results, updatedInput should be filtered out
      // but other fields should be preserved
      expect(
        result.output.hookSpecificOutput?.['updatedInput'],
      ).toBeUndefined();
      expect(result.output.hookSpecificOutput?.['otherField']).toBe(
        'should be kept',
      );
      expect(result.output.hookSpecificOutput?.['anotherField']).toBe(
        'also kept',
      );
    });

    it('should return original output when single result', () => {
      const results = [
        createMockResult(
          true,
          new DefaultHookOutput({
            hookSpecificOutput: {
              updatedInput: { should: 'be preserved for single result' },
            },
          }),
        ),
      ];

      const aggregator = new HookAggregator(HookEventName.PostToolUse);
      const result = aggregator.aggregate(results);

      // For single result, original output is returned as-is
      expect(result.output.hookSpecificOutput?.['updatedInput']).toEqual({
        should: 'be preserved for single result',
      });
    });
  });
});

describe('aggregateHookResults', () => {
  // Helper function for this describe block
  const createMockResult = (
    success: boolean,
    output?: DefaultHookOutput,
    overrides?: Partial<HookExecutionResult>,
  ): HookExecutionResult => ({
    hookConfig: { type: HookType.Command, command: 'test-hook' },
    eventName: HookEventName.PreToolUse,
    success,
    output,
    stdout: '',
    stderr: '',
    exitCode: success ? 0 : 1,
    duration: 100,
    ...overrides,
  });

  it('should be a convenience function that creates aggregator and aggregates', () => {
    const results = [
      createMockResult(true, new DefaultHookOutput({ decision: 'allow' })),
      createMockResult(true, new DefaultHookOutput({ decision: 'block' })),
    ];

    const result = aggregateHookResults(HookEventName.PreToolUse, results);

    expect(result.output.decision).toBe('block');
    expect(result.isBlocking).toBe(true);
  });

  it('should accept custom config', () => {
    const results = [
      createMockResult(true, new DefaultHookOutput({ decision: 'block' })),
      createMockResult(true, new DefaultHookOutput({ decision: 'allow' })),
    ];

    const result = aggregateHookResults(HookEventName.PreToolUse, results, {
      decisionStrategy: 'allow-priority',
    });

    expect(result.output.decision).toBe('allow');
  });
});
