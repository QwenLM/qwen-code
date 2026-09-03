/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { Part } from '@google/genai';
import type { Config } from '../config/config.js';
import type {
  ServerLlmContentEvent,
  ServerLlmModelFallbackEvent,
  ServerLlmRetryEvent,
  ServerLlmStreamEvent,
  ServerLlmThoughtEvent,
  ServerLlmToolCallRequestEvent,
} from '../core/turn.js';
import { LlmEventType } from '../core/turn.js';
import * as loggers from '../telemetry/loggers.js';
import { LoopType } from '../telemetry/types.js';
import type { DebugLogger } from '../utils/debugLogger.js';
import { FULL_OUTPUT_DIGEST_LABEL } from '../tools/truncation.js';
import {
  DEFAULT_MAX_TOOL_CALLS_PER_TURN,
  LoopDetectionService,
} from './loopDetectionService.js';

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
const GLOBAL_DUPLICATE_THRESHOLD = 6;
const SHELL_COMMAND_STAGNATION_THRESHOLD = 8;
const ALTERNATING_PATTERN_CYCLES = 3;

describe('LoopDetectionService', () => {
  let service: LoopDetectionService;
  let mockConfig: Config;
  let mockDebugLogger: DebugLogger;

  // getMaxToolCallsPerTurn mimics the real Config getter, which always
  // returns an effective cap (default applied, <= 0 resolved to Infinity).
  // `explicit` mimics isMaxToolCallsPerTurnExplicit: an explicit value is a
  // hard cap, the default (unset) is adaptive.
  const makeConfig = (
    cap: number = DEFAULT_MAX_TOOL_CALLS_PER_TURN,
    explicit = false,
    skipLoopDetection = true,
  ): Config =>
    ({
      getTelemetryEnabled: () => true,
      getMaxToolCallsPerTurn: () => cap,
      isMaxToolCallsPerTurnExplicit: () => explicit,
      getDebugLogger: () => mockDebugLogger,
      getSkipLoopDetection: () => skipLoopDetection,
    }) as unknown as Config;

  beforeEach(() => {
    mockDebugLogger = {
      isEnabled: () => true,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    mockConfig = makeConfig();
    service = new LoopDetectionService(mockConfig);
    vi.clearAllMocks();
  });

  const createToolCallRequestEvent = (
    name: string,
    args: Record<string, unknown>,
  ): ServerLlmToolCallRequestEvent => ({
    type: LlmEventType.ToolCallRequest,
    value: {
      name,
      args,
      callId: 'test-id',
      isClientInitiated: false,
      prompt_id: 'test-prompt-id',
    },
  });

  const createContentEvent = (content: string): ServerLlmContentEvent => ({
    type: LlmEventType.Content,
    value: content,
  });

  const createThoughtEvent = (
    subject: string,
    description = '',
  ): ServerLlmThoughtEvent => ({
    type: LlmEventType.Thought,
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
        type: LlmEventType.UserCancelled,
      } as unknown as ServerLlmStreamEvent;

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

    it('resets the consecutive tool-call counter on retry', () => {
      const event = createToolCallRequestEvent('testTool', { param: 'value' });
      for (let i = 0; i < TOOL_CALL_LOOP_THRESHOLD - 1; i++) {
        expect(service.checkAlwaysOnSafeties(event)).toBe(false);
      }

      expect(
        service.checkAlwaysOnSafeties({
          type: LlmEventType.Retry,
        } as ServerLlmStreamEvent),
      ).toBe(false);

      for (let i = 0; i < TOOL_CALL_LOOP_THRESHOLD - 1; i++) {
        expect(service.checkAlwaysOnSafeties(event)).toBe(false);
      }
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('should expose the current consecutive tool-call count', () => {
      const event = createToolCallRequestEvent('testTool', { param: 'value' });
      for (let i = 0; i < TOOL_CALL_LOOP_THRESHOLD - 1; i++) {
        service.checkAlwaysOnSafeties(event);
      }

      expect(service.getConsecutiveToolCallCount()).toBe(
        TOOL_CALL_LOOP_THRESHOLD - 1,
      );
      expect(service.checkAlwaysOnSafeties(event)).toBe(true);
      expect(service.getConsecutiveToolCallCount()).toBe(
        TOOL_CALL_LOOP_THRESHOLD,
      );
    });

    it('halts consecutive identical calls via the always-on guard', () => {
      // The consecutive guard lives in checkAlwaysOnSafeties, so it fires
      // independently of the skipLoopDetection gate (which only gates the
      // heuristic path at the client layer).
      const event = createToolCallRequestEvent('stuck_tool', { p: 'same' });
      for (let i = 0; i < TOOL_CALL_LOOP_THRESHOLD - 1; i++) {
        expect(service.checkAlwaysOnSafeties(event)).toBe(false);
      }
      expect(service.checkAlwaysOnSafeties(event)).toBe(true);
      expect(service.getLastLoopType()).toBe(
        LoopType.CONSECUTIVE_IDENTICAL_TOOL_CALLS,
      );
      expect(loggers.logLoopDetected).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          loop_type: 'consecutive_identical_tool_calls',
        }),
      );
    });

    it('treats reordered argument fields as identical for the consecutive guard', () => {
      // canonicalizeForHash makes the consecutive-identical guard see the same
      // call with fields in different insertion orders as identical, so a stuck
      // model cannot evade it by reordering keys. Pins the canonicalization
      // contract for this always-on detector (not just the adaptive cap).
      let fired = false;
      for (let i = 0; i < TOOL_CALL_LOOP_THRESHOLD; i++) {
        const args = i % 2 === 0 ? { a: 1, b: 2 } : { b: 2, a: 1 };
        fired = service.checkAlwaysOnSafeties(
          createToolCallRequestEvent('stuck_tool', args),
        );
        if (fired) break;
      }
      expect(fired).toBe(true);
      expect(service.getLastLoopType()).toBe(
        LoopType.CONSECUTIVE_IDENTICAL_TOOL_CALLS,
      );
    });

    it('always-on consecutive guard honors an in-session disable', () => {
      service.disableForSession();
      const event = createToolCallRequestEvent('stuck_tool', { p: 'same' });
      // Well past the threshold, but an explicit in-session disable suppresses
      // the consecutive guard (unlike the per-turn cap, which is unconditional).
      for (let i = 0; i < TOOL_CALL_LOOP_THRESHOLD + 2; i++) {
        expect(service.checkAlwaysOnSafeties(event)).toBe(false);
      }
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
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

  describe('Shell Command Stagnation (Always-On Circuit Breaker)', () => {
    it('halts repeated git inspection command variants via the always-on guard', () => {
      const commands = [
        'git status --short',
        'git status --short && git diff --stat',
        'git diff --name-only HEAD',
        'git status --porcelain=v1',
        'git diff --stat HEAD',
        'git -C . status --short',
        'git --no-pager diff --stat',
        'git ls-files --modified',
      ];

      for (const command of commands.slice(0, -1)) {
        expect(
          service.checkAlwaysOnSafeties(
            createToolCallRequestEvent('run_shell_command', {
              command,
              description: 'Inspect repository changes',
            }),
          ),
        ).toBe(false);
      }

      expect(
        service.checkAlwaysOnSafeties(
          createToolCallRequestEvent('run_shell_command', {
            command: commands.at(-1),
            description: 'Inspect repository changes',
          }),
        ),
      ).toBe(true);
      expect(service.getLastLoopType()).toBe(LoopType.SHELL_COMMAND_STAGNATION);
      expect(loggers.logLoopDetected).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          loop_type: 'shell_command_stagnation',
        }),
      );
    });

    it('resets the streak when a non-inspection tool call interrupts the run', () => {
      // Vary the command text so the consecutive-identical guard (threshold 5)
      // never fires and only the shell-stagnation bucket accumulates.
      const variants = [
        'git status --short',
        'git diff --stat',
        'git ls-files --modified',
        'git status --porcelain=v1',
        'git diff --name-only HEAD',
        'git -C . status --short',
        'git --no-pager diff --stat',
      ];
      const gitInspect = (i: number) =>
        service.checkAlwaysOnSafeties(
          createToolCallRequestEvent('run_shell_command', {
            command: variants[i % variants.length],
            description: 'Inspect repository changes',
          }),
        );

      // One short of the threshold, so the next inspection alone would trip.
      for (let i = 0; i < SHELL_COMMAND_STAGNATION_THRESHOLD - 1; i++) {
        expect(gitInspect(i)).toBe(false);
      }

      // A non-inspection tool call must reset the streak to zero.
      expect(
        service.checkAlwaysOnSafeties(
          createToolCallRequestEvent('read_file', {
            absolute_path: '/repo/README.md',
          }),
        ),
      ).toBe(false);

      // Counting restarts from zero: a full threshold-minus-one run of git
      // inspections still does not trip, proving the streak did not carry over.
      for (let i = 0; i < SHELL_COMMAND_STAGNATION_THRESHOLD - 1; i++) {
        expect(gitInspect(i)).toBe(false);
      }
      expect(service.getLastLoopType()).not.toBe(
        LoopType.SHELL_COMMAND_STAGNATION,
      );
    });

    it('resets the streak when a retry replays shell inspections', () => {
      const variants = [
        'git status --short',
        'git diff --stat',
        'git ls-files --modified',
        'git status --porcelain=v1',
        'git diff --name-only HEAD',
        'git -C . status --short',
        'git --no-pager diff --stat',
      ];

      for (const command of variants) {
        expect(
          service.checkAlwaysOnSafeties(
            createToolCallRequestEvent('run_shell_command', {
              command,
              description: 'Inspect repository changes',
            }),
          ),
        ).toBe(false);
      }

      expect(
        service.checkAlwaysOnSafeties({
          type: LlmEventType.Retry,
        } as ServerLlmStreamEvent),
      ).toBe(false);

      for (const command of variants) {
        expect(
          service.checkAlwaysOnSafeties(
            createToolCallRequestEvent('run_shell_command', {
              command,
              description: 'Inspect repository changes',
            }),
          ),
        ).toBe(false);
      }
      expect(service.getLastLoopType()).not.toBe(
        LoopType.SHELL_COMMAND_STAGNATION,
      );
    });

    it('honors an in-session disable for shell inspection stagnation', () => {
      service.disableForSession();

      const variants = [
        'git status --short',
        'git diff --stat',
        'git ls-files --modified',
        'git status --porcelain=v1',
        'git diff --name-only HEAD',
        'git -C . status --short',
        'git --no-pager diff --stat',
        'git ls-files --others',
      ];

      for (const command of variants) {
        expect(
          service.checkAlwaysOnSafeties(
            createToolCallRequestEvent('run_shell_command', {
              command,
              description: 'Inspect repository changes',
            }),
          ),
        ).toBe(false);
      }
      expect(loggers.logLoopDetected).not.toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          loop_type: 'shell_command_stagnation',
        }),
      );
    });

    it('does not bucket compound commands that also write to the repository', () => {
      // Each chain stages and commits real work; the embedded `git status` must
      // not classify the whole command as stagnant read-only inspection. Vary
      // the path so the consecutive-identical guard never fires, isolating the
      // shell-stagnation guard under test.
      for (let i = 0; i < SHELL_COMMAND_STAGNATION_THRESHOLD; i++) {
        expect(
          service.checkAlwaysOnSafeties(
            createToolCallRequestEvent('run_shell_command', {
              command: `git add file-${i}.txt && git status --short && git commit -m progress-${i}`,
              description: 'Stage, inspect, and commit progress',
            }),
          ),
        ).toBe(false);
      }
      expect(service.getLastLoopType()).not.toBe(
        LoopType.SHELL_COMMAND_STAGNATION,
      );
    });

    it('does not bucket shell chains that include non-git commands', () => {
      for (let i = 0; i < SHELL_COMMAND_STAGNATION_THRESHOLD; i++) {
        expect(
          service.checkAlwaysOnSafeties(
            createToolCallRequestEvent('run_shell_command', {
              command: `git status --short && npm test -- --runInBand=${i}`,
              description: 'Inspect repository changes and run tests',
            }),
          ),
        ).toBe(false);
      }
      expect(service.getLastLoopType()).not.toBe(
        LoopType.SHELL_COMMAND_STAGNATION,
      );
    });

    it('does not halt repeated non-git shell commands', () => {
      for (let i = 0; i < SHELL_COMMAND_STAGNATION_THRESHOLD + 2; i++) {
        expect(
          service.checkAlwaysOnSafeties(
            createToolCallRequestEvent('run_shell_command', {
              command: `npm test -- --runInBand=${i}`,
              description: 'Run tests',
            }),
          ),
        ).toBe(false);
      }
      expect(service.getLastLoopType()).not.toBe(
        LoopType.SHELL_COMMAND_STAGNATION,
      );
    });

    it('halts newline-separated git inspection command variants', () => {
      const commands = [
        'git diff --stat\ngit status --short',
        'git diff --name-only HEAD\ngit ls-files --modified',
        'git --no-pager diff --stat\ngit status --porcelain=v1',
        'git diff --stat HEAD\ngit ls-files --others',
        'git diff --name-only\ngit status --short',
        'git diff --stat\ngit -C . status --short',
        'git --no-pager diff --stat\ngit ls-files --modified',
        'git diff --name-only HEAD\ngit status --short',
      ];

      for (const command of commands.slice(0, -1)) {
        expect(
          service.checkAlwaysOnSafeties(
            createToolCallRequestEvent('run_shell_command', {
              command,
              description: 'Inspect repository changes',
            }),
          ),
        ).toBe(false);
      }

      expect(
        service.checkAlwaysOnSafeties(
          createToolCallRequestEvent('run_shell_command', {
            command: commands.at(-1),
            description: 'Inspect repository changes',
          }),
        ),
      ).toBe(true);
      expect(service.getLastLoopType()).toBe(LoopType.SHELL_COMMAND_STAGNATION);
    });

    it('does not halt file-specific git diff review commands', () => {
      const commands = [
        'git status --short',
        'git diff --stat',
        'git diff -- src/a.ts',
        'git diff -- src/b.ts',
        'git diff -- src/c.ts',
        'git diff -- src/d.ts',
        'git diff -- src/e.ts',
        'git diff -- src/f.ts',
      ];

      for (const command of commands) {
        expect(
          service.checkAlwaysOnSafeties(
            createToolCallRequestEvent('run_shell_command', {
              command,
              description: 'Inspect repository changes',
            }),
          ),
        ).toBe(false);
      }
      expect(loggers.logLoopDetected).not.toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          loop_type: 'shell_command_stagnation',
        }),
      );
    });

    it('does not halt file-specific git diff review commands without -- separator', () => {
      const commands = [
        'git status --short',
        'git diff --stat',
        'git diff src/a.ts',
        'git diff src/b.ts',
        'git diff src/c.ts',
        'git diff src/d.ts',
        'git diff src/e.ts',
        'git diff src/f.ts',
      ];

      for (const command of commands) {
        expect(
          service.checkAlwaysOnSafeties(
            createToolCallRequestEvent('run_shell_command', {
              command,
              description: 'Inspect repository changes',
            }),
          ),
        ).toBe(false);
      }
      expect(loggers.logLoopDetected).not.toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          loop_type: 'shell_command_stagnation',
        }),
      );
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

      let isLoop = false;
      for (let i = 0; i < CONTENT_LOOP_THRESHOLD; i++) {
        isLoop = service.addAndCheck(createContentEvent(repeatedContent));
        // A fresh filler each cycle: repetitions separated by VARYING
        // content are not a loop. (Reusing one identical filler made the
        // whole stream byte-periodic, which the long-period rule for
        // issue #1775 correctly treats as a chant.)
        isLoop = service.addAndCheck(
          createContentEvent(generateRandomString(500)),
        );
      }
      expect(isLoop).toBe(false);
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });
  });

  describe('Content element detection', () => {
    const feed = (content: string, times: number): boolean => {
      let isLoop = false;
      for (let i = 0; i < times; i++) {
        isLoop = service.addAndCheck(createContentEvent(content));
      }
      return isLoop;
    };

    // A list item resets tracking so a long list is not mistaken for a loop.
    // `-` is the most common bullet in markdown, and it used to be the one
    // marker the check could not see.
    it.each([['-'], ['*'], ['+']])(
      'should treat "%s" as a list item and not report a loop',
      (marker) => {
        service.reset('');
        const bullet = `${marker} ${createRepetitiveContent(1, CONTENT_CHUNK_SIZE)}\n`;

        expect(feed(bullet, CONTENT_LOOP_THRESHOLD * 2)).toBe(false);
        expect(loggers.logLoopDetected).not.toHaveBeenCalled();
      },
    );

    it('should still report a loop for repeated non-list content', () => {
      service.reset('');
      const notABullet = `${createRepetitiveContent(1, CONTENT_CHUNK_SIZE)}\n`;

      expect(feed(notABullet, CONTENT_LOOP_THRESHOLD)).toBe(true);
    });

    // A divider suppresses detection outright, so anything wrongly classified
    // as one becomes invisible to the detector. Uppercase letters and digits
    // fall inside the U+002B-U+005F span that the old pattern accidentally
    // described, which made a model chanting such a token undetectable.
    it.each([['ABCDE'], ['01234'], ['SELEC']])(
      'should detect a loop when the model chants "%s"',
      (token) => {
        service.reset('');
        const chant = token.repeat(CONTENT_CHUNK_SIZE / token.length);

        expect(feed(chant, CONTENT_LOOP_THRESHOLD)).toBe(true);
      },
    );

    // Guards against over-correcting. Real horizontal rules must keep
    // suppressing detection, including the box-drawing span that is a
    // deliberate range. These pass both before and after the fix.
    it.each([['-'], ['='], ['*'], ['_'], ['+'], ['─'], ['━']])(
      'should still treat a rule of "%s" as a divider',
      (char) => {
        service.reset('');
        const rule = char.repeat(CONTENT_CHUNK_SIZE);

        expect(feed(rule, CONTENT_LOOP_THRESHOLD * 2)).toBe(false);
        expect(loggers.logLoopDetected).not.toHaveBeenCalled();
      },
    );
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
      } as unknown as ServerLlmStreamEvent;
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

  describe('Long verbatim repetition loops (issue #1775)', () => {
    // The report shows one multi-sentence analysis block (~300 chars)
    // chanted verbatim many times without the turn halting. The repeated
    // unit is far longer than the clustered chunk rule's 75-char window,
    // and on OpenAI-compatible providers such chants often run in the
    // reasoning stream, which only reaches the service as Thought events.
    // These tests stream the repeated block with deliberately misaligned
    // deltas (a size that does not divide the unit) so no two adjacent
    // deltas are identical, matching real token-stream chunking.
    const CHANTED_UNIT =
      'The issue might be that the API call is not being made properly ' +
      'when the switch is toggled. Let me make sure the fetchPublicRecipes ' +
      'function is called correctly with the right parameters. The issue ' +
      'might be that the API call is not being made with the correct ' +
      'parameters when the switch is toggled.';
    const DELTA = 17;

    const streamAsMisalignedThoughtDeltas = (
      text: string,
      deltaSize = DELTA,
    ): boolean => {
      let detected = false;
      for (let i = 0; i < text.length && !detected; i += deltaSize) {
        detected = service.addAndCheck(
          createThoughtEvent('', text.slice(i, i + deltaSize)),
        );
      }
      return detected;
    };

    const streamAsMisalignedContentDeltas = (
      text: string,
      deltaSize = DELTA,
    ): boolean => {
      let detected = false;
      for (let i = 0; i < text.length && !detected; i += deltaSize) {
        detected = service.addAndCheck(
          createContentEvent(text.slice(i, i + deltaSize)),
        );
      }
      return detected;
    };

    it('unit shape sanity: the chanted block exceeds the cluster window', () => {
      expect(CHANTED_UNIT.length % DELTA).not.toBe(0);
      expect(CHANTED_UNIT.length).toBeGreaterThan(CONTENT_CHUNK_SIZE * 1.5);
    });

    it('detects the long chant in the reasoning/thought channel', () => {
      service.reset('');
      const detected = streamAsMisalignedThoughtDeltas(CHANTED_UNIT.repeat(40));
      expect(detected).toBe(true);
      expect(service.getLastLoopType()).toBe(
        LoopType.CHANTING_IDENTICAL_SENTENCES,
      );
    });

    it('detects the long chant on the visible content channel', () => {
      service.reset('');
      const detected = streamAsMisalignedContentDeltas(CHANTED_UNIT.repeat(40));
      expect(detected).toBe(true);
      expect(service.getLastLoopType()).toBe(
        LoopType.CHANTING_IDENTICAL_SENTENCES,
      );
    });

    it('detects an even longer (~550-char) repeated unit', () => {
      service.reset('');
      // Same symptom class as the follow-up comment on the issue, whose
      // repeated block is roughly half a kilobyte. Well inside the history
      // window the long-period rule retains (see MAX_HISTORY_LENGTH).
      const longUnit =
        "Now I'm implementing the fix by modifying the version comparison " +
        "logic to use the API's supportedIosVersions field when available, " +
        'falling back to the static table only if the API does not have ' +
        'that information. I realize the core issue: if the device is ' +
        'already on the newest major release and the table claims a lower ' +
        'maximum, the comparison correctly evaluates to false. The real ' +
        'problem is that the static table values are stale and do not ' +
        'match what the API reports, so I need to prioritize the API data.';
      expect(longUnit.length).toBeGreaterThan(500);
      expect(longUnit.length % DELTA).not.toBe(0);

      const detected = streamAsMisalignedThoughtDeltas(longUnit.repeat(20));
      expect(detected).toBe(true);
    });

    // Pseudo-random, internally aperiodic units (lowercase only, so no
    // markdown-structure delta ever resets tracking) for probing unit
    // lengths the original chant block does not cover.
    const makeAperiodicUnit = (length: number, seed: number): string => {
      let state = Math.imul(seed + 1, 2654435761) >>> 0 || 1;
      let out = '';
      while (out.length < length) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        out += String.fromCharCode(97 + ((state >>> 16) % 26));
      }
      return out.slice(0, length);
    };

    // Between the clustered rule's ~75-char bound and the span a fixed
    // five-occurrence window can verify (~238 chars), the verified region
    // must grow with the occurrence run — a run pinned to the last five
    // occurrences left these units permanently undetectable.
    it.each([100, 150, 200])(
      'detects a %d-char repeated unit in the mid-length band',
      (unitLength) => {
        service.reset('');
        const unit = makeAperiodicUnit(unitLength, unitLength);
        expect(unit.length % DELTA).not.toBe(0);

        const detected = streamAsMisalignedContentDeltas(unit.repeat(40));
        expect(detected).toBe(true);
        expect(service.getLastLoopType()).toBe(
          LoopType.CHANTING_IDENTICAL_SENTENCES,
        );
      },
    );

    // Units of ~1 KB or more can never fit five occurrences into the
    // retained history window; once the window saturates, the truncated-run
    // path must admit them by verifying the whole retained region.
    it.each([1000, 1500])(
      'detects a %d-char repeated unit that cannot fit five occurrences in the window',
      (unitLength) => {
        service.reset('');
        const unit = makeAperiodicUnit(unitLength, unitLength);
        expect(unit.length % DELTA).not.toBe(0);

        const detected = streamAsMisalignedContentDeltas(unit.repeat(30));
        expect(detected).toBe(true);
        expect(service.getLastLoopType()).toBe(
          LoopType.CHANTING_IDENTICAL_SENTENCES,
        );
      },
    );

    it('does not accept a short occurrence run in fresh history', () => {
      service.reset('');
      // Three occurrences of a 1000-char unit span only 2050 chars — the
      // history has not saturated, so the run cannot have been truncated
      // and the short-run path must not admit it.
      const unit = makeAperiodicUnit(1000, 7);
      const detected = streamAsMisalignedContentDeltas(unit.repeat(3));
      expect(detected).toBe(false);
    });

    it('detects a chant that starts after a long varied turn fills the window', () => {
      service.reset('');
      // The realistic #1775 shape: a long varied turn beyond the retained
      // window, then the chant starts. Detection must survive
      // truncateAndUpdate's index adjustment, and it must happen exactly
      // when the fifth in-window occurrence of the unit lands. The two
      // bounds pin the window size: a shrunken window (e.g. 2500) cannot
      // hold five occurrences of a 700-char unit and instead fires early
      // via the truncated-run path as soon as the filler has flushed out
      // of the pure-chant window — before the bound below.
      let filler = '';
      for (let i = 0; i < 100; i++) {
        filler += `Step ${i}: consider aspect ${i * 7 + 3} of the problem. `;
      }
      expect(filler.length).toBeGreaterThan(2500);
      const unit = makeAperiodicUnit(700, 42);
      expect(unit.length % DELTA).not.toBe(0);

      expect(streamAsMisalignedContentDeltas(filler)).toBe(false);

      const chant = unit.repeat(20);
      let detectedAt = -1;
      for (let i = 0; i < chant.length; i += DELTA) {
        if (
          service.addAndCheck(createContentEvent(chant.slice(i, i + DELTA)))
        ) {
          detectedAt = i + DELTA;
          break;
        }
      }
      expect(detectedAt).not.toBe(-1);
      expect(service.getLastLoopType()).toBe(
        LoopType.CHANTING_IDENTICAL_SENTENCES,
      );
      // Not before the fifth occurrence can exist (four full units of
      // span), and immediately once its final chunk lands (plus a
      // one-delta margin for the streaming boundary).
      expect(detectedAt).toBeGreaterThan(4 * unit.length);
      expect(detectedAt).toBeLessThanOrEqual(
        4 * unit.length + CONTENT_CHUNK_SIZE + DELTA,
      );
    });

    it('does not halt on a long, varied reasoning stream', () => {
      service.reset('');
      let text = '';
      for (let i = 0; i < 200; i++) {
        text += `Step ${i}: consider aspect ${i * 7 + 3} of the problem. `;
      }
      expect(streamAsMisalignedThoughtDeltas(text)).toBe(false);
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('does not halt when identical chunks recur at an even stride but intervening text varies', () => {
      service.reset('');
      // A fixed 50-char anchor reappearing every 200 chars with VARYING
      // same-length filler between occurrences: equal-stride occurrences
      // without a genuinely periodic region must not fire.
      const anchor =
        'The quick brown fox jumps over the lazy dog again! '.slice(
          0,
          CONTENT_CHUNK_SIZE,
        );
      // Pseudo-random, internally aperiodic filler that still has the SAME
      // length for every seed, so anchor occurrences stay exactly 200 chars
      // apart. (A modular padding like `(seed + k*7) % 26` is periodic with
      // period 26 and the existing clustered rule rightly halts on it.)
      const filler = (seed: number, length: number): string => {
        let state = ((seed + 1) * 2654435761) >>> 0;
        let out = `Varying filler number ${seed} `;
        while (out.length < length) {
          state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
          out += String.fromCharCode(97 + ((state >>> 16) % 26));
        }
        return out;
      };

      let text = '';
      for (let i = 0; i < 6; i++) {
        text += anchor + filler(i, 150);
      }
      expect(streamAsMisalignedContentDeltas(text, CONTENT_CHUNK_SIZE)).toBe(
        false,
      );
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('does not halt on fewer than five occurrences of a long unit', () => {
      service.reset('');
      // Four full repetitions only yield four equally-spaced occurrences
      // of any one chunk — below the long-period threshold.
      const detected = streamAsMisalignedContentDeltas(CHANTED_UNIT.repeat(4));
      expect(detected).toBe(false);
    });

    it('detects a visible-content chant after a fenced thought delta', () => {
      service.reset('');
      // Reasoning deltas must not drive the content channel's code-block
      // state: an unbalanced fence in a thought used to flip the shared
      // inCodeBlock parity, which nothing clears mid-turn, silently
      // disabling visible-content detection for the rest of the turn.
      service.addAndCheck(
        createThoughtEvent('', 'Let me look at this snippet:\n```'),
      );
      const detected = streamAsMisalignedContentDeltas(CHANTED_UNIT.repeat(40));
      expect(detected).toBe(true);
      expect(service.getLastLoopType()).toBe(
        LoopType.CHANTING_IDENTICAL_SENTENCES,
      );
    });

    it('detects a reasoning chant whose unit contains markdown list markers', () => {
      service.reset('');
      // Chain-of-thought often repeats structured units (checklists,
      // steps). Reasoning text is never rendered markdown, so
      // list-item-shaped thought deltas must not reset the shared history —
      // they used to wipe the accumulated evidence every cycle, making the
      // chant undetectable at any length.
      const unit =
        'Review the migration plan:\n' +
        '- check rollback safety\n' +
        '- verify indexes\n' +
        '- confirm the cache invalidation path\n';
      expect(unit.length).toBeGreaterThan(CONTENT_CHUNK_SIZE * 1.5);
      expect(unit.length % DELTA).not.toBe(0);

      const detected = streamAsMisalignedThoughtDeltas(unit.repeat(60));
      expect(detected).toBe(true);
      expect(service.getLastLoopType()).toBe(
        LoopType.CHANTING_IDENTICAL_SENTENCES,
      );
    });
  });

  describe('Retry and ModelFallback stream-state resets', () => {
    // The #7832 transport-replay gate admits thought-only cuts, so a
    // replay retry re-streams the failed attempt's reasoning through the
    // chunk detectors. With deterministic decoding the re-stream is
    // verbatim; the accumulated identical copies must not read as a chant,
    // or a healthy turn halts mid-attempt on a false positive.
    const ATTEMPT_DELTA = 17;

    // Deterministic pseudo-random non-repetitive text (LCG over a word
    // list): no repeated 50-gram inside one attempt, so a single streamed
    // attempt — or a replayed one after a reset — can never fire on its
    // own.
    const variedText = (len: number, seed: number): string => {
      let out = '';
      let x = seed + 1;
      const words = [
        'alpha',
        'bravo',
        'charlie',
        'delta',
        'echo',
        'foxtrot',
        'golf',
        'hotel',
        'india',
        'juliet',
        'kilo',
        'lima',
        'mike',
        'november',
        'oscar',
        'papa',
        'quebec',
        'romeo',
        'sierra',
        'tango',
      ];
      while (out.length < len) {
        x = (x * 1103515245 + 12345) % 2147483648;
        out += words[x % words.length] + String(x % 97) + ' ';
      }
      return out.slice(0, len);
    };

    const createRetryEvent = (
      isContinuation?: boolean,
    ): ServerLlmRetryEvent => ({
      type: LlmEventType.Retry,
      ...(isContinuation !== undefined && { isContinuation }),
    });

    const createModelFallbackEvent = (): ServerLlmModelFallbackEvent => ({
      type: LlmEventType.ModelFallback,
      fromModel: 'primary-model',
      toModel: 'fallback-model',
      fallbackIndex: 1,
    });

    const streamAsThoughts = (text: string): boolean => {
      let detected = false;
      for (let i = 0; i < text.length && !detected; i += ATTEMPT_DELTA) {
        detected = service.addAndCheck(
          createThoughtEvent('', text.slice(i, i + ATTEMPT_DELTA)),
        );
      }
      return detected;
    };

    const streamAsContent = (text: string): boolean => {
      let detected = false;
      for (let i = 0; i < text.length && !detected; i += ATTEMPT_DELTA) {
        detected = service.addAndCheck(
          createContentEvent(text.slice(i, i + ATTEMPT_DELTA)),
        );
      }
      return detected;
    };

    it('does not halt a healthy turn when replay retries re-stream identical reasoning', () => {
      service.reset('');
      // The witness shape: a ~1.4 KB reasoning phase cut twice and
      // re-streamed byte-identically. Three copies saturate the window;
      // without the reset the third (healthy) attempt fires
      // CHANTING_IDENTICAL_SENTENCES mid-stream.
      const attempt = variedText(1400, 42);
      expect(streamAsThoughts(attempt)).toBe(false);
      service.addAndCheck(createRetryEvent());
      expect(streamAsThoughts(attempt)).toBe(false);
      service.addAndCheck(createRetryEvent());
      expect(streamAsThoughts(attempt)).toBe(false);
      expect(service.getLastLoopType()).toBeNull();
    });

    it('does not halt a healthy turn when replay retries re-stream identical content', () => {
      service.reset('');
      const attempt = variedText(1400, 43);
      expect(streamAsContent(attempt)).toBe(false);
      service.addAndCheck(createRetryEvent());
      expect(streamAsContent(attempt)).toBe(false);
      service.addAndCheck(createRetryEvent());
      expect(streamAsContent(attempt)).toBe(false);
      expect(service.getLastLoopType()).toBeNull();
    });

    it('does not halt when rate-limit retries replay five shorter identical copies', () => {
      service.reset('');
      // The rate-limit branch replays without a yielded-content guard; five
      // ~300-char copies reach the five-occurrence path unsaturated.
      const attempt = variedText(300, 7);
      for (let copy = 0; copy < 5; copy++) {
        if (copy > 0) {
          service.addAndCheck(createRetryEvent());
        }
        expect(streamAsThoughts(attempt)).toBe(false);
      }
      expect(service.getLastLoopType()).toBeNull();
    });

    it('keeps accumulated evidence across a continuation retry', () => {
      service.reset('');
      // Continuation recovery (#7832) keeps the delivered text and appends
      // genuinely new output — nothing is re-streamed, so the accumulated
      // evidence must survive. An uninterrupted chant of this unit fires at
      // ~1258 chars; streaming 1192, continuing, then 100 more must fire at
      // the same point a continuous stream would.
      const unit = variedText(298, 21);
      const chant = unit.repeat(6);
      expect(streamAsThoughts(chant.slice(0, 1192))).toBe(false);
      service.addAndCheck(createRetryEvent(true));
      expect(streamAsThoughts(chant.slice(1192, 1292))).toBe(true);
      expect(service.getLastLoopType()).toBe(
        LoopType.CHANTING_IDENTICAL_SENTENCES,
      );
    });

    it('drops accumulated evidence on a replay retry at the same point', () => {
      service.reset('');
      // Contrast with the continuation test: a replay re-streams from the
      // start, so the same partial chant must NOT be one short continuation
      // away from firing after it.
      const unit = variedText(298, 21);
      const chant = unit.repeat(6);
      expect(streamAsThoughts(chant.slice(0, 1192))).toBe(false);
      service.addAndCheck(createRetryEvent());
      expect(streamAsThoughts(chant.slice(1192, 1292))).toBe(false);
      expect(service.getLastLoopType()).toBeNull();
    });

    it('drops the failed model stream state on ModelFallback', () => {
      service.reset('');
      // The fallback model restarts from scratch; with the failed model's
      // state retained, its two copies plus two more from the fallback model
      // would fire the long-period escape valve mid-way through the fourth
      // copy.
      const attempt = variedText(1400, 99);
      expect(streamAsThoughts(attempt)).toBe(false);
      expect(streamAsThoughts(attempt)).toBe(false);
      service.addAndCheck(createModelFallbackEvent());
      expect(streamAsThoughts(attempt)).toBe(false);
      expect(streamAsThoughts(attempt)).toBe(false);
      expect(service.getLastLoopType()).toBeNull();
    });

    it('still halts a genuine chant after a replay restart', () => {
      service.reset('');
      // The reset must not blind the detector: a real chant re-accumulates
      // after the restart and still fires.
      const unit = variedText(298, 21);
      service.addAndCheck(createRetryEvent());
      expect(streamAsThoughts(unit.repeat(40))).toBe(true);
      expect(service.getLastLoopType()).toBe(
        LoopType.CHANTING_IDENTICAL_SENTENCES,
      );
    });
  });

  describe('Truncation hysteresis', () => {
    // The physical trim walks the whole contentStats map, which at
    // saturation holds one entry per window position — Θ(window)
    // synchronous CPU per streamed event. The trim now runs with hysteresis
    // (a TRUNCATION_SLACK margin), and these tests pin that the change is
    // behavior-neutral: the fire offsets below were recorded on the
    // pre-hysteresis implementation and must not drift.
    const MAX_HISTORY_LENGTH = 4000;
    const TRUNCATION_SLACK = 1000;
    const DELTA = 17;

    const variedText = (len: number, seed: number): string => {
      let out = '';
      let x = seed + 1;
      const words = [
        'alpha',
        'bravo',
        'charlie',
        'delta',
        'echo',
        'foxtrot',
        'golf',
        'hotel',
        'india',
        'juliet',
        'kilo',
        'lima',
        'mike',
        'november',
        'oscar',
        'papa',
        'quebec',
        'romeo',
        'sierra',
        'tango',
      ];
      while (out.length < len) {
        x = (x * 1103515245 + 12345) % 2147483648;
        out += words[x % words.length] + String(x % 97) + ' ';
      }
      return out.slice(0, len);
    };

    const U300 =
      'The issue might be that the API call is not being made properly ' +
      'when the switch is toggled. Let me make sure the fetchPublicRecipes ' +
      'function is called correctly with the right parameters. The issue ' +
      'might be that the API call is not being made with the correct ' +
      'parameters when the switch is toggled.';
    const U1200 = variedText(1200, 7);
    const U1350 = variedText(1350, 9);

    const historyLength = (): number =>
      (service as unknown as { streamContentHistory: string })
        .streamContentHistory.length;

    // Streams as Content deltas of DELTA chars and returns the number of
    // chars streamed when detection fired (-1 when it never fired).
    const fireOffset = (text: string): number => {
      service.reset('');
      let streamed = 0;
      for (let i = 0; i < text.length; i += DELTA) {
        const piece = text.slice(i, i + DELTA);
        streamed += piece.length;
        if (
          service.addAndCheck({
            type: LlmEventType.Content,
            value: piece,
          })
        ) {
          return streamed;
        }
      }
      return -1;
    };

    it('unit shape sanity', () => {
      expect(U300.length).toBe(298);
      expect(U1200.length).toBe(1200);
      expect(U1350.length).toBe(1350);
    });

    it('defers physical truncation until the slack margin, then trims to the window', () => {
      service.reset('');
      const text = variedText(5100, 1);
      // Delta-aligned stream positions: one inside the slack band (past
      // the window, before the margin) and the first event crossing it.
      const insideSlackBand =
        DELTA * Math.floor((MAX_HISTORY_LENGTH + TRUNCATION_SLACK / 2) / DELTA);
      const trimPoint =
        DELTA * Math.ceil((MAX_HISTORY_LENGTH + TRUNCATION_SLACK + 1) / DELTA);
      let streamed = 0;
      for (let i = 0; i < text.length; i += DELTA) {
        const piece = text.slice(i, i + DELTA);
        streamed += piece.length;
        expect(
          service.addAndCheck({ type: LlmEventType.Content, value: piece }),
        ).toBe(false);
        if (streamed === insideSlackBand) {
          // Past the window, inside the slack band: no physical trim yet —
          // the per-event trim would have pinned the length to the window.
          expect(historyLength()).toBe(insideSlackBand);
        }
        if (streamed === trimPoint) {
          // Crossing the margin trims back to exactly the window.
          expect(historyLength()).toBe(MAX_HISTORY_LENGTH);
        }
      }
      expect(historyLength()).toBeLessThanOrEqual(
        MAX_HISTORY_LENGTH + TRUNCATION_SLACK,
      );
    });

    it('keeps detection fire offsets identical to the pre-hysteresis baseline', () => {
      // Recorded on the per-event-trim implementation. Shapes chosen to
      // fire before saturation (S1), right at it (S2, S4, S7), and after
      // several physical trims with a non-periodic prefix still inside the
      // slack band (S3, S5, S6) — the cases where a lazy trim could change
      // what the escape valve and occurrence runs see.
      expect(fireOffset(U300.repeat(60))).toBe(1258);
      expect(fireOffset(U1200.repeat(12))).toBe(4012);
      expect(fireOffset(variedText(3000, 3) + U1200.repeat(12))).toBe(7004);
      expect(fireOffset(U1350.repeat(12))).toBe(4012);
      expect(fireOffset(variedText(4500, 5) + U300.repeat(60))).toBe(5763);
      expect(fireOffset(variedText(200, 11) + U1200.repeat(12))).toBe(4216);
      expect(fireOffset(U1200.repeat(4))).toBe(4012);
    });

    it('never fires on a long varied stream across many trims', () => {
      expect(fireOffset(variedText(30000, 13))).toBe(-1);
    });
  });

  describe('Chanting halt debug-log excerpt', () => {
    // A reasoning-channel halt exits headless runs with empty stdout and a
    // label-only stderr; the excerpt debug log is the artifact that tells a
    // true repetition from a misfire. Kept out of the LoopDetected event
    // payload on purpose (the event contract stays loop_type + prompt_id).
    const DELTA = 17;

    const unit =
      'The issue might be that the API call is not being made properly ' +
      'when the switch is toggled. Let me make sure the fetchPublicRecipes ' +
      'function is called correctly with the right parameters. The issue ' +
      'might be that the API call is not being made with the correct ' +
      'parameters when the switch is toggled.';

    const streamAsThoughts = (text: string): boolean => {
      let detected = false;
      for (let i = 0; i < text.length && !detected; i += DELTA) {
        detected = service.addAndCheck(
          createThoughtEvent('', text.slice(i, i + DELTA)),
        );
      }
      return detected;
    };

    it('logs a short excerpt of one period of the repeated region', () => {
      service.reset('');
      expect(streamAsThoughts(unit.repeat(40))).toBe(true);

      const debug = vi.mocked(mockDebugLogger.debug);
      expect(debug).toHaveBeenCalledTimes(1);
      const message = String(debug.mock.calls[0]?.[0]);
      expect(message).toContain(LoopType.CHANTING_IDENTICAL_SENTENCES);
      const match = /excerpt \((\d+) chars\): (.*)$/.exec(message);
      expect(match).not.toBeNull();
      const excerpt = JSON.parse(String(match?.[2])) as string;
      expect(excerpt.length).toBeGreaterThan(0);
      expect(excerpt.length).toBeLessThanOrEqual(80);
      expect(Number(match?.[1])).toBe(excerpt.length);
      // The excerpt is one period of the chant: it must reappear verbatim
      // in the repeated unit (allowing a wrap across the unit boundary).
      expect((unit + unit).includes(excerpt)).toBe(true);
    });

    it('does not log an excerpt when nothing fires', () => {
      service.reset('');
      expect(streamAsThoughts(unit.slice(0, 500))).toBe(false);
      expect(vi.mocked(mockDebugLogger.debug)).not.toHaveBeenCalled();
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
      // (read_file, read_many_files, list_directory, zoom_image) or match the
      // read_/list_ prefix fallback used for MCP-provided tools.
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
        createToolCallRequestEvent('zoom_image', {
          file_path: 'chart.png',
          x1: 0,
          y1: 0,
          x2: 500,
          y2: 500,
        }),
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

  describe('Turn Tool Call Cap', () => {
    // The cap is configurable via model.maxToolCallsPerTurn; the service
    // reads the resolved Config getter with no fallback of its own, so the
    // pinned mock below is the single source of the cap in these tests.
    //
    // An explicit value is a hard cap; the default (unset) is adaptive — a
    // *soft* cap where diverse (productive) calls are allowed past it up to a
    // hard backstop (soft * 10), and only a stuck-repetition signal halts at
    // the soft cap. A small soft cap keeps the adaptive tests compact.
    const SOFT_CAP = 10;
    const HARD_CAP = SOFT_CAP * 10;
    let capConfig: Config;

    beforeEach(() => {
      // Default (unset) cap → adaptive behavior.
      capConfig = makeConfig(SOFT_CAP, false);
      service = new LoopDetectionService(capConfig);
    });

    const retryEvent = {
      type: LlmEventType.Retry,
    } as ServerLlmStreamEvent;
    const finishedEvent = {
      type: LlmEventType.Finished,
      value: { reason: 'STOP' },
    } as unknown as ServerLlmStreamEvent;

    it('does not fire at or below the soft cap', () => {
      service.reset('');
      for (let i = 0; i < SOFT_CAP; i++) {
        expect(
          service.checkAlwaysOnSafeties(
            createToolCallRequestEvent('any_tool', { i }),
          ),
        ).toBe(false);
      }
    });

    it('does not fire on diverse calls above the soft cap (productive turn)', () => {
      // Mirrors session 80db472f turn 8: a large implementation turn that
      // makes ~100 distinct calls without repeating any. The old blunt cap
      // halted this at the soft cap; the adaptive cap lets it continue.
      service.reset('');
      for (let i = 0; i < HARD_CAP - 1; i++) {
        expect(
          service.checkAlwaysOnSafeties(
            createToolCallRequestEvent('any_tool', { i }),
          ),
        ).toBe(false);
      }
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
      expect(service.getLastLoopType()).toBeNull();
    });

    it('fires when a stuck signal accumulates between the soft and hard cap', () => {
      // The primary scenario the adaptive cap targets: a productive turn
      // crosses the soft cap with diverse calls, THEN a stuck pattern emerges
      // mid-range. Guards against a refactor that only evaluates `stuck` at the
      // soft-cap boundary (the other stuck test crosses the boundary and builds
      // the signal simultaneously, so it would not catch that regression).
      service.reset('');
      for (let i = 0; i < SOFT_CAP; i++) {
        expect(
          service.checkAlwaysOnSafeties(
            createToolCallRequestEvent('any_tool', { i }),
          ),
        ).toBe(false);
      }
      // Now interleave 6 repeats of one key with distinct fillers so the
      // consecutive-identical guard does not fire; the stuck signal completes
      // well inside the (softCap, hardCap] range and halts there.
      let fired = false;
      for (let i = 0; i < GLOBAL_DUPLICATE_THRESHOLD * 2 && !fired; i++) {
        const isRepeat = i % 2 === 0;
        const args = isRepeat ? { stuck: true } : { filler: i };
        fired = service.checkAlwaysOnSafeties(
          createToolCallRequestEvent('any_tool', args),
        );
      }
      expect(fired).toBe(true);
      expect(service.getLastLoopType()).toBe(LoopType.TURN_TOOL_CALL_CAP);
    });

    it('fires on a stuck signal accumulated across Finished round-trips', () => {
      // The stuck-repetition tracker must survive Finished boundaries within a
      // turn (only reset() / Retry clear it): a model repeating the same call
      // across successful round-trips halts at the soft cap via the stuck
      // signal, not the hard backstop. Guards against a regression that clears
      // capKeyCounts on Finished.
      service.reset('');
      const same = { same: true };
      let fired = false;
      const step = (args: Record<string, unknown>) => {
        if (!fired)
          fired = service.checkAlwaysOnSafeties(
            createToolCallRequestEvent('t', args),
          );
      };
      // 3 round-trips, each repeating the same key twice (interleaved with
      // distinct calls so the consecutive-identical guard does not fire). The
      // 6th repeat crosses the soft cap and halts via the stuck signal, well
      // before the hard backstop.
      for (let rt = 0; rt < 3 && !fired; rt++) {
        step(same);
        step({ d: rt * 2 });
        step(same);
        step({ d: rt * 2 + 1 });
        if (!fired) service.checkAlwaysOnSafeties(finishedEvent);
      }
      expect(fired).toBe(true);
      expect(service.getLastLoopType()).toBe(LoopType.TURN_TOOL_CALL_CAP);
    });

    it('treats reordered argument fields as one call for the stuck signal', () => {
      // getToolCallKey canonicalizes object keys recursively, so the same
      // semantic call with fields in different insertion orders — at the top
      // level AND inside nested objects — hashes to the same key and
      // accumulates as repeats. Without canonicalization (or if the recursion
      // broke) each permutation would be a distinct key and the stuck signal
      // would never build. The variants are interleaved with distinct fillers
      // so the consecutive-identical guard does not fire first.
      service.reset('');
      const variants = [
        { a: 1, b: 2, c: 3, nested: { x: 10, y: 20 } },
        { nested: { y: 20, x: 10 }, c: 3, b: 2, a: 1 },
        { b: 2, a: 1, nested: { x: 10, y: 20 }, c: 3 },
        { c: 3, nested: { y: 20, x: 10 }, a: 1, b: 2 },
        { nested: { x: 10, y: 20 }, a: 1, c: 3, b: 2 },
        { b: 2, c: 3, a: 1, nested: { y: 20, x: 10 } },
      ];
      let fired = false;
      for (let i = 0; i < SOFT_CAP + variants.length && !fired; i++) {
        const isRepeat = i % 2 === 0;
        const args = isRepeat
          ? variants[(i / 2) % variants.length]
          : { filler: i };
        fired = service.checkAlwaysOnSafeties(
          createToolCallRequestEvent('any_tool', args),
        );
      }
      expect(fired).toBe(true);
      expect(service.getLastLoopType()).toBe(LoopType.TURN_TOOL_CALL_CAP);
    });

    it('fires at the hard cap regardless of diversity', () => {
      // The hard cap is the backstop for a runaway that varies its arguments
      // on every call (which no repetition signal catches).
      service.reset('');
      for (let i = 0; i < HARD_CAP; i++) {
        expect(
          service.checkAlwaysOnSafeties(createToolCallRequestEvent('t', { i })),
        ).toBe(false);
      }
      expect(
        service.checkAlwaysOnSafeties(
          createToolCallRequestEvent('t', { last: true }),
        ),
      ).toBe(true);
      expect(service.getLastLoopType()).toBe(LoopType.TURN_TOOL_CALL_CAP);
    });

    it('fires at the soft cap when a stuck-repetition signal is present', () => {
      // One (tool,args) call repeated GLOBAL_DUPLICATE_THRESHOLD times
      // (non-consecutively, so the consecutive-identical guard does not fire
      // first) makes the turn "stuck": exceeding the soft cap halts.
      service.reset('');
      let fired = false;
      // Interleave the repeated key X with distinct calls so X never repeats
      // back-to-back. X reaches the threshold exactly as the total crosses the
      // soft cap, so the next call after the soft cap fires.
      for (
        let i = 0;
        i < SOFT_CAP + GLOBAL_DUPLICATE_THRESHOLD && !fired;
        i++
      ) {
        const isRepeat = i % 2 === 0;
        const args = isRepeat ? { stuck: true } : { distinct: i };
        fired = service.checkAlwaysOnSafeties(
          createToolCallRequestEvent('any_tool', args),
        );
      }
      expect(fired).toBe(true);
      expect(loggers.logLoopDetected).toHaveBeenCalledTimes(1);
      expect(loggers.logLoopDetected).toHaveBeenCalledWith(
        capConfig,
        expect.objectContaining({ loop_type: 'turn_tool_call_cap' }),
      );
      expect(service.getLastLoopType()).toBe(LoopType.TURN_TOOL_CALL_CAP);
    });

    it('allows diverse calls past the built-in default soft cap', () => {
      // Documents that the default soft cap is DEFAULT_MAX_TOOL_CALLS_PER_TURN
      // and that diverse calls are allowed past it (no fire at default+1). The
      // hard-cap firing at the default config is covered by the SOFT_CAP=10
      // 'fires at the hard cap' test (same code path, scaled by the multiplier).
      const svc = new LoopDetectionService(mockConfig);
      svc.reset('');
      for (let i = 0; i < DEFAULT_MAX_TOOL_CALLS_PER_TURN + 1; i++) {
        expect(
          svc.checkAlwaysOnSafeties(createToolCallRequestEvent('t', { i })),
        ).toBe(false);
      }
    });

    it('never fires when the cap is disabled (Config resolves <= 0 to Infinity)', () => {
      const svc = new LoopDetectionService(
        makeConfig(Number.POSITIVE_INFINITY),
      );
      svc.reset('');
      for (let i = 0; i < DEFAULT_MAX_TOOL_CALLS_PER_TURN + 50; i++) {
        expect(
          svc.checkAlwaysOnSafeties(createToolCallRequestEvent('t', { i })),
        ).toBe(false);
      }
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('does not fire after loop detection is disabled for the session', () => {
      // The dialog's "Disable loop detection for this session" must suppress
      // the cap too — the user's explicit choice outranks the circuit breaker
      // (it used to fire regardless, contradicting the dialog text).
      service.reset('');
      service.disableForSession();
      for (let i = 0; i < HARD_CAP + 10; i++) {
        expect(
          service.checkAlwaysOnSafeties(
            createToolCallRequestEvent('any_tool', { i }),
          ),
        ).toBe(false);
      }
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('rolls back a failed attempt on retry so its calls do not count', () => {
      service.reset('');
      // Attempt makes 6 calls, then the API retries (no round-trip committed
      // yet, so the rollback floor is 0).
      for (let i = 0; i < 6; i++) {
        service.checkAlwaysOnSafeties(createToolCallRequestEvent('t', { i }));
      }
      service.checkAlwaysOnSafeties(retryEvent);
      // The 6 discarded calls must not count: a full hard cap's worth of fresh
      // diverse calls stays under the limit, and only the (hardCap+1)-th fires.
      // (If the rollback had failed, the 6 prior calls would push the fire
      // earlier and this loop would observe a fire before the end.)
      for (let i = 0; i < HARD_CAP; i++) {
        expect(
          service.checkAlwaysOnSafeties(
            createToolCallRequestEvent('t', { j: i }),
          ),
        ).toBe(false);
      }
      expect(
        service.checkAlwaysOnSafeties(
          createToolCallRequestEvent('t', { last: true }),
        ),
      ).toBe(true);
      expect(loggers.logLoopDetected).toHaveBeenCalledTimes(1);
    });

    it('rolls back the stuck-repetition signal on retry', () => {
      // Larger soft cap so the failed attempt can build a stuck signal (6
      // non-consecutive repeats of one call) without crossing the soft cap and
      // firing early.
      const svc = new LoopDetectionService(makeConfig(20));
      svc.reset('');
      // Failed attempt: 6 repeats of one call interleaved with distinct calls
      // (so the consecutive-identical guard does not fire). Total stays under
      // the soft cap, so the cap does not fire — but capMaxKeyRepeat reaches 6.
      for (let i = 0; i < 6; i++) {
        svc.checkAlwaysOnSafeties(
          createToolCallRequestEvent('t', { stuck: true }),
        );
        svc.checkAlwaysOnSafeties(createToolCallRequestEvent('t', { d: i }));
      }
      svc.checkAlwaysOnSafeties(retryEvent);
      // The stuck signal must be cleared on retry: a diverse replay is allowed
      // well past the soft cap (20). If capMaxKeyRepeat had survived at 6, the
      // replay would halt at the 21st call (total > 20 and stuck).
      for (let i = 0; i < 25; i++) {
        expect(
          svc.checkAlwaysOnSafeties(createToolCallRequestEvent('t', { i })),
        ).toBe(false);
      }
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('preserves committed round-trip counts when a later attempt retries', () => {
      service.reset('');
      // Round-trip 1: 6 calls, then Finished commits them as the floor.
      for (let i = 0; i < 6; i++) {
        service.checkAlwaysOnSafeties(createToolCallRequestEvent('t', { i }));
      }
      service.checkAlwaysOnSafeties(finishedEvent);
      // Round-trip 2: 4 calls, then a retry discards only these 4.
      for (let i = 0; i < 4; i++) {
        service.checkAlwaysOnSafeties(
          createToolCallRequestEvent('t', { k: i }),
        );
      }
      service.checkAlwaysOnSafeties(retryEvent);
      // Total is back to the committed 6 (NOT zero): the hard cap is reached
      // after exactly (hardCap - 6) more diverse calls, and the next fires.
      // (If the commit had been lost, total would restart at 0 and the fire
      // would land later, failing the no-fire loop below.)
      for (let i = 0; i < HARD_CAP - 6; i++) {
        expect(
          service.checkAlwaysOnSafeties(
            createToolCallRequestEvent('t', { m: i }),
          ),
        ).toBe(false);
      }
      expect(
        service.checkAlwaysOnSafeties(
          createToolCallRequestEvent('t', { last: true }),
        ),
      ).toBe(true);
    });

    it('still accumulates across committed round-trips to trip the cap', () => {
      service.reset('');
      let fired = false;
      // Diverse calls across committed round-trips accumulate; the hard
      // backstop (soft * 10) is crossed partway through.
      for (let rt = 0; rt < 12 && !fired; rt++) {
        for (let i = 0; i < 15 && !fired; i++) {
          fired = service.checkAlwaysOnSafeties(
            createToolCallRequestEvent('t', { rt, i }),
          );
        }
        if (!fired) {
          service.checkAlwaysOnSafeties(finishedEvent);
        }
      }
      expect(fired).toBe(true);
      expect(service.getLastLoopType()).toBe(LoopType.TURN_TOOL_CALL_CAP);
    });

    it('treats an explicit value as a hard cap: cap of 2 halts call 3', () => {
      // Regression for the released contract (yiliang114): an explicitly set
      // maxToolCallsPerTurn halts on the call that exceeds it, even with
      // diverse args — no adaptive ×N extension.
      const svc = new LoopDetectionService(makeConfig(2, true));
      svc.reset('');
      expect(
        svc.checkAlwaysOnSafeties(createToolCallRequestEvent('t', { a: 1 })),
      ).toBe(false);
      expect(
        svc.checkAlwaysOnSafeties(createToolCallRequestEvent('t', { a: 2 })),
      ).toBe(false);
      expect(
        svc.checkAlwaysOnSafeties(createToolCallRequestEvent('t', { a: 3 })),
      ).toBe(true);
      expect(svc.getLastLoopType()).toBe(LoopType.TURN_TOOL_CALL_CAP);
    });

    it('the same value left at the default is adaptive, not a hard cap', () => {
      // Contrast proving the explicit flag (not the value) drives the hard-cap
      // behavior: an unset cap of the same value does not halt at value+1.
      const svc = new LoopDetectionService(makeConfig(2, false));
      svc.reset('');
      expect(
        svc.checkAlwaysOnSafeties(createToolCallRequestEvent('t', { a: 1 })),
      ).toBe(false);
      expect(
        svc.checkAlwaysOnSafeties(createToolCallRequestEvent('t', { a: 2 })),
      ).toBe(false);
      expect(
        svc.checkAlwaysOnSafeties(createToolCallRequestEvent('t', { a: 3 })),
      ).toBe(false);
    });
  });

  describe('Global Tool Call Duplicate Detection', () => {
    it('should not fire when same call appears fewer than threshold times', () => {
      service.reset('');
      const event = createToolCallRequestEvent('stuck_tool', {
        param: 'same',
      });
      for (let i = 0; i < GLOBAL_DUPLICATE_THRESHOLD - 1; i++) {
        const isLoop = service.addAndCheckHeuristicLoops(event);
        expect(isLoop).toBe(false);
      }
    });

    it('should fire when same (tool, args) appears threshold times non-consecutively', () => {
      service.reset('');
      const stuckEvent = createToolCallRequestEvent('stuck_tool', {
        param: 'same',
      });
      const otherEvents = [
        createToolCallRequestEvent('other_a', { x: 1 }),
        createToolCallRequestEvent('other_b', { y: 2 }),
        createToolCallRequestEvent('other_c', { z: 3 }),
      ];

      // Interleave: stuck, other_a, stuck, other_b, stuck, other_c, ...
      // GLOBAL_DUPLICATE_THRESHOLD total stuck calls with different calls between
      let otherIdx = 0;
      for (let i = 0; i < GLOBAL_DUPLICATE_THRESHOLD - 1; i++) {
        expect(service.addAndCheckHeuristicLoops(stuckEvent)).toBe(false);
        expect(
          service.addAndCheckHeuristicLoops(
            otherEvents[otherIdx % otherEvents.length],
          ),
        ).toBe(false);
        otherIdx++;
      }
      // The threshold-th stuck call should fire
      const isLoop = service.addAndCheckHeuristicLoops(stuckEvent);
      expect(isLoop).toBe(true);
      expect(loggers.logLoopDetected).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          loop_type: 'global_tool_call_duplicate',
        }),
      );
      // getLastLoopType() is the getter the client uses to populate the
      // bubbled LoopDetected event, so assert it too — not just the logged one.
      expect(service.getLastLoopType()).toBe(
        LoopType.GLOBAL_TOOL_CALL_DUPLICATE,
      );
    });

    it('should not fire for different (tool, args) pairs', () => {
      service.reset('');
      for (let i = 0; i < GLOBAL_DUPLICATE_THRESHOLD; i++) {
        const isLoop = service.addAndCheckHeuristicLoops(
          createToolCallRequestEvent('stuck_tool', { param: i }),
        );
        expect(isLoop).toBe(false);
      }
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('global-duplicate also fires for a consecutive identical run', () => {
      // checkGlobalDuplicate runs on every ToolCallRequest independently of the
      // always-on consecutive guard (which lives in checkAlwaysOnSafeties, not
      // this heuristic path). Exercised directly, the heuristic path fires
      // global-duplicate once a consecutive identical run reaches its threshold.
      service.reset('');
      const event = createToolCallRequestEvent('stuck_tool', {
        param: 'same',
      });
      for (let i = 0; i < GLOBAL_DUPLICATE_THRESHOLD - 1; i++) {
        service.addAndCheckHeuristicLoops(event);
      }
      const isLoop = service.addAndCheckHeuristicLoops(event);
      expect(isLoop).toBe(true);
      expect(loggers.logLoopDetected).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          loop_type: 'global_tool_call_duplicate',
        }),
      );
    });

    it('does not count a retried replay toward the global-duplicate threshold', () => {
      service.reset('');
      const stuck = createToolCallRequestEvent('stuck_tool', { param: 'same' });
      const retry = { type: LlmEventType.Retry } as ServerLlmStreamEvent;
      // Failed attempt streams (threshold - 3) identical calls, then retries.
      for (let i = 0; i < GLOBAL_DUPLICATE_THRESHOLD - 3; i++) {
        expect(service.addAndCheckHeuristicLoops(stuck)).toBe(false);
      }
      service.addAndCheckHeuristicLoops(retry);
      // The replay streams the same calls again. Without the Retry reset the
      // pre- and post-retry counts would sum to the threshold and false-fire.
      for (let i = 0; i < GLOBAL_DUPLICATE_THRESHOLD - 3; i++) {
        expect(service.addAndCheckHeuristicLoops(stuck)).toBe(false);
      }
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });
  });

  describe('Alternating Tool Call Pattern Detection', () => {
    it('should fire for a clean ABABAB alternating pattern', () => {
      service.reset('');
      const eventA = createToolCallRequestEvent('tool_a', { param: 'a' });
      const eventB = createToolCallRequestEvent('tool_b', { param: 'b' });

      // ALTERNATING_PATTERN_CYCLES cycles = 2*CYCLES calls. Build up to
      // one call short of the trigger.
      const totalCycles = ALTERNATING_PATTERN_CYCLES;
      for (let i = 0; i < totalCycles - 1; i++) {
        expect(service.addAndCheckHeuristicLoops(eventA)).toBe(false);
        expect(service.addAndCheckHeuristicLoops(eventB)).toBe(false);
      }
      // First call of the final cycle
      expect(service.addAndCheckHeuristicLoops(eventA)).toBe(false);
      // Second call of the final cycle completes the pattern
      const isLoop = service.addAndCheckHeuristicLoops(eventB);
      expect(isLoop).toBe(true);
      expect(loggers.logLoopDetected).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          loop_type: 'alternating_tool_call_pattern',
        }),
      );
      expect(service.getLastLoopType()).toBe(
        LoopType.ALTERNATING_TOOL_CALL_PATTERN,
      );
    });

    it('should not fire when calls alternate but with varying keys', () => {
      service.reset('');
      // Alternating tool names but different args each time → different
      // keys → no clean ABAB because the keys keep changing.
      const totalCycles = ALTERNATING_PATTERN_CYCLES + 2;
      for (let i = 0; i < totalCycles; i++) {
        expect(
          service.addAndCheckHeuristicLoops(
            createToolCallRequestEvent('tool_a', { param: i }),
          ),
        ).toBe(false);
        expect(
          service.addAndCheckHeuristicLoops(
            createToolCallRequestEvent('tool_b', { param: i }),
          ),
        ).toBe(false);
      }
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('should not fire for a single tool repeated (consecutive, not alternating)', () => {
      service.reset('');
      const event = createToolCallRequestEvent('tool_a', { param: 'a' });
      const totalCalls = 2 * ALTERNATING_PATTERN_CYCLES;
      for (let i = 0; i < totalCalls; i++) {
        // The consecutive identical detector would fire at threshold 5,
        // but we only check the heuristic path here. At 6 calls the
        // global duplicate detector fires. This test just confirms the
        // alternating detector doesn't false-positive on a repeated key.
        service.addAndCheckHeuristicLoops(event);
      }
      // Either global_duplicate or consecutive_identical fires — we just
      // verify the alternating pattern detector didn't fire.
      const logged = vi.mocked(loggers.logLoopDetected).mock.calls;
      const alternatingFired = logged.some((call) => {
        const event = call[1] as unknown as Record<string, unknown>;
        return 'loop_type' in event
          ? event['loop_type'] === 'alternating_tool_call_pattern'
          : false;
      });
      expect(alternatingFired).toBe(false);
    });

    it('should reset alternating window after a different third pattern', () => {
      service.reset('');
      const eventA = createToolCallRequestEvent('tool_a', { param: 'a' });
      const eventB = createToolCallRequestEvent('tool_b', { param: 'b' });
      const eventC = createToolCallRequestEvent('tool_c', { param: 'c' });

      // Build up ABAB
      service.addAndCheckHeuristicLoops(eventA);
      service.addAndCheckHeuristicLoops(eventB);
      service.addAndCheckHeuristicLoops(eventA);
      service.addAndCheckHeuristicLoops(eventB);
      // Insert C to break the pattern
      service.addAndCheckHeuristicLoops(eventC);
      // Restart ABAB from here — need 6 calls (3 cycles) after the break
      service.addAndCheckHeuristicLoops(eventA);
      service.addAndCheckHeuristicLoops(eventB);
      service.addAndCheckHeuristicLoops(eventA);
      service.addAndCheckHeuristicLoops(eventB);
      expect(service.addAndCheckHeuristicLoops(eventA)).toBe(false);
      const isLoop = service.addAndCheckHeuristicLoops(eventB);
      expect(isLoop).toBe(true);
      expect(loggers.logLoopDetected).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          loop_type: 'alternating_tool_call_pattern',
        }),
      );
    });
  });

  describe('Result-aware guards for stateful read tools (issue #9450)', () => {
    // Identical `task_list` arguments do not imply an identical result:
    // teammates mutate the shared task board between calls. These tests pin
    // the fix for the false positive where a polling teammate was halted by
    // the argument-only guards while the board kept changing.
    const TASK_LIST_ARGS = {
      status: 'in_progress',
      owner: 'peer-a',
      blockedBy: '',
    };

    const taskListEvent = (
      callId: string,
      args: Record<string, unknown> = TASK_LIST_ARGS,
    ): ServerLlmToolCallRequestEvent => ({
      type: LlmEventType.ToolCallRequest,
      value: {
        name: 'task_list',
        args,
        callId,
        isClientInitiated: false,
        prompt_id: 'test-prompt-id',
      },
    });

    const taskListResult = (boardState: string, callId = 'call-x'): Part[] => [
      {
        functionResponse: {
          id: callId,
          name: 'task_list',
          response: { output: boardState },
        },
      },
    ];

    it('still halts at the threshold when no results were recorded (fail-safe)', () => {
      // A wiring gap must never loosen the DashScope protection (#5019):
      // without result evidence the guard behaves exactly as pre-fix.
      const event = taskListEvent('call-1');
      for (let i = 0; i < TOOL_CALL_LOOP_THRESHOLD - 1; i++) {
        expect(service.checkAlwaysOnSafeties(event)).toBe(false);
      }
      expect(service.checkAlwaysOnSafeties(event)).toBe(true);
      expect(service.getLastLoopType()).toBe(
        LoopType.CONSECUTIVE_IDENTICAL_TOOL_CALLS,
      );
    });

    it('still halts when result evidence is only partial (fail-safe)', () => {
      // Incomplete evidence (a dropped/failed execution records no result)
      // must never grant the result-aware exemption: the guard needs one
      // recorded result per preceding request before it trusts a streak.
      let fired = false;
      for (let i = 0; i < TOOL_CALL_LOOP_THRESHOLD; i++) {
        fired = service.checkAlwaysOnSafeties(taskListEvent(`call-${i}`));
        if (fired) break;
        if (i !== 2) {
          // Skip one recording mid-streak: 4 results for 5 requests.
          service.recordToolResult(
            { name: 'task_list', args: TASK_LIST_ARGS },
            taskListResult('frozen board'),
          );
        }
      }
      expect(fired).toBe(true);
      expect(service.getLastLoopType()).toBe(
        LoopType.CONSECUTIVE_IDENTICAL_TOOL_CALLS,
      );
    });

    it('still halts at the threshold when every result is unchanged', () => {
      const unchanged = '#1 [in_progress] @peer-a — task';
      let fired = false;
      for (let i = 0; i < TOOL_CALL_LOOP_THRESHOLD; i++) {
        fired = service.checkAlwaysOnSafeties(taskListEvent(`call-${i}`));
        if (fired) break;
        service.recordToolResult(
          { name: 'task_list', args: TASK_LIST_ARGS },
          taskListResult(unchanged),
        );
      }
      expect(fired).toBe(true);
      expect(service.getConsecutiveToolCallCount()).toBe(
        TOOL_CALL_LOOP_THRESHOLD,
      );
      expect(service.getLastLoopType()).toBe(
        LoopType.CONSECUTIVE_IDENTICAL_TOOL_CALLS,
      );
    });

    it('does not halt while the task board keeps changing between identical calls', () => {
      let fired = false;
      // Well past the argument-only threshold: every poll returns a changed
      // board (a peer completed/claimed a task between calls), which is the
      // productive polling pattern the team prompt encourages.
      for (let i = 0; i < 4 * TOOL_CALL_LOOP_THRESHOLD; i++) {
        fired = service.checkAlwaysOnSafeties(taskListEvent(`call-${i}`));
        if (fired) break;
        service.recordToolResult(
          { name: 'task_list', args: TASK_LIST_ARGS },
          taskListResult(`board state v${i}`),
        );
      }
      expect(fired).toBe(false);
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('keeps productive polling alive past the adaptive per-turn cap', () => {
      // With the default (adaptive) cap, a turn beyond the soft cap halts
      // only on a stuck-repetition signal. Changed results must not build
      // that signal, so polling continues past the soft cap.
      const defaultCapService = new LoopDetectionService(makeConfig());
      defaultCapService.reset('cap-prompt');
      let fired = false;
      for (let i = 0; i < DEFAULT_MAX_TOOL_CALLS_PER_TURN + 20; i++) {
        fired = defaultCapService.checkAlwaysOnSafeties(
          taskListEvent(`call-${i}`),
        );
        if (fired) break;
        defaultCapService.recordToolResult(
          { name: 'task_list', args: TASK_LIST_ARGS },
          taskListResult(`board state v${i}`),
        );
      }
      expect(fired).toBe(false);
    });

    it('does not accumulate an oscillating board toward the global-duplicate halt (heuristics on)', () => {
      // A board flipping between two byte-identical states returns a result
      // different from its predecessor on EVERY poll — changed-state
      // progress — even though each (call, result) pair recurs across the
      // turn. Turn-wide pair totals would reach the threshold here; the
      // consecutive identical-result count must not.
      const heuristicService = new LoopDetectionService(
        makeConfig(DEFAULT_MAX_TOOL_CALLS_PER_TURN, false, false),
      );
      heuristicService.reset('oscillating-global');
      let detected = false;
      for (let i = 0; i < 4 * GLOBAL_DUPLICATE_THRESHOLD && !detected; i++) {
        detected = heuristicService.addAndCheck(taskListEvent(`call-${i}`));
        if (detected) break;
        detected = heuristicService.recordToolResult(
          { name: 'task_list', args: TASK_LIST_ARGS },
          taskListResult(i % 2 === 0 ? 'board A' : 'board B'),
        );
      }
      expect(detected).toBe(false);
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('keeps an oscillating board alive past the adaptive cap (skipLoopDetection default)', () => {
      // CLI default (skipLoopDetection=true): the pair totals previously
      // fed capMaxKeyRepeat, so an oscillating board past the 100-call soft
      // cap was halted by the always-on adaptive cap. Every poll changing
      // the result must keep the stuck signal at bay instead.
      const defaultCapService = new LoopDetectionService(makeConfig());
      defaultCapService.reset('oscillating-cap');
      let fired = false;
      for (let i = 0; i < DEFAULT_MAX_TOOL_CALLS_PER_TURN + 20; i++) {
        fired = defaultCapService.checkAlwaysOnSafeties(
          taskListEvent(`call-${i}`),
        );
        if (fired) break;
        fired = defaultCapService.recordToolResult(
          { name: 'task_list', args: TASK_LIST_ARGS },
          taskListResult(i % 2 === 0 ? 'board A' : 'board B'),
        );
        if (fired) break;
      }
      expect(fired).toBe(false);
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('still halts an interleaved frozen board via the adaptive cap', () => {
      // The other direction under the CLI default: a genuinely frozen board
      // (same result on every poll) interleaved with other calls must still
      // build the stuck signal and trip the adaptive cap past the soft cap.
      const svc = new LoopDetectionService(makeConfig());
      svc.reset('frozen-cap');
      let fired = false;
      for (let i = 0; i < GLOBAL_DUPLICATE_THRESHOLD && !fired; i++) {
        fired = svc.checkAlwaysOnSafeties(
          createToolCallRequestEvent('filler', { i }),
        );
        if (fired) break;
        fired = svc.checkAlwaysOnSafeties(taskListEvent(`call-${i}`));
        if (fired) break;
        fired = svc.recordToolResult(
          { name: 'task_list', args: TASK_LIST_ARGS },
          taskListResult('frozen board'),
        );
      }
      expect(fired).toBe(false);
      // Diverse filler calls push the turn past the soft cap; the frozen
      // result streak (>= threshold) is the stuck signal that halts it.
      for (let i = 0; i < DEFAULT_MAX_TOOL_CALLS_PER_TURN + 20 && !fired; i++) {
        fired = svc.checkAlwaysOnSafeties(
          createToolCallRequestEvent('filler', { j: i }),
        );
      }
      expect(fired).toBe(true);
      expect(svc.getLastLoopType()).toBe(LoopType.TURN_TOOL_CALL_CAP);
    });

    describe('oversized (persisted) results fingerprint as stubs (issue #9450)', () => {
      // Results over the persistence threshold are rewritten into stubs
      // whose envelope embeds a per-call unique path. Hashing the envelope
      // verbatim would fingerprint uniquely every poll, silently disabling
      // every result-aware guard for exactly the largest results.
      const digestOf = (content: string): string =>
        createHash('sha256').update(content).digest('hex');

      const persistedStub = (
        boardState: string,
        opts: { digest?: string; path?: string } = {},
      ): string => {
        const digestLine =
          opts.digest !== undefined
            ? `\n${FULL_OUTPUT_DIGEST_LABEL}${opts.digest}`
            : '';
        return `<persisted-output>
Output too large (42 KB). Full output saved to: ${opts.path ?? '/tool-results/call-x.txt'}${digestLine}
Note: this file may be cleaned up after 24 hours.

Preview (up to 2000 chars):
${boardState}
</persisted-output>`;
      };

      const driveUntilFireOrEnd = (
        results: () => Part[],
        rounds: number,
      ): boolean => {
        let fired = false;
        for (let i = 0; i < rounds && !fired; i++) {
          fired = service.checkAlwaysOnSafeties(taskListEvent(`call-${i}`));
          if (fired) break;
          service.recordToolResult(
            { name: 'task_list', args: TASK_LIST_ARGS },
            results(),
          );
        }
        return fired;
      };

      it('halts a frozen oversized board despite per-call unique stub paths', () => {
        // Same frozen content persisted to a DIFFERENT per-call path each
        // poll: the envelope varies, the digest does not, so the guard must
        // still see five unchanged results and halt at the same threshold.
        let callCounter = 0;
        const fired = driveUntilFireOrEnd(() => {
          callCounter += 1;
          return taskListResult(
            persistedStub('frozen oversized board', {
              digest: digestOf('frozen oversized board'),
              path: `/tool-results/call-${callCounter}.txt`,
            }),
            `call-${callCounter}`,
          );
        }, 8);
        expect(fired).toBe(true);
        expect(service.getLastLoopType()).toBe(
          LoopType.CONSECUTIVE_IDENTICAL_TOOL_CALLS,
        );
      });

      it('keeps an oversized board alive when mutations land beyond the preview window', () => {
        // The preview covers only the first chars; the full-output digest is
        // what keeps the fingerprint sensitive to mutations past it.
        let version = 0;
        const fired = driveUntilFireOrEnd(() => {
          version += 1;
          const content = `board head\n${'x'.repeat(3000)}\ntail v${version}`;
          return taskListResult(
            persistedStub('board head', { digest: digestOf(content) }),
          );
        }, 4 * TOOL_CALL_LOOP_THRESHOLD);
        expect(fired).toBe(false);
      });

      it('falls back to the path-free preview for digest-less stubs', () => {
        // Stubs produced before the digest line existed: identical previews
        // in different envelopes must still collide (halt), changed previews
        // must not.
        let callCounter = 0;
        const frozen = driveUntilFireOrEnd(() => {
          callCounter += 1;
          return taskListResult(
            persistedStub('legacy frozen preview', {
              path: `/tool-results/legacy-${callCounter}.txt`,
            }),
            `call-${callCounter}`,
          );
        }, 8);
        expect(frozen).toBe(true);

        const svc = new LoopDetectionService(makeConfig());
        svc.reset('legacy-changed');
        let fired = false;
        for (let i = 0; i < 4 * TOOL_CALL_LOOP_THRESHOLD && !fired; i++) {
          fired = svc.checkAlwaysOnSafeties(taskListEvent(`call-${i}`));
          if (fired) break;
          fired = svc.recordToolResult(
            { name: 'task_list', args: TASK_LIST_ARGS },
            taskListResult(
              persistedStub(`legacy preview v${i}`, {
                path: `/tool-results/legacy-${i}.txt`,
              }),
            ),
          );
        }
        expect(fired).toBe(false);
      });

      it('fingerprints quoted stub markers mid-content as ordinary text', () => {
        // Board content can QUOTE a stub (label + hex); only LEADING
        // producer shapes are stubs, so two boards differing only in quoted
        // content must still count as changed.
        const quoted = (hex: string) =>
          `peer said:\n${FULL_OUTPUT_DIGEST_LABEL}${hex}\nend`;
        let fired = false;
        for (let i = 0; i < 4 * TOOL_CALL_LOOP_THRESHOLD && !fired; i++) {
          fired = service.checkAlwaysOnSafeties(taskListEvent(`call-${i}`));
          if (fired) break;
          fired = service.recordToolResult(
            { name: 'task_list', args: TASK_LIST_ARGS },
            taskListResult(quoted(digestOf(`content ${i}`))),
          );
        }
        expect(fired).toBe(false);
      });
    });

    it('restarts the streak when a result changed, then halts on a fresh unchanged streak', () => {
      const args = TASK_LIST_ARGS;
      // R1..R4: the board changes once mid-streak (v2), so R5 must NOT halt.
      const states = ['v1', 'v1', 'v2', 'v1'];
      for (let i = 0; i < 4; i++) {
        expect(service.checkAlwaysOnSafeties(taskListEvent(`call-${i}`))).toBe(
          false,
        );
        service.recordToolResult(
          { name: 'task_list', args },
          taskListResult(states[i]),
        );
      }
      expect(service.checkAlwaysOnSafeties(taskListEvent('call-4'))).toBe(
        false,
      );
      service.recordToolResult(
        { name: 'task_list', args },
        taskListResult('v1'),
      );

      // The streak restarted at call-4 (the reset made it request #1 of the
      // new streak): call-5..call-7 stay below the threshold, and their
      // unchanged results corroborate the loop, so call-8 — the 5th request
      // of the restarted streak — halts.
      for (let i = 5; i <= 7; i++) {
        expect(service.checkAlwaysOnSafeties(taskListEvent(`call-${i}`))).toBe(
          false,
        );
        service.recordToolResult(
          { name: 'task_list', args },
          taskListResult('v1'),
        );
      }
      expect(service.checkAlwaysOnSafeties(taskListEvent('call-8'))).toBe(true);
      expect(service.getLastLoopType()).toBe(
        LoopType.CONSECUTIVE_IDENTICAL_TOOL_CALLS,
      );
    });

    it('does not change behavior for deterministic (non-stateful) tools', () => {
      const event = createToolCallRequestEvent('read_file', {
        file_path: '/a',
      });
      for (let i = 0; i < TOOL_CALL_LOOP_THRESHOLD - 1; i++) {
        service.checkAlwaysOnSafeties(event);
        // Results are recorded but ignored for non-stateful tools: identical
        // args still mean an identical result, so the argument-only guard
        // must fire unchanged.
        service.recordToolResult(
          { name: 'read_file', args: { file_path: '/a' } },
          [
            {
              functionResponse: {
                id: `call-${i}`,
                name: 'read_file',
                response: { output: `content v${i}` },
              },
            },
          ],
        );
      }
      expect(service.checkAlwaysOnSafeties(event)).toBe(true);
      expect(service.getLastLoopType()).toBe(
        LoopType.CONSECUTIVE_IDENTICAL_TOOL_CALLS,
      );
    });

    it('records results by callId pairing from ToolCallRequest events', () => {
      for (let i = 0; i < TOOL_CALL_LOOP_THRESHOLD - 1; i++) {
        expect(service.checkAlwaysOnSafeties(taskListEvent(`call-${i}`))).toBe(
          false,
        );
        expect(
          service.recordToolResultByCallId(
            `call-${i}`,
            taskListResult(`board state v${i}`, `call-${i}`),
          ),
        ).toBe(false);
      }
      // Changed results arrived through the callId pairing, so the
      // threshold-th identical request is accepted.
      expect(
        service.checkAlwaysOnSafeties(
          taskListEvent(`call-${TOOL_CALL_LOOP_THRESHOLD - 1}`),
        ),
      ).toBe(false);
      // Unknown callIds (never streamed through this service) are ignored.
      expect(
        service.recordToolResultByCallId('never-seen', taskListResult('x')),
      ).toBe(false);
    });

    it('counts global duplicates on (call, result) pairs when heuristics run', () => {
      const heuristicService = new LoopDetectionService(
        makeConfig(DEFAULT_MAX_TOOL_CALLS_PER_TURN, false, false),
      );
      heuristicService.reset('global-dup');

      // Identical task_list calls whose results CHANGE never reach the
      // global-duplicate threshold, no matter how they are interleaved.
      const interleaved = ['task_list', 'tool_b', 'tool_c'];
      let stateOrdinal = 0;
      for (let round = 0; round < 3; round++) {
        for (const name of interleaved) {
          const args = name === 'task_list' ? TASK_LIST_ARGS : { step: round };
          expect(
            heuristicService.addAndCheck(
              createToolCallRequestEvent(name, args),
            ),
          ).toBe(false);
          if (name === 'task_list') {
            expect(
              heuristicService.recordToolResult(
                { name, args },
                taskListResult(`state-${stateOrdinal++}`),
              ),
            ).toBe(false);
          }
        }
      }

      // A genuinely stuck poll — same call, SAME result, interleaved so the
      // consecutive guard never fires — trips the result-aware global
      // duplicate at the threshold.
      const stuckService = new LoopDetectionService(
        makeConfig(DEFAULT_MAX_TOOL_CALLS_PER_TURN, false, false),
      );
      stuckService.reset('global-dup-stuck');
      let detected = false;
      for (
        let round = 0;
        round < GLOBAL_DUPLICATE_THRESHOLD && !detected;
        round++
      ) {
        for (const name of interleaved) {
          const args = name === 'task_list' ? TASK_LIST_ARGS : { step: round };
          if (
            stuckService.addAndCheck(createToolCallRequestEvent(name, args))
          ) {
            detected = true;
            break;
          }
          if (name === 'task_list') {
            detected = stuckService.recordToolResult(
              { name, args },
              taskListResult('frozen board'),
            );
            if (detected) break;
          }
        }
      }
      expect(detected).toBe(true);
      expect(stuckService.getLastLoopType()).toBe(
        LoopType.GLOBAL_TOOL_CALL_DUPLICATE,
      );
    });

    it('treats changed results as progress for action stagnation', () => {
      const heuristicService = new LoopDetectionService(
        makeConfig(DEFAULT_MAX_TOOL_CALLS_PER_TURN, false, false),
      );
      heuristicService.reset('stagnation');

      // 8+ same-name task_list calls with VARYING args (the consecutive
      // guard never fires) and CHANGING results: productive polling, no
      // ACTION_STAGNATION halt.
      for (let i = 0; i < 12; i++) {
        const args = { owner: `peer-${i % 3}` };
        expect(
          heuristicService.addAndCheck(
            createToolCallRequestEvent('task_list', args),
          ),
        ).toBe(false);
        expect(
          heuristicService.recordToolResult(
            { name: 'task_list', args },
            taskListResult(`state v${i}`),
          ),
        ).toBe(false);
      }

      // Same shape but the board is FROZEN: the same-name streak is not
      // reset and stagnation fires.
      const frozenService = new LoopDetectionService(
        makeConfig(DEFAULT_MAX_TOOL_CALLS_PER_TURN, false, false),
      );
      frozenService.reset('stagnation-frozen');
      let fired = false;
      for (let i = 0; i < 12; i++) {
        const args = { owner: `peer-${i % 3}` };
        fired = frozenService.addAndCheck(
          createToolCallRequestEvent('task_list', args),
        );
        if (fired) break;
        frozenService.recordToolResult(
          { name: 'task_list', args },
          taskListResult('frozen board'),
        );
      }
      expect(fired).toBe(true);
      expect(frozenService.getLastLoopType()).toBe(LoopType.ACTION_STAGNATION);
    });

    it('resets result evidence on retry so a replay is judged on its own results', () => {
      const unchanged = '#1 [in_progress] @peer-a — task';
      for (let i = 0; i < TOOL_CALL_LOOP_THRESHOLD - 1; i++) {
        service.checkAlwaysOnSafeties(taskListEvent(`call-${i}`));
        service.recordToolResult(
          { name: 'task_list', args: TASK_LIST_ARGS },
          taskListResult(unchanged),
        );
      }
      expect(
        service.checkAlwaysOnSafeties({
          type: LlmEventType.Retry,
        } as ServerLlmStreamEvent),
      ).toBe(false);

      // After the retry the replayed attempt starts with fresh evidence:
      // four unchanged results are not yet enough to halt.
      for (let i = 0; i < TOOL_CALL_LOOP_THRESHOLD - 1; i++) {
        expect(
          service.checkAlwaysOnSafeties(taskListEvent(`replay-${i}`)),
        ).toBe(false);
        service.recordToolResult(
          { name: 'task_list', args: TASK_LIST_ARGS },
          taskListResult(unchanged),
        );
      }
      expect(service.checkAlwaysOnSafeties(taskListEvent('replay-4'))).toBe(
        true,
      );
    });

    it('clears stateful tracking on reset()', () => {
      const unchanged = '#1 [in_progress] @peer-a — task';
      service.checkAlwaysOnSafeties(taskListEvent('call-0'));
      service.recordToolResult(
        { name: 'task_list', args: TASK_LIST_ARGS },
        taskListResult(unchanged),
      );
      service.reset('fresh-prompt');

      // Changed results in the fresh prompt must not be compared against
      // the previous prompt's fingerprint.
      let fired = false;
      for (let i = 0; i < 4 * TOOL_CALL_LOOP_THRESHOLD; i++) {
        fired = service.checkAlwaysOnSafeties(taskListEvent(`call-${i}`));
        if (fired) break;
        service.recordToolResult(
          { name: 'task_list', args: TASK_LIST_ARGS },
          taskListResult(`fresh v${i}`),
        );
      }
      expect(fired).toBe(false);
    });
  });

  describe('Repeated tool-error detection (issue #10887)', () => {
    // Dead-end sessions kept burning millions of tokens re-running failing
    // operations: every (tool, args) pair unique (the model varies the
    // retry), interleaved successful reads between failures, and the same
    // error returning on every call. No argument-based repetition signal
    // ever accumulates, so only the repeated error payload is evidence.
    // Mirrored from loopDetectionService.ts.
    const REPEATED_TOOL_ERROR_THRESHOLD = 3;

    const errorResult = (errorMessage: string, callId = 'call-err'): Part[] => [
      {
        functionResponse: {
          id: callId,
          name: 'run_shell_command',
          response: { error: errorMessage },
        },
      },
    ];

    const successResult = (output: string, callId = 'call-ok'): Part[] => [
      {
        functionResponse: {
          id: callId,
          name: 'read_file',
          response: { output },
        },
      },
    ];

    it('halts when the same error keeps returning across distinct calls with interleaved successes', () => {
      const gitError =
        'fatal: not a git repository (or any of the parent directories): .git';
      let fired = false;
      for (let i = 0; i < 10 && !fired; i++) {
        // A successful read between failing calls must not mask the streak
        // (interleaved reads are what let the reported loops slip past the
        // stagnation detectors).
        expect(
          service.recordToolResult(
            { name: 'read_file', args: { file_path: `f${i}.ts` } },
            successResult(`content ${i}`, `ok-${i}`),
          ),
        ).toBe(false);
        fired = service.recordToolResult(
          {
            name: 'run_shell_command',
            args: { command: `git remote -v attempt-${i}` },
          },
          errorResult(gitError, `err-${i}`),
        );
        if (i < REPEATED_TOOL_ERROR_THRESHOLD - 1) {
          expect(fired).toBe(false);
        }
      }
      expect(fired).toBe(true);
      expect(service.getLastLoopType()).toBe(LoopType.REPEATED_TOOL_ERROR);
    });

    it('fires from recordToolResultByCallId for calls this service never streamed', () => {
      // client.ts records every functionResponse by callId, including calls
      // the service never paired at request time.
      const permDenied = 'bash: /usr/bin/foo: Permission denied';
      for (let i = 0; i < REPEATED_TOOL_ERROR_THRESHOLD - 1; i++) {
        expect(
          service.recordToolResultByCallId(
            `unknown-${i}`,
            errorResult(permDenied, `unknown-${i}`),
          ),
        ).toBe(false);
      }
      expect(
        service.recordToolResultByCallId(
          `unknown-${REPEATED_TOOL_ERROR_THRESHOLD}`,
          errorResult(permDenied, `unknown-${REPEATED_TOOL_ERROR_THRESHOLD}`),
        ),
      ).toBe(true);
      expect(service.getLastLoopType()).toBe(LoopType.REPEATED_TOOL_ERROR);
    });

    it('does not halt below the threshold and restarts the streak on a different error', () => {
      const errA = 'fatal: not a git repository';
      const errB = 'npm ERR! code E404';
      const call = (command: string) => ({
        name: 'run_shell_command',
        args: { command },
      });
      expect(service.recordToolResult(call('a1'), errorResult(errA))).toBe(
        false,
      );
      expect(service.recordToolResult(call('a2'), errorResult(errA))).toBe(
        false,
      );
      // A different error signature restarts the streak...
      expect(service.recordToolResult(call('b1'), errorResult(errB))).toBe(
        false,
      );
      expect(service.recordToolResult(call('a3'), errorResult(errA))).toBe(
        false,
      );
      expect(service.recordToolResult(call('a4'), errorResult(errA))).toBe(
        false,
      );
      expect(service.getLastLoopType()).toBeNull();
    });

    it('clears the error streak on reset()', () => {
      const err = 'fatal: not a git repository';
      const call = (command: string) => ({
        name: 'run_shell_command',
        args: { command },
      });
      service.recordToolResult(call('a1'), errorResult(err));
      service.recordToolResult(call('a2'), errorResult(err));
      service.reset('fresh-prompt');
      expect(service.recordToolResult(call('a3'), errorResult(err))).toBe(
        false,
      );
      expect(service.recordToolResult(call('a4'), errorResult(err))).toBe(
        false,
      );
      expect(service.getLastLoopType()).toBeNull();
    });

    it('honors an explicit in-session disable', () => {
      service.disableForSession();
      const err = 'fatal: not a git repository';
      for (let i = 0; i <= REPEATED_TOOL_ERROR_THRESHOLD; i++) {
        expect(
          service.recordToolResult(
            { name: 'run_shell_command', args: { command: `c${i}` } },
            errorResult(err),
          ),
        ).toBe(false);
      }
      expect(service.getLastLoopType()).toBeNull();
    });
  });
});
