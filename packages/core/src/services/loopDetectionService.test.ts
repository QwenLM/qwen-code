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
  ServerGeminiThoughtEvent,
  ServerGeminiToolCallRequestEvent,
} from '../core/turn.js';
import { GeminiEventType } from '../core/turn.js';
import * as loggers from '../telemetry/loggers.js';
import { LoopDetectionService } from './loopDetectionService.js';

vi.mock('../telemetry/loggers.js', () => ({
  logLoopDetected: vi.fn(),
  logLoopDetectionDisabled: vi.fn(),
}));

const TOOL_CALL_LOOP_THRESHOLD = 5;
const CONTENT_LOOP_THRESHOLD = 10;
const CONTENT_CHUNK_SIZE = 50;
// Mirrored from loopDetectionService.ts. Kept local so the test is
// self-describing and failures point to the constant that changed.
const FILE_READ_WINDOW = 15;

describe('LoopDetectionService', () => {
  let service: LoopDetectionService;
  let mockConfig: Config;

  beforeEach(() => {
    mockConfig = {
      getTelemetryEnabled: () => true,
    } as unknown as Config;
    service = new LoopDetectionService(mockConfig);
    vi.clearAllMocks();
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

  const createThoughtEvent = (
    subject: string,
    description = '',
  ): ServerGeminiThoughtEvent => ({
    type: GeminiEventType.Thought,
    value: { subject, description },
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
        type: GeminiEventType.UserCancelled,
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
      const fillerContent = generateRandomString(500);

      let isLoop = false;
      for (let i = 0; i < CONTENT_LOOP_THRESHOLD; i++) {
        isLoop = service.addAndCheck(createContentEvent(repeatedContent));
        isLoop = service.addAndCheck(createContentEvent(fillerContent));
      }
      expect(isLoop).toBe(false);
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
      const repeatingTokens =
        'for (let i = 0; i < 10; i++) { console.log(i); }';

      service.addAndCheck(createContentEvent('```\n'));

      for (let i = 0; i < 20; i++) {
        const isLoop = service.addAndCheck(createContentEvent(repeatingTokens));
        expect(isLoop).toBe(false);
      }

      const isLoop = service.addAndCheck(createContentEvent('\n```'));
      expect(isLoop).toBe(false);
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('should reset tracking when a code fence is found', () => {
      service.reset('');
      const repeatedContent = createRepetitiveContent(1, CONTENT_CHUNK_SIZE);

      for (let i = 0; i < CONTENT_LOOP_THRESHOLD - 1; i++) {
        service.addAndCheck(createContentEvent(repeatedContent));
      }

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

  describe('Repetitive Thoughts Detection', () => {
    it('should detect repetitive thoughts pattern', () => {
      service.reset('');

      for (let i = 0; i < 3; i++) {
        service.addAndCheck(
          createThoughtEvent('Plan', 'Inspect the migration script.'),
        );
      }

      expect(loggers.logLoopDetected).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          loop_type: 'repetitive_thoughts',
        }),
      );
    });

    it('should not detect loop with varied thoughts', () => {
      service.reset('');

      service.addAndCheck(createThoughtEvent('Plan', 'Inspect the schema.'));
      service.addAndCheck(
        createThoughtEvent('Analysis', 'Check migration risks.'),
      );
      service.addAndCheck(
        createThoughtEvent('Plan', 'Evaluate rollout alternatives.'),
      );

      const isLoop = service.addAndCheck(
        createThoughtEvent('Next', 'Draft the fix.'),
      );
      expect(isLoop).toBe(false);
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('should not detect a loop when an earlier thought reappears after progress', () => {
      service.reset('');

      // Regression: earlier counting-based implementation fired as soon as
      // any thought appeared >= THRESHOLD times anywhere in the retained
      // history. A healthy long-running session where the model revisits
      // the same phrase after making progress on unrelated steps should
      // *not* trip this detector — only a sustained consecutive run does.
      service.addAndCheck(createThoughtEvent('Plan', 'Inspect the schema.'));
      service.addAndCheck(
        createThoughtEvent('Analysis', 'Consider migration.'),
      );
      service.addAndCheck(createThoughtEvent('Analysis', 'Review indexes.'));
      service.addAndCheck(createThoughtEvent('Plan', 'Inspect the schema.'));
      service.addAndCheck(
        createThoughtEvent('Analysis', 'Consider rollout risks.'),
      );
      const isLoop = service.addAndCheck(
        createThoughtEvent('Plan', 'Inspect the schema.'),
      );
      expect(isLoop).toBe(false);
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('clears thought history across tool-call roundtrips within a turn', () => {
      service.reset('');

      // Regression: thoughtHistory previously persisted across ToolCallRequest
      // events within a single prompt. Three identical thoughts separated by
      // real tool-call progress would incorrectly fire REPETITIVE_THOUGHTS.
      service.addAndCheck(createThoughtEvent('Plan', 'Inspect the schema.'));
      service.addAndCheck(
        createToolCallRequestEvent('read_file', { path: 'a.sql' }),
      );
      service.addAndCheck(createThoughtEvent('Plan', 'Inspect the schema.'));
      service.addAndCheck(
        createToolCallRequestEvent('read_file', { path: 'b.sql' }),
      );
      const isLoop = service.addAndCheck(
        createThoughtEvent('Plan', 'Inspect the schema.'),
      );
      expect(isLoop).toBe(false);
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('ignores hedge phrases in Content events (thought detection is Thought-only)', () => {
      service.reset('');

      // Content events used to feed a substring-matched hedge-phrase list
      // into thoughtHistory, which conflated prose with the model's actual
      // reasoning channel. Thought detection now runs only on Thought events.
      for (let i = 0; i < 5; i++) {
        service.addAndCheck(
          createContentEvent('I should check the config, maybe it helps.'),
        );
      }
      expect(loggers.logLoopDetected).not.toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({ loop_type: 'repetitive_thoughts' }),
      );
    });
  });

  describe('Read File Loop Detection', () => {
    // Cold-start exemption: a prompt that has not yet fired any non-read-like
    // tool is still in its opening-exploration phase, so the detector gives
    // it an initial pass. Tests that want to exercise the detector must
    // fire a non-read tool first so subsequent reads are judged normally.
    const primeNonReadTool = () => {
      service.addAndCheck(
        createToolCallRequestEvent('write_file', {
          path: 'prime.txt',
          content: '',
        }),
      );
    };

    it('should detect excessive file read operations', () => {
      service.reset('');
      primeNonReadTool();

      // FILE_READ_THRESHOLD reads in the window trigger the loop. The first
      // (THRESHOLD - 1) reads must not fire; the THRESHOLD-th does.
      for (let i = 0; i < 7; i++) {
        const event = createToolCallRequestEvent('read_file', {
          path: `file${i}.txt`,
        });
        const isLoop = service.addAndCheck(event);
        expect(isLoop).toBe(false);
      }

      const event = createToolCallRequestEvent('read_file', {
        path: 'file7.txt',
      });
      const isLoop = service.addAndCheck(event);
      expect(isLoop).toBe(true);
      expect(loggers.logLoopDetected).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          loop_type: 'read_file_loop',
        }),
      );
    });

    it('should exempt opening exploration from READ_FILE_LOOP (cold start)', () => {
      service.reset('');

      // Regression for PR #3236 review: a prompt like "summarize this
      // project" opens with parallel read_file / list_directory calls and
      // must not trip READ_FILE_LOOP before any write/execute action has
      // fired. This exercises FILE_READ_WINDOW+ consecutive reads with no
      // prior non-read tool — nothing should fire.
      for (let i = 0; i < 20; i++) {
        const name = i % 2 === 0 ? 'read_file' : 'list_directory';
        const isLoop = service.addAndCheck(
          createToolCallRequestEvent(name, { path: `f${i}` }),
        );
        expect(isLoop).toBe(false);
      }
      expect(loggers.logLoopDetected).not.toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({ loop_type: 'read_file_loop' }),
      );
    });

    it('should activate READ_FILE_LOOP once a non-read tool lands mid-prompt', () => {
      service.reset('');

      // No firing before the cold-start gate flips.
      for (let i = 0; i < 7; i++) {
        service.addAndCheck(
          createToolCallRequestEvent('read_file', { path: `pre${i}.txt` }),
        );
      }
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();

      // A non-read tool lands — gate opens.
      service.addAndCheck(
        createToolCallRequestEvent('write_file', {
          path: 'out.txt',
          content: 'x',
        }),
      );

      // Now a window of reads should eventually trip READ_FILE_LOOP. As new
      // reads push the write_file out of the FILE_READ_WINDOW-sized history
      // and FILE_READ_THRESHOLD read-likes accumulate, detection fires.
      let detected = false;
      for (let i = 0; i < FILE_READ_WINDOW + 2 && !detected; i++) {
        detected = service.addAndCheck(
          createToolCallRequestEvent('read_file', { path: `post${i}.txt` }),
        );
      }
      expect(detected).toBe(true);
      expect(loggers.logLoopDetected).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({ loop_type: 'read_file_loop' }),
      );
    });

    it('should detect other read-like operations (exact names + read_/list_ prefixes)', () => {
      service.reset('');
      primeNonReadTool();

      // Mix of read-like tool names that either appear in the exact allowlist
      // (read_file, read_many_files, list_directory) or match the read_/list_
      // prefix fallback used for MCP-provided tools.
      service.addAndCheck(
        createToolCallRequestEvent('read_many_files', {
          paths: ['file1.txt'],
        }),
      );
      service.addAndCheck(
        createToolCallRequestEvent('list_directory', { path: '.' }),
      );
      service.addAndCheck(
        createToolCallRequestEvent('read_resource', { uri: 'a' }),
      );
      service.addAndCheck(
        createToolCallRequestEvent('read_file', { path: 'file3.txt' }),
      );
      service.addAndCheck(createToolCallRequestEvent('list_projects', {}));
      service.addAndCheck(
        createToolCallRequestEvent('read_file', { path: 'file5.txt' }),
      );
      service.addAndCheck(
        createToolCallRequestEvent('read_many_files', {
          paths: ['file6.txt'],
        }),
      );

      const isLoop = service.addAndCheck(
        createToolCallRequestEvent('list_directory', { path: 'nested' }),
      );
      expect(isLoop).toBe(true);
      expect(loggers.logLoopDetected).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          loop_type: 'read_file_loop',
        }),
      );
    });

    it('should not treat tools that merely contain read-like substrings as file reads', () => {
      service.reset('');
      primeNonReadTool();

      // Regression: the earlier substring heuristic treated any name
      // containing 'read'/'cat'/'view'/'list' as a file read, so `review`
      // (contains 'view') and `concat_chunks` (contains 'cat') contributed
      // to READ_FILE_LOOP even though no file-read loop was happening.
      const nonReadLikeNames = [
        'review',
        'concat_chunks',
        'viewport_set',
        'listener_bind',
      ];
      for (let i = 0; i < 6; i++) {
        const name = nonReadLikeNames[i % nonReadLikeNames.length];
        const isLoop = service.addAndCheck(
          createToolCallRequestEvent(name, { i }),
        );
        expect(isLoop).toBe(false);
      }
      expect(loggers.logLoopDetected).not.toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({ loop_type: 'read_file_loop' }),
      );
    });

    it('should not detect loop with mixed operations', () => {
      service.reset('');
      primeNonReadTool();

      // Mix of read and non-read operations
      service.addAndCheck(
        createToolCallRequestEvent('read_file', { path: 'file1.txt' }),
      );
      service.addAndCheck(
        createToolCallRequestEvent('write_file', {
          path: 'file2.txt',
          content: 'test',
        }),
      );
      service.addAndCheck(
        createToolCallRequestEvent('read_file', { path: 'file3.txt' }),
      );
      service.addAndCheck(
        createToolCallRequestEvent('execute', { command: 'ls' }),
      );
      service.addAndCheck(
        createToolCallRequestEvent('read_file', { path: 'file4.txt' }),
      );

      const isLoop = service.addAndCheck(
        createToolCallRequestEvent('read_file', { path: 'file5.txt' }),
      );
      expect(isLoop).toBe(false);
      expect(loggers.logLoopDetected).not.toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({ loop_type: 'read_file_loop' }),
      );
    });
  });

  describe('Action Stagnation Detection', () => {
    // Stagnation fires when the same tool *name* is called STAGNATION_THRESHOLD
    // times consecutively regardless of arguments. This is distinct from
    // CONSECUTIVE_IDENTICAL_TOOL_CALLS (same name AND args) and from
    // READ_FILE_LOOP (high proportion of read-like tools in the window),
    // so we exercise it with a non-read-like tool and varying args.
    it('should detect action stagnation when the same tool is repeated with varying args', () => {
      service.reset('');

      // STAGNATION_THRESHOLD - 1 calls must not fire
      for (let i = 0; i < 7; i++) {
        const isLoop = service.addAndCheck(
          createToolCallRequestEvent('search_code', { query: `term${i}` }),
        );
        expect(isLoop).toBe(false);
      }

      // THRESHOLD-th consecutive same-name call triggers stagnation
      const isLoop = service.addAndCheck(
        createToolCallRequestEvent('search_code', { query: 'term7' }),
      );
      expect(isLoop).toBe(true);
      expect(loggers.logLoopDetected).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({ loop_type: 'action_stagnation' }),
      );
    });

    it('should reset stagnation streak when a different tool is called', () => {
      service.reset('');

      // Accumulate 5 consecutive same-name calls (below threshold)
      for (let i = 0; i < 5; i++) {
        service.addAndCheck(
          createToolCallRequestEvent('search_code', { query: `a${i}` }),
        );
      }

      // A different tool resets the streak
      service.addAndCheck(
        createToolCallRequestEvent('write_file', {
          path: 'out.txt',
          content: 'x',
        }),
      );

      // 5 more calls of the original tool: streak only reaches 5, below threshold
      for (let i = 0; i < 5; i++) {
        const isLoop = service.addAndCheck(
          createToolCallRequestEvent('search_code', { query: `b${i}` }),
        );
        expect(isLoop).toBe(false);
      }
    });
  });
});
