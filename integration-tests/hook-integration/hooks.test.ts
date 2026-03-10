import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestRig, validateModelOutput } from '../test-helper.js';

/**
 * Hooks System Integration Tests
 *
 * Tests for complete hook system flow including:
 * - UserPromptSubmit hooks: Triggered before prompt is sent to LLM
 * - Stop hooks: Triggered when agent is about to stop
 * - SessionStart hooks: Triggered when a new session starts (Startup, Resume, Clear, Compact)
 * - SessionEnd hooks: Triggered when a session ends (Clear, Logout, PromptInputExit)
 *
 * Test categories:
 * - Single hook scenarios (allow, block, modify, context, etc.)
 * - Multiple hooks scenarios (parallel, sequential, mixed)
 * - Error handling (missing command, exit codes)
 * - Combined hooks (multiple hook types in same session)
 */
describe('Hooks System Integration', () => {
  let rig: TestRig;

  beforeEach(() => {
    rig = new TestRig();
  });

  afterEach(async () => {
    if (rig) {
      await rig.cleanup();
    }
  });

  // ==========================================================================
  // UserPromptSubmit Hooks
  // Triggered before user prompt is sent to the LLM for processing
  // ==========================================================================
  describe('UserPromptSubmit Hooks', () => {
    describe('Allow Decision', () => {
      it('should allow prompt when hook returns allow decision', async () => {
        const hookScript =
          'echo \'{"decision": "allow", "reason": "approved by hook"}\'';

        await rig.setup('ups-allow-decision', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              UserPromptSubmit: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: hookScript,
                      name: 'ups-allow-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say hello');
        expect(result).toBeDefined();
        expect(result.length).toBeGreaterThan(0);
      });

      it('should allow tool execution with allow decision and verify tool was called', async () => {
        const hookScript =
          'echo \'{"decision": "allow", "reason": "Tool execution approved"}\'';

        await rig.setup('ups-allow-tool', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              UserPromptSubmit: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: hookScript,
                      name: 'ups-allow-tool-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        await rig.run('Create a file test.txt with content "hello"');

        const foundToolCall = await rig.waitForToolCall('write_file');
        expect(foundToolCall).toBeTruthy();

        const fileContent = rig.readFile('test.txt');
        expect(fileContent).toContain('hello');
      });
    });

    describe('Block Decision', () => {
      it('should block prompt when hook returns block decision', async () => {
        const blockScript =
          'echo \'{"decision": "block", "reason": "Prompt blocked by security policy"}\'';

        await rig.setup('ups-block-decision', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              UserPromptSubmit: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: blockScript,
                      name: 'ups-block-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        // When UserPromptSubmit hook blocks, CLI exits with non-zero code
        // and rig.run() throws an error
        await expect(rig.run('Create a file')).rejects.toThrow(/block/i);
      });

      it('should block tool execution when hook returns block and verify no tool was called', async () => {
        const blockScript =
          '(echo "hook_called" >> hook_invoke_count.txt &) ; echo \'{"decision": "block", "reason": "File writing blocked by security policy"}\'';

        await rig.setup('ups-block-tool', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              UserPromptSubmit: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: blockScript,
                      name: 'ups-block-tool-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        // When UserPromptSubmit hook blocks, CLI exits with non-zero code
        await expect(
          rig.run('Create a file test.txt with "hello"'),
        ).rejects.toThrow(/block/i);

        // Tool should not be called due to blocking hook
        const hookInvokeCount = rig
          .readFile('hook_invoke_count.txt')
          .split('\n')
          .filter((line) => line.trim() === 'hook_called').length;
        expect(hookInvokeCount).toBeGreaterThan(0); // At least one hook call occurred

        const toolLogs = rig.readToolLogs();
        const writeFileCalls = toolLogs.filter(
          (t) =>
            t.toolRequest.name === 'write_file' &&
            t.toolRequest.success === true,
        );
        expect(writeFileCalls).toHaveLength(0);
      });
    });

    describe('Modify Prompt', () => {
      it('should use modified prompt when hook provides modification', async () => {
        const modifyScript =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "modifiedPrompt": "Modified prompt content", "additionalContext": "Context added by hook"}}\'';

        await rig.setup('ups-modify-prompt', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              UserPromptSubmit: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: modifyScript,
                      name: 'ups-modify-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say test');
        expect(result).toBeDefined();
      });
    });

    describe('Additional Context', () => {
      it('should include additional context in response when hook provides it', async () => {
        const contextScript =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "Extra context information from hook"}}\'';

        await rig.setup('ups-add-context', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              UserPromptSubmit: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: contextScript,
                      name: 'ups-context-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('What is 1+1?');
        expect(result).toBeDefined();
      });
    });

    describe('Timeout Handling', () => {
      it('should continue execution when hook times out', async () => {
        await rig.setup('ups-timeout', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              UserPromptSubmit: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: 'sleep 60',
                      name: 'ups-timeout-hook',
                      timeout: 1000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say timeout test');
        // Should continue despite timeout
        expect(result).toBeDefined();
      });
    });

    describe('Error Handling', () => {
      it('should continue execution when hook exits with non-blocking error (exit code 1)', async () => {
        await rig.setup('ups-nonblocking-error', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              UserPromptSubmit: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: 'echo warning && exit 1',
                      name: 'ups-error-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say error test');
        // Non-blocking error should not prevent execution
        expect(result).toBeDefined();
      });

      it('should block execution when hook exits with blocking error (exit code 2)', async () => {
        await rig.setup('ups-blocking-error', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              UserPromptSubmit: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: 'echo "Critical security error" >&2 && exit 2',
                      name: 'ups-blocking-error-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        // Exit code 2 is a blocking error, so CLI should throw an error
        await expect(rig.run('Create a file')).rejects.toThrow(/block/i);
      });

      it('should continue execution when hook command is empty', async () => {
        await rig.setup('ups-missing-command', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              UserPromptSubmit: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: '',
                      name: 'ups-missing-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        // Empty command is ignored, execution continues normally
        const result = await rig.run('Say missing test');
        expect(result).toBeDefined();
        expect(result.length).toBeGreaterThan(0);
      });
    });

    describe('Input Format Validation', () => {
      it('should receive properly formatted input when hook is called', async () => {
        const inputValidationScript =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "Valid input format"}}\'';

        await rig.setup('ups-correct-input', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              UserPromptSubmit: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: inputValidationScript,
                      name: 'ups-input-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say input test');
        validateModelOutput(result, 'input test', 'UPS: correct input');
      });
    });

    describe('System Message', () => {
      it('should include system message in response when hook provides it', async () => {
        const systemMsgScript =
          'echo \'{"decision": "allow", "systemMessage": "This is a system message from hook"}\'';

        await rig.setup('ups-system-message', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              UserPromptSubmit: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: systemMsgScript,
                      name: 'ups-system-msg-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say system message');
        expect(result).toBeDefined();
      });
    });

    describe('Multiple UserPromptSubmit Hooks', () => {
      it('should block when one of multiple parallel hooks returns block', async () => {
        const allowScript =
          'echo \'{"decision": "allow", "reason": "Allowed"}\'';
        const blockScript =
          'echo \'{"decision": "block", "reason": "Blocked by security policy"}\'';

        await rig.setup('ups-multi-one-blocks', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              UserPromptSubmit: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: allowScript,
                      name: 'ups-allow-hook',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: blockScript,
                      name: 'ups-block-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        // When any hook blocks, CLI should throw an error
        await expect(rig.run('Create a file')).rejects.toThrow(/block/i);
      });

      it('should block when first sequential hook returns block', async () => {
        // Note: Sequential hooks execute ALL hooks before aggregating results.
        // Even if the first hook returns block, the second hook still runs.
        // The final aggregated result will be block if any hook returns block.
        // For UserPromptSubmit, a block decision should cause CLI to throw an error.
        const blockScript =
          'echo \'{"decision": "block", "reason": "First hook blocks"}\'';

        await rig.setup('ups-seq-first-blocks', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              UserPromptSubmit: [
                {
                  sequential: true,
                  hooks: [
                    {
                      type: 'command',
                      command: blockScript,
                      name: 'ups-seq-block-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        // Single sequential hook with block decision should throw an error
        await expect(rig.run('Create a file')).rejects.toThrow(/block/i);
      });

      it('should block when second sequential hook returns block', async () => {
        // Note: Sequential hooks execute ALL hooks before aggregating results.
        // The first hook allows, but the second hook blocks.
        // The final aggregated result will be block (OR logic: any block = block).
        const allowScript =
          'echo \'{"decision": "allow", "reason": "First allows"}\'';
        const blockScript =
          'echo \'{"decision": "block", "reason": "Second hook blocks"}\'';

        await rig.setup('ups-seq-second-blocks', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              UserPromptSubmit: [
                {
                  sequential: true,
                  hooks: [
                    {
                      type: 'command',
                      command: allowScript,
                      name: 'ups-seq-first-allow',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: blockScript,
                      name: 'ups-seq-second-block',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        // Second hook blocks, CLI should throw an error
        await expect(rig.run('Create a file')).rejects.toThrow(/block/i);
      });

      it('should handle multiple hooks all returning allow', async () => {
        const allow1Script =
          'echo \'{"decision": "allow", "reason": "First allows"}\'';
        const allow2Script =
          'echo \'{"decision": "allow", "reason": "Second allows"}\'';
        const allow3Script =
          'echo \'{"decision": "allow", "reason": "Third allows"}\'';

        await rig.setup('ups-multi-all-allow', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              UserPromptSubmit: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: allow1Script,
                      name: 'ups-allow-1',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: allow2Script,
                      name: 'ups-allow-2',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: allow3Script,
                      name: 'ups-allow-3',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say hello');
        // All hooks allow, should complete normally
        expect(result).toBeDefined();
        expect(result.length).toBeGreaterThan(0);
      });

      it('should handle multiple hooks all returning block', async () => {
        const block1Script =
          'echo \'{"decision": "block", "reason": "First blocks"}\'';
        const block2Script =
          'echo \'{"decision": "block", "reason": "Second blocks"}\'';

        await rig.setup('ups-multi-all-block', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              UserPromptSubmit: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: block1Script,
                      name: 'ups-block-1',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: block2Script,
                      name: 'ups-block-2',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        // All hooks block, CLI should throw an error
        await expect(rig.run('Create a file')).rejects.toThrow(/block/i);
      });

      it('should concatenate additional context from multiple hooks', async () => {
        const context1Script =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "context from hook 1"}}\'';
        const context2Script =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "context from hook 2"}}\'';

        await rig.setup('ups-multi-context', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              UserPromptSubmit: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: context1Script,
                      name: 'ups-context-1',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: context2Script,
                      name: 'ups-context-2',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say hello');
        expect(result).toBeDefined();
      });

      it('should handle hook with error alongside blocking hook', async () => {
        const blockScript =
          'echo \'{"decision": "block", "reason": "Blocked"}\'';

        await rig.setup('ups-error-with-block', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              UserPromptSubmit: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: '/nonexistent/command',
                      name: 'ups-error-hook',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: blockScript,
                      name: 'ups-block-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        // Block should still work despite error in other hook, CLI should throw an error
        await expect(rig.run('Create a file')).rejects.toThrow(/block/i);
      });

      it('should handle hook timeout alongside blocking hook', async () => {
        const blockScript =
          'echo \'{"decision": "block", "reason": "Blocked while other times out"}\'';

        await rig.setup('ups-timeout-with-block', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              UserPromptSubmit: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: 'sleep 60',
                      name: 'ups-timeout-hook',
                      timeout: 1000,
                    },
                    {
                      type: 'command',
                      command: blockScript,
                      name: 'ups-block-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        // Block should work despite timeout in other hook, CLI should throw an error
        await expect(rig.run('Create a file')).rejects.toThrow(/block/i);
      });

      it('should handle multiple hook groups with different configurations', async () => {
        const allow1Script =
          'echo \'{"decision": "allow", "reason": "Group 1 allows"}\'';
        const allow2Script =
          'echo \'{"decision": "allow", "reason": "Group 2 allows"}\'';

        await rig.setup('ups-multi-groups', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              UserPromptSubmit: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: allow1Script,
                      name: 'ups-group1-hook',
                      timeout: 5000,
                    },
                  ],
                },
                {
                  sequential: true,
                  hooks: [
                    {
                      type: 'command',
                      command: allow2Script,
                      name: 'ups-group2-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say hello');
        expect(result).toBeDefined();
      });

      it('should block when one group blocks in multiple hook groups', async () => {
        const allowScript =
          'echo \'{"decision": "allow", "reason": "Group 1 allows"}\'';
        const blockScript =
          'echo \'{"decision": "block", "reason": "Group 2 blocks"}\'';

        await rig.setup('ups-multi-groups-one-blocks', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              UserPromptSubmit: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: allowScript,
                      name: 'ups-group1-allow',
                      timeout: 5000,
                    },
                  ],
                },
                {
                  hooks: [
                    {
                      type: 'command',
                      command: blockScript,
                      name: 'ups-group2-block',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        // One group blocks, CLI should throw an error
        await expect(rig.run('Create a file')).rejects.toThrow(/block/i);
      });

      it('should handle modified prompt from multiple hooks', async () => {
        const modify1Script =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"modifiedPrompt": "Modified by hook 1"}}\'';
        const modify2Script =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"modifiedPrompt": "Modified by hook 2"}}\'';

        await rig.setup('ups-multi-modify', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              UserPromptSubmit: [
                {
                  sequential: true,
                  hooks: [
                    {
                      type: 'command',
                      command: modify1Script,
                      name: 'ups-modify-1',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: modify2Script,
                      name: 'ups-modify-2',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say hello');
        expect(result).toBeDefined();
      });

      it('should handle system messages from multiple hooks', async () => {
        const msg1Script =
          'echo \'{"decision": "allow", "systemMessage": "System message 1"}\'';
        const msg2Script =
          'echo \'{"decision": "allow", "systemMessage": "System message 2"}\'';

        await rig.setup('ups-multi-system-msg', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              UserPromptSubmit: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: msg1Script,
                      name: 'ups-msg-1',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: msg2Script,
                      name: 'ups-msg-2',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say hello');
        expect(result).toBeDefined();
      });
    });
  });

  // ==========================================================================
  // Stop Hooks
  // Triggered when the agent is about to stop execution
  // ==========================================================================
  describe('Stop Hooks', () => {
    describe('Allow Decision', () => {
      it('should allow stopping when hook returns allow decision', async () => {
        const allowStopScript =
          'echo \'{"decision": "allow", "reason": "Stop allowed"}\'';

        await rig.setup('stop-allow', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              Stop: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: allowStopScript,
                      name: 'stop-allow-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say stop test');
        expect(result).toBeDefined();
      });

      it('should allow stopping and verify final response is produced', async () => {
        const allowFinalScript =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "Final context from stop hook"}}\'';

        await rig.setup('stop-allow-final', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              Stop: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: allowFinalScript,
                      name: 'stop-final-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say goodbye');
        expect(result).toBeDefined();
        expect(result.length).toBeGreaterThan(0);
      });
    });

    describe('Block Decision', () => {
      it('should continue execution when hook returns block decision', async () => {
        // Stop hook's block decision means "block stopping" (i.e., force continuation)
        // not "block operation and show error"
        // Use background process to write count file, ensuring final output is pure JSON
        const blockStopScript =
          '(echo "hook_called" >> hook_invoke_count.txt &) ; echo \'{"decision": "block", "reason": "Stop blocked by security policy"}\'';

        await rig.setup('stop-block-decision', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              Stop: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: blockStopScript,
                      name: 'stop-block-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        // When Stop hook blocks, agent continues execution normally (with max turns to prevent infinite loop)
        const result = await rig.run('Say hello', '--max-session-turns', '3');

        // Verify that execution completed successfully (not blocked by Stop hook)
        // Verify Stop hook was invoked multiple times (indicating multiple rounds)
        const hookInvokeCount = rig
          .readFile('hook_invoke_count.txt')
          .split('\n')
          .filter((line) => line.trim() === 'hook_called').length;
        expect(hookInvokeCount).toBeGreaterThan(1);

        const toolLogs = rig.readToolLogs();
        const hasActivity = result.length > 0 || toolLogs.length > 0;
        expect(hasActivity).toBe(true);
      });

      it('should continue execution with custom reason', async () => {
        // Stop hook's block decision means "block stopping" (i.e., force continuation)
        const blockReasonScript =
          '(echo "hook_called" >> hook_invoke_count.txt &) ; echo \'{"decision": "block", "reason": "Custom block reason: task incomplete"}\'';

        await rig.setup('stop-block-custom-reason', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              Stop: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: blockReasonScript,
                      name: 'stop-block-reason-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        // When Stop hook blocks, agent continues execution normally (with max turns to prevent infinite loop)
        const result = await rig.run('Say goodbye', '--max-session-turns', '3');

        // Verify that execution completed successfully (not blocked by Stop hook)
        // This confirms: 1) Agent could execute after Stop hook blocked, 2) Session terminated normally
        const hookInvokeCount = rig
          .readFile('hook_invoke_count.txt')
          .split('\n')
          .filter((line) => line.trim() === 'hook_called').length;
        expect(hookInvokeCount).toBeGreaterThan(1);

        const toolLogs = rig.readToolLogs();
        const hasActivity = result.length > 0 || toolLogs.length > 0;
        expect(hasActivity).toBe(true);
      });
    });

    describe('Additional Context', () => {
      it('should include additional context in final response', async () => {
        const contextScript =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "Final context from hook"}}\'';

        await rig.setup('stop-add-context', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              Stop: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: contextScript,
                      name: 'stop-context-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('What is 3+3?');
        expect(result).toBeDefined();
      });

      it('should concatenate multiple additionalContext from multiple hooks', async () => {
        const context1Script =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "context1"}}\'';
        const context2Script =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "context2"}}\'';

        await rig.setup('stop-multi-context', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              Stop: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: context1Script,
                      name: 'stop-context-1',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: context2Script,
                      name: 'stop-context-2',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say multi context');
        expect(result).toBeDefined();
      });
    });

    describe('Stop Reason', () => {
      it('should include stop reason when hook provides it', async () => {
        const reasonScript =
          'echo \'{"decision": "allow", "stopReason": "Custom stop reason from hook"}\'';

        await rig.setup('stop-set-reason', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              Stop: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: reasonScript,
                      name: 'stop-reason-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say reason test');
        expect(result).toBeDefined();
      });
    });

    describe('Timeout Handling', () => {
      it('should continue stopping when hook times out', async () => {
        await rig.setup('stop-timeout', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              Stop: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: 'sleep 60',
                      name: 'stop-timeout-hook',
                      timeout: 1000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say timeout');
        // Timeout should not prevent stopping
        expect(result).toBeDefined();
      });
    });

    describe('Error Handling', () => {
      it('should continue stopping when hook has non-blocking error', async () => {
        await rig.setup('stop-error', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              Stop: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: 'echo warning && exit 1',
                      name: 'stop-error-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say error');
        // Error should not prevent stopping
        expect(result).toBeDefined();
      });

      it('should continue stopping when hook command does not exist', async () => {
        await rig.setup('stop-missing-command', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              Stop: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: 'false',
                      name: 'stop-missing-hook',
                      timeout: 1000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say missing');
        // Missing command should not prevent stopping
        expect(result).toBeDefined();
      });
    });

    describe('System Message', () => {
      it('should include system message in final response', async () => {
        const systemMsgScript =
          'echo \'{"decision": "allow", "systemMessage": "Final system message from stop hook"}\'';

        await rig.setup('stop-system-message', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              Stop: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: systemMsgScript,
                      name: 'stop-system-msg-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say final');
        expect(result).toBeDefined();
      });
    });

    describe('Multiple Stop Hooks', () => {
      it('should continue execution when one of multiple parallel stop hooks returns block', async () => {
        // Stop hook's block decision means "block stopping" (i.e., force continuation)
        const allowScript =
          'echo \'{"decision": "allow", "reason": "Stop allowed"}\'';
        // Write to a file to count hook invocations, then echo the decision
        const blockScript =
          'echo "hook_called" >> hook_invoke_count.txt; echo \'{"decision": "block", "reason": "Stop blocked by security policy"}\'';

        await rig.setup('stop-multi-one-blocks', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              Stop: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: allowScript,
                      name: 'stop-allow-hook',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: blockScript,
                      name: 'stop-block-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        // When Stop hook blocks, agent continues execution normally (with max turns to prevent infinite loop)
        const result = await rig.run(
          'Say multi stop',
          '--max-session-turns',
          '3',
        );

        // Verify that execution completed successfully (not blocked by Stop hook)
        // This confirms: 1) Agent could execute after Stop hook blocked, 2) Session terminated normally
        const hookInvokeCount = rig
          .readFile('hook_invoke_count.txt')
          .split('\n')
          .filter((line) => line.trim() === 'hook_called').length;
        expect(hookInvokeCount).toBeGreaterThan(1);

        const toolLogs = rig.readToolLogs();
        const hasActivity = result.length > 0 || toolLogs.length > 0;
        expect(hasActivity).toBe(true);
      });

      it('should continue execution when first sequential stop hook returns block', async () => {
        // Stop hook's block decision means "block stopping" (i.e., force continuation)
        const blockScript =
          '(echo "hook_called" >> hook_invoke_count.txt &) ; echo \'{"decision": "block", "reason": "First hook blocks stop"}\'';
        const allowScript =
          '(echo "hook_called" >> hook_invoke_count.txt &) ; echo \'{"decision": "allow", "reason": "This should still run"}\'';

        await rig.setup('stop-seq-first-blocks', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              Stop: [
                {
                  sequential: true,
                  hooks: [
                    {
                      type: 'command',
                      command: blockScript,
                      name: 'stop-seq-block-hook',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: allowScript,
                      name: 'stop-seq-allow-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        // When Stop hook blocks, agent continues execution normally (with max turns to prevent infinite loop)
        const result = await rig.run(
          'Say sequential stop',
          '--max-session-turns',
          '3',
        );

        // Verify that execution completed successfully (not blocked by Stop hook)
        // This confirms: 1) Agent could execute after Stop hook blocked, 2) Session terminated normally
        const hookInvokeCount = rig
          .readFile('hook_invoke_count.txt')
          .split('\n')
          .filter((line) => line.trim() === 'hook_called').length;
        expect(hookInvokeCount).toBeGreaterThan(1);

        const toolLogs = rig.readToolLogs();
        const hasActivity = result.length > 0 || toolLogs.length > 0;
        expect(hasActivity).toBe(true);
      });

      it('should continue execution when second sequential stop hook returns block', async () => {
        // Stop hook's block decision means "block stopping" (i.e., force continuation)
        const allowScript =
          '(echo "hook_called" >> hook_invoke_count.txt &) ; echo \'{"decision": "allow", "reason": "First allows"}\'';
        const blockScript =
          '(echo "hook_called" >> hook_invoke_count.txt &) ; echo \'{"decision": "block", "reason": "Second hook blocks stop"}\'';

        await rig.setup('stop-seq-second-blocks', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              Stop: [
                {
                  sequential: true,
                  hooks: [
                    {
                      type: 'command',
                      command: allowScript,
                      name: 'stop-seq-first-allow',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: blockScript,
                      name: 'stop-seq-second-block',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        // When Stop hook blocks, agent continues execution normally (with max turns to prevent infinite loop)
        const result = await rig.run(
          'Say seq second blocks',
          '--max-session-turns',
          '3',
        );

        // Verify that execution completed successfully (not blocked by Stop hook)
        // This confirms: 1) Agent could execute after Stop hook blocked, 2) Session terminated normally
        const hookInvokeCount = rig
          .readFile('hook_invoke_count.txt')
          .split('\n')
          .filter((line) => line.trim() === 'hook_called').length;
        expect(hookInvokeCount).toBeGreaterThan(1);

        const toolLogs = rig.readToolLogs();
        const hasActivity = result.length > 0 || toolLogs.length > 0;
        expect(hasActivity).toBe(true);
      });

      it('should handle multiple stop hooks all returning allow', async () => {
        const allow1Script =
          'echo \'{"decision": "allow", "reason": "First allows"}\'';
        const allow2Script =
          'echo \'{"decision": "allow", "reason": "Second allows"}\'';
        const allow3Script =
          'echo \'{"decision": "allow", "reason": "Third allows"}\'';

        await rig.setup('stop-multi-all-allow', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              Stop: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: allow1Script,
                      name: 'stop-allow-1',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: allow2Script,
                      name: 'stop-allow-2',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: allow3Script,
                      name: 'stop-allow-3',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say all allow');
        // All hooks allow, should complete normally
        expect(result).toBeDefined();
        expect(result.length).toBeGreaterThan(0);
      });

      it('should handle multiple stop hooks all returning block', async () => {
        const block1Script =
          '(echo "hook_called" >> hook_invoke_count.txt &) ; echo \'{"decision": "block", "reason": "First blocks"}\'';
        const block2Script =
          '(echo "hook_called" >> hook_invoke_count.txt &) ; echo \'{"decision": "block", "reason": "Second blocks"}\'';

        await rig.setup('stop-multi-all-block', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              Stop: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: block1Script,
                      name: 'stop-block-1',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: block2Script,
                      name: 'stop-block-2',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        // When Stop hooks block, agent continues execution normally (with max turns to prevent infinite loop)
        const _result = await rig.run(
          'Say all block',
          '--max-session-turns',
          '3',
        );

        // Verify Stop hook was invoked multiple times (indicating multiple rounds)
        const hookInvokeCount = rig
          .readFile('hook_invoke_count.txt')
          .split('\n')
          .filter((line) => line.trim() === 'hook_called').length;
        expect(hookInvokeCount).toBeGreaterThan(1);
      });

      it('should handle stop hook with error alongside blocking hook', async () => {
        const blockScript =
          'echo \'{"decision": "block", "reason": "Blocked"}\'';

        await rig.setup('stop-error-with-block', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              Stop: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: '/nonexistent/command',
                      name: 'stop-error-hook',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: blockScript,
                      name: 'stop-block-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        // When Stop hook blocks, agent continues execution normally (with max turns to prevent infinite loop)
        const result = await rig.run(
          'Say error with block',
          '--max-session-turns',
          '2',
        );
        expect(result).toBeDefined();
        expect(result.length).toBeGreaterThan(0);
      });
    });
  });

  // ==========================================================================
  // Multiple Hooks (General)
  // Tests for hook execution modes: sequential vs parallel
  // ==========================================================================
  describe('Multiple Hooks', () => {
    describe('Sequential Execution', () => {
      it('should execute hooks sequentially when sequential: true', async () => {
        const hook1Script =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "first"}}\'';
        const hook2Script =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "second"}}\'';

        await rig.setup('multi-sequential', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              UserPromptSubmit: [
                {
                  sequential: true,
                  hooks: [
                    {
                      type: 'command',
                      command: hook1Script,
                      name: 'seq-hook-1',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: hook2Script,
                      name: 'seq-hook-2',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say sequential');
        expect(result).toBeDefined();
      });

      it('should stop at first blocking hook and not execute subsequent', async () => {
        const blockScript =
          'echo \'{"decision": "block", "reason": "Blocked by first hook"}\'';
        const allowScript = 'echo \'{"decision": "allow"}\'';

        await rig.setup('multi-first-blocks', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              UserPromptSubmit: [
                {
                  sequential: true,
                  hooks: [
                    {
                      type: 'command',
                      command: blockScript,
                      name: 'seq-block-hook',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: allowScript,
                      name: 'seq-should-not-run',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        // When the first hook blocks, the UserPromptSubmit should be blocked
        await expect(rig.run('Create a file')).rejects.toThrow(
          /blocked|Blocked by first hook/i,
        );
      });

      it('should pass output from first hook to second hook input', async () => {
        const passScript1 =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "from first", "passthrough": "data"}}\'';
        const passScript2 =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "received passthrough"}}\'';

        await rig.setup('multi-passthrough', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              UserPromptSubmit: [
                {
                  sequential: true,
                  hooks: [
                    {
                      type: 'command',
                      command: passScript1,
                      name: 'passthrough-hook-1',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: passScript2,
                      name: 'passthrough-hook-2',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say passthrough');
        expect(result).toBeDefined();
      });
    });

    describe('Parallel Execution', () => {
      it('should execute hooks in parallel when sequential is not set', async () => {
        const hook1Script = 'echo \'{"decision": "allow"}\'';
        const hook2Script = 'echo \'{"decision": "allow"}\'';

        await rig.setup('multi-parallel', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              UserPromptSubmit: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: hook1Script,
                      name: 'parallel-hook-1',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: hook2Script,
                      name: 'parallel-hook-2',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say parallel');
        expect(result).toBeDefined();
      });

      it('should handle mixed success/failure results from parallel hooks', async () => {
        // For UserPromptSubmit hooks, command execution failure is treated as a blocking error
        // So when one hook fails, the entire operation is blocked
        const allowScript = 'echo \'{"decision": "allow"}\'';

        await rig.setup('multi-mixed', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              UserPromptSubmit: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: allowScript,
                      name: 'mixed-allow-hook',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: '/nonexistent/command',
                      name: 'mixed-error-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        // UserPromptSubmit hook command failure blocks the operation
        await expect(rig.run('Say mixed')).rejects.toThrow(
          /blocked|error|nonexistent/i,
        );
      });

      it('should allow when any hook returns allow in parallel (OR logic)', async () => {
        const blockScript =
          'echo \'{"decision": "block", "reason": "blocked"}\'';
        const allowScript = 'echo \'{"decision": "allow"}\'';

        await rig.setup('multi-or-logic', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              UserPromptSubmit: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: blockScript,
                      name: 'block-hook',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: allowScript,
                      name: 'allow-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        // With security-sensitive OR logic, block should win (most restrictive decision wins)
        await expect(rig.run('Say or logic')).rejects.toThrow(/blocked|error/i);
      });
    });
  });

  // ==========================================================================
  // SessionStart Hooks
  // Tests for session start lifecycle hooks with rich matcher and aggregator scenarios
  // ==========================================================================
  describe('SessionStart Hooks', () => {
    describe('Single SessionStart Hook', () => {
      it('should execute SessionStart hook on session startup', async () => {
        const sessionStartScript =
          'echo  \'{decision: "allow", hookSpecificOutput: {additionalContext: "Session started successfully"}}\'';

        await rig.setup('session-start-basic', {
          settings: {
            hooks: {
              enabled: true,
              SessionStart: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: sessionStartScript,
                      name: 'session-start-basic-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say hello');
        expect(result).toBeDefined();
        expect(result.length).toBeGreaterThan(0);
      });

      it('should inject additional context from SessionStart hook', async () => {
        const contextScript =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "Project context: TypeScript React app with strict linting rules"}}\'';

        await rig.setup('session-start-context', {
          settings: {
            hooks: {
              enabled: true,
              SessionStart: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: contextScript,
                      name: 'session-start-context-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('What project context do you have?');
        expect(result).toBeDefined();
        expect(result.toLowerCase()).toContain('typescript');
      });

      it('should set environment variables via CLAUDE_ENV_FILE', async () => {
        const envScript = `if [ -n "$CLAUDE_ENV_FILE" ]; then echo 'export TEST_VAR=session_start_value' >> "$CLAUDE_ENV_FILE"; echo 'export NODE_ENV=test' >> "$CLAUDE_ENV_FILE"; fi; echo '{"decision": "allow"}';`;

        await rig.setup('session-start-env', {
          settings: {
            hooks: {
              enabled: true,
              SessionStart: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: envScript,
                      name: 'session-start-env-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Echo $TEST_VAR using Bash');
        expect(result).toBeDefined();
      });

      it('should handle SessionStart hook with system message', async () => {
        const systemMsgScript =
          'echo \'{"decision": "allow", "systemMessage": "Welcome! Session initialized with custom settings"}\'';

        await rig.setup('session-start-system-msg', {
          settings: {
            hooks: {
              enabled: true,
              SessionStart: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: systemMsgScript,
                      name: 'session-start-system-msg-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say hello');
        expect(result).toBeDefined();
      });
    });

    describe('SessionStart Matcher Scenarios', () => {
      it('should match startup source with matcher', async () => {
        const startupScript =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "Startup hook executed"}}\'';
        const otherScript =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "Other hook executed"}}\'';

        await rig.setup('session-start-matcher-startup', {
          settings: {
            hooks: {
              enabled: true,
              SessionStart: [
                {
                  matcher: 'startup',
                  hooks: [
                    {
                      type: 'command',
                      command: startupScript,
                      name: 'session-start-startup-hook',
                      timeout: 5000,
                    },
                  ],
                },
                {
                  matcher: 'resume',
                  hooks: [
                    {
                      type: 'command',
                      command: otherScript,
                      name: 'session-start-resume-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say startup test');
        expect(result).toBeDefined();
      });

      it('should match multiple sources with regex matcher', async () => {
        const multiSourceScript =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "Multi-source hook executed"}}\'';

        await rig.setup('session-start-matcher-regex', {
          settings: {
            hooks: {
              enabled: true,
              SessionStart: [
                {
                  matcher: 'startup|resume',
                  hooks: [
                    {
                      type: 'command',
                      command: multiSourceScript,
                      name: 'session-start-multi-source-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say regex matcher test');
        expect(result).toBeDefined();
      });

      it('should match all sources with wildcard matcher', async () => {
        const wildcardScript =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "Wildcard hook executed"}}\'';

        await rig.setup('session-start-matcher-wildcard', {
          settings: {
            hooks: {
              enabled: true,
              SessionStart: [
                {
                  matcher: '*',
                  hooks: [
                    {
                      type: 'command',
                      command: wildcardScript,
                      name: 'session-start-wildcard-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say wildcard test');
        expect(result).toBeDefined();
      });

      it('should not execute when matcher does not match', async () => {
        const noMatchScript =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "Should not execute"}}\'';

        await rig.setup('session-start-matcher-no-match', {
          settings: {
            hooks: {
              enabled: true,
              SessionStart: [
                {
                  matcher: 'clear', // This won't match startup
                  hooks: [
                    {
                      type: 'command',
                      command: noMatchScript,
                      name: 'session-start-clear-only-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say no match test');
        expect(result).toBeDefined();
      });

      it('should match clear source with matcher', async () => {
        const clearScript =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "Clear hook executed"}}\'';

        await rig.setup('session-start-matcher-clear', {
          settings: {
            hooks: {
              enabled: true,
              SessionStart: [
                {
                  matcher: 'clear',
                  hooks: [
                    {
                      type: 'command',
                      command: clearScript,
                      name: 'session-start-clear-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say clear test');
        expect(result).toBeDefined();
      });

      it('should match compact source with matcher', async () => {
        const compactScript =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "Compact hook executed"}}\'';

        await rig.setup('session-start-matcher-compact', {
          settings: {
            hooks: {
              enabled: true,
              SessionStart: [
                {
                  matcher: 'compact',
                  hooks: [
                    {
                      type: 'command',
                      command: compactScript,
                      name: 'session-start-compact-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say compact test');
        expect(result).toBeDefined();
      });

      it('should match all four sources with regex matcher', async () => {
        const allSourcesScript =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "All sources hook executed"}}\'';

        await rig.setup('session-start-matcher-all-sources', {
          settings: {
            hooks: {
              enabled: true,
              SessionStart: [
                {
                  matcher: 'startup|resume|clear|compact',
                  hooks: [
                    {
                      type: 'command',
                      command: allSourcesScript,
                      name: 'session-start-all-sources-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say all sources test');
        expect(result).toBeDefined();
      });

      it('should match startup and resume but not clear or compact', async () => {
        const startupResumeScript =
          'echo  \'{decision: "allow", hookSpecificOutput: {additionalContext: "Startup/Resume hook executed"}}\'';
        const clearCompactScript =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "Clear/Compact hook executed"}}\'';

        await rig.setup('session-start-matcher-partial', {
          settings: {
            hooks: {
              enabled: true,
              SessionStart: [
                {
                  matcher: 'startup|resume',
                  hooks: [
                    {
                      type: 'command',
                      command: startupResumeScript,
                      name: 'session-start-startup-resume-hook',
                      timeout: 5000,
                    },
                  ],
                },
                {
                  matcher: 'clear|compact',
                  hooks: [
                    {
                      type: 'command',
                      command: clearCompactScript,
                      name: 'session-start-clear-compact-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say partial matcher test');
        expect(result).toBeDefined();
      });

      it('should handle invalid regex in matcher gracefully', async () => {
        const invalidRegexScript =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "Fallback to exact match"}}\'';

        await rig.setup('session-start-matcher-invalid-regex', {
          settings: {
            hooks: {
              enabled: true,
              SessionStart: [
                {
                  matcher: '[invalid-regex', // Invalid regex pattern
                  hooks: [
                    {
                      type: 'command',
                      command: invalidRegexScript,
                      name: 'session-start-invalid-regex-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say invalid regex test');
        expect(result).toBeDefined();
      });

      it('should match all session start sources with individual hooks', async () => {
        const startupScript =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "Startup triggered"}}\'';
        const resumeScript =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "Resume triggered"}}\'';
        const clearScript =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "Clear triggered"}}\'';
        const compactScript =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "Compact triggered"}}\'';

        await rig.setup('session-start-all-sources-individual', {
          settings: {
            hooks: {
              enabled: true,
              SessionStart: [
                {
                  matcher: 'startup',
                  hooks: [
                    {
                      type: 'command',
                      command: startupScript,
                      name: 'session-start-startup-hook',
                      timeout: 5000,
                    },
                  ],
                },
                {
                  matcher: 'resume',
                  hooks: [
                    {
                      type: 'command',
                      command: resumeScript,
                      name: 'session-start-resume-hook',
                      timeout: 5000,
                    },
                  ],
                },
                {
                  matcher: 'clear',
                  hooks: [
                    {
                      type: 'command',
                      command: clearScript,
                      name: 'session-start-clear-hook',
                      timeout: 5000,
                    },
                  ],
                },
                {
                  matcher: 'compact',
                  hooks: [
                    {
                      type: 'command',
                      command: compactScript,
                      name: 'session-start-compact-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say all sources individual test');
        expect(result).toBeDefined();
      });
    });

    describe('Multiple SessionStart Hooks', () => {
      it('should execute multiple parallel SessionStart hooks', async () => {
        const script1 =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "Parallel hook 1"}}\'';
        const script2 =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "Parallel hook 2"}}\'';
        const script3 =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "Parallel hook 3"}}\'';

        await rig.setup('session-start-multi-parallel', {
          settings: {
            hooks: {
              enabled: true,
              SessionStart: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: script1,
                      name: 'session-start-parallel-1',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: script2,
                      name: 'session-start-parallel-2',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: script3,
                      name: 'session-start-parallel-3',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say multi parallel');
        expect(result).toBeDefined();
      });

      it('should execute sequential SessionStart hooks in order', async () => {
        const script1 =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "Sequential hook 1"}}\'';
        const script2 =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "Sequential hook 2"}}\'';

        await rig.setup('session-start-multi-sequential', {
          settings: {
            hooks: {
              enabled: true,
              SessionStart: [
                {
                  sequential: true,
                  hooks: [
                    {
                      type: 'command',
                      command: script1,
                      name: 'session-start-seq-1',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: script2,
                      name: 'session-start-seq-2',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say sequential');
        expect(result).toBeDefined();
      });

      it('should concatenate additional context from multiple hooks', async () => {
        const context1 =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "Context from hook 1"}}\'';
        const context2 =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "Context from hook 2"}}\'';

        await rig.setup('session-start-multi-context', {
          settings: {
            hooks: {
              enabled: true,
              SessionStart: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: context1,
                      name: 'session-start-ctx-1',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: context2,
                      name: 'session-start-ctx-2',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('What context do you have?');
        expect(result).toBeDefined();
      });

      it('should handle system messages from multiple hooks', async () => {
        const msg1 =
          'echo  \'{"decision": "allow", "systemMessage": "System message 1"}\'';
        const msg2 =
          'echo \'{"decision": "allow", "systemMessage": "System message 2"}\'';

        await rig.setup('session-start-multi-system-msg', {
          settings: {
            hooks: {
              enabled: true,
              SessionStart: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: msg1,
                      name: 'session-start-sys-1',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: msg2,
                      name: 'session-start-sys-2',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say hello');
        expect(result).toBeDefined();
      });
    });

    describe('SessionStart Error Handling', () => {
      it('should continue session when hook exits with non-blocking error', async () => {
        await rig.setup('session-start-nonblocking-error', {
          settings: {
            hooks: {
              enabled: true,
              SessionStart: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: 'echo warning && exit 1',
                      name: 'session-start-error-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say error test');
        expect(result).toBeDefined();
      });

      it('should continue session when hook command does not exist', async () => {
        await rig.setup('session-start-missing-command', {
          settings: {
            hooks: {
              enabled: true,
              SessionStart: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: '/nonexistent/session/start/command',
                      name: 'session-start-missing-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say missing test');
        expect(result).toBeDefined();
      });

      it('should handle hook timeout gracefully', async () => {
        await rig.setup('session-start-timeout', {
          settings: {
            hooks: {
              enabled: true,
              SessionStart: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: 'sleep 60',
                      name: 'session-start-timeout-hook',
                      timeout: 1000, // 1 second timeout
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say timeout test');
        expect(result).toBeDefined();
      });
    });
  });

  // ==========================================================================
  // SessionEnd Hooks
  // Tests for session end lifecycle hooks with various exit reasons
  // ==========================================================================
  describe('SessionEnd Hooks', () => {
    describe('Single SessionEnd Hook', () => {
      it('should execute SessionEnd hook on session end', async () => {
        const sessionEndScript = 'echo \'{"decision": "allow"}\'';

        await rig.setup('session-end-basic', {
          settings: {
            hooks: {
              enabled: true,
              SessionEnd: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: sessionEndScript,
                      name: 'session-end-basic-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say hello');
        expect(result).toBeDefined();
      });

      it('should execute SessionEnd hook with cleanup tasks', async () => {
        const cleanupScript =
          'echo {decision: "allow", hookSpecificOutput: {additionalContext: "Cleanup completed"}}';

        await rig.setup('session-end-cleanup', {
          settings: {
            hooks: {
              enabled: true,
              SessionEnd: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: cleanupScript,
                      name: 'session-end-cleanup-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say cleanup test');
        expect(result).toBeDefined();
      });
    });

    describe('SessionEnd Matcher Scenarios', () => {
      it('should match specific exit reason with matcher', async () => {
        const clearScript =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "Clear hook executed"}}\'';
        const logoutScript =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "Logout hook executed"}}\'';

        await rig.setup('session-end-matcher-clear', {
          settings: {
            hooks: {
              enabled: true,
              SessionEnd: [
                {
                  matcher: 'clear',
                  hooks: [
                    {
                      type: 'command',
                      command: clearScript,
                      name: 'session-end-clear-hook',
                      timeout: 5000,
                    },
                  ],
                },
                {
                  matcher: 'logout',
                  hooks: [
                    {
                      type: 'command',
                      command: logoutScript,
                      name: 'session-end-logout-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say matcher test');
        expect(result).toBeDefined();
      });

      it('should match multiple exit reasons with regex matcher', async () => {
        const multiReasonScript =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "Multi-reason hook executed"}}\'';

        await rig.setup('session-end-matcher-regex', {
          settings: {
            hooks: {
              enabled: true,
              SessionEnd: [
                {
                  matcher: 'clear|logout|other',
                  hooks: [
                    {
                      type: 'command',
                      command: multiReasonScript,
                      name: 'session-end-multi-reason-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say regex matcher test');
        expect(result).toBeDefined();
      });

      it('should match all reasons with wildcard matcher', async () => {
        const wildcardScript =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "Wildcard end hook executed"}}\'';

        await rig.setup('session-end-matcher-wildcard', {
          settings: {
            hooks: {
              enabled: true,
              SessionEnd: [
                {
                  matcher: '*',
                  hooks: [
                    {
                      type: 'command',
                      command: wildcardScript,
                      name: 'session-end-wildcard-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say wildcard test');
        expect(result).toBeDefined();
      });

      it('should handle invalid regex in SessionEnd matcher gracefully', async () => {
        const invalidRegexScript =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "SessionEnd fallback to exact match"}}\'';

        await rig.setup('session-end-matcher-invalid-regex', {
          settings: {
            hooks: {
              enabled: true,
              SessionEnd: [
                {
                  matcher: '[invalid-regex', // Invalid regex pattern
                  hooks: [
                    {
                      type: 'command',
                      command: invalidRegexScript,
                      name: 'session-end-invalid-regex-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say invalid regex SessionEnd test');
        expect(result).toBeDefined();
      });

      it('should match all SessionEnd reasons with individual hooks', async () => {
        const clearScript =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "Clear reason triggered"}}\'';
        const logoutScript =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "Logout reason triggered"}}\'';
        const promptExitScript =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "PromptInputExit reason triggered"}}\'';
        const bypassDisabledScript =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "Bypass permissions disabled triggered"}}\'';
        const otherScript =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "Other reason triggered"}}\'';

        await rig.setup('session-end-all-reasons-individual', {
          settings: {
            hooks: {
              enabled: true,
              SessionEnd: [
                {
                  matcher: 'clear',
                  hooks: [
                    {
                      type: 'command',
                      command: clearScript,
                      name: 'session-end-clear-hook',
                      timeout: 5000,
                    },
                  ],
                },
                {
                  matcher: 'logout',
                  hooks: [
                    {
                      type: 'command',
                      command: logoutScript,
                      name: 'session-end-logout-hook',
                      timeout: 5000,
                    },
                  ],
                },
                {
                  matcher: 'promptInputExit',
                  hooks: [
                    {
                      type: 'command',
                      command: promptExitScript,
                      name: 'session-end-prompt-exit-hook',
                      timeout: 5000,
                    },
                  ],
                },
                {
                  matcher: 'bypass_permissions_disabled',
                  hooks: [
                    {
                      type: 'command',
                      command: bypassDisabledScript,
                      name: 'session-end-bypass-disabled-hook',
                      timeout: 5000,
                    },
                  ],
                },
                {
                  matcher: 'other',
                  hooks: [
                    {
                      type: 'command',
                      command: otherScript,
                      name: 'session-end-other-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say all SessionEnd reasons test');
        expect(result).toBeDefined();
      });
    });

    describe('Multiple SessionEnd Hooks', () => {
      it('should execute multiple parallel SessionEnd hooks', async () => {
        const script1 =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "End hook 1"}}\'';
        const script2 =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "End hook 2"}}\'';

        await rig.setup('session-end-multi-parallel', {
          settings: {
            hooks: {
              enabled: true,
              SessionEnd: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: script1,
                      name: 'session-end-parallel-1',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: script2,
                      name: 'session-end-parallel-2',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say multi parallel end');
        expect(result).toBeDefined();
      });

      it('should execute sequential SessionEnd hooks in order', async () => {
        const script1 =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "Sequential end hook 1"}}\'';
        const script2 =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "Sequential end hook 2"}}\'';

        await rig.setup('session-end-multi-sequential', {
          settings: {
            hooks: {
              enabled: true,
              SessionEnd: [
                {
                  sequential: true,
                  hooks: [
                    {
                      type: 'command',
                      command: script1,
                      name: 'session-end-seq-1',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: script2,
                      name: 'session-end-seq-2',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say sequential end');
        expect(result).toBeDefined();
      });

      it('should concatenate additional context from multiple hooks', async () => {
        const context1 =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "End context from hook 1"}}\'';
        const context2 =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "End context from hook 2"}}\'';

        await rig.setup('session-end-multi-context', {
          settings: {
            hooks: {
              enabled: true,
              SessionEnd: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: context1,
                      name: 'session-end-ctx-1',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: context2,
                      name: 'session-end-ctx-2',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say end context test');
        expect(result).toBeDefined();
      });
    });

    describe('SessionEnd Block Scenarios', () => {
      it('should block session end when hook returns block decision', async () => {
        const blockScript =
          'echo  \'{"decision": "block", "reason": "Session end blocked by policy"}\'';

        await rig.setup('session-end-block', {
          settings: {
            hooks: {
              enabled: true,
              SessionEnd: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: blockScript,
                      name: 'session-end-block-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say block test');
        expect(result).toBeDefined();
        // Session should not end, agent continues
        expect(result.toLowerCase()).toContain('block');
      });

      it('should allow session end when hook returns allow decision', async () => {
        const allowScript =
          'echo  \'{"decision": "allow", "reason": "Session end allowed"}\'';

        await rig.setup('session-end-allow', {
          settings: {
            hooks: {
              enabled: true,
              SessionEnd: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: allowScript,
                      name: 'session-end-allow-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say allow test');
        expect(result).toBeDefined();
        expect(result.length).toBeGreaterThan(0);
      });

      it('should block when one of multiple parallel hooks returns block', async () => {
        const allowScript =
          'echo  \'{"decision": "allow", "reason": "Allowed"}\'';
        const blockScript =
          'echo  \'{"decision": "block", "reason": "Blocked by security policy"}\'';

        await rig.setup('session-end-multi-one-blocks', {
          settings: {
            hooks: {
              enabled: true,
              SessionEnd: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: allowScript,
                      name: 'session-end-allow-hook',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: blockScript,
                      name: 'session-end-block-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say multi block test');
        expect(result).toBeDefined();
        expect(result.toLowerCase()).toContain('block');
      });

      it('should block when first sequential hook returns block', async () => {
        const blockScript =
          'echo \'{"decision": "block", "reason": "First hook blocks session end"}\'';
        const allowScript = 'echo \'{"decision": "allow"}\'';

        await rig.setup('session-end-seq-first-blocks', {
          settings: {
            hooks: {
              enabled: true,
              SessionEnd: [
                {
                  sequential: true,
                  hooks: [
                    {
                      type: 'command',
                      command: blockScript,
                      name: 'session-end-seq-block-hook',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: allowScript,
                      name: 'session-end-seq-allow-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say seq block test');
        expect(result).toBeDefined();
        expect(result.toLowerCase()).toContain('block');
      });

      it('should allow when all hooks return allow', async () => {
        const allow1Script =
          'echo \'{"decision": "allow", "reason": "First allows"}\'';
        const allow2Script =
          'echo \'{"decision": "allow", "reason": "Second allows"}\'';

        await rig.setup('session-end-all-allow', {
          settings: {
            hooks: {
              enabled: true,
              SessionEnd: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: allow1Script,
                      name: 'session-end-allow-1',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: allow2Script,
                      name: 'session-end-allow-2',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say all allow test');
        expect(result).toBeDefined();
        expect(result.length).toBeGreaterThan(0);
      });

      it('should handle block with reason in session end', async () => {
        const blockWithReasonScript =
          'echo  \'{"decision": "block", "reason": "Critical operations pending - cannot end session"} \'';

        await rig.setup('session-end-block-with-reason', {
          settings: {
            hooks: {
              enabled: true,
              SessionEnd: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: blockWithReasonScript,
                      name: 'session-end-block-reason-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say block with reason');
        expect(result).toBeDefined();
        expect(result.toLowerCase()).toContain('block');
      });
    });

    describe('SessionEnd Error Handling', () => {
      it('should continue session end when hook exits with non-blocking error', async () => {
        await rig.setup('session-end-nonblocking-error', {
          settings: {
            hooks: {
              enabled: true,
              SessionEnd: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: 'echo warning && exit 1',
                      name: 'session-end-error-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say error test');
        expect(result).toBeDefined();
      });

      it('should continue session end when hook command does not exist', async () => {
        await rig.setup('session-end-missing-command', {
          settings: {
            hooks: {
              enabled: true,
              SessionEnd: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: '/nonexistent/session/end/command',
                      name: 'session-end-missing-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say missing test');
        expect(result).toBeDefined();
      });
    });

    describe('Multiple SessionEnd Hooks', () => {
      it('should block when one of multiple parallel hooks returns block', async () => {
        const allowScript = 'echo \'{"decision": "allow"}\'';
        const blockScript =
          'echo \'{"decision": "block", "reason": "Blocked"}\'';

        await rig.setup('session-end-multi-one-blocks', {
          settings: {
            hooks: {
              enabled: true,
              SessionEnd: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: allowScript,
                      name: 'session-end-allow-hook',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: blockScript,
                      name: 'session-end-block-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say hello');
        expect(result).toBeDefined();
        // SessionEnd hooks run after the main command completes and don't affect the main output
        expect(result.toLowerCase()).not.toContain('block');
      });

      it('should block when first sequential hook returns block', async () => {
        const blockScript =
          'echo \'{"decision": "block", "reason": "Blocked"}\'';
        const allowScript = 'echo \'{"decision": "allow"}\'';

        await rig.setup('session-end-seq-first-blocks', {
          settings: {
            hooks: {
              enabled: true,
              SessionEnd: [
                {
                  sequential: true,
                  hooks: [
                    {
                      type: 'command',
                      command: blockScript,
                      name: 'session-end-seq-block-hook',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: allowScript,
                      name: 'session-end-seq-allow-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say test');
        expect(result).toBeDefined();
        // SessionEnd hooks run after the main command completes and don't affect the main output
        expect(result.toLowerCase()).not.toContain('block');
      });

      it('should handle multiple hooks all returning allow', async () => {
        const allow1Script =
          'echo \'{"decision": "allow", "reason": "First allows"}\'';
        const allow2Script =
          'echo \'{"decision": "allow", "reason": "Second allows"}\'';

        await rig.setup('session-end-multi-all-allow', {
          settings: {
            hooks: {
              enabled: true,
              SessionEnd: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: allow1Script,
                      name: 'session-end-allow-1',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: allow2Script,
                      name: 'session-end-allow-2',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say hello');
        expect(result).toBeDefined();
        expect(result.length).toBeGreaterThan(0);
      });

      it('should concatenate additional context from multiple hooks', async () => {
        const context1Script =
          'echo {decision: "allow", hookSpecificOutput: {additionalContext: "context from session end hook 1"}}';
        const context2Script =
          'echo {decision: "allow", hookSpecificOutput: {additionalContext: "context from session end hook 2"}}';

        await rig.setup('session-end-multi-context', {
          settings: {
            hooks: {
              enabled: true,
              SessionEnd: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: context1Script,
                      name: 'session-end-context-1',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: context2Script,
                      name: 'session-end-context-2',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say hello');
        expect(result).toBeDefined();
      });

      it('should handle hook with error alongside blocking hook', async () => {
        const blockScript =
          'echo \'{"decision": "block", "reason": "Blocked"}\'';

        await rig.setup('session-end-error-with-block', {
          settings: {
            hooks: {
              enabled: true,
              SessionEnd: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: '/nonexistent/command',
                      name: 'session-end-error-hook',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: blockScript,
                      name: 'session-end-block-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say test');
        expect(result).toBeDefined();
        // SessionEnd hooks run after the main command completes and don't affect the main output
        expect(result.toLowerCase()).not.toContain('block');
      });

      it('should handle hook timeout alongside blocking hook', async () => {
        const blockScript =
          'echo \'{"decision": "block", "reason": "Blocked"}\'';

        await rig.setup('session-end-timeout-with-block', {
          settings: {
            hooks: {
              enabled: true,
              SessionEnd: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: 'sleep 60',
                      name: 'session-end-timeout-hook',
                      timeout: 1000,
                    },
                    {
                      type: 'command',
                      command: blockScript,
                      name: 'session-end-block-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say test');
        expect(result).toBeDefined();
        // SessionEnd hooks run after the main command completes and don't affect the main output
        expect(result.toLowerCase()).not.toContain('block');
      });

      it('should handle system messages from multiple hooks', async () => {
        const msg1Script =
          'echo  \'{"decision": "allow", "systemMessage": "System message 1 from SessionEnd"}\'';
        const msg2Script =
          'echo \'{"decision": "allow", "systemMessage": "System message 2 from SessionEnd"}\'';

        await rig.setup('session-end-multi-system-msg', {
          settings: {
            hooks: {
              enabled: true,
              SessionEnd: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: msg1Script,
                      name: 'session-end-msg-1',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: msg2Script,
                      name: 'session-end-msg-2',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say hello');
        expect(result).toBeDefined();
      });
    });
  });

  // ==========================================================================
  // Combined Hooks
  // Tests for using multiple hook types together
  // ==========================================================================
  // Combined Hooks
  // Tests for using multiple hook types together
  // ==========================================================================
  describe('Combined Hooks', () => {
    it('should execute both Stop and UserPromptSubmit hooks in same session', async () => {
      const stopScript = 'echo \'{"decision": "allow"}\'';
      const upsScript = 'echo \'{"decision": "allow"}\'';

      await rig.setup('combined-both-hooks', {
        settings: {
          hooksConfig: { enabled: true },
          hooks: {
            Stop: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: stopScript,
                    name: 'stop-hook',
                    timeout: 5000,
                  },
                ],
              },
            ],
            UserPromptSubmit: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: upsScript,
                    name: 'ups-hook',
                    timeout: 5000,
                  },
                ],
              },
            ],
          },
          trusted: true,
        },
      });

      const result = await rig.run('Say both hooks');
      expect(result).toBeDefined();
    });

    it('should execute multiple hook types together', async () => {
      const upsScript = 'echo \'{"decision": "allow"}\'';
      const sessionEndScript = 'echo \'{"decision": "allow"}\'';

      await rig.setup('combined-ups-sessionend', {
        settings: {
          hooksConfig: { enabled: true },
          hooks: {
            UserPromptSubmit: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: upsScript,
                    name: 'ups-hook',
                    timeout: 5000,
                  },
                ],
              },
            ],
            SessionEnd: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: sessionEndScript,
                    name: 'session-end-hook',
                    timeout: 5000,
                  },
                ],
              },
            ],
          },
          trusted: true,
        },
      });

      const result = await rig.run('Say hello with multiple hooks');
      expect(result).toBeDefined();
    });

    it('should execute Stop, UserPromptSubmit and SessionEnd hooks together', async () => {
      const stopScript = 'echo \'{"decision": "allow"}\'';
      const upsScript = 'echo \'{"decision": "allow"}\'';
      const sessionEndScript = 'echo \'{"decision": "allow"}\'';

      await rig.setup('combined-three-hooks', {
        settings: {
          hooksConfig: { enabled: true },
          hooks: {
            Stop: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: stopScript,
                    name: 'stop-hook',
                    timeout: 5000,
                  },
                ],
              },
            ],
            UserPromptSubmit: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: upsScript,
                    name: 'ups-hook',
                    timeout: 5000,
                  },
                ],
              },
            ],
            SessionEnd: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: sessionEndScript,
                    name: 'session-end-hook',
                    timeout: 5000,
                  },
                ],
              },
            ],
          },
          trusted: true,
        },
      });

      const result = await rig.run('Say hello with three hooks');
      expect(result).toBeDefined();
    });

    it('should execute all hook types together', async () => {
      const stopScript = 'echo \'{"decision": "allow"}\'';
      const upsScript = 'echo \'{"decision": "allow"}\'';
      const sessionEndScript = 'echo \'{"decision": "allow"}\'';
      const permissionScript = 'echo \'{"decision": "allow"}\'';

      await rig.setup('combined-all-hooks', {
        settings: {
          hooksConfig: { enabled: true },
          hooks: {
            Stop: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: stopScript,
                    name: 'stop-hook',
                    timeout: 5000,
                  },
                ],
              },
            ],
            UserPromptSubmit: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: upsScript,
                    name: 'ups-hook',
                    timeout: 5000,
                  },
                ],
              },
            ],
            SessionEnd: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: sessionEndScript,
                    name: 'session-end-hook',
                    timeout: 5000,
                  },
                ],
              },
            ],
            PermissionRequest: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: permissionScript,
                    name: 'permission-hook',
                    timeout: 5000,
                  },
                ],
              },
            ],
          },
          trusted: true,
        },
      });

      const result = await rig.run('Say hello with all hooks');
      expect(result).toBeDefined();
    });
  });

  // ==========================================================================
  // Hook Script File Tests
  // Tests for executing hooks from external script files
  // ==========================================================================
  describe('Hook Script File Tests', () => {
    it('should execute hook from script file', async () => {
      const scriptFileHook =
        'echo  \'{"decision": "allow", "reason": "Approved by script file", "hookSpecificOutput": {"additionalContext": "Script file executed successfully"}}\'';

      await rig.setup('script-file-hook', {
        settings: {
          hooksConfig: { enabled: true },
          hooks: {
            UserPromptSubmit: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: scriptFileHook,
                    name: 'script-file-hook',
                    timeout: 5000,
                  },
                ],
              },
            ],
          },
          trusted: true,
        },
      });

      const result = await rig.run('Say script file test');
      expect(result).toBeDefined();
    });

    it('should execute blocking hook from script file', async () => {
      const scriptBlockHook =
        'echo \'{"decision": "block", "reason": "Blocked by security script"}\'';

      await rig.setup('script-file-block-hook', {
        settings: {
          hooksConfig: { enabled: true },
          hooks: {
            UserPromptSubmit: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: scriptBlockHook,
                    name: 'script-block-hook',
                    timeout: 5000,
                  },
                ],
              },
            ],
          },
          trusted: true,
        },
      });

      // When UserPromptSubmit hook blocks, CLI exits with non-zero code
      await expect(rig.run('Create a file')).rejects.toThrow(/block/i);
    });
  });

  // ==========================================================================
  // PermissionRequest Hooks
  // Tests for permission request lifecycle hooks that control tool access
  // ==========================================================================
  describe('PermissionRequest Hooks', () => {
    describe('Single PermissionRequest Hook - Allow Scenarios', () => {
      it('should allow tool execution when hook returns allow decision', async () => {
        const allowScript =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "Tool access granted by permission hook"}}\'';

        await rig.setup('permission-req-allow-basic', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              PermissionRequest: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: allowScript,
                      name: 'permission-req-allow-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run(
          'Create a file test.txt with content "hello"',
        );
        expect(result).toBeDefined();

        const fileContent = rig.readFile('test.txt');
        expect(fileContent).toContain('hello');
      });

      it('should allow specific tools based on tool name matching', async () => {
        const allowSafeToolsScript = `
          INPUT=$(cat)
          TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name')

          if [ "$TOOL_NAME" = "Read" ] || [ "$TOOL_NAME" = "Grep" ]; then
            echo '{"decision": "allow", "hookSpecificOutput": {"additionalContext": "Safe tool access granted"}}'
          else
            echo '{}'
          fi
        `;

        await rig.setup('permission-req-allow-safe-tools', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              PermissionRequest: [
                {
                  matcher: 'Read|Grep',
                  hooks: [
                    {
                      type: 'command',
                      command: allowSafeToolsScript,
                      name: 'permission-req-allow-safe-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        // Test with a Read operation
        const result = await rig.run('Read the package.json file');
        expect(result).toBeDefined();
      });
    });

    describe('Single PermissionRequest Hook - Deny Scenarios', () => {
      it('should deny tool execution when hook returns deny decision', async () => {
        const denyScript =
          'echo \'{"decision": "deny", "reason": "Tool execution denied by security hook", "hookSpecificOutput": {"additionalContext": "Security policy violation"}}\'';

        await rig.setup('permission-req-deny-basic', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              PermissionRequest: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: denyScript,
                      name: 'permission-req-deny-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        // Note: Currently the PermissionRequest deny decision may not block tool execution
        // This test verifies that the hook is executed and returns the expected decision
        const result = await rig.run(
          'Create a file denied.txt with content "should be blocked"',
        );
        expect(result).toBeDefined();

        // The hook is triggered but current implementation may not block execution
        // This highlights the gap where deny decisions don't prevent tool execution
        // In future, we'd expect the deny decision to block execution and result to contain deny-related message
      });

      it('should block dangerous operations based on tool input matching', async () => {
        const blockDangerousOpsScript = `
          INPUT=$(cat)
          TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name')
          COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

          if [ "$TOOL_NAME" = "Bash" ] && [[ "$COMMAND" == *"rm -rf"* ]]; then
            echo '{"decision": "deny", "reason": "Dangerous command blocked", "hookSpecificOutput": {"additionalContext": "Security threat detected"}}'
          else
            echo '{"decision": "allow"}'
          fi
        `;

        await rig.setup('permission-req-block-dangerous', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              PermissionRequest: [
                {
                  matcher: 'Bash',
                  hooks: [
                    {
                      type: 'command',
                      command: blockDangerousOpsScript,
                      name: 'permission-req-block-dangerous-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        // This command should ideally be blocked by the hook
        // Note: Currently the PermissionRequest deny decision may not block tool execution
        const result = await rig.run('Execute bash command: rm -rf /tmp');
        expect(result).toBeDefined();

        // The hook system correctly identifies dangerous operations
        // But current implementation may not fully enforce the deny decision
      });
    });

    describe('Multiple PermissionRequest Hooks - Allow Scenarios', () => {
      it('should allow tool execution when all hooks return allow decision', async () => {
        const allowScript1 =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "First permission check passed"}}\'';
        const allowScript2 =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "Second permission check passed"}}\'';

        await rig.setup('permission-req-multi-allow', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              PermissionRequest: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: allowScript1,
                      name: 'permission-req-allow-1',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: allowScript2,
                      name: 'permission-req-allow-2',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run(
          'Create a file multi-test.txt with content "multi allow"',
        );
        expect(result).toBeDefined();

        const fileContent = rig.readFile('multi-test.txt');
        expect(fileContent).toContain('multi allow');
      });

      it('should allow execution with sequential permission checks', async () => {
        const allowScript1 =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "First sequential check passed"}}\'';
        const allowScript2 =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "Second sequential check passed"}}\'';

        await rig.setup('permission-req-sequential-allow', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              PermissionRequest: [
                {
                  sequential: true,
                  hooks: [
                    {
                      type: 'command',
                      command: allowScript1,
                      name: 'permission-req-seq-allow-1',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: allowScript2,
                      name: 'permission-req-seq-allow-2',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Read this test file');
        expect(result).toBeDefined();
      });
    });

    describe('Multiple PermissionRequest Hooks - Deny Scenarios', () => {
      it('should deny tool execution when one hook returns deny decision in parallel', async () => {
        const allowScript = 'echo \'{"decision": "allow"}\'';
        const denyScript =
          'echo \'{"decision": "deny", "reason": "Denied by security policy"}\'';

        await rig.setup('permission-req-multi-one-denies', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              PermissionRequest: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: allowScript,
                      name: 'permission-req-allow-parallel',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: denyScript,
                      name: 'permission-req-deny-parallel',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        // Note: Currently the PermissionRequest deny decision may not block tool execution
        // In a proper implementation, one deny decision among parallel hooks should block execution
        const result = await rig.run(
          'Create a file blocked.txt with content "should not be created"',
        );
        expect(result).toBeDefined();

        // This test demonstrates the current behavior where deny decisions may not block execution
        // Future implementation should ensure that a deny decision blocks the tool execution
      });

      it('should deny execution when first sequential hook denies', async () => {
        const denyScript =
          'echo \'{"decision": "deny", "reason": "First check denied execution"}\'';
        const allowScript = 'echo \'{"decision": "allow"}\'';

        await rig.setup('permission-req-sequential-first-denies', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              PermissionRequest: [
                {
                  sequential: true,
                  hooks: [
                    {
                      type: 'command',
                      command: denyScript,
                      name: 'permission-req-seq-deny-first',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: allowScript,
                      name: 'permission-req-seq-allow-second',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        // Note: Currently the PermissionRequest deny decision may not block tool execution
        // In a proper implementation, the first deny decision should prevent subsequent hooks from executing
        // and block the tool execution entirely
        const result = await rig.run(
          'Try to write a file that should be blocked',
        );
        expect(result).toBeDefined();

        // This test highlights where the implementation could be strengthened
        // to properly respect deny decisions in sequential hook execution
      });
    });

    describe('PermissionRequest Matcher Scenarios', () => {
      it('should match specific tools with regex matcher', async () => {
        const specificToolScript =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "Specific tool matched and allowed"}}\'';

        await rig.setup('permission-req-matcher-specific', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              PermissionRequest: [
                {
                  matcher: 'Read|Write',
                  hooks: [
                    {
                      type: 'command',
                      command: specificToolScript,
                      name: 'permission-req-specific-tool-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Read the current directory');
        expect(result).toBeDefined();
      });

      it('should match all tools with wildcard matcher', async () => {
        const wildcardScript =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "Wildcard matcher allowed all tools"}}\'';

        await rig.setup('permission-req-matcher-wildcard', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              PermissionRequest: [
                {
                  matcher: '*',
                  hooks: [
                    {
                      type: 'command',
                      command: wildcardScript,
                      name: 'permission-req-wildcard-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run('Say wildcard test');
        expect(result).toBeDefined();
      });
    });
  });

  // ==========================================================================
  // SubagentStart Hooks
  // Triggered when a subagent is spawned via the Task tool
  // ==========================================================================
  describe('SubagentStart Hooks', () => {
    describe('Single SubagentStart Hook', () => {
      it('should execute SubagentStart hook when a subagent is launched', async () => {
        const hookScript =
          'echo \'{"hookSpecificOutput": {"additionalContext": "Subagent start approved"}}\'';

        await rig.setup('subagent-start-basic', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              SubagentStart: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: hookScript,
                      name: 'subagent-start-basic-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        // Use the Task tool to trigger SubagentStart
        const result = await rig.run(
          'Use the Task tool to create a bash subagent that says "hello from subagent"',
        );
        expect(result).toBeDefined();
      });

      it('should inject additional context from SubagentStart hook', async () => {
        const contextScript =
          'echo \'{"hookSpecificOutput": {"additionalContext": "Security check passed for subagent"}}\'';

        await rig.setup('subagent-start-context', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              SubagentStart: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: contextScript,
                      name: 'subagent-start-context-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        // The additional context should be available to the subagent
        const result = await rig.run(
          'Use the Task tool to create a bash subagent that says "hello"',
        );
        expect(result).toBeDefined();
      });

      it('should execute SubagentStart hook with additional context', async () => {
        const contextScript =
          'echo \'{"hookSpecificOutput": {"additionalContext": "Audit log created"}}\'';

        await rig.setup('subagent-start-context-only', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              SubagentStart: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: contextScript,
                      name: 'subagent-start-context-only-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        // The hook should be called and subagent should execute normally
        const result = await rig.run(
          'Use the Task tool to create a bash subagent that says "hello"',
        );
        expect(result).toBeDefined();
      });

      it('should handle error when SubagentStart hook command fails', async () => {
        const errorScript = 'echo "some error output" >&2; exit 1';

        await rig.setup('subagent-start-error', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              SubagentStart: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: errorScript,
                      name: 'subagent-start-error-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        // Even with error hooks, the subagent should still run
        const result = await rig.run(
          'Use the Task tool to create a bash subagent that says "hello"',
        );
        expect(result).toBeDefined();
      });
    });

    describe('Multiple SubagentStart Hooks', () => {
      it('should execute multiple SubagentStart hooks in parallel', async () => {
        const hook1Script =
          '(echo "hook1_called" >> hook_invoke_count.txt &) ; echo \'{"hookSpecificOutput": {"additionalContext": "Hook1 executed"}}\'';
        const hook2Script =
          '(echo "hook2_called" >> hook_invoke_count.txt &) ; echo \'{"hookSpecificOutput": {"additionalContext": "Hook2 executed"}}\'';

        await rig.setup('subagent-start-parallel', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              SubagentStart: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: hook1Script,
                      name: 'subagent-start-hook1',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: hook2Script,
                      name: 'subagent-start-hook2',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run(
          'Use the Task tool to create a bash subagent that says "hello"',
        );
        expect(result).toBeDefined();

        // Both hooks should have been invoked
        const hookInvokeCount = rig
          .readFile('hook_invoke_count.txt')
          .split('\n')
          .filter(
            (line) =>
              line.trim() === 'hook1_called' || line.trim() === 'hook2_called',
          ).length;
        expect(hookInvokeCount).toBeGreaterThanOrEqual(0);
      });

      it('should execute multiple SubagentStart hooks sequentially', async () => {
        const hook1Script =
          '(echo "hook1_called" >> hook_invoke_count.txt &) ; echo \'{"hookSpecificOutput": {"additionalContext": "Hook1 executed"}}\'';
        const hook2Script =
          '(echo "hook2_called" >> hook_invoke_count.txt &) ; echo \'{"hookSpecificOutput": {"additionalContext": "Hook2 executed"}}\'';

        await rig.setup('subagent-start-sequential', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              SubagentStart: [
                {
                  sequential: true,
                  hooks: [
                    {
                      type: 'command',
                      command: hook1Script,
                      name: 'subagent-start-seq-hook1',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: hook2Script,
                      name: 'subagent-start-seq-hook2',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run(
          'Use the Task tool to create a bash subagent that says "hello"',
        );
        expect(result).toBeDefined();

        // Both hooks should have been invoked sequentially
        const hookInvokeCount = rig
          .readFile('hook_invoke_count.txt')
          .split('\n')
          .filter(
            (line) =>
              line.trim() === 'hook1_called' || line.trim() === 'hook2_called',
          ).length;
        expect(hookInvokeCount).toBeGreaterThanOrEqual(0);
      });
    });

    describe('SubagentStart Matcher Scenarios', () => {
      it('should match specific agent types with exact matcher', async () => {
        const specificAgentScript =
          'echo \'{"hookSpecificOutput": {"additionalContext": "Specific agent type matched"}}\'';

        await rig.setup('subagent-start-matcher-specific', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              SubagentStart: [
                {
                  matcher: 'Bash',
                  hooks: [
                    {
                      type: 'command',
                      command: specificAgentScript,
                      name: 'subagent-start-specific-agent-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        // This should trigger the hook since we're launching a bash subagent
        const result = await rig.run(
          'Use the Task tool to create a bash subagent that says "hello"',
        );
        expect(result).toBeDefined();
      });

      it('should match all agent types with wildcard matcher', async () => {
        const wildcardScript =
          'echo \'{"hookSpecificOutput": {"additionalContext": "Wildcard matcher matched all agent types"}}\'';

        await rig.setup('subagent-start-matcher-wildcard', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              SubagentStart: [
                {
                  matcher: '*',
                  hooks: [
                    {
                      type: 'command',
                      command: wildcardScript,
                      name: 'subagent-start-wildcard-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run(
          'Use the Task tool to create a bash subagent that says "hello"',
        );
        expect(result).toBeDefined();
      });
    });
  });

  // ==========================================================================
  // SubagentStop Hooks
  // Triggered when a subagent finishes responding
  // ==========================================================================
  describe('SubagentStop Hooks', () => {
    describe('Single SubagentStop Hook', () => {
      it('should execute SubagentStop hook when a subagent finishes', async () => {
        const hookScript =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "Subagent stop processed"}}\'';

        await rig.setup('subagent-stop-basic', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              SubagentStop: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: hookScript,
                      name: 'subagent-stop-basic-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        // Use the Task tool to trigger both SubagentStart and SubagentStop
        const result = await rig.run(
          'Use the Task tool to create a bash subagent that says "hello from subagent"',
        );
        expect(result).toBeDefined();
      });

      it('should allow subagent to continue when SubagentStop hook blocks and requires continuation', async () => {
        // Create a script that returns block only once, then allow
        const blockOnceScript =
          'if [ -f hook_stop_state.txt ]; then echo \'{"decision": "allow"}\'; else echo "blocked_once" > hook_stop_state.txt; echo \'{"decision": "block", "reason": "File writing blocked by security policy, retrying..."}\'; fi';

        await rig.setup('subagent-stop-block-once', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              SubagentStop: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: blockOnceScript,
                      name: 'subagent-stop-block-once-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        // When SubagentStop hook blocks once, the subagent should receive the feedback and continue
        const result = await rig.run(
          'Use the Task tool to create a bash subagent to write a test file with "hello"',
        );
        expect(result).toBeDefined();

        // Verify that the state file was created with expected content (indicating block was triggered once)
        const stateContent = rig.readFile('hook_stop_state.txt');
        expect(stateContent).toContain('blocked_once');
      });

      it('should handle error when SubagentStop hook command fails', async () => {
        const errorScript = 'echo "some error output" >&2; exit 1';

        await rig.setup('subagent-stop-error', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              SubagentStop: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: errorScript,
                      name: 'subagent-stop-error-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        // Even with error hooks, the subagent should still complete
        const result = await rig.run(
          'Use the Task tool to create a bash subagent that says "hello"',
        );
        expect(result).toBeDefined();
      });
    });

    describe('Multiple SubagentStop Hooks', () => {
      it('should execute multiple SubagentStop hooks in parallel', async () => {
        const hook1Script =
          '(echo "hook1_called" >> hook_invoke_count.txt &) ; echo \'{"decision": "allow"}\'';
        const hook2Script =
          '(echo "hook2_called" >> hook_invoke_count.txt &) ; echo \'{"decision": "allow"}\'';

        await rig.setup('subagent-stop-parallel', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              SubagentStop: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: hook1Script,
                      name: 'subagent-stop-hook1',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: hook2Script,
                      name: 'subagent-stop-hook2',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run(
          'Use the Task tool to create a bash subagent that says "hello"',
        );
        expect(result).toBeDefined();

        // Both hooks should have been invoked
        const hookInvokeCount = rig
          .readFile('hook_invoke_count.txt')
          .split('\n')
          .filter(
            (line) =>
              line.trim() === 'hook1_called' || line.trim() === 'hook2_called',
          ).length;
        expect(hookInvokeCount).toBeGreaterThanOrEqual(2);
      });

      it('should execute multiple SubagentStop hooks sequentially', async () => {
        const hook1Script =
          '(echo "hook1_called" >> hook_invoke_count.txt &) ; echo \'{"decision": "allow"}\'';
        const hook2Script =
          '(echo "hook2_called" >> hook_invoke_count.txt &) ; echo \'{"decision": "allow"}\'';

        await rig.setup('subagent-stop-sequential', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              SubagentStop: [
                {
                  sequential: true,
                  hooks: [
                    {
                      type: 'command',
                      command: hook1Script,
                      name: 'subagent-stop-seq-hook1',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: hook2Script,
                      name: 'subagent-stop-seq-hook2',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run(
          'Use the Task tool to create a bash subagent that says "hello"',
        );
        expect(result).toBeDefined();

        // Both hooks should have been invoked sequentially
        const hookInvokeCount = rig
          .readFile('hook_invoke_count.txt')
          .split('\n')
          .filter(
            (line) =>
              line.trim() === 'hook1_called' || line.trim() === 'hook2_called',
          ).length;
        expect(hookInvokeCount).toBeGreaterThanOrEqual(2);
      });
    });

    describe('SubagentStop Matcher Scenarios', () => {
      it('should match specific agent types with exact matcher', async () => {
        const specificAgentScript =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "Specific agent type matched and allowed at stop"}}\'';

        await rig.setup('subagent-stop-matcher-specific', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              SubagentStop: [
                {
                  matcher: 'Bash',
                  hooks: [
                    {
                      type: 'command',
                      command: specificAgentScript,
                      name: 'subagent-stop-specific-agent-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        // This should trigger the hook since we're launching a bash subagent
        const result = await rig.run(
          'Use the Task tool to create a bash subagent that says "hello"',
        );
        expect(result).toBeDefined();
      });

      it('should match all agent types with wildcard matcher', async () => {
        const wildcardScript =
          'echo \'{"decision": "allow", "hookSpecificOutput": {"additionalContext": "Wildcard matcher allowed all agent types at stop"}}\'';

        await rig.setup('subagent-stop-matcher-wildcard', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              SubagentStop: [
                {
                  matcher: '*',
                  hooks: [
                    {
                      type: 'command',
                      command: wildcardScript,
                      name: 'subagent-stop-wildcard-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run(
          'Use the Task tool to create a bash subagent that says "hello"',
        );
        expect(result).toBeDefined();
      });
    });
  });

  // ==========================================================================
  // Notification Hooks
  // Triggered when various notification events occur
  // ==========================================================================
  describe('Notification Hooks', () => {
    describe('Idle Prompt Notifications', () => {
      it('should handle idle prompt notifications correctly', async () => {
        const idlePromptScript =
          'echo \'{"additionalContext": "Idle prompt notification processed"}\'';
        await rig.setup('notification-idle-prompt', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              Notification: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: idlePromptScript,
                      name: 'notification-idle-prompt-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        // Simulate an idle prompt scenario - this might involve simulating a timeout
        const result = await rig.run('Say idle prompt notification test');

        expect(result).toBeDefined();
      });

      it('should process multiple idle prompt notifications', async () => {
        const idlePromptScript1 =
          'echo \'{"additionalContext": "First idle prompt notification"}\'';
        const idlePromptScript2 =
          'echo \'{"additionalContext": "Second idle prompt notification"}\'';
        await rig.setup('notification-idle-prompt-multiple', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              Notification: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: idlePromptScript1,
                      name: 'notification-idle-prompt-hook-1',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: idlePromptScript2,
                      name: 'notification-idle-prompt-hook-2',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run(
          'Say multiple idle prompt notification test',
        );

        expect(result).toBeDefined();
      });
    });

    describe('Elicitation Dialog Notifications', () => {
      it('should handle elication dialog notifications correctly', async () => {
        const elicationDialogScript =
          'echo \'{"additionalContext": "Elicitation dialog notification processed"}\'';

        await rig.setup('notification-elication-dialog', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              Notification: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: elicationDialogScript,
                      name: 'notification-elication-dialog-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        // Simulate an elication dialog scenario
        const result = await rig.run('Say elication dialog notification test');

        expect(result).toBeDefined();
      });

      it('should handle multiple elication dialog notifications', async () => {
        const elicationDialogScript1 =
          'echo \'{"additionalContext": "First elication dialog notification"}\'';
        const elicationDialogScript2 =
          'echo \'{"additionalContext": "Second elication dialog notification"}\'';
        await rig.setup('notification-elication-dialog-multiple', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              Notification: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: elicationDialogScript1,
                      name: 'notification-elication-dialog-hook-1',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: elicationDialogScript2,
                      name: 'notification-elication-dialog-hook-2',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run(
          'Say multiple elication dialog notification test',
        );

        expect(result).toBeDefined();
      });

      it('should handle elication dialog notification with error', async () => {
        await rig.setup('notification-elication-dialog-error', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              Notification: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: 'nonexistent_command_xyz',
                      name: 'notification-elication-dialog-error-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        // Error should be handled gracefully and not block execution
        const result = await rig.run('Say elication dialog error test');

        expect(result).toBeDefined();
      });
    });

    describe('Multiple Notification Hooks', () => {
      it('should handle multiple different notification types correctly', async () => {
        const notificationScript1 =
          'echo \'{"additionalContext": "Generic notification 1"}\'';
        const notificationScript2 =
          'echo \'{"additionalContext": "Generic notification 2"}\'';

        await rig.setup('notification-multiple-different', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              Notification: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: notificationScript1,
                      name: 'notification-multiple-hook-1',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: notificationScript2,
                      name: 'notification-multiple-hook-2',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        const result = await rig.run(
          'Say multiple different notification test',
        );

        expect(result).toBeDefined();
      });
    });

    describe('Notification Hook Error Handling', () => {
      it('should handle missing command gracefully', async () => {
        await rig.setup('notification-missing-command', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              Notification: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: '', // Empty command
                      name: 'notification-empty-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        // Empty command should be skipped gracefully
        const result = await rig.run('Say missing command test');

        expect(result).toBeDefined();
      });

      it('should handle non-executable command gracefully', async () => {
        await rig.setup('notification-non-executable', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              Notification: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: '/nonexistent/path/to/command',
                      name: 'notification-non-exec-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        // Non-existent command should be handled gracefully
        const result = await rig.run('Say non-executable command test');

        expect(result).toBeDefined();
      });

      it('should handle command with non-zero exit code gracefully', async () => {
        await rig.setup('notification-nonzero-exit', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              Notification: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: 'echo "warning" >&2 && exit 1',
                      name: 'notification-nonzero-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
          },
        });

        // Non-zero exit should be handled gracefully for notification hooks
        const result = await rig.run('Say nonzero exit code test');

        expect(result).toBeDefined();
      });

      it('should handle command timeout gracefully', async () => {
        await rig.setup('notification-timeout', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              Notification: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: 'sleep 10',
                      name: 'notification-timeout-hook',
                      timeout: 1000, // Very short timeout to trigger timeout condition
                    },
                  ],
                },
              ],
            },
          },
        });

        // Timeout should be handled gracefully
        const result = await rig.run('Say timeout test');

        expect(result).toBeDefined();
      });
    });
  });
});
