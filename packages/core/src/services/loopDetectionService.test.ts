/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import type {
  ServerGeminiContentEvent,
  ServerGeminiStreamEvent,
  ServerGeminiToolCallRequestEvent,
} from '../core/turn.js';
import { GeminiEventType } from '../core/turn.js';
import * as loggers from '../telemetry/loggers.js';
import { LoopDetectionService } from './loopDetectionService.js';

const TOOL_CALL_LOOP_THRESHOLD = 5;
const CONTENT_LOOP_THRESHOLD = 10;
const CONTENT_CHUNK_SIZE = 50;

describe('LoopDetectionService', () => {
  let service: LoopDetectionService;
  let mockConfig: Config;

  beforeEach(() => {
    mockConfig = {
      getTelemetryEnabled: () => true,
      getUsageStatisticsEnabled: () => false,
    } as unknown as Config;
    service = new LoopDetectionService(mockConfig);
    vi.spyOn(loggers, 'logLoopDetected').mockImplementation(() => {});
    vi.spyOn(loggers, 'logLoopDetectionDisabled').mockImplementation(() => {});
  });

  const createToolCallRequestEvent = (
    name: string,
    args: Record<string, unknown>,
  ): ServerGeminiToolCallRequestEvent => ({
    type: GeminiEventType.ToolCallRequest,
    value: {
      name,
      args,
      callId: 'test-id',
      isClientInitiated: false,
      prompt_id: 'test-prompt-id',
    },
  });

  const createContentEvent = (content: string): ServerGeminiContentEvent => ({
    type: GeminiEventType.Content,
    value: content,
  });

  const createRepetitiveContent = (id: number, length: number): string => {
    const baseString = `This is a unique sentence, id=${id}. `;
    let content = '';
    while (content.length < length) {
      content += baseString;
    }
    return content.slice(0, length);
  };

  describe('Tool Call Loop Detection', () => {
    it(`should not detect a loop for fewer than TOOL_CALL_LOOP_THRESHOLD identical calls`, () => {
      const event = createToolCallRequestEvent('testTool', { param: 'value' });
      for (let i = 0; i < TOOL_CALL_LOOP_THRESHOLD - 1; i++) {
        expect(service.addAndCheck(event)).toBe(false);
      }
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it(`should detect a loop on the TOOL_CALL_LOOP_THRESHOLD-th identical call`, () => {
      const event = createToolCallRequestEvent('testTool', { param: 'value' });
      for (let i = 0; i < TOOL_CALL_LOOP_THRESHOLD - 1; i++) {
        service.addAndCheck(event);
      }
      expect(service.addAndCheck(event)).toBe(true);
      expect(loggers.logLoopDetected).toHaveBeenCalledTimes(1);
    });

    it('should detect a loop on subsequent identical calls', () => {
      const event = createToolCallRequestEvent('testTool', { param: 'value' });
      for (let i = 0; i < TOOL_CALL_LOOP_THRESHOLD; i++) {
        service.addAndCheck(event);
      }
      expect(service.addAndCheck(event)).toBe(true);
      expect(loggers.logLoopDetected).toHaveBeenCalledTimes(1);
    });

    it('should not detect a loop for different tool calls', () => {
      const event1 = createToolCallRequestEvent('testTool', {
        param: 'value1',
      });
      const event2 = createToolCallRequestEvent('testTool', {
        param: 'value2',
      });
      const event3 = createToolCallRequestEvent('anotherTool', {
        param: 'value1',
      });

      for (let i = 0; i < TOOL_CALL_LOOP_THRESHOLD - 2; i++) {
        expect(service.addAndCheck(event1)).toBe(false);
        expect(service.addAndCheck(event2)).toBe(false);
        expect(service.addAndCheck(event3)).toBe(false);
      }
    });

    it('should not reset tool call counter for other event types', () => {
      const toolCallEvent = createToolCallRequestEvent('testTool', {
        param: 'value',
      });
      const otherEvent = {
        type: 'thought',
      } as unknown as ServerGeminiStreamEvent;

      // Send events just below the threshold
      for (let i = 0; i < TOOL_CALL_LOOP_THRESHOLD - 1; i++) {
        expect(service.addAndCheck(toolCallEvent)).toBe(false);
      }

      // Send a different event type
      expect(service.addAndCheck(otherEvent)).toBe(false);

      // Send the tool call event again, which should now trigger the loop
      expect(service.addAndCheck(toolCallEvent)).toBe(true);
      expect(loggers.logLoopDetected).toHaveBeenCalledTimes(1);
    });

    it('should not detect a loop when disabled for session', () => {
      service.disableForSession();
      expect(loggers.logLoopDetectionDisabled).toHaveBeenCalledTimes(1);
      const event = createToolCallRequestEvent('testTool', { param: 'value' });
      for (let i = 0; i < TOOL_CALL_LOOP_THRESHOLD; i++) {
        expect(service.addAndCheck(event)).toBe(false);
      }
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });
  });

  describe('Content Loop Detection', () => {
    const generateRandomString = (length: number) => {
      let result = '';
      const characters =
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      const charactersLength = characters.length;
      for (let i = 0; i < length; i++) {
        result += characters.charAt(
          Math.floor(Math.random() * charactersLength),
        );
      }
      return result;
    };

    it('should not detect a loop for random content', () => {
      service.reset('');
      for (let i = 0; i < 1000; i++) {
        const content = generateRandomString(10);
        const isLoop = service.addAndCheck(createContentEvent(content));
        expect(isLoop).toBe(false);
        // Add different tool call every 10 content events to reset stagnation counter
        if (i % 10 === 0) {
          const toolEvent = createToolCallRequestEvent('testTool', {
            param: `value-${i}`,
          });
          service.addAndCheck(toolEvent);
        }
      }
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('should detect a loop when a chunk of content repeats consecutively', () => {
      service.reset('');
      const repeatedContent = createRepetitiveContent(1, CONTENT_CHUNK_SIZE);

      let isLoop = false;
      for (let i = 0; i < CONTENT_LOOP_THRESHOLD; i++) {
        isLoop = service.addAndCheck(createContentEvent(repeatedContent));
      }
      expect(isLoop).toBe(true);
      expect(loggers.logLoopDetected).toHaveBeenCalledTimes(1);
    });

    it('should not detect a loop if repetitions are very far apart', () => {
      service.reset('');
      const repeatedContent = createRepetitiveContent(1, CONTENT_CHUNK_SIZE);

      for (let i = 0; i < CONTENT_LOOP_THRESHOLD; i++) {
        const isLoop1 = service.addAndCheck(
          createContentEvent(repeatedContent),
        );
        expect(isLoop1).toBe(false);
        // Use much larger unique filler to avoid content loop detection
        const fillerContent = generateRandomString(2000);
        const isLoop2 = service.addAndCheck(createContentEvent(fillerContent));
        expect(isLoop2).toBe(false);
        // Add tool call every 2 iterations to prevent action stagnation
        if (i % 2 === 0) {
          const toolEvent = createToolCallRequestEvent('testTool', {
            param: `value-${i}`,
          });
          service.addAndCheck(toolEvent);
        }
      }
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });
  });

  describe('Content Loop Detection with Code Blocks', () => {
    it('should not detect a loop when repetitive content is inside a code block', () => {
      service.reset('');
      const repeatedContent = createRepetitiveContent(1, CONTENT_CHUNK_SIZE);

      service.addAndCheck(createContentEvent('```\n'));

      for (let i = 0; i < CONTENT_LOOP_THRESHOLD; i++) {
        const isLoop = service.addAndCheck(createContentEvent(repeatedContent));
        expect(isLoop).toBe(false);
      }

      const isLoop = service.addAndCheck(createContentEvent('\n```'));
      expect(isLoop).toBe(false);
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('should not detect loops when content transitions into a code block', () => {
      service.reset('');
      const repeatedContent = createRepetitiveContent(1, CONTENT_CHUNK_SIZE);

      // Add some repetitive content outside of code block
      for (let i = 0; i < CONTENT_LOOP_THRESHOLD - 2; i++) {
        service.addAndCheck(createContentEvent(repeatedContent));
      }

      // Now transition into a code block - this should prevent loop detection
      // even though we were already close to the threshold
      const codeBlockStart = '```javascript\n';
      const isLoop = service.addAndCheck(createContentEvent(codeBlockStart));
      expect(isLoop).toBe(false);

      // Continue adding repetitive content inside the code block - should not trigger loop
      for (let i = 0; i < CONTENT_LOOP_THRESHOLD; i++) {
        const isLoopInside = service.addAndCheck(
          createContentEvent(repeatedContent),
        );
        expect(isLoopInside).toBe(false);
      }

      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('should skip loop detection when already inside a code block (this.inCodeBlock)', () => {
      service.reset('');

      // Start with content that puts us inside a code block
      service.addAndCheck(createContentEvent('Here is some code:\n```\n'));

      // Verify we are now inside a code block and any content should be ignored for loop detection
      const repeatedContent = createRepetitiveContent(1, CONTENT_CHUNK_SIZE);
      for (let i = 0; i < CONTENT_LOOP_THRESHOLD + 5; i++) {
        const isLoop = service.addAndCheck(createContentEvent(repeatedContent));
        expect(isLoop).toBe(false);
      }

      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('should correctly track inCodeBlock state with multiple fence transitions', () => {
      service.reset('');
      const repeatedContent = createRepetitiveContent(1, CONTENT_CHUNK_SIZE);

      // Outside code block - should track content
      service.addAndCheck(createContentEvent('Normal text '));

      // Enter code block (1 fence) - should stop tracking
      const enterResult = service.addAndCheck(createContentEvent('```\n'));
      expect(enterResult).toBe(false);

      // Inside code block - should not track loops
      for (let i = 0; i < 5; i++) {
        const insideResult = service.addAndCheck(
          createContentEvent(repeatedContent),
        );
        expect(insideResult).toBe(false);
      }

      // Exit code block (2nd fence) - should reset tracking but still return false
      const exitResult = service.addAndCheck(createContentEvent('```\n'));
      expect(exitResult).toBe(false);

      // Enter code block again (3rd fence) - should stop tracking again
      const reenterResult = service.addAndCheck(
        createContentEvent('```python\n'),
      );
      expect(reenterResult).toBe(false);

      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('should detect a loop when repetitive content is outside a code block', () => {
      service.reset('');
      const repeatedContent = createRepetitiveContent(1, CONTENT_CHUNK_SIZE);

      service.addAndCheck(createContentEvent('```'));
      service.addAndCheck(createContentEvent('\nsome code\n'));
      service.addAndCheck(createContentEvent('```'));

      let isLoop = false;
      for (let i = 0; i < CONTENT_LOOP_THRESHOLD; i++) {
        isLoop = service.addAndCheck(createContentEvent(repeatedContent));
      }
      expect(isLoop).toBe(true);
      expect(loggers.logLoopDetected).toHaveBeenCalledTimes(1);
    });

    it('should handle content with multiple code blocks and no loops', () => {
      service.reset('');
      service.addAndCheck(createContentEvent('```\ncode1\n```'));
      service.addAndCheck(createContentEvent('\nsome text\n'));
      const isLoop = service.addAndCheck(createContentEvent('```\ncode2\n```'));

      expect(isLoop).toBe(false);
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('should handle content with mixed code blocks and looping text', () => {
      service.reset('');
      const repeatedContent = createRepetitiveContent(1, CONTENT_CHUNK_SIZE);

      service.addAndCheck(createContentEvent('```'));
      service.addAndCheck(createContentEvent('\ncode1\n'));
      service.addAndCheck(createContentEvent('```'));

      let isLoop = false;
      for (let i = 0; i < CONTENT_LOOP_THRESHOLD; i++) {
        isLoop = service.addAndCheck(createContentEvent(repeatedContent));
      }

      expect(isLoop).toBe(true);
      expect(loggers.logLoopDetected).toHaveBeenCalledTimes(1);
    });

    it('should not detect a loop for a long code block with some repeating tokens', () => {
      service.reset('');
      const repeatingToken = 'for (let i = 0; i < 10; i++) { console.log(i); }';
      const toolEvent = createToolCallRequestEvent('testTool', {
        param: 'value',
      });

      service.addAndCheck(createContentEvent('```\n'));

      for (let i = 0; i < 20; i++) {
        const isLoop = service.addAndCheck(createContentEvent(repeatingToken));
        expect(isLoop).toBe(false);
        // Add tool call every 10 iterations to prevent action stagnation
        if (i % 10 === 0) {
          service.addAndCheck(toolEvent);
        }
      }

      const isLoop = service.addAndCheck(createContentEvent('\n```'));
      expect(isLoop).toBe(false);
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('should reset tracking when a code fence is found', () => {
      service.reset('');
      const repeatedContent = createRepetitiveContent(1, CONTENT_CHUNK_SIZE);
      const toolEvent = createToolCallRequestEvent('testTool', {
        param: 'value',
      });

      for (let i = 0; i < CONTENT_LOOP_THRESHOLD - 1; i++) {
        service.addAndCheck(createContentEvent(repeatedContent));
      }
      service.addAndCheck(toolEvent); // Reset stagnation counter

      // This should not trigger a loop because of the reset
      service.addAndCheck(createContentEvent('```'));

      // We are now in a code block, so loop detection should be off.
      // Let's add the repeated content again, it should not trigger a loop.
      let isLoop = false;
      for (let i = 0; i < CONTENT_LOOP_THRESHOLD; i++) {
        isLoop = service.addAndCheck(createContentEvent(repeatedContent));
        expect(isLoop).toBe(false);
      }

      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });
    it('should reset tracking when a table is detected', () => {
      service.reset('');
      const repeatedContent = createRepetitiveContent(1, CONTENT_CHUNK_SIZE);

      for (let i = 0; i < CONTENT_LOOP_THRESHOLD - 1; i++) {
        service.addAndCheck(createContentEvent(repeatedContent));
      }

      // This should reset tracking and not trigger a loop
      service.addAndCheck(createContentEvent('| Column 1 | Column 2 |'));

      // Add more repeated content after table - should not trigger loop
      for (let i = 0; i < CONTENT_LOOP_THRESHOLD - 1; i++) {
        const isLoop = service.addAndCheck(createContentEvent(repeatedContent));
        expect(isLoop).toBe(false);
      }

      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('should reset tracking when a list item is detected', () => {
      service.reset('');
      const repeatedContent = createRepetitiveContent(1, CONTENT_CHUNK_SIZE);

      for (let i = 0; i < CONTENT_LOOP_THRESHOLD - 1; i++) {
        service.addAndCheck(createContentEvent(repeatedContent));
      }

      // This should reset tracking and not trigger a loop
      service.addAndCheck(createContentEvent('* List item'));

      // Add more repeated content after list - should not trigger loop
      for (let i = 0; i < CONTENT_LOOP_THRESHOLD - 1; i++) {
        const isLoop = service.addAndCheck(createContentEvent(repeatedContent));
        expect(isLoop).toBe(false);
      }

      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('should reset tracking when a heading is detected', () => {
      service.reset('');
      const repeatedContent = createRepetitiveContent(1, CONTENT_CHUNK_SIZE);

      for (let i = 0; i < CONTENT_LOOP_THRESHOLD - 1; i++) {
        service.addAndCheck(createContentEvent(repeatedContent));
      }

      // This should reset tracking and not trigger a loop
      service.addAndCheck(createContentEvent('## Heading'));

      // Add more repeated content after heading - should not trigger loop
      for (let i = 0; i < CONTENT_LOOP_THRESHOLD - 1; i++) {
        const isLoop = service.addAndCheck(createContentEvent(repeatedContent));
        expect(isLoop).toBe(false);
      }

      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('should reset tracking when a blockquote is detected', () => {
      service.reset('');
      const repeatedContent = createRepetitiveContent(1, CONTENT_CHUNK_SIZE);

      for (let i = 0; i < CONTENT_LOOP_THRESHOLD - 1; i++) {
        service.addAndCheck(createContentEvent(repeatedContent));
      }

      // This should reset tracking and not trigger a loop
      service.addAndCheck(createContentEvent('> Quote text'));

      // Add more repeated content after blockquote - should not trigger loop
      for (let i = 0; i < CONTENT_LOOP_THRESHOLD - 1; i++) {
        const isLoop = service.addAndCheck(createContentEvent(repeatedContent));
        expect(isLoop).toBe(false);
      }

      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('should reset tracking for various list item formats', () => {
      const repeatedContent = createRepetitiveContent(1, CONTENT_CHUNK_SIZE);

      // Test different list formats - make sure they start at beginning of line
      const listFormats = [
        '* Bullet item',
        '- Dash item',
        '+ Plus item',
        '1. Numbered item',
        '42. Another numbered item',
      ];

      listFormats.forEach((listFormat, index) => {
        service.reset('');

        // Build up to near threshold
        for (let i = 0; i < CONTENT_LOOP_THRESHOLD - 1; i++) {
          service.addAndCheck(createContentEvent(repeatedContent));
        }

        // Reset should occur with list item - add newline to ensure it starts at beginning
        service.addAndCheck(createContentEvent('\n' + listFormat));

        // Should not trigger loop after reset - use different content to avoid any cached state issues
        const newRepeatedContent = createRepetitiveContent(
          index + 100,
          CONTENT_CHUNK_SIZE,
        );
        for (let i = 0; i < CONTENT_LOOP_THRESHOLD - 1; i++) {
          const isLoop = service.addAndCheck(
            createContentEvent(newRepeatedContent),
          );
          expect(isLoop).toBe(false);
        }
      });

      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('should reset tracking for various table formats', () => {
      const repeatedContent = createRepetitiveContent(1, CONTENT_CHUNK_SIZE);

      const tableFormats = [
        '| Column 1 | Column 2 |',
        '|---|---|',
        '|++|++|',
        '+---+---+',
      ];

      tableFormats.forEach((tableFormat, index) => {
        service.reset('');

        // Build up to near threshold
        for (let i = 0; i < CONTENT_LOOP_THRESHOLD - 1; i++) {
          service.addAndCheck(createContentEvent(repeatedContent));
        }

        // Reset should occur with table format - add newline to ensure it starts at beginning
        service.addAndCheck(createContentEvent('\n' + tableFormat));

        // Should not trigger loop after reset - use different content to avoid any cached state issues
        const newRepeatedContent = createRepetitiveContent(
          index + 200,
          CONTENT_CHUNK_SIZE,
        );
        for (let i = 0; i < CONTENT_LOOP_THRESHOLD - 1; i++) {
          const isLoop = service.addAndCheck(
            createContentEvent(newRepeatedContent),
          );
          expect(isLoop).toBe(false);
        }
      });

      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('should reset tracking for various heading levels', () => {
      const repeatedContent = createRepetitiveContent(1, CONTENT_CHUNK_SIZE);

      const headingFormats = [
        '# H1 Heading',
        '## H2 Heading',
        '### H3 Heading',
        '#### H4 Heading',
        '##### H5 Heading',
        '###### H6 Heading',
      ];

      headingFormats.forEach((headingFormat, index) => {
        service.reset('');

        // Build up to near threshold
        for (let i = 0; i < CONTENT_LOOP_THRESHOLD - 1; i++) {
          service.addAndCheck(createContentEvent(repeatedContent));
        }

        // Reset should occur with heading - add newline to ensure it starts at beginning
        service.addAndCheck(createContentEvent('\n' + headingFormat));

        // Should not trigger loop after reset - use different content to avoid any cached state issues
        const newRepeatedContent = createRepetitiveContent(
          index + 300,
          CONTENT_CHUNK_SIZE,
        );
        for (let i = 0; i < CONTENT_LOOP_THRESHOLD - 1; i++) {
          const isLoop = service.addAndCheck(
            createContentEvent(newRepeatedContent),
          );
          expect(isLoop).toBe(false);
        }
      });

      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty content', () => {
      const event = createContentEvent('');
      expect(service.addAndCheck(event)).toBe(false);
    });
  });

  describe('Divider Content Detection', () => {
    it('should not detect a loop for repeating divider-like content', () => {
      service.reset('');
      const dividerContent = '-'.repeat(CONTENT_CHUNK_SIZE);
      let isLoop = false;
      for (let i = 0; i < CONTENT_LOOP_THRESHOLD + 5; i++) {
        isLoop = service.addAndCheck(createContentEvent(dividerContent));
        expect(isLoop).toBe(false);
      }
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('should not detect a loop for repeating complex box-drawing dividers', () => {
      service.reset('');
      const dividerContent = '╭─'.repeat(CONTENT_CHUNK_SIZE / 2);
      let isLoop = false;
      for (let i = 0; i < CONTENT_LOOP_THRESHOLD + 5; i++) {
        isLoop = service.addAndCheck(createContentEvent(dividerContent));
        expect(isLoop).toBe(false);
      }
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });
  });

  describe('Reset Functionality', () => {
    it('tool call should reset content count', () => {
      const contentEvent = createContentEvent('Some content.');
      const toolEvent = createToolCallRequestEvent('testTool', {
        param: 'value',
      });
      for (let i = 0; i < 9; i++) {
        service.addAndCheck(contentEvent);
      }

      service.addAndCheck(toolEvent);

      // Should start fresh
      expect(service.addAndCheck(createContentEvent('Fresh content.'))).toBe(
        false,
      );
    });
  });

  describe('General Behavior', () => {
    it('should return false for unhandled event types', () => {
      const otherEvent = {
        type: 'unhandled_event',
      } as unknown as ServerGeminiStreamEvent;
      expect(service.addAndCheck(otherEvent)).toBe(false);
      expect(service.addAndCheck(otherEvent)).toBe(false);
    });
  });

  describe('Thought Loop Detection', () => {
    const createThoughtEvent = (
      subject: string,
      description: string,
    ): ServerGeminiStreamEvent => ({
      type: GeminiEventType.Thought,
      value: { subject, description },
    });

    it('should not detect a loop for fewer than 3 similar thoughts', () => {
      const event = createThoughtEvent(
        'Analyze the issue',
        'The problem is with the retry loop',
      );

      service.addAndCheck(event);
      expect(service.addAndCheck(event)).toBe(false);
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('should detect a loop on the 3rd identical thought', () => {
      const event = createThoughtEvent(
        'Analyze the issue',
        'The problem is with the retry loop',
      );

      service.addAndCheck(event);
      service.addAndCheck(event);
      expect(service.addAndCheck(event)).toBe(true);
      expect(loggers.logLoopDetected).toHaveBeenCalledTimes(1);
    });

    it('should detect a loop with highly similar thoughts', () => {
      const thought1 = createThoughtEvent(
        'The issue is clear',
        'when a 401 occurs for Qwen, the retry loop only handles Anthropic OAuth tokens',
      );
      const thought2 = createThoughtEvent(
        'The issue is clear',
        'when a 401 occurs for Qwen, the retry loop handles Anthropic OAuth tokens only',
      );
      const thought3 = createThoughtEvent(
        'The issue is clear:',
        'when a 401 occurs for Qwen the retry loop only handles Anthropic OAuth tokens',
      );

      service.addAndCheck(thought1);
      service.addAndCheck(thought2);
      expect(service.addAndCheck(thought3)).toBe(true);
    });

    it('should not detect a loop with different thoughts', () => {
      const thought1 = createThoughtEvent(
        'First issue',
        'Problem with authentication',
      );
      const thought2 = createThoughtEvent(
        'Second issue',
        'Problem with file reading',
      );
      const thought3 = createThoughtEvent(
        'Third issue',
        'Problem with network calls',
      );

      service.addAndCheck(thought1);
      service.addAndCheck(thought2);
      expect(service.addAndCheck(thought3)).toBe(false);
    });
  });

  describe('Read File Loop Detection', () => {
    const createReadFileEvent = (
      filePath: string,
    ): ServerGeminiToolCallRequestEvent => ({
      type: GeminiEventType.ToolCallRequest,
      value: {
        name: 'ReadFile',
        args: { file_path: filePath },
        callId: 'test-id',
        isClientInitiated: false,
        prompt_id: 'test-prompt-id',
      },
    });

    const createGlobEvent = (): ServerGeminiToolCallRequestEvent => ({
      type: GeminiEventType.ToolCallRequest,
      value: {
        name: 'Glob',
        args: { pattern: '**/*.ts' },
        callId: 'test-id',
        isClientInitiated: false,
        prompt_id: 'test-prompt-id',
      },
    });

    const createEditEvent = (): ServerGeminiToolCallRequestEvent => ({
      type: GeminiEventType.ToolCallRequest,
      value: {
        name: 'Edit',
        args: { file_path: 'test.ts', old_string: 'a', new_string: 'b' },
        callId: 'test-id',
        isClientInitiated: false,
        prompt_id: 'test-prompt-id',
      },
    });

    it('should detect a loop after 4 consecutive read operations', () => {
      const event = createReadFileEvent('test.ts');

      service.addAndCheck(event);
      service.addAndCheck(event);
      service.addAndCheck(event);
      expect(service.addAndCheck(event)).toBe(true);
      expect(loggers.logLoopDetected).toHaveBeenCalledTimes(1);
    });

    it('should not detect a loop with mixed operations', () => {
      const readEvent = createReadFileEvent('test.ts');
      const editEvent = createEditEvent();

      service.addAndCheck(readEvent);
      service.addAndCheck(readEvent);
      service.addAndCheck(editEvent); // Resets counter
      service.addAndCheck(readEvent);
      service.addAndCheck(readEvent);
      expect(service.addAndCheck(readEvent)).toBe(false);
    });

    it('should detect loop with different read operations', () => {
      const readEvent = createReadFileEvent('test1.ts');
      const globEvent = createGlobEvent();

      service.addAndCheck(readEvent);
      service.addAndCheck(readEvent);
      service.addAndCheck(globEvent);
      expect(service.addAndCheck(readEvent)).toBe(true);
    });
  });

  describe('Action Stagnation Detection', () => {
    const createContentEvent = (content: string): ServerGeminiContentEvent => ({
      type: GeminiEventType.Content,
      value: content,
    });

    it('should detect stagnation after 20 content events without tool calls', () => {
      // Simulate 20 content events without any tool calls
      // First 19 should not trigger
      for (let i = 0; i < 19; i++) {
        expect(service.addAndCheck(createContentEvent(`Content ${i}`))).toBe(
          false,
        );
      }
      // 20th should trigger
      expect(service.addAndCheck(createContentEvent('Content 19'))).toBe(true);
    });

    it('should not detect stagnation when tool calls are present', () => {
      // Use different content each time to avoid content loop detection
      for (let i = 0; i < 15; i++) {
        const readEvent: ServerGeminiToolCallRequestEvent = {
          type: GeminiEventType.ToolCallRequest,
          value: {
            name: 'ReadFile',
            args: { file_path: `test${i}.ts` },
            callId: 'test-id',
            isClientInitiated: false,
            prompt_id: 'test-prompt-id',
          },
        };
        const contentEvent = createContentEvent(`Unique content ${i}`);
        service.addAndCheck(readEvent);
        service.addAndCheck(contentEvent);
        // Add an action operation every 3 iterations to reset read file loop counter
        if (i % 3 === 0) {
          const editEvent: ServerGeminiToolCallRequestEvent = {
            type: GeminiEventType.ToolCallRequest,
            value: {
              name: 'Edit',
              args: {
                file_path: `test${i}.ts`,
                old_string: 'a',
                new_string: 'b',
              },
              callId: 'test-id',
              isClientInitiated: false,
              prompt_id: 'test-prompt-id',
            },
          };
          service.addAndCheck(editEvent);
        }
      }
      // Should not trigger because tool calls reset the counter
      expect(
        service.addAndCheck(createContentEvent('Final unique content')),
      ).toBe(false);
    });

    it('should reset stagnation counter on action tool call', () => {
      const editEvent: ServerGeminiToolCallRequestEvent = {
        type: GeminiEventType.ToolCallRequest,
        value: {
          name: 'Edit',
          args: { file_path: 'test.ts', old_string: 'a', new_string: 'b' },
          callId: 'test-id',
          isClientInitiated: false,
          prompt_id: 'test-prompt-id',
        },
      };

      // Build up some stagnation with content only
      for (let i = 0; i < 5; i++) {
        service.addAndCheck(createContentEvent(`Content ${i}`));
      }

      // Perform an action
      service.addAndCheck(editEvent);

      // Should not trigger immediately after action
      for (let i = 0; i < 7; i++) {
        expect(
          service.addAndCheck(createContentEvent(`New content ${i}`)),
        ).toBe(false);
      }
    });
  });
});
