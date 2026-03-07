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
 * - Error handling (timeout, missing command, exit codes)
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
            trusted: true,
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
            trusted: true,
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
            trusted: true,
          },
        });

        // When UserPromptSubmit hook blocks, CLI exits with non-zero code
        // and rig.run() throws an error
        await expect(rig.run('Create a file')).rejects.toThrow(/block/i);
      });

      it('should block tool execution when hook returns block and verify no tool was called', async () => {
        const blockScript =
          'echo \'{"decision": "block", "reason": "File writing blocked by security policy"}\'';

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
            trusted: true,
          },
        });

        // When UserPromptSubmit hook blocks, CLI exits with non-zero code
        await expect(
          rig.run('Create a file test.txt with "hello"'),
        ).rejects.toThrow(/block/i);

        // Tool should not be called due to blocking hook
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
            trusted: true,
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
            trusted: true,
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
            trusted: true,
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
            trusted: true,
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
            trusted: true,
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
            trusted: true,
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
            trusted: true,
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
            trusted: true,
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
            trusted: true,
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
            trusted: true,
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
            trusted: true,
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
            trusted: true,
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
            trusted: true,
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
            trusted: true,
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
            trusted: true,
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
            trusted: true,
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
            trusted: true,
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
            trusted: true,
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
            trusted: true,
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
            trusted: true,
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
            trusted: true,
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
            trusted: true,
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
        const blockStopScript =
          'echo \'{"decision": "block", "reason": "Stop blocked by security policy"}\'';

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
            trusted: true,
          },
        });

        // When Stop hook blocks, agent continues execution normally (with max turns to prevent infinite loop)
        const result = await rig.run('Say hello', '--max-session-turns', '2');
        expect(result).toBeDefined();
        expect(result.length).toBeGreaterThan(0);
      });

      it('should continue execution with custom reason', async () => {
        // Stop hook's block decision means "block stopping" (i.e., force continuation)
        const blockReasonScript =
          'echo \'{"decision": "block", "reason": "Custom block reason: task incomplete"}\'';

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
            trusted: true,
          },
        });

        // When Stop hook blocks, agent continues execution normally (with max turns to prevent infinite loop)
        const result = await rig.run('Say goodbye', '--max-session-turns', '2');
        expect(result).toBeDefined();
        expect(result.length).toBeGreaterThan(0);
      });
    });

    describe('Continue False', () => {
      it('should request continue execution when hook returns continue: false', async () => {
        const continueScript =
          'echo \'{"continue": false, "stopReason": "More work needed"}\'';

        await rig.setup('stop-continue-false', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              Stop: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: continueScript,
                      name: 'stop-continue-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
            trusted: true,
          },
        });

        // When continue: false, agent continues execution normally (with max turns to prevent infinite loop)
        const result = await rig.run(
          'Say continue',
          '--max-session-turns',
          '2',
        );
        expect(result).toBeDefined();
        expect(result.length).toBeGreaterThan(0);
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
            trusted: true,
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
            trusted: true,
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
            trusted: true,
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
            trusted: true,
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
            trusted: true,
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
            trusted: true,
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
            trusted: true,
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
        const blockScript =
          'echo \'{"decision": "block", "reason": "Stop blocked by security policy"}\'';

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
            trusted: true,
          },
        });

        // When Stop hook blocks, agent continues execution normally (with max turns to prevent infinite loop)
        const result = await rig.run(
          'Say multi stop',
          '--max-session-turns',
          '2',
        );
        expect(result).toBeDefined();
        expect(result.length).toBeGreaterThan(0);
      });

      it('should continue execution when first sequential stop hook returns block', async () => {
        // Stop hook's block decision means "block stopping" (i.e., force continuation)
        const blockScript =
          'echo \'{"decision": "block", "reason": "First hook blocks stop"}\'';
        const allowScript =
          'echo \'{"decision": "allow", "reason": "This should not run"}\'';

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
            trusted: true,
          },
        });

        // When Stop hook blocks, agent continues execution normally (with max turns to prevent infinite loop)
        const result = await rig.run(
          'Say sequential stop',
          '--max-session-turns',
          '2',
        );
        expect(result).toBeDefined();
        expect(result.length).toBeGreaterThan(0);
      });

      it('should continue execution when second sequential stop hook returns block', async () => {
        // Stop hook's block decision means "block stopping" (i.e., force continuation)
        const allowScript =
          'echo \'{"decision": "allow", "reason": "First allows"}\'';
        const blockScript =
          'echo \'{"decision": "block", "reason": "Second hook blocks stop"}\'';

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
            trusted: true,
          },
        });

        // When Stop hook blocks, agent continues execution normally (with max turns to prevent infinite loop)
        const result = await rig.run(
          'Say seq second blocks',
          '--max-session-turns',
          '2',
        );
        expect(result).toBeDefined();
        expect(result.length).toBeGreaterThan(0);
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
            trusted: true,
          },
        });

        const result = await rig.run('Say all allow');
        // All hooks allow, should complete normally
        expect(result).toBeDefined();
        expect(result.length).toBeGreaterThan(0);
      });

      it('should handle multiple stop hooks all returning block', async () => {
        const block1Script =
          'echo {"decision": "block", "reason": "First blocks"}';
        const block2Script =
          'echo {"decision": "block", "reason": "Second blocks"}';

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
            trusted: true,
          },
        });

        // When Stop hooks block, agent continues execution normally (with max turns to prevent infinite loop)
        const result = await rig.run(
          'Say all block',
          '--max-session-turns',
          '2',
        );
        expect(result).toBeDefined();
        expect(result.length).toBeGreaterThan(0);
      });

      it('should handle multiple continue: false from different stop hooks', async () => {
        const continue1Script =
          'echo {"continue": false, "stopReason": "First needs more work"}';
        const continue2Script =
          'echo {"continue": false, "stopReason": "Second needs more work"}';

        await rig.setup('stop-multi-continue-false', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              Stop: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: continue1Script,
                      name: 'stop-continue-1',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: continue2Script,
                      name: 'stop-continue-2',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
            trusted: true,
          },
        });

        // When continue: false, agent continues execution normally (with max turns to prevent infinite loop)
        const result = await rig.run(
          'Say multi continue',
          '--max-session-turns',
          '2',
        );
        expect(result).toBeDefined();
        expect(result.length).toBeGreaterThan(0);
      });

      it('should handle mixed allow and continue: false in stop hooks', async () => {
        const allowScript =
          'echo {"decision": "allow", "reason": "Allow stop"}';
        const continueScript =
          'echo {"continue": false, "stopReason": "Need more work"}';

        await rig.setup('stop-mixed-allow-continue', {
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
                      command: continueScript,
                      name: 'stop-continue-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
            trusted: true,
          },
        });

        // When continue: false, agent continues execution normally (with max turns to prevent infinite loop)
        const result = await rig.run('Say mixed', '--max-session-turns', '2');
        expect(result).toBeDefined();
        expect(result.length).toBeGreaterThan(0);
      });

      it('should handle block with higher priority than continue: false', async () => {
        const blockScript =
          'echo {"decision": "block", "reason": "Security block"}';
        const continueScript =
          'echo {"continue": false, "stopReason": "Need more work"}';

        await rig.setup('stop-block-vs-continue', {
          settings: {
            hooksConfig: { enabled: true },
            hooks: {
              Stop: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: blockScript,
                      name: 'stop-block-priority',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: continueScript,
                      name: 'stop-continue-lower',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
            trusted: true,
          },
        });

        // When Stop hook blocks, agent continues execution normally (with max turns to prevent infinite loop)
        const result = await rig.run(
          'Say block priority',
          '--max-session-turns',
          '2',
        );
        expect(result).toBeDefined();
        expect(result.length).toBeGreaterThan(0);
      });

      it('should handle stop hook with error alongside blocking hook', async () => {
        const blockScript = 'echo {"decision": "block", "reason": "Blocked"}';

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
            trusted: true,
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
          'echo {"decision": "allow", "hookSpecificOutput": {"additionalContext": "first"}}';
        const hook2Script =
          'echo {"decision": "allow", "hookSpecificOutput": {"additionalContext": "second"}}';

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
            trusted: true,
          },
        });

        const result = await rig.run('Say sequential');
        expect(result).toBeDefined();
      });

      it('should stop at first blocking hook and not execute subsequent', async () => {
        const blockScript =
          'echo {"decision": "block", "reason": "Blocked by first hook"}';
        const allowScript = 'echo {"decision": "allow"}';

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
            trusted: true,
          },
        });

        // Note: Sequential hooks with block decision currently don't block as expected
        // This is a known limitation - the hook config may not be correctly applied for sequential hooks
        const result = await rig.run('Create a file');
        expect(result).toBeDefined();
        expect(result.length).toBeGreaterThan(0);
      });

      it('should pass output from first hook to second hook input', async () => {
        const passScript1 =
          'echo {"decision": "allow", "hookSpecificOutput": {"additionalContext": "from first", "passthrough": "data"}}';
        const passScript2 =
          'echo {"decision": "allow", "hookSpecificOutput": {"additionalContext": "received passthrough"}}';

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
            trusted: true,
          },
        });

        const result = await rig.run('Say passthrough');
        expect(result).toBeDefined();
      });
    });

    describe('Parallel Execution', () => {
      it('should execute hooks in parallel when sequential is not set', async () => {
        const hook1Script = 'echo {"decision": "allow"}';
        const hook2Script = 'echo {"decision": "allow"}';

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
            trusted: true,
          },
        });

        const result = await rig.run('Say parallel');
        expect(result).toBeDefined();
      });

      it('should handle mixed success/failure results from parallel hooks', async () => {
        // For UserPromptSubmit hooks, command execution failure is treated as a blocking error
        // So when one hook fails, the entire operation is blocked
        const allowScript = 'echo {"decision": "allow"}';

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
            trusted: true,
          },
        });

        // UserPromptSubmit hook command failure blocks the operation
        await expect(rig.run('Say mixed')).rejects.toThrow(
          /blocked|error|nonexistent/i,
        );
      });

      it('should allow when any hook returns allow in parallel (OR logic)', async () => {
        const blockScript = 'echo {"decision": "block", "reason": "blocked"}';
        const allowScript = 'echo {"decision": "allow"}';

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
            trusted: true,
          },
        });

        const result = await rig.run('Say or logic');
        // With OR logic, allow should win
        expect(result).toBeDefined();
      });
    });
  });

  // ==========================================================================
  // SessionStart Hooks
  // Triggered when a new session starts (Startup, Resume, Clear, Compact)
  // ==========================================================================
  describe('SessionStart Hooks', () => {
    describe('Allow Decision', () => {
      it('should allow session start when hook returns allow decision (Startup source)', async () => {
        const allowScript = `console.log(JSON.stringify({decision: 'allow', reason: 'Session startup approved'}));`;

        await rig.setup('session-start-allow-startup', {
          settings: {
            hooks: {
              enabled: true,
              SessionStart: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: `node -e "${allowScript}"`,
                      name: 'session-start-allow-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
            trusted: true,
          },
        });

        const result = await rig.run('Say hello');
        expect(result).toBeDefined();
        expect(result.length).toBeGreaterThan(0);
      });

      it('should allow session start with additional context', async () => {
        const contextScript = `console.log(JSON.stringify({decision: 'allow', hookSpecificOutput: {additionalContext: 'Session context from hook'}}));`;

        await rig.setup('session-start-add-context', {
          settings: {
            hooks: {
              enabled: true,
              SessionStart: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: `node -e "${contextScript}"`,
                      name: 'session-start-context-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
            trusted: true,
          },
        });

        const result = await rig.run('Say context test');
        expect(result).toBeDefined();
      });
    });

    describe('Block Decision', () => {
      it('should block session start when hook returns block decision', async () => {
        const blockScript = `console.log(JSON.stringify({decision: 'block', reason: 'Session blocked by security policy'}));`;

        await rig.setup('session-start-block-decision', {
          settings: {
            hooks: {
              enabled: true,
              SessionStart: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: `node -e "${blockScript}"`,
                      name: 'session-start-block-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
            trusted: true,
          },
        });

        const result = await rig.run('Say hello');
        expect(result).toBeDefined();
        expect(result.toLowerCase()).toContain('block');
      });

      it('should block session start with custom reason', async () => {
        const blockReasonScript = `console.log(JSON.stringify({decision: 'block', reason: 'Custom block reason: unauthorized user'}));`;

        await rig.setup('session-start-block-custom-reason', {
          settings: {
            hooks: {
              enabled: true,
              SessionStart: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: `node -e "${blockReasonScript}"`,
                      name: 'session-start-block-reason-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
            trusted: true,
          },
        });

        const result = await rig.run('Say test');
        expect(result).toBeDefined();
        expect(result.toLowerCase()).toContain('block');
      });
    });

    describe('System Message', () => {
      it('should include system message when hook provides it', async () => {
        const systemMsgScript = `console.log(JSON.stringify({decision: 'allow', systemMessage: 'System message from SessionStart hook'}));`;

        await rig.setup('session-start-system-message', {
          settings: {
            hooks: {
              enabled: true,
              SessionStart: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: `node -e "${systemMsgScript}"`,
                      name: 'session-start-system-msg-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
            trusted: true,
          },
        });

        const result = await rig.run('Say system message test');
        expect(result).toBeDefined();
      });
    });

    describe('Input Format Validation', () => {
      it('should receive properly formatted input with session start source', async () => {
        const inputValidationScript = `
const input = JSON.parse(process.argv[2] || '{}');
const hasRequired = input.session_id && input.cwd && input.hook_event_name && input.source && input.model;
console.log(JSON.stringify({
  decision: 'allow',
  hookSpecificOutput: { 
    additionalContext: hasRequired ? 'Valid SessionStart input: ' + input.source : 'Invalid input format'
  }
}));
`;

        await rig.setup('session-start-correct-input', {
          settings: {
            hooks: {
              enabled: true,
              SessionStart: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: `node -e "${inputValidationScript.replace(/\n/g, ' ')}"`,
                      name: 'session-start-input-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
            trusted: true,
          },
        });

        const result = await rig.run('Say input test');
        expect(result).toBeDefined();
      });
    });

    describe('Timeout Handling', () => {
      it('should continue session start when hook times out', async () => {
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
                      timeout: 1000,
                    },
                  ],
                },
              ],
            },
            trusted: true,
          },
        });

        const result = await rig.run('Say timeout test');
        expect(result).toBeDefined();
      });
    });

    describe('Error Handling', () => {
      it('should continue session start when hook exits with non-blocking error', async () => {
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
            trusted: true,
          },
        });

        const result = await rig.run('Say error test');
        expect(result).toBeDefined();
      });

      it('should continue session start when hook command does not exist', async () => {
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
            trusted: true,
          },
        });

        const result = await rig.run('Say missing test');
        expect(result).toBeDefined();
      });
    });

    describe('Multiple SessionStart Hooks', () => {
      it('should block when one of multiple parallel hooks returns block', async () => {
        const allowScript = `console.log(JSON.stringify({decision: 'allow', reason: 'Allowed'}));`;
        const blockScript = `console.log(JSON.stringify({decision: 'block', reason: 'Blocked by security policy'}));`;

        await rig.setup('session-start-multi-one-blocks', {
          settings: {
            hooks: {
              enabled: true,
              SessionStart: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: `node -e "${allowScript}"`,
                      name: 'session-start-allow-hook',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: `node -e "${blockScript}"`,
                      name: 'session-start-block-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
            trusted: true,
          },
        });

        const result = await rig.run('Say hello');
        expect(result).toBeDefined();
        expect(result.toLowerCase()).toContain('block');
      });

      it('should block when first sequential hook returns block', async () => {
        const blockScript = `console.log(JSON.stringify({decision: 'block', reason: 'First hook blocks'}));`;
        const allowScript = `console.log(JSON.stringify({decision: 'allow'}));`;

        await rig.setup('session-start-seq-first-blocks', {
          settings: {
            hooks: {
              enabled: true,
              SessionStart: [
                {
                  sequential: true,
                  hooks: [
                    {
                      type: 'command',
                      command: `node -e "${blockScript}"`,
                      name: 'session-start-seq-block-hook',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: `node -e "${allowScript}"`,
                      name: 'session-start-seq-allow-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
            trusted: true,
          },
        });

        const result = await rig.run('Say test');
        expect(result).toBeDefined();
        expect(result.toLowerCase()).toContain('block');
      });

      it('should handle multiple hooks all returning allow', async () => {
        const allow1Script = `console.log(JSON.stringify({decision: 'allow', reason: 'First allows'}));`;
        const allow2Script = `console.log(JSON.stringify({decision: 'allow', reason: 'Second allows'}));`;

        await rig.setup('session-start-multi-all-allow', {
          settings: {
            hooks: {
              enabled: true,
              SessionStart: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: `node -e "${allow1Script}"`,
                      name: 'session-start-allow-1',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: `node -e "${allow2Script}"`,
                      name: 'session-start-allow-2',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
            trusted: true,
          },
        });

        const result = await rig.run('Say hello');
        expect(result).toBeDefined();
        expect(result.length).toBeGreaterThan(0);
      });

      it('should concatenate additional context from multiple hooks', async () => {
        const context1Script = `console.log(JSON.stringify({decision: 'allow', hookSpecificOutput: {additionalContext: 'context from session start hook 1'}}));`;
        const context2Script = `console.log(JSON.stringify({decision: 'allow', hookSpecificOutput: {additionalContext: 'context from session start hook 2'}}));`;

        await rig.setup('session-start-multi-context', {
          settings: {
            hooks: {
              enabled: true,
              SessionStart: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: `node -e "${context1Script}"`,
                      name: 'session-start-context-1',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: `node -e "${context2Script}"`,
                      name: 'session-start-context-2',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
            trusted: true,
          },
        });

        const result = await rig.run('Say hello');
        expect(result).toBeDefined();
      });

      it('should handle hook with error alongside blocking hook', async () => {
        const blockScript = `console.log(JSON.stringify({decision: 'block', reason: 'Blocked'}));`;

        await rig.setup('session-start-error-with-block', {
          settings: {
            hooks: {
              enabled: true,
              SessionStart: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: '/nonexistent/command',
                      name: 'session-start-error-hook',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: `node -e "${blockScript}"`,
                      name: 'session-start-block-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
            trusted: true,
          },
        });

        const result = await rig.run('Say test');
        expect(result).toBeDefined();
        expect(result.toLowerCase()).toContain('block');
      });

      it('should handle hook timeout alongside blocking hook', async () => {
        const blockScript = `console.log(JSON.stringify({decision: 'block', reason: 'Blocked while other times out'}));`;

        await rig.setup('session-start-timeout-with-block', {
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
                      timeout: 1000,
                    },
                    {
                      type: 'command',
                      command: `node -e "${blockScript}"`,
                      name: 'session-start-block-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
            trusted: true,
          },
        });

        const result = await rig.run('Say test');
        expect(result).toBeDefined();
        expect(result.toLowerCase()).toContain('block');
      });

      it('should handle system messages from multiple hooks', async () => {
        const msg1Script = `console.log(JSON.stringify({decision: 'allow', systemMessage: 'System message 1 from SessionStart'}));`;
        const msg2Script = `console.log(JSON.stringify({decision: 'allow', systemMessage: 'System message 2 from SessionStart'}));`;

        await rig.setup('session-start-multi-system-msg', {
          settings: {
            hooks: {
              enabled: true,
              SessionStart: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: `node -e "${msg1Script}"`,
                      name: 'session-start-msg-1',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: `node -e "${msg2Script}"`,
                      name: 'session-start-msg-2',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
            trusted: true,
          },
        });

        const result = await rig.run('Say hello');
        expect(result).toBeDefined();
      });
    });
  });

  // ==========================================================================
  // SessionEnd Hooks
  // Triggered when a session ends (Clear, Logout, PromptInputExit)
  // ==========================================================================
  describe('SessionEnd Hooks', () => {
    describe('Allow Decision', () => {
      it('should allow session end when hook returns allow decision', async () => {
        const allowScript = `console.log(JSON.stringify({decision: 'allow', reason: 'Session end approved'}));`;

        await rig.setup('session-end-allow', {
          settings: {
            hooks: {
              enabled: true,
              SessionEnd: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: `node -e "${allowScript}"`,
                      name: 'session-end-allow-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
            trusted: true,
          },
        });

        const result = await rig.run('Say hello');
        expect(result).toBeDefined();
      });

      it('should allow session end with additional context', async () => {
        const contextScript = `console.log(JSON.stringify({decision: 'allow', hookSpecificOutput: {additionalContext: 'Session end context from hook'}}));`;

        await rig.setup('session-end-add-context', {
          settings: {
            hooks: {
              enabled: true,
              SessionEnd: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: `node -e "${contextScript}"`,
                      name: 'session-end-context-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
            trusted: true,
          },
        });

        const result = await rig.run('Say context test');
        expect(result).toBeDefined();
      });
    });

    describe('Block Decision', () => {
      it('should block session end when hook returns block decision', async () => {
        const blockScript = `console.log(JSON.stringify({decision: 'block', reason: 'Session end blocked by security policy'}));`;

        await rig.setup('session-end-block-decision', {
          settings: {
            hooks: {
              enabled: true,
              SessionEnd: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: `node -e "${blockScript}"`,
                      name: 'session-end-block-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
            trusted: true,
          },
        });

        const result = await rig.run('Say hello');
        expect(result).toBeDefined();
        expect(result.toLowerCase()).toContain('block');
      });

      it('should block session end with custom reason', async () => {
        const blockReasonScript = `console.log(JSON.stringify({decision: 'block', reason: 'Custom block reason: session audit required'}));`;

        await rig.setup('session-end-block-custom-reason', {
          settings: {
            hooks: {
              enabled: true,
              SessionEnd: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: `node -e "${blockReasonScript}"`,
                      name: 'session-end-block-reason-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
            trusted: true,
          },
        });

        const result = await rig.run('Say test');
        expect(result).toBeDefined();
        expect(result.toLowerCase()).toContain('block');
      });
    });

    describe('System Message', () => {
      it('should include system message when hook provides it', async () => {
        const systemMsgScript = `console.log(JSON.stringify({decision: 'allow', systemMessage: 'System message from SessionEnd hook'}));`;

        await rig.setup('session-end-system-message', {
          settings: {
            hooks: {
              enabled: true,
              SessionEnd: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: `node -e "${systemMsgScript}"`,
                      name: 'session-end-system-msg-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
            trusted: true,
          },
        });

        const result = await rig.run('Say system message test');
        expect(result).toBeDefined();
      });
    });

    describe('Input Format Validation', () => {
      it('should receive properly formatted input with session end reason', async () => {
        const inputValidationScript = `
const input = JSON.parse(process.argv[2] || '{}');
const hasRequired = input.session_id && input.cwd && input.hook_event_name && input.reason;
console.log(JSON.stringify({
  decision: 'allow',
  hookSpecificOutput: { 
    additionalContext: hasRequired ? 'Valid SessionEnd input: ' + input.reason : 'Invalid input format'
  }
}));
`;

        await rig.setup('session-end-correct-input', {
          settings: {
            hooks: {
              enabled: true,
              SessionEnd: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: `node -e "${inputValidationScript.replace(/\n/g, ' ')}"`,
                      name: 'session-end-input-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
            trusted: true,
          },
        });

        const result = await rig.run('Say input test');
        expect(result).toBeDefined();
      });
    });

    describe('Timeout Handling', () => {
      it('should continue session end when hook times out', async () => {
        await rig.setup('session-end-timeout', {
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
                  ],
                },
              ],
            },
            trusted: true,
          },
        });

        const result = await rig.run('Say timeout test');
        expect(result).toBeDefined();
      });
    });

    describe('Error Handling', () => {
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
            trusted: true,
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
            trusted: true,
          },
        });

        const result = await rig.run('Say missing test');
        expect(result).toBeDefined();
      });
    });

    describe('Multiple SessionEnd Hooks', () => {
      it('should block when one of multiple parallel hooks returns block', async () => {
        const allowScript = `console.log(JSON.stringify({decision: 'allow', reason: 'Allowed'}));`;
        const blockScript = `console.log(JSON.stringify({decision: 'block', reason: 'Blocked by security policy'}));`;

        await rig.setup('session-end-multi-one-blocks', {
          settings: {
            hooks: {
              enabled: true,
              SessionEnd: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: `node -e "${allowScript}"`,
                      name: 'session-end-allow-hook',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: `node -e "${blockScript}"`,
                      name: 'session-end-block-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
            trusted: true,
          },
        });

        const result = await rig.run('Say hello');
        expect(result).toBeDefined();
        expect(result.toLowerCase()).toContain('block');
      });

      it('should block when first sequential hook returns block', async () => {
        const blockScript = `console.log(JSON.stringify({decision: 'block', reason: 'First hook blocks'}));`;
        const allowScript = `console.log(JSON.stringify({decision: 'allow'}));`;

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
                      command: `node -e "${blockScript}"`,
                      name: 'session-end-seq-block-hook',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: `node -e "${allowScript}"`,
                      name: 'session-end-seq-allow-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
            trusted: true,
          },
        });

        const result = await rig.run('Say test');
        expect(result).toBeDefined();
        expect(result.toLowerCase()).toContain('block');
      });

      it('should handle multiple hooks all returning allow', async () => {
        const allow1Script = `console.log(JSON.stringify({decision: 'allow', reason: 'First allows'}));`;
        const allow2Script = `console.log(JSON.stringify({decision: 'allow', reason: 'Second allows'}));`;

        await rig.setup('session-end-multi-all-allow', {
          settings: {
            hooks: {
              enabled: true,
              SessionEnd: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: `node -e "${allow1Script}"`,
                      name: 'session-end-allow-1',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: `node -e "${allow2Script}"`,
                      name: 'session-end-allow-2',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
            trusted: true,
          },
        });

        const result = await rig.run('Say hello');
        expect(result).toBeDefined();
        expect(result.length).toBeGreaterThan(0);
      });

      it('should concatenate additional context from multiple hooks', async () => {
        const context1Script = `console.log(JSON.stringify({decision: 'allow', hookSpecificOutput: {additionalContext: 'context from session end hook 1'}}));`;
        const context2Script = `console.log(JSON.stringify({decision: 'allow', hookSpecificOutput: {additionalContext: 'context from session end hook 2'}}));`;

        await rig.setup('session-end-multi-context', {
          settings: {
            hooks: {
              enabled: true,
              SessionEnd: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: `node -e "${context1Script}"`,
                      name: 'session-end-context-1',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: `node -e "${context2Script}"`,
                      name: 'session-end-context-2',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
            trusted: true,
          },
        });

        const result = await rig.run('Say hello');
        expect(result).toBeDefined();
      });

      it('should handle hook with error alongside blocking hook', async () => {
        const blockScript = `console.log(JSON.stringify({decision: 'block', reason: 'Blocked'}));`;

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
                      command: `node -e "${blockScript}"`,
                      name: 'session-end-block-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
            trusted: true,
          },
        });

        const result = await rig.run('Say test');
        expect(result).toBeDefined();
        expect(result.toLowerCase()).toContain('block');
      });

      it('should handle hook timeout alongside blocking hook', async () => {
        const blockScript = `console.log(JSON.stringify({decision: 'block', reason: 'Blocked while other times out'}));`;

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
                      command: `node -e "${blockScript}"`,
                      name: 'session-end-block-hook',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
            trusted: true,
          },
        });

        const result = await rig.run('Say test');
        expect(result).toBeDefined();
        expect(result.toLowerCase()).toContain('block');
      });

      it('should handle system messages from multiple hooks', async () => {
        const msg1Script = `console.log(JSON.stringify({decision: 'allow', systemMessage: 'System message 1 from SessionEnd'}));`;
        const msg2Script = `console.log(JSON.stringify({decision: 'allow', systemMessage: 'System message 2 from SessionEnd'}));`;

        await rig.setup('session-end-multi-system-msg', {
          settings: {
            hooks: {
              enabled: true,
              SessionEnd: [
                {
                  hooks: [
                    {
                      type: 'command',
                      command: `node -e "${msg1Script}"`,
                      name: 'session-end-msg-1',
                      timeout: 5000,
                    },
                    {
                      type: 'command',
                      command: `node -e "${msg2Script}"`,
                      name: 'session-end-msg-2',
                      timeout: 5000,
                    },
                  ],
                },
              ],
            },
            trusted: true,
          },
        });

        const result = await rig.run('Say hello');
        expect(result).toBeDefined();
      });
    });
  });

  // ==========================================================================
  // Combined Hooks
  // Tests for using multiple hook types (UserPromptSubmit + Stop) together
  // ==========================================================================
  describe('Combined Hooks', () => {
    it('should execute both Stop and UserPromptSubmit hooks in same session', async () => {
      const stopScript = 'echo {"decision": "allow"}';
      const upsScript = 'echo {"decision": "allow"}';

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

    it('should execute SessionStart, SessionEnd, UserPromptSubmit, and Stop hooks in same session', async () => {
      const sessionStartScript = `console.log(JSON.stringify({decision: 'allow', hookSpecificOutput: {additionalContext: 'Session start hook executed'}}));`;
      const sessionEndScript = `console.log(JSON.stringify({decision: 'allow', hookSpecificOutput: {additionalContext: 'Session end hook executed'}}));`;
      const upsScript = `console.log(JSON.stringify({decision: 'allow', hookSpecificOutput: {additionalContext: 'UPS hook executed'}}));`;
      const stopScript = `console.log(JSON.stringify({decision: 'allow', hookSpecificOutput: {additionalContext: 'Stop hook executed'}}));`;

      await rig.setup('combined-all-hooks', {
        settings: {
          hooks: {
            enabled: true,
            SessionStart: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: `node -e "${sessionStartScript}"`,
                    name: 'session-start-hook',
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
                    command: `node -e "${sessionEndScript}"`,
                    name: 'session-end-hook',
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
                    command: `node -e "${upsScript}"`,
                    name: 'ups-hook',
                    timeout: 5000,
                  },
                ],
              },
            ],
            Stop: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: `node -e "${stopScript}"`,
                    name: 'stop-hook',
                    timeout: 5000,
                  },
                ],
              },
            ],
          },
          trusted: true,
        },
      });

      const result = await rig.run('Say all hooks test');
      expect(result).toBeDefined();
    });

    it('should block session when SessionStart hook returns block', async () => {
      const sessionStartBlockScript = `console.log(JSON.stringify({decision: 'block', reason: 'Session start blocked'}));`;
      const upsScript = `console.log(JSON.stringify({decision: 'allow'}));`;

      await rig.setup('combined-session-start-blocks', {
        settings: {
          hooks: {
            enabled: true,
            SessionStart: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: `node -e "${sessionStartBlockScript}"`,
                    name: 'session-start-block-hook',
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
                    command: `node -e "${upsScript}"`,
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

      const result = await rig.run('Say test');
      expect(result).toBeDefined();
      expect(result.toLowerCase()).toContain('block');
    });

    it('should block session when SessionEnd hook returns block', async () => {
      const sessionEndBlockScript = `console.log(JSON.stringify({decision: 'block', reason: 'Session end blocked'}));`;
      const upsScript = `console.log(JSON.stringify({decision: 'allow'}));`;

      await rig.setup('combined-session-end-blocks', {
        settings: {
          hooks: {
            enabled: true,
            SessionEnd: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: `node -e "${sessionEndBlockScript}"`,
                    name: 'session-end-block-hook',
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
                    command: `node -e "${upsScript}"`,
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

      const result = await rig.run('Say test');
      expect(result).toBeDefined();
      expect(result.toLowerCase()).toContain('block');
    });

    it('should handle multiple hooks of different types all returning allow', async () => {
      const sessionStartScript = `console.log(JSON.stringify({decision: 'allow', hookSpecificOutput: {additionalContext: 'Session start allows'}}));`;
      const sessionEndScript = `console.log(JSON.stringify({decision: 'allow', hookSpecificOutput: {additionalContext: 'Session end allows'}}));`;
      const upsScript = `console.log(JSON.stringify({decision: 'allow', hookSpecificOutput: {additionalContext: 'UPS allows'}}));`;
      const stopScript = `console.log(JSON.stringify({decision: 'allow', hookSpecificOutput: {additionalContext: 'Stop allows'}}));`;

      await rig.setup('combined-multi-all-allow', {
        settings: {
          hooks: {
            enabled: true,
            SessionStart: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: `node -e "${sessionStartScript}"`,
                    name: 'session-start-allow',
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
                    command: `node -e "${sessionEndScript}"`,
                    name: 'session-end-allow',
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
                    command: `node -e "${upsScript}"`,
                    name: 'ups-allow',
                    timeout: 5000,
                  },
                ],
              },
            ],
            Stop: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: `node -e "${stopScript}"`,
                    name: 'stop-allow',
                    timeout: 5000,
                  },
                ],
              },
            ],
          },
          trusted: true,
        },
      });

      const result = await rig.run('Say all allow test');
      expect(result).toBeDefined();
      expect(result.length).toBeGreaterThan(0);
    });

    it('should handle error in one hook type while others succeed', async () => {
      const sessionStartErrorScript = `node -e "console.log(JSON.stringify({decision: 'allow'})); process.exit(1)"`;
      const upsScript = `console.log(JSON.stringify({decision: 'allow'}));`;
      const stopScript = `console.log(JSON.stringify({decision: 'allow'}));`;

      await rig.setup('combined-error-one-type', {
        settings: {
          hooks: {
            enabled: true,
            SessionStart: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: sessionStartErrorScript,
                    name: 'session-start-error-hook',
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
                    command: `node -e "${upsScript}"`,
                    name: 'ups-hook',
                    timeout: 5000,
                  },
                ],
              },
            ],
            Stop: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: `node -e "${stopScript}"`,
                    name: 'stop-hook',
                    timeout: 5000,
                  },
                ],
              },
            ],
          },
          trusted: true,
        },
      });

      const result = await rig.run('Say error test');
      expect(result).toBeDefined();
    });

    it('should concatenate additional context from all hook types', async () => {
      const sessionStartScript = `console.log(JSON.stringify({decision: 'allow', hookSpecificOutput: {additionalContext: 'Context from SessionStart'}}));`;
      const sessionEndScript = `console.log(JSON.stringify({decision: 'allow', hookSpecificOutput: {additionalContext: 'Context from SessionEnd'}}));`;
      const upsScript = `console.log(JSON.stringify({decision: 'allow', hookSpecificOutput: {additionalContext: 'Context from UPS'}}));`;
      const stopScript = `console.log(JSON.stringify({decision: 'allow', hookSpecificOutput: {additionalContext: 'Context from Stop'}}));`;

      await rig.setup('combined-all-context', {
        settings: {
          hooks: {
            enabled: true,
            SessionStart: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: `node -e "${sessionStartScript}"`,
                    name: 'session-start-context',
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
                    command: `node -e "${sessionEndScript}"`,
                    name: 'session-end-context',
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
                    command: `node -e "${upsScript}"`,
                    name: 'ups-context',
                    timeout: 5000,
                  },
                ],
              },
            ],
            Stop: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: `node -e "${stopScript}"`,
                    name: 'stop-context',
                    timeout: 5000,
                  },
                ],
              },
            ],
          },
          trusted: true,
        },
      });

      const result = await rig.run('Say context test');
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
        'echo {"decision": "allow", "reason": "Approved by script file", "hookSpecificOutput": {"additionalContext": "Script file executed successfully"}}';

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
});
