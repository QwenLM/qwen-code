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
import { ToolNames } from '../tools/tool-names.js';
import {
  DEFAULT_MAX_TOOL_CALLS_PER_TURN,
  LoopDetectionService,
} from './loopDetectionService.js';
import { fnResponse } from '../test-utils/model-fixtures.js';

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

// Streaming delta size; it does not divide the chant units below, so no two
// adjacent deltas are identical, matching real token-stream chunking.
const DELTA = 17;
// The ~300-char analysis block chanted verbatim in issue #1775.
const CHANT =
  'The issue might be that the API call is not being made properly ' +
  'when the switch is toggled. Let me make sure the fetchPublicRecipes ' +
  'function is called correctly with the right parameters. The issue ' +
  'might be that the API call is not being made with the correct ' +
  'parameters when the switch is toggled.';

// Deterministic pseudo-random non-repetitive text (LCG over a word list): no
// repeated 50-gram inside one attempt, so a single streamed attempt — or a
// replayed one after a reset — can never fire on its own.
const WORDS = (
  'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo ' +
  'lima mike november oscar papa quebec romeo sierra tango'
).split(' ');
const variedText = (len: number, seed: number): string => {
  let out = '';
  let x = seed + 1;
  while (out.length < len) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out += WORDS[x % WORDS.length] + String(x % 97) + ' ';
  }
  return out.slice(0, len);
};

// `n` distinct "Step i" sentences: a long, varied stream.
const stepsText = (n: number): string =>
  Array.from(
    { length: n },
    (_, i) => `Step ${i}: consider aspect ${i * 7 + 3} of the problem. `,
  ).join('');

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

  const toolCall = (
    name: string,
    args: Record<string, unknown>,
    callId = 'test-id',
  ): ServerLlmToolCallRequestEvent => ({
    type: LlmEventType.ToolCallRequest,
    value: {
      name,
      args,
      callId,
      isClientInitiated: false,
      prompt_id: 'test-prompt-id',
    },
  });

  const contentEvent = (value: string): ServerLlmContentEvent => ({
    type: LlmEventType.Content,
    value,
  });

  const thoughtEvent = (
    subject: string,
    description = '',
  ): ServerLlmThoughtEvent => ({
    type: LlmEventType.Thought,
    value: { subject, description },
  });

  const RETRY: ServerLlmRetryEvent = { type: LlmEventType.Retry };

  const createRepetitiveContent = (id: number, length: number): string => {
    const base = `This is a unique sentence, id=${id}. `;
    return base.repeat(Math.ceil(length / base.length)).slice(0, length);
  };
  const REPEATED = createRepetitiveContent(1, CONTENT_CHUNK_SIZE);

  // Thin wrappers over the service; they read `service` at call time.
  const add = (event: ServerLlmStreamEvent) => service.addAndCheck(event);
  const addText = (text: string) => add(contentEvent(text));
  const addThought = (subject: string, description: string) =>
    add(thoughtEvent(subject, description));
  const addTool = (name: string, args: Record<string, unknown>) =>
    add(toolCall(name, args));
  const guard = (event: ServerLlmStreamEvent, svc = service) =>
    svc.checkAlwaysOnSafeties(event);
  const guardTool = (
    name: string,
    args: Record<string, unknown>,
    svc = service,
  ) => guard(toolCall(name, args), svc);
  const heur = (event: ServerLlmStreamEvent) =>
    service.addAndCheckHeuristicLoops(event);
  const newService = (config: Config, promptId = '') => {
    const svc = new LoopDetectionService(config);
    svc.reset(promptId);
    return svc;
  };

  // Calls fn(i) for each i < n and returns the last result.
  const run = (n: number, fn: (i: number) => boolean): boolean => {
    let last = false;
    for (let i = 0; i < n; i++) last = fn(i);
    return last;
  };
  // Calls fn(i) for i < n, stopping at the first call that fires.
  const fires = (n: number, fn: (i: number) => boolean): boolean => {
    for (let i = 0; i < n; i++) if (fn(i)) return true;
    return false;
  };
  // One expect per call: fn(i) must not fire for any i < n.
  const expectNone = (n: number, fn: (i: number) => boolean) => {
    for (let i = 0; i < n; i++) expect(fn(i)).toBe(false);
  };
  const feed = (text: string, times: number) => run(times, () => addText(text));
  const feedQuiet = (text: string, times: number) =>
    expectNone(times, () => addText(text));

  // Streams `text` as `delta`-sized events until the detector fires.
  const streamWith =
    (toEvent: (piece: string) => ServerLlmStreamEvent) =>
    (text: string, delta = DELTA): boolean =>
      fires(Math.ceil(text.length / delta), (i) =>
        add(toEvent(text.slice(i * delta, (i + 1) * delta))),
      );
  const streamThoughts = streamWith((piece) => thoughtEvent('', piece));
  const streamContent = streamWith(contentEvent);

  const expectFired = (fired: boolean, type: LoopType, svc = service) => {
    expect(fired).toBe(true);
    expect(svc.getLastLoopType()).toBe(type);
  };
  const expectType = (type: LoopType) =>
    expect(service.getLastLoopType()).toBe(type);
  const expectLogged = (type: string, config: Config = mockConfig) =>
    expect(loggers.logLoopDetected).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ loop_type: type }),
    );
  const expectNotLogged = (type: string) =>
    expect(loggers.logLoopDetected).not.toHaveBeenCalledWith(
      mockConfig,
      expect.objectContaining({ loop_type: type }),
    );

  describe('Tool Call Loop Detection', () => {
    it(`should not detect a loop for fewer than TOOL_CALL_LOOP_THRESHOLD identical calls`, () => {
      const event = toolCall('testTool', { param: 'value' });
      expectNone(TOOL_CALL_LOOP_THRESHOLD - 1, () => add(event));
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it(`should detect a loop on the TOOL_CALL_LOOP_THRESHOLD-th identical call`, () => {
      const event = toolCall('testTool', { param: 'value' });
      run(TOOL_CALL_LOOP_THRESHOLD - 1, () => add(event));
      expect(add(event)).toBe(true);
      expect(loggers.logLoopDetected).toHaveBeenCalledTimes(1);
    });

    it('should detect a loop on subsequent identical calls', () => {
      const event = toolCall('testTool', { param: 'value' });
      run(TOOL_CALL_LOOP_THRESHOLD, () => add(event));
      expect(add(event)).toBe(true);
      expect(loggers.logLoopDetected).toHaveBeenCalledTimes(1);
    });

    it('should not detect a loop for different tool calls', () => {
      const event1 = toolCall('testTool', { param: 'value1' });
      const event2 = toolCall('testTool', { param: 'value2' });
      const event3 = toolCall('anotherTool', { param: 'value1' });
      for (let i = 0; i < TOOL_CALL_LOOP_THRESHOLD - 2; i++) {
        expect(add(event1)).toBe(false);
        expect(add(event2)).toBe(false);
        expect(add(event3)).toBe(false);
      }
    });

    it('should not reset tool call counter for other event types', () => {
      const toolCallEvent = toolCall('testTool', { param: 'value' });
      const otherEvent = {
        type: LlmEventType.UserCancelled,
      } as unknown as ServerLlmStreamEvent;
      // Just below the threshold, then a different event type, then the
      // tool call again, which should now trigger the loop.
      expectNone(TOOL_CALL_LOOP_THRESHOLD - 1, () => add(toolCallEvent));
      expect(add(otherEvent)).toBe(false);
      expect(add(toolCallEvent)).toBe(true);
      expect(loggers.logLoopDetected).toHaveBeenCalledTimes(1);
    });

    it('resets the consecutive tool-call counter on retry', () => {
      const event = toolCall('testTool', { param: 'value' });
      expectNone(TOOL_CALL_LOOP_THRESHOLD - 1, () => guard(event));
      expect(guard(RETRY)).toBe(false);
      expectNone(TOOL_CALL_LOOP_THRESHOLD - 1, () => guard(event));
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('should expose the current consecutive tool-call count', () => {
      const event = toolCall('testTool', { param: 'value' });
      run(TOOL_CALL_LOOP_THRESHOLD - 1, () => guard(event));
      expect(service.getConsecutiveToolCallCount()).toBe(
        TOOL_CALL_LOOP_THRESHOLD - 1,
      );
      expect(guard(event)).toBe(true);
      expect(service.getConsecutiveToolCallCount()).toBe(
        TOOL_CALL_LOOP_THRESHOLD,
      );
    });

    it('halts consecutive identical calls via the always-on guard', () => {
      // The consecutive guard lives in checkAlwaysOnSafeties, so it fires
      // regardless of the skipLoopDetection gate (which only gates the
      // heuristic path at the client layer).
      const event = toolCall('stuck_tool', { p: 'same' });
      expectNone(TOOL_CALL_LOOP_THRESHOLD - 1, () => guard(event));
      expect(guard(event)).toBe(true);
      expectType(LoopType.CONSECUTIVE_IDENTICAL_TOOL_CALLS);
      expectLogged('consecutive_identical_tool_calls');
    });

    it('treats reordered argument fields as identical for the consecutive guard', () => {
      // canonicalizeForHash makes this always-on guard (not just the adaptive
      // cap) see reordered keys as the same call, so a stuck model cannot
      // evade it by reordering them.
      const fired = fires(TOOL_CALL_LOOP_THRESHOLD, (i) =>
        guardTool('stuck_tool', i % 2 === 0 ? { a: 1, b: 2 } : { b: 2, a: 1 }),
      );
      expectFired(fired, LoopType.CONSECUTIVE_IDENTICAL_TOOL_CALLS);
    });

    it('always-on consecutive guard honors an in-session disable', () => {
      service.disableForSession();
      const event = toolCall('stuck_tool', { p: 'same' });
      // Well past the threshold, but an explicit in-session disable suppresses
      // the consecutive guard (unlike the per-turn cap, which is unconditional).
      expectNone(TOOL_CALL_LOOP_THRESHOLD + 2, () => guard(event));
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('should not detect a loop when disabled for session', () => {
      service.disableForSession();
      expect(loggers.logLoopDetectionDisabled).toHaveBeenCalledTimes(1);
      const event = toolCall('testTool', { param: 'value' });
      expectNone(TOOL_CALL_LOOP_THRESHOLD, () => add(event));
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });
  });

  describe('Shell Command Stagnation (Always-On Circuit Breaker)', () => {
    const SHELL = LoopType.SHELL_COMMAND_STAGNATION;
    const shell = (
      command: string,
      description = 'Inspect repository changes',
    ) => guardTool('run_shell_command', { command, description });
    // Distinct command text, so the consecutive-identical guard (threshold 5)
    // never fires and only the shell-stagnation bucket accumulates.
    const VARIANTS = [
      'git status --short',
      'git diff --stat',
      'git ls-files --modified',
      'git status --porcelain=v1',
      'git diff --name-only HEAD',
      'git -C . status --short',
      'git --no-pager diff --stat',
    ];
    const inspectAll = (commands: string[]) =>
      expectNone(commands.length, (i) => shell(commands[i]));
    const expectHaltOnLast = (commands: string[]) => {
      inspectAll(commands.slice(0, -1));
      expect(shell(commands[commands.length - 1])).toBe(true);
      expect(service.getLastLoopType()).toBe(SHELL);
    };
    const expectNeverHalts = (
      n: number,
      description: string,
      command: (i: number) => string,
    ) => {
      expectNone(n, (i) => shell(command(i), description));
      expect(service.getLastLoopType()).not.toBe(SHELL);
    };

    it('halts repeated git inspection command variants via the always-on guard', () => {
      expectHaltOnLast([
        'git status --short',
        'git status --short && git diff --stat',
        'git diff --name-only HEAD',
        'git status --porcelain=v1',
        'git diff --stat HEAD',
        'git -C . status --short',
        'git --no-pager diff --stat',
        'git ls-files --modified',
      ]);
      expectLogged('shell_command_stagnation');
    });

    it('resets the streak when a non-inspection tool call interrupts the run', () => {
      const gitInspect = (i: number) => shell(VARIANTS[i % VARIANTS.length]);
      // One short of the threshold, so the next inspection alone would trip.
      expectNone(SHELL_COMMAND_STAGNATION_THRESHOLD - 1, gitInspect);
      // A non-inspection tool call must reset the streak to zero.
      expect(guardTool('read_file', { absolute_path: '/repo/README.md' })).toBe(
        false,
      );
      // Counting restarts from zero: a full threshold-minus-one run of git
      // inspections still does not trip, proving the streak did not carry over.
      expectNone(SHELL_COMMAND_STAGNATION_THRESHOLD - 1, gitInspect);
      expect(service.getLastLoopType()).not.toBe(SHELL);
    });

    it('resets the streak when a retry replays shell inspections', () => {
      inspectAll(VARIANTS);
      expect(guard(RETRY)).toBe(false);
      inspectAll(VARIANTS);
      expect(service.getLastLoopType()).not.toBe(SHELL);
    });

    it('honors an in-session disable for shell inspection stagnation', () => {
      service.disableForSession();
      inspectAll([...VARIANTS, 'git ls-files --others']);
      expectNotLogged('shell_command_stagnation');
    });

    it('does not bucket compound commands that also write to the repository', () => {
      // Each chain stages and commits real work; the embedded `git status` must
      // not classify the whole command as stagnant read-only inspection. The
      // varying path keeps the consecutive-identical guard from firing.
      expectNeverHalts(
        SHELL_COMMAND_STAGNATION_THRESHOLD,
        'Stage, inspect, and commit progress',
        (i) =>
          `git add file-${i}.txt && git status --short && git commit -m progress-${i}`,
      );
    });

    it('does not bucket shell chains that include non-git commands', () => {
      expectNeverHalts(
        SHELL_COMMAND_STAGNATION_THRESHOLD,
        'Inspect repository changes and run tests',
        (i) => `git status --short && npm test -- --runInBand=${i}`,
      );
    });

    it('does not halt repeated non-git shell commands', () => {
      expectNeverHalts(
        SHELL_COMMAND_STAGNATION_THRESHOLD + 2,
        'Run tests',
        (i) => `npm test -- --runInBand=${i}`,
      );
    });

    it('halts newline-separated git inspection command variants', () => {
      expectHaltOnLast([
        'git diff --stat\ngit status --short',
        'git diff --name-only HEAD\ngit ls-files --modified',
        'git --no-pager diff --stat\ngit status --porcelain=v1',
        'git diff --stat HEAD\ngit ls-files --others',
        'git diff --name-only\ngit status --short',
        'git diff --stat\ngit -C . status --short',
        'git --no-pager diff --stat\ngit ls-files --modified',
        'git diff --name-only HEAD\ngit status --short',
      ]);
    });

    it.each([
      ['does not halt file-specific git diff review commands', 'git diff -- '],
      [
        'does not halt file-specific git diff review commands without -- separator',
        'git diff ',
      ],
    ])('%s', (_title, diff) => {
      inspectAll([
        'git status --short',
        'git diff --stat',
        ...['a', 'b', 'c', 'd', 'e', 'f'].map((f) => `${diff}src/${f}.ts`),
      ]);
      expectNotLogged('shell_command_stagnation');
    });
  });

  describe('Content Loop Detection', () => {
    const CHARACTERS =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const generateRandomString = (length: number) => {
      let result = '';
      for (let i = 0; i < length; i++) {
        result += CHARACTERS[Math.floor(Math.random() * CHARACTERS.length)];
      }
      return result;
    };

    it('should not detect a loop for random content', () => {
      service.reset('');
      expectNone(1000, () => addText(generateRandomString(10)));
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('should detect a loop when a chunk of content repeats consecutively', () => {
      service.reset('');
      expect(feed(REPEATED, CONTENT_LOOP_THRESHOLD)).toBe(true);
      expect(loggers.logLoopDetected).toHaveBeenCalledTimes(1);
    });

    it('should not detect a loop if repetitions are very far apart', () => {
      service.reset('');
      // A fresh filler each cycle: repetitions separated by VARYING content
      // are not a loop. (Reusing one identical filler made the whole stream
      // byte-periodic, which the long-period rule for issue #1775 correctly
      // treats as a chant.)
      const isLoop = run(CONTENT_LOOP_THRESHOLD, () => {
        addText(REPEATED);
        return addText(generateRandomString(500));
      });
      expect(isLoop).toBe(false);
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });
  });

  describe('Content element detection', () => {
    // A list item resets tracking so a long list is not mistaken for a loop.
    // `-` is the most common bullet in markdown, and it used to be the one
    // marker the check could not see.
    it.each([['-'], ['*'], ['+']])(
      'should treat "%s" as a list item and not report a loop',
      (marker) => {
        service.reset('');
        expect(
          feed(`${marker} ${REPEATED}\n`, CONTENT_LOOP_THRESHOLD * 2),
        ).toBe(false);
        expect(loggers.logLoopDetected).not.toHaveBeenCalled();
      },
    );

    it('should still report a loop for repeated non-list content', () => {
      service.reset('');
      expect(feed(`${REPEATED}\n`, CONTENT_LOOP_THRESHOLD)).toBe(true);
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
    // Inside an open fence nothing is a loop, including the closing fence.
    const expectQuietInBlock = (text: string, times: number) => {
      service.reset('');
      addText('```\n');
      feedQuiet(text, times);
      expect(addText('\n```')).toBe(false);
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    };
    // After a closed code block, repeated prose is detected again.
    const expectLoopAfterBlock = (code: string) => {
      service.reset('');
      addText('```');
      addText(code);
      addText('```');
      expect(feed(REPEATED, CONTENT_LOOP_THRESHOLD)).toBe(true);
      expect(loggers.logLoopDetected).toHaveBeenCalledTimes(1);
    };
    // One short of the threshold, then `marker` resets tracking, so the same
    // content afterwards does not trigger a loop.
    const expectResetBy = (marker: string, after: number) => {
      service.reset('');
      feed(REPEATED, CONTENT_LOOP_THRESHOLD - 1);
      addText(marker);
      feedQuiet(REPEATED, after);
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    };

    it('should not detect a loop when repetitive content is inside a code block', () => {
      expectQuietInBlock(REPEATED, CONTENT_LOOP_THRESHOLD);
    });

    it('should not detect loops when content transitions into a code block', () => {
      service.reset('');
      // Repetitive content outside of a code block, then a transition into
      // one: this prevents detection even though we were already close to the
      // threshold, and repetitive content inside the block does not trigger.
      feed(REPEATED, CONTENT_LOOP_THRESHOLD - 2);
      expect(addText('```javascript\n')).toBe(false);
      feedQuiet(REPEATED, CONTENT_LOOP_THRESHOLD);
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('should skip loop detection when already inside a code block (this.inCodeBlock)', () => {
      service.reset('');
      // Content that leaves us inside a code block: any content after it is
      // ignored for loop detection.
      addText('Here is some code:\n```\n');
      feedQuiet(REPEATED, CONTENT_LOOP_THRESHOLD + 5);
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('should correctly track inCodeBlock state with multiple fence transitions', () => {
      service.reset('');
      addText('Normal text '); // outside a code block: tracked
      expect(addText('```\n')).toBe(false); // 1st fence enters: tracking stops
      feedQuiet(REPEATED, 5); // inside a code block: no loops
      // 2nd fence exits (resets tracking, still false); 3rd re-enters.
      expect(addText('```\n')).toBe(false);
      expect(addText('```python\n')).toBe(false);
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('should detect a loop when repetitive content is outside a code block', () => {
      expectLoopAfterBlock('\nsome code\n');
    });

    it('should handle content with multiple code blocks and no loops', () => {
      service.reset('');
      addText('```\ncode1\n```');
      addText('\nsome text\n');
      expect(addText('```\ncode2\n```')).toBe(false);
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('should handle content with mixed code blocks and looping text', () => {
      expectLoopAfterBlock('\ncode1\n');
    });

    it('should not detect a loop for a long code block with some repeating tokens', () => {
      expectQuietInBlock(
        'for (let i = 0; i < 10; i++) { console.log(i); }',
        20,
      );
    });

    it('should reset tracking when a code fence is found', () => {
      // The fence also enters a code block, where loop detection is off.
      expectResetBy('```', CONTENT_LOOP_THRESHOLD);
    });

    it.each([
      ['a table', '| Column 1 | Column 2 |'],
      ['a list item', '* List item'],
      ['a heading', '## Heading'],
      ['a blockquote', '> Quote text'],
    ])('should reset tracking when %s is detected', (_kind, marker) => {
      expectResetBy(marker, CONTENT_LOOP_THRESHOLD - 1);
    });

    it.each([
      [
        'should reset tracking for various list item formats',
        100,
        [
          '* Bullet item',
          '- Dash item',
          '+ Plus item',
          '1. Numbered item',
          '42. Another numbered item',
        ],
      ],
      [
        'should reset tracking for various table formats',
        200,
        ['| Column 1 | Column 2 |', '|---|---|', '|++|++|', '+---+---+'],
      ],
      [
        'should reset tracking for various heading levels',
        300,
        [1, 2, 3, 4, 5, 6].map((n) => `${'#'.repeat(n)} H${n} Heading`),
      ],
    ])('%s', (_title, idBase, formats) => {
      formats.forEach((format, index) => {
        service.reset('');
        // Near the threshold, then the marker at the start of a fresh line
        // resets tracking. Different content afterwards avoids any cached
        // state issues.
        feed(REPEATED, CONTENT_LOOP_THRESHOLD - 1);
        addText('\n' + format);
        feedQuiet(
          createRepetitiveContent(index + idBase, CONTENT_CHUNK_SIZE),
          CONTENT_LOOP_THRESHOLD - 1,
        );
      });
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty content', () => {
      expect(addText('')).toBe(false);
    });
  });

  describe('Divider Content Detection', () => {
    it('should not detect a loop for repeating divider-like content', () => {
      service.reset('');
      feedQuiet('-'.repeat(CONTENT_CHUNK_SIZE), CONTENT_LOOP_THRESHOLD + 5);
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('should not detect a loop for repeating complex box-drawing dividers', () => {
      service.reset('');
      feedQuiet(
        '╭─'.repeat(CONTENT_CHUNK_SIZE / 2),
        CONTENT_LOOP_THRESHOLD + 5,
      );
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });
  });

  describe('Reset Functionality', () => {
    it('tool call should reset content count', () => {
      feed('Some content.', 9);
      addTool('testTool', { param: 'value' });
      // Should start fresh
      expect(addText('Fresh content.')).toBe(false);
    });
  });

  describe('General Behavior', () => {
    it('should return false for unhandled event types', () => {
      const otherEvent = {
        type: 'unhandled_event',
      } as unknown as ServerLlmStreamEvent;
      expect(add(otherEvent)).toBe(false);
      expect(add(otherEvent)).toBe(false);
    });
  });

  describe('Repetitive Thoughts Detection', () => {
    it('should detect repetitive thoughts pattern', () => {
      service.reset('');
      run(3, () => addThought('Plan', 'Inspect the migration script.'));
      expectLogged('repetitive_thoughts');
    });

    it('should not detect loop with varied thoughts', () => {
      service.reset('');
      addThought('Plan', 'Inspect the schema.');
      addThought('Analysis', 'Check migration risks.');
      addThought('Plan', 'Evaluate rollout alternatives.');
      expect(addThought('Next', 'Draft the fix.')).toBe(false);
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('should not detect a loop when an earlier thought reappears after progress', () => {
      service.reset('');
      // Regression: the earlier counting-based implementation fired as soon
      // as any thought appeared >= THRESHOLD times anywhere in the retained
      // history. A healthy session that revisits a phrase after progress on
      // unrelated steps must *not* trip; only a sustained consecutive run does.
      addThought('Plan', 'Inspect the schema.');
      addThought('Analysis', 'Consider migration.');
      addThought('Analysis', 'Review indexes.');
      addThought('Plan', 'Inspect the schema.');
      addThought('Analysis', 'Consider rollout risks.');
      expect(addThought('Plan', 'Inspect the schema.')).toBe(false);
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('clears thought history across tool-call roundtrips within a turn', () => {
      service.reset('');
      // Regression: thoughtHistory previously persisted across ToolCallRequest
      // events within a single prompt. Three identical thoughts separated by
      // real tool-call progress would incorrectly fire REPETITIVE_THOUGHTS.
      addThought('Plan', 'Inspect the schema.');
      addTool('read_file', { path: 'a.sql' });
      addThought('Plan', 'Inspect the schema.');
      addTool('read_file', { path: 'b.sql' });
      expect(addThought('Plan', 'Inspect the schema.')).toBe(false);
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('ignores hedge phrases in Content events (thought detection is Thought-only)', () => {
      service.reset('');
      // Content events used to feed a substring-matched hedge-phrase list
      // into thoughtHistory, which conflated prose with the model's actual
      // reasoning channel. Thought detection now runs only on Thought events.
      feed('I should check the config, maybe it helps.', 5);
      expectNotLogged('repetitive_thoughts');
    });
  });

  describe('Long verbatim repetition loops (issue #1775)', () => {
    // The report shows one ~300-char analysis block chanted verbatim many
    // times without the turn halting: far longer than the clustered chunk
    // rule's 75-char window, and on OpenAI-compatible providers often in the
    // reasoning stream, which reaches the service only as Thought events.
    // Deltas are deliberately misaligned (DELTA does not divide the unit).
    const CHANTING = LoopType.CHANTING_IDENTICAL_SENTENCES;

    it('unit shape sanity: the chanted block exceeds the cluster window', () => {
      expect(CHANT.length % DELTA).not.toBe(0);
      expect(CHANT.length).toBeGreaterThan(CONTENT_CHUNK_SIZE * 1.5);
    });

    it('detects the long chant in the reasoning/thought channel', () => {
      service.reset('');
      expectFired(streamThoughts(CHANT.repeat(40)), CHANTING);
    });

    it('detects the long chant on the visible content channel', () => {
      service.reset('');
      expectFired(streamContent(CHANT.repeat(40)), CHANTING);
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
      expect(streamThoughts(longUnit.repeat(20))).toBe(true);
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
    const expectUnitChant = (unitLength: number, copies: number) => {
      service.reset('');
      const unit = makeAperiodicUnit(unitLength, unitLength);
      expect(unit.length % DELTA).not.toBe(0);
      expectFired(streamContent(unit.repeat(copies)), CHANTING);
    };

    // Between the clustered rule's ~75-char bound and the span a fixed
    // five-occurrence window can verify (~238 chars), the verified region
    // must grow with the occurrence run — a run pinned to the last five
    // occurrences left these units permanently undetectable.
    it.each([100, 150, 200])(
      'detects a %d-char repeated unit in the mid-length band',
      (unitLength) => expectUnitChant(unitLength, 40),
    );

    // Units of ~1 KB or more can never fit five occurrences into the
    // retained history window; once the window saturates, the truncated-run
    // path must admit them by verifying the whole retained region.
    it.each([1000, 1500])(
      'detects a %d-char repeated unit that cannot fit five occurrences in the window',
      (unitLength) => expectUnitChant(unitLength, 30),
    );

    it('does not accept a short occurrence run in fresh history', () => {
      service.reset('');
      // Three occurrences of a 1000-char unit span only 2050 chars — the
      // history has not saturated, so the run cannot have been truncated
      // and the short-run path must not admit it.
      const unit = makeAperiodicUnit(1000, 7);
      expect(streamContent(unit.repeat(3))).toBe(false);
    });

    it('detects a chant that starts after a long varied turn fills the window', () => {
      service.reset('');
      // The realistic #1775 shape: a long varied turn beyond the retained
      // window, then the chant. Detection must survive truncateAndUpdate's
      // index adjustment and fire exactly when the fifth in-window occurrence
      // lands. The bounds pin the window size: a shrunken one (e.g. 2500)
      // cannot hold five 700-char occurrences and fires early via the
      // truncated-run path once the filler flushes out, before the bound below.
      const filler = stepsText(100);
      expect(filler.length).toBeGreaterThan(2500);
      const unit = makeAperiodicUnit(700, 42);
      expect(unit.length % DELTA).not.toBe(0);
      expect(streamContent(filler)).toBe(false);

      const chant = unit.repeat(20);
      let detectedAt = -1;
      for (let i = 0; i < chant.length && detectedAt === -1; i += DELTA) {
        if (addText(chant.slice(i, i + DELTA))) detectedAt = i + DELTA;
      }
      expect(detectedAt).not.toBe(-1);
      expectType(CHANTING);
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
      expect(streamThoughts(stepsText(200))).toBe(false);
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
      for (let i = 0; i < 6; i++) text += anchor + filler(i, 150);
      expect(streamContent(text, CONTENT_CHUNK_SIZE)).toBe(false);
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('does not halt on fewer than five occurrences of a long unit', () => {
      service.reset('');
      // Four full repetitions only yield four equally-spaced occurrences
      // of any one chunk — below the long-period threshold.
      expect(streamContent(CHANT.repeat(4))).toBe(false);
    });

    it('detects a visible-content chant after a fenced thought delta', () => {
      service.reset('');
      // Reasoning deltas must not drive the content channel's code-block
      // state: an unbalanced fence in a thought used to flip the shared
      // inCodeBlock parity, which nothing clears mid-turn, silently
      // disabling visible-content detection for the rest of the turn.
      add(thoughtEvent('', 'Let me look at this snippet:\n```'));
      expectFired(streamContent(CHANT.repeat(40)), CHANTING);
    });

    it('detects a reasoning chant whose unit contains markdown list markers', () => {
      service.reset('');
      // Chain-of-thought often repeats structured units (checklists, steps).
      // Reasoning is never rendered markdown, so list-item-shaped thought
      // deltas must not reset the shared history: they used to wipe the
      // evidence every cycle, making the chant undetectable at any length.
      const unit =
        'Review the migration plan:\n' +
        '- check rollback safety\n' +
        '- verify indexes\n' +
        '- confirm the cache invalidation path\n';
      expect(unit.length).toBeGreaterThan(CONTENT_CHUNK_SIZE * 1.5);
      expect(unit.length % DELTA).not.toBe(0);
      expectFired(streamThoughts(unit.repeat(60)), CHANTING);
    });
  });

  describe('Retry and ModelFallback stream-state resets', () => {
    // The #7832 transport-replay gate admits thought-only cuts, so a replay
    // retry re-streams the failed attempt's reasoning (verbatim, under
    // deterministic decoding) through the chunk detectors; the identical
    // copies must not read as a chant, or a healthy turn halts mid-attempt.
    const CHANTING = LoopType.CHANTING_IDENTICAL_SENTENCES;

    // `copies` identical attempts separated by replay retries: none fires.
    const expectReplaysQuiet = (
      stream: (text: string) => boolean,
      attempt: string,
      copies: number,
    ) => {
      for (let copy = 0; copy < copies; copy++) {
        if (copy > 0) add(RETRY);
        expect(stream(attempt)).toBe(false);
      }
      expect(service.getLastLoopType()).toBeNull();
    };

    it('does not halt a healthy turn when replay retries re-stream identical reasoning', () => {
      service.reset('');
      // The witness shape: a ~1.4 KB reasoning phase cut twice and
      // re-streamed byte-identically. Three copies saturate the window;
      // without the reset the third (healthy) attempt fires
      // CHANTING_IDENTICAL_SENTENCES mid-stream.
      expectReplaysQuiet(streamThoughts, variedText(1400, 42), 3);
    });

    it('does not halt a healthy turn when replay retries re-stream identical content', () => {
      service.reset('');
      expectReplaysQuiet(streamContent, variedText(1400, 43), 3);
    });

    it('does not halt when rate-limit retries replay five shorter identical copies', () => {
      service.reset('');
      // The rate-limit branch replays without a yielded-content guard; five
      // ~300-char copies reach the five-occurrence path unsaturated.
      expectReplaysQuiet(streamThoughts, variedText(300, 7), 5);
    });

    it('keeps accumulated evidence across a continuation retry', () => {
      service.reset('');
      // Continuation recovery (#7832) keeps the delivered text and appends
      // new output, re-streaming nothing, so accumulated evidence must
      // survive. An uninterrupted chant of this unit fires at ~1258 chars;
      // streaming 1192, continuing, then 100 more must fire at that point.
      const chant = variedText(298, 21).repeat(6);
      expect(streamThoughts(chant.slice(0, 1192))).toBe(false);
      add({ type: LlmEventType.Retry, isContinuation: true });
      expectFired(streamThoughts(chant.slice(1192, 1292)), CHANTING);
    });

    it('drops accumulated evidence on a replay retry at the same point', () => {
      service.reset('');
      // Contrast with the continuation test: a replay re-streams from the
      // start, so the same partial chant must NOT be one short continuation
      // away from firing after it.
      const chant = variedText(298, 21).repeat(6);
      expect(streamThoughts(chant.slice(0, 1192))).toBe(false);
      add(RETRY);
      expect(streamThoughts(chant.slice(1192, 1292))).toBe(false);
      expect(service.getLastLoopType()).toBeNull();
    });

    it('drops the failed model stream state on ModelFallback', () => {
      service.reset('');
      // The fallback model restarts from scratch; had the failed model's state
      // been kept, its two copies plus two from the fallback model would fire
      // the long-period escape valve mid-way through the fourth copy.
      const attempt = variedText(1400, 99);
      expect(streamThoughts(attempt)).toBe(false);
      expect(streamThoughts(attempt)).toBe(false);
      add({
        type: LlmEventType.ModelFallback,
        fromModel: 'primary-model',
        toModel: 'fallback-model',
        fallbackIndex: 1,
      } satisfies ServerLlmModelFallbackEvent);
      expect(streamThoughts(attempt)).toBe(false);
      expect(streamThoughts(attempt)).toBe(false);
      expect(service.getLastLoopType()).toBeNull();
    });

    it('still halts a genuine chant after a replay restart', () => {
      service.reset('');
      // The reset must not blind the detector: a real chant re-accumulates
      // after the restart and still fires.
      add(RETRY);
      expectFired(streamThoughts(variedText(298, 21).repeat(40)), CHANTING);
    });
  });

  describe('Truncation hysteresis', () => {
    // The physical trim walks the whole contentStats map (one entry per
    // window position at saturation): Θ(window) synchronous CPU per event.
    // It now runs with hysteresis (a TRUNCATION_SLACK margin); these tests
    // pin that this is behavior-neutral: the fire offsets below were recorded
    // on the pre-hysteresis implementation and must not drift.
    const MAX_HISTORY_LENGTH = 4000;
    const TRUNCATION_SLACK = 1000;
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
        if (addText(piece)) return streamed;
      }
      return -1;
    };

    it('unit shape sanity', () => {
      expect(CHANT.length).toBe(298);
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
        expect(addText(piece)).toBe(false);
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
      expect(fireOffset(CHANT.repeat(60))).toBe(1258);
      expect(fireOffset(U1200.repeat(12))).toBe(4012);
      expect(fireOffset(variedText(3000, 3) + U1200.repeat(12))).toBe(7004);
      expect(fireOffset(U1350.repeat(12))).toBe(4012);
      expect(fireOffset(variedText(4500, 5) + CHANT.repeat(60))).toBe(5763);
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
    it('logs a short excerpt of one period of the repeated region', () => {
      service.reset('');
      expect(streamThoughts(CHANT.repeat(40))).toBe(true);

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
      expect((CHANT + CHANT).includes(excerpt)).toBe(true);
    });

    it('does not log an excerpt when nothing fires', () => {
      service.reset('');
      expect(streamThoughts(CHANT.slice(0, 500))).toBe(false);
      expect(vi.mocked(mockDebugLogger.debug)).not.toHaveBeenCalled();
    });
  });

  describe('Read File Loop Detection', () => {
    // Cold-start exemption: a prompt that has not yet fired any non-read-like
    // tool is still in its opening-exploration phase, so the detector gives
    // it an initial pass. Tests that want to exercise the detector must
    // fire a non-read tool first so subsequent reads are judged normally.
    const resetAndPrime = () => {
      service.reset('');
      addTool('write_file', { path: 'prime.txt', content: '' });
    };
    const read = (path: string) => addTool('read_file', { path });

    it('should detect excessive file read operations', () => {
      resetAndPrime();
      // FILE_READ_THRESHOLD reads in the window trigger the loop. The first
      // (THRESHOLD - 1) reads must not fire; the THRESHOLD-th does.
      expectNone(7, (i) => read(`file${i}.txt`));
      expect(read('file7.txt')).toBe(true);
      expectLogged('read_file_loop');
    });

    it('should exempt opening exploration from READ_FILE_LOOP (cold start)', () => {
      service.reset('');
      // Regression for PR #3236 review: a prompt like "summarize this project"
      // opens with parallel read_file / list_directory calls and must not trip
      // READ_FILE_LOOP before any write/execute action: FILE_READ_WINDOW+
      // consecutive reads with no prior non-read tool, and nothing fires.
      expectNone(20, (i) =>
        addTool(i % 2 === 0 ? 'read_file' : 'list_directory', {
          path: `f${i}`,
        }),
      );
      expectNotLogged('read_file_loop');
    });

    it('should activate READ_FILE_LOOP once a non-read tool lands mid-prompt', () => {
      service.reset('');
      // No firing before the cold-start gate flips.
      run(7, (i) => read(`pre${i}.txt`));
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
      // A non-read tool lands — gate opens.
      addTool('write_file', { path: 'out.txt', content: 'x' });
      // Now a window of reads should eventually trip READ_FILE_LOOP. As new
      // reads push the write_file out of the FILE_READ_WINDOW-sized history
      // and FILE_READ_THRESHOLD read-likes accumulate, detection fires.
      expect(fires(FILE_READ_WINDOW + 2, (i) => read(`post${i}.txt`))).toBe(
        true,
      );
      expectLogged('read_file_loop');
    });

    it('should detect other read-like operations (exact names + read_/list_ prefixes)', () => {
      resetAndPrime();
      // Mix of read-like tool names that either appear in the exact allowlist
      // (read_file, read_many_files, list_directory, zoom_image) or match the
      // read_/list_ prefix fallback used for MCP-provided tools.
      addTool('read_many_files', { paths: ['file1.txt'] });
      addTool('list_directory', { path: '.' });
      addTool('read_resource', { uri: 'a' });
      addTool('zoom_image', {
        file_path: 'chart.png',
        x1: 0,
        y1: 0,
        x2: 500,
        y2: 500,
      });
      addTool('list_projects', {});
      read('file5.txt');
      addTool('read_many_files', { paths: ['file6.txt'] });
      expect(addTool('list_directory', { path: 'nested' })).toBe(true);
      expectLogged('read_file_loop');
    });

    it('should not treat tools that merely contain read-like substrings as file reads', () => {
      resetAndPrime();
      // Regression: the earlier substring heuristic treated any name
      // containing 'read'/'cat'/'view'/'list' as a file read, so `review`
      // (contains 'view') and `concat_chunks` (contains 'cat') contributed
      // to READ_FILE_LOOP even though no file-read loop was happening.
      const names = [
        'review',
        'concat_chunks',
        'viewport_set',
        'listener_bind',
      ];
      expectNone(6, (i) => addTool(names[i % names.length], { i }));
      expectNotLogged('read_file_loop');
    });

    it('should not detect loop with mixed operations', () => {
      resetAndPrime();
      // Mix of read and non-read operations
      read('file1.txt');
      addTool('write_file', { path: 'file2.txt', content: 'test' });
      read('file3.txt');
      addTool('execute', { command: 'ls' });
      read('file4.txt');
      expect(read('file5.txt')).toBe(false);
      expectNotLogged('read_file_loop');
    });
  });

  describe('Action Stagnation Detection', () => {
    // Stagnation: the same tool *name* STAGNATION_THRESHOLD times in a row,
    // whatever the args. Distinct from CONSECUTIVE_IDENTICAL_TOOL_CALLS (same
    // name AND args) and READ_FILE_LOOP (mostly read-like tools in the
    // window), so it is exercised with a non-read-like tool and varying args.
    const search = (query: string) => addTool('search_code', { query });

    it('should detect action stagnation when the same tool is repeated with varying args', () => {
      service.reset('');
      // STAGNATION_THRESHOLD - 1 calls must not fire; the THRESHOLD-th
      // consecutive same-name call triggers stagnation.
      expectNone(7, (i) => search(`term${i}`));
      expect(search('term7')).toBe(true);
      expectLogged('action_stagnation');
    });

    it('should reset stagnation streak when a different tool is called', () => {
      service.reset('');
      // 5 consecutive same-name calls (below threshold), then a different
      // tool resets the streak, so 5 more calls only reach 5 again.
      run(5, (i) => search(`a${i}`));
      addTool('write_file', { path: 'out.txt', content: 'x' });
      expectNone(5, (i) => search(`b${i}`));
    });

    it('tracks bridged target names instead of the shared wrapper name', () => {
      service.reset('');
      expectNone(8, (i) =>
        addTool(ToolNames.TOOL_CALL, {
          name: `mcp__service_${i}__read`,
          arguments: { id: i },
        }),
      );
    });

    it('still detects eight bridged calls to the same target', () => {
      service.reset('');
      const getIssue = (number: number) =>
        addTool(ToolNames.TOOL_CALL, {
          name: 'mcp__github__get_issue',
          arguments: { number },
        });
      expectNone(7, getIssue);
      expectFired(getIssue(7), LoopType.ACTION_STAGNATION);
    });

    it('does not collapse bridged calls with stringified arguments onto one repeat key', () => {
      service.reset('');
      // A model can emit the bridge envelope with `arguments` as a JSON
      // string (the malformation SchemaValidator repairs before execution),
      // so the loop detector must keep that payload as key material instead
      // of collapsing every such call onto `{}`.
      expectNone(TOOL_CALL_LOOP_THRESHOLD, (i) =>
        guardTool(ToolNames.TOOL_CALL, {
          name: 'read_file',
          arguments: JSON.stringify({ file_path: `/file-${i}` }),
        }),
      );
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });
  });

  describe('Turn Tool Call Cap', () => {
    // The cap comes from model.maxToolCallsPerTurn; the service reads the
    // resolved Config getter with no fallback, so the pinned mock below is the
    // single source of the cap here. An explicit value is a hard cap; the
    // default (unset) is adaptive: a *soft* cap diverse (productive) calls may
    // pass up to a hard backstop (soft * 10), halting at the soft cap only on
    // a stuck-repetition signal. A small soft cap keeps these tests compact.
    const SOFT_CAP = 10;
    const HARD_CAP = SOFT_CAP * 10;
    const CAP = LoopType.TURN_TOOL_CALL_CAP;
    let capConfig: Config;

    beforeEach(() => {
      // Default (unset) cap → adaptive behavior.
      capConfig = makeConfig(SOFT_CAP, false);
      service = new LoopDetectionService(capConfig);
    });

    const finishedEvent = {
      type: LlmEventType.Finished,
      value: { reason: 'STOP' },
    } as unknown as ServerLlmStreamEvent;
    // Diverse calls: `key` varies with i, so no two calls repeat.
    const diverse = (n: number, name = 't', key = 'i', svc = service) =>
      expectNone(n, (i) => guardTool(name, { [key]: i }, svc));

    it('does not fire at or below the soft cap', () => {
      service.reset('');
      diverse(SOFT_CAP, 'any_tool');
    });

    it('does not fire on diverse calls above the soft cap (productive turn)', () => {
      // Mirrors session 80db472f turn 8: a large implementation turn that
      // makes ~100 distinct calls without repeating any. The old blunt cap
      // halted this at the soft cap; the adaptive cap lets it continue.
      service.reset('');
      diverse(HARD_CAP - 1, 'any_tool');
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
      expect(service.getLastLoopType()).toBeNull();
    });

    it('fires when a stuck signal accumulates between the soft and hard cap', () => {
      // The primary adaptive-cap scenario: a productive turn crosses the soft
      // cap with diverse calls, THEN a stuck pattern emerges mid-range. Guards
      // against evaluating `stuck` only at the soft-cap boundary (the other
      // stuck test builds the signal while crossing it, so would miss that).
      service.reset('');
      diverse(SOFT_CAP, 'any_tool');
      // Now interleave 6 repeats of one key with distinct fillers so the
      // consecutive-identical guard does not fire; the stuck signal completes
      // well inside the (softCap, hardCap] range and halts there.
      const fired = fires(GLOBAL_DUPLICATE_THRESHOLD * 2, (i) =>
        guardTool('any_tool', i % 2 === 0 ? { stuck: true } : { filler: i }),
      );
      expectFired(fired, CAP);
    });

    it('fires on a stuck signal accumulated across Finished round-trips', () => {
      // The stuck-repetition tracker must survive Finished boundaries within a
      // turn (only reset() / Retry clear it): repeating the same call across
      // successful round-trips halts at the soft cap via the stuck signal, not
      // the hard backstop. Guards against clearing capKeyCounts on Finished.
      service.reset('');
      const same = { same: true };
      let fired = false;
      const step = (args: Record<string, unknown>) => {
        if (!fired) fired = guardTool('t', args);
      };
      // 3 round-trips, each repeating the same key twice between distinct
      // calls (so the consecutive-identical guard stays quiet); the 6th
      // repeat crosses the soft cap and halts via the stuck signal, well
      // before the hard backstop.
      for (let rt = 0; rt < 3 && !fired; rt++) {
        step(same);
        step({ d: rt * 2 });
        step(same);
        step({ d: rt * 2 + 1 });
        if (!fired) guard(finishedEvent);
      }
      expectFired(fired, CAP);
    });

    it('treats reordered argument fields as one call for the stuck signal', () => {
      // getToolCallKey canonicalizes object keys recursively, so the same call
      // with fields reordered (top level AND nested) hashes to one key and
      // accumulates as repeats; without that (or with broken recursion) each
      // permutation is distinct and the stuck signal never builds. Distinct
      // fillers in between keep the consecutive-identical guard from firing.
      service.reset('');
      const variants = [
        { a: 1, b: 2, c: 3, nested: { x: 10, y: 20 } },
        { nested: { y: 20, x: 10 }, c: 3, b: 2, a: 1 },
        { b: 2, a: 1, nested: { x: 10, y: 20 }, c: 3 },
        { c: 3, nested: { y: 20, x: 10 }, a: 1, b: 2 },
        { nested: { x: 10, y: 20 }, a: 1, c: 3, b: 2 },
        { b: 2, c: 3, a: 1, nested: { y: 20, x: 10 } },
      ];
      const fired = fires(SOFT_CAP + variants.length, (i) =>
        guardTool(
          'any_tool',
          i % 2 === 0 ? variants[(i / 2) % variants.length] : { filler: i },
        ),
      );
      expectFired(fired, CAP);
    });

    it('fires at the hard cap regardless of diversity', () => {
      // The hard cap is the backstop for a runaway that varies its arguments
      // on every call (which no repetition signal catches).
      service.reset('');
      diverse(HARD_CAP);
      expectFired(guardTool('t', { last: true }), CAP);
    });

    it('fires at the soft cap when a stuck-repetition signal is present', () => {
      // One (tool,args) call repeated GLOBAL_DUPLICATE_THRESHOLD times
      // (non-consecutively, so the consecutive-identical guard does not fire
      // first) makes the turn "stuck": exceeding the soft cap halts.
      service.reset('');
      // Interleave the repeated key X with distinct calls so X never repeats
      // back-to-back. X reaches the threshold exactly as the total crosses the
      // soft cap, so the next call after the soft cap fires.
      const fired = fires(SOFT_CAP + GLOBAL_DUPLICATE_THRESHOLD, (i) =>
        guardTool('any_tool', i % 2 === 0 ? { stuck: true } : { distinct: i }),
      );
      expect(fired).toBe(true);
      expect(loggers.logLoopDetected).toHaveBeenCalledTimes(1);
      expectLogged('turn_tool_call_cap', capConfig);
      expectType(CAP);
    });

    it('allows diverse calls past the built-in default soft cap', () => {
      // Documents that the default soft cap is DEFAULT_MAX_TOOL_CALLS_PER_TURN
      // and that diverse calls are allowed past it (no fire at default+1). The
      // hard-cap firing at the default config is covered by the SOFT_CAP=10
      // 'fires at the hard cap' test (same code path, scaled by the multiplier).
      const svc = newService(mockConfig);
      diverse(DEFAULT_MAX_TOOL_CALLS_PER_TURN + 1, 't', 'i', svc);
    });

    it('never fires when the cap is disabled (Config resolves <= 0 to Infinity)', () => {
      const svc = newService(makeConfig(Number.POSITIVE_INFINITY));
      diverse(DEFAULT_MAX_TOOL_CALLS_PER_TURN + 50, 't', 'i', svc);
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('does not fire after loop detection is disabled for the session', () => {
      // The dialog's "Disable loop detection for this session" must suppress
      // the cap too — the user's explicit choice outranks the circuit breaker
      // (it used to fire regardless, contradicting the dialog text).
      service.reset('');
      service.disableForSession();
      diverse(HARD_CAP + 10, 'any_tool');
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('rolls back a failed attempt on retry so its calls do not count', () => {
      service.reset('');
      // Attempt makes 6 calls, then the API retries (no round-trip committed
      // yet, so the rollback floor is 0).
      run(6, (i) => guardTool('t', { i }));
      guard(RETRY);
      // The 6 discarded calls must not count: a full hard cap of fresh diverse
      // calls stays under the limit and only the (hardCap+1)-th fires (a failed
      // rollback would push the fire earlier, into the no-fire loop).
      diverse(HARD_CAP, 't', 'j');
      expect(guardTool('t', { last: true })).toBe(true);
      expect(loggers.logLoopDetected).toHaveBeenCalledTimes(1);
    });

    it('rolls back the stuck-repetition signal on retry', () => {
      // Larger soft cap so the failed attempt can build a stuck signal (6
      // non-consecutive repeats of one call) without crossing the soft cap and
      // firing early.
      const svc = newService(makeConfig(20));
      // Failed attempt: 6 repeats of one call interleaved with distinct calls
      // (so the consecutive-identical guard does not fire). Total stays under
      // the soft cap, so the cap does not fire — but capMaxKeyRepeat reaches 6.
      for (let i = 0; i < 6; i++) {
        guardTool('t', { stuck: true }, svc);
        guardTool('t', { d: i }, svc);
      }
      guard(RETRY, svc);
      // The stuck signal must be cleared on retry: a diverse replay is allowed
      // well past the soft cap (20). If capMaxKeyRepeat had survived at 6, the
      // replay would halt at the 21st call (total > 20 and stuck).
      diverse(25, 't', 'i', svc);
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('preserves committed round-trip counts when a later attempt retries', () => {
      service.reset('');
      // Round-trip 1: 6 calls, then Finished commits them as the floor.
      run(6, (i) => guardTool('t', { i }));
      guard(finishedEvent);
      // Round-trip 2: 4 calls, then a retry discards only these 4.
      run(4, (i) => guardTool('t', { k: i }));
      guard(RETRY);
      // Total is back to the committed 6 (NOT zero): the hard cap is reached
      // after exactly (hardCap - 6) more diverse calls and the next fires (a
      // lost commit would restart the total at 0 and move the fire later).
      diverse(HARD_CAP - 6, 't', 'm');
      expect(guardTool('t', { last: true })).toBe(true);
    });

    it('still accumulates across committed round-trips to trip the cap', () => {
      service.reset('');
      let fired = false;
      // Diverse calls across committed round-trips accumulate; the hard
      // backstop (soft * 10) is crossed partway through.
      for (let rt = 0; rt < 12 && !fired; rt++) {
        fired = fires(15, (i) => guardTool('t', { rt, i }));
        if (!fired) guard(finishedEvent);
      }
      expectFired(fired, CAP);
    });

    // Cap of 2: calls 1 and 2 pass either way; `explicit` decides call 3.
    const capOfTwo = (explicit: boolean) => {
      const svc = newService(makeConfig(2, explicit));
      expect(guardTool('t', { a: 1 }, svc)).toBe(false);
      expect(guardTool('t', { a: 2 }, svc)).toBe(false);
      return svc;
    };

    it('treats an explicit value as a hard cap: cap of 2 halts call 3', () => {
      // Regression for the released contract (yiliang114): an explicitly set
      // maxToolCallsPerTurn halts on the call that exceeds it, even with
      // diverse args — no adaptive ×N extension.
      const svc = capOfTwo(true);
      expectFired(guardTool('t', { a: 3 }, svc), CAP, svc);
    });

    it('the same value left at the default is adaptive, not a hard cap', () => {
      // Contrast proving the explicit flag (not the value) drives the hard-cap
      // behavior: an unset cap of the same value does not halt at value+1.
      const svc = capOfTwo(false);
      expect(guardTool('t', { a: 3 }, svc)).toBe(false);
    });
  });

  describe('Global Tool Call Duplicate Detection', () => {
    it('should not fire when same call appears fewer than threshold times', () => {
      service.reset('');
      const event = toolCall('stuck_tool', { param: 'same' });
      expectNone(GLOBAL_DUPLICATE_THRESHOLD - 1, () => heur(event));
    });

    it('should fire when same (tool, args) appears threshold times non-consecutively', () => {
      service.reset('');
      const stuckEvent = toolCall('stuck_tool', { param: 'same' });
      const otherEvents = [
        toolCall('other_a', { x: 1 }),
        toolCall('other_b', { y: 2 }),
        toolCall('other_c', { z: 3 }),
      ];
      // Interleave: stuck, other_a, stuck, other_b, stuck, other_c, ...
      // GLOBAL_DUPLICATE_THRESHOLD total stuck calls with different calls
      // between; the threshold-th stuck call should fire.
      for (let i = 0; i < GLOBAL_DUPLICATE_THRESHOLD - 1; i++) {
        expect(heur(stuckEvent)).toBe(false);
        expect(heur(otherEvents[i % otherEvents.length])).toBe(false);
      }
      expect(heur(stuckEvent)).toBe(true);
      expectLogged('global_tool_call_duplicate');
      // getLastLoopType() is the getter the client uses to populate the
      // bubbled LoopDetected event, so assert it too — not just the logged one.
      expectType(LoopType.GLOBAL_TOOL_CALL_DUPLICATE);
    });

    it('should not fire for different (tool, args) pairs', () => {
      service.reset('');
      expectNone(GLOBAL_DUPLICATE_THRESHOLD, (i) =>
        heur(toolCall('stuck_tool', { param: i })),
      );
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('global-duplicate also fires for a consecutive identical run', () => {
      // checkGlobalDuplicate runs on every ToolCallRequest independently of the
      // always-on consecutive guard (which lives in checkAlwaysOnSafeties, not
      // this heuristic path). Exercised directly, the heuristic path fires
      // global-duplicate once a consecutive identical run reaches its threshold.
      service.reset('');
      const event = toolCall('stuck_tool', { param: 'same' });
      run(GLOBAL_DUPLICATE_THRESHOLD - 1, () => heur(event));
      expect(heur(event)).toBe(true);
      expectLogged('global_tool_call_duplicate');
    });

    it('does not count a retried replay toward the global-duplicate threshold', () => {
      service.reset('');
      const stuck = toolCall('stuck_tool', { param: 'same' });
      // Failed attempt streams (threshold - 3) identical calls, then retries.
      expectNone(GLOBAL_DUPLICATE_THRESHOLD - 3, () => heur(stuck));
      heur(RETRY);
      // The replay streams the same calls again. Without the Retry reset the
      // pre- and post-retry counts would sum to the threshold and false-fire.
      expectNone(GLOBAL_DUPLICATE_THRESHOLD - 3, () => heur(stuck));
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });
  });

  describe('Alternating Tool Call Pattern Detection', () => {
    const eventA = toolCall('tool_a', { param: 'a' });
    const eventB = toolCall('tool_b', { param: 'b' });

    it('should fire for a clean ABABAB alternating pattern', () => {
      service.reset('');
      // ALTERNATING_PATTERN_CYCLES cycles = 2*CYCLES calls. Build up to
      // one call short of the trigger.
      for (let i = 0; i < ALTERNATING_PATTERN_CYCLES - 1; i++) {
        expect(heur(eventA)).toBe(false);
        expect(heur(eventB)).toBe(false);
      }
      // First call of the final cycle; the second completes the pattern.
      expect(heur(eventA)).toBe(false);
      expect(heur(eventB)).toBe(true);
      expectLogged('alternating_tool_call_pattern');
      expectType(LoopType.ALTERNATING_TOOL_CALL_PATTERN);
    });

    it('should not fire when calls alternate but with varying keys', () => {
      service.reset('');
      // Alternating tool names but different args each time → different
      // keys → no clean ABAB because the keys keep changing.
      for (let i = 0; i < ALTERNATING_PATTERN_CYCLES + 2; i++) {
        expect(heur(toolCall('tool_a', { param: i }))).toBe(false);
        expect(heur(toolCall('tool_b', { param: i }))).toBe(false);
      }
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('should not fire for a single tool repeated (consecutive, not alternating)', () => {
      service.reset('');
      // The consecutive detector would fire at 5, but only the heuristic path
      // runs here, where global-duplicate fires at 6. This only confirms the
      // alternating detector doesn't false-positive on a repeated key.
      run(2 * ALTERNATING_PATTERN_CYCLES, () => heur(eventA));
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
      const eventC = toolCall('tool_c', { param: 'c' });
      // Build up ABAB, insert C to break the pattern, then restart ABAB from
      // there — 6 calls (3 cycles) are needed after the break.
      for (const event of [eventA, eventB, eventA, eventB, eventC]) heur(event);
      for (const event of [eventA, eventB, eventA, eventB]) heur(event);
      expect(heur(eventA)).toBe(false);
      expect(heur(eventB)).toBe(true);
      expectLogged('alternating_tool_call_pattern');
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
    const UNCHANGED = '#1 [in_progress] @peer-a — task';
    const CONSECUTIVE = LoopType.CONSECUTIVE_IDENTICAL_TOOL_CALLS;

    const taskListEvent = (
      callId: string,
      args: Record<string, unknown> = TASK_LIST_ARGS,
    ) => toolCall('task_list', args, callId);

    const taskListResult = (boardState: string, callId = 'call-x'): Part[] => [
      fnResponse('task_list', { output: boardState }, callId),
    ];
    const record = (
      result: Part[],
      svc = service,
      args: Record<string, unknown> = TASK_LIST_ARGS,
    ) => svc.recordToolResult({ name: 'task_list', args }, result);
    const oscillating = (i: number) =>
      taskListResult(i % 2 === 0 ? 'board A' : 'board B');
    const heuristicsOn = () =>
      makeConfig(DEFAULT_MAX_TOOL_CALLS_PER_TURN, false, false);

    // Up to `rounds` task_list polls (call-0, call-1, ...), each followed by
    // recording result(i) unless it is undefined. Stops at the first fire;
    // a recorded result's own verdict counts only when `counted`.
    const poll = (
      rounds: number,
      result: (i: number) => Part[] | undefined,
      {
        svc = service,
        counted = false,
        viaAddAndCheck = false,
      }: {
        svc?: LoopDetectionService;
        counted?: boolean;
        viaAddAndCheck?: boolean;
      } = {},
    ): boolean =>
      fires(rounds, (i) => {
        const event = taskListEvent(`call-${i}`);
        if (viaAddAndCheck ? svc.addAndCheck(event) : guard(event, svc)) {
          return true;
        }
        const parts = result(i);
        return parts !== undefined && record(parts, svc) && counted;
      });

    it('still halts at the threshold when no results were recorded (fail-safe)', () => {
      // A wiring gap must never loosen the DashScope protection (#5019):
      // without result evidence the guard behaves exactly as pre-fix.
      const event = taskListEvent('call-1');
      expectNone(TOOL_CALL_LOOP_THRESHOLD - 1, () => guard(event));
      expectFired(guard(event), CONSECUTIVE);
    });

    it('still halts when result evidence is only partial (fail-safe)', () => {
      // Incomplete evidence (a dropped/failed execution records no result)
      // must never grant the result-aware exemption: the guard needs one
      // recorded result per preceding request. Here: 4 results for 5 requests.
      const fired = poll(TOOL_CALL_LOOP_THRESHOLD, (i) =>
        i === 2 ? undefined : taskListResult('frozen board'),
      );
      expectFired(fired, CONSECUTIVE);
    });

    it('still halts at the threshold when every result is unchanged', () => {
      const fired = poll(TOOL_CALL_LOOP_THRESHOLD, () =>
        taskListResult(UNCHANGED),
      );
      expect(fired).toBe(true);
      expect(service.getConsecutiveToolCallCount()).toBe(
        TOOL_CALL_LOOP_THRESHOLD,
      );
      expectType(CONSECUTIVE);
    });

    it('does not halt while the task board keeps changing between identical calls', () => {
      // Well past the argument-only threshold: every poll returns a changed
      // board (a peer completed/claimed a task between calls), which is the
      // productive polling pattern the team prompt encourages.
      const fired = poll(4 * TOOL_CALL_LOOP_THRESHOLD, (i) =>
        taskListResult(`board state v${i}`),
      );
      expect(fired).toBe(false);
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it.each(['task_list', 'Task_List'])(
      'uses changing result evidence for bridged task-list polling (%s)',
      (targetName) => {
        const bridgeArgs = { name: targetName, arguments: TASK_LIST_ARGS };
        for (let i = 0; i < TOOL_CALL_LOOP_THRESHOLD; i++) {
          expect(guardTool(ToolNames.TOOL_CALL, bridgeArgs)).toBe(false);
          expect(
            service.recordToolResult(
              { name: ToolNames.TOOL_CALL, args: bridgeArgs },
              taskListResult(`bridged board state v${i}`),
            ),
          ).toBe(false);
        }
        expect(loggers.logLoopDetected).not.toHaveBeenCalled();
      },
    );

    it('treats case variants of a bridged tool as one loop identity', () => {
      const fired = fires(TOOL_CALL_LOOP_THRESHOLD, (i) =>
        guardTool(ToolNames.TOOL_CALL, {
          name: i % 2 === 0 ? 'Read_File' : 'read_file',
          arguments: { file_path: '/tmp/example' },
        }),
      );
      expectFired(fired, CONSECUTIVE);
    });

    it('keeps productive polling alive past the adaptive per-turn cap', () => {
      // With the default (adaptive) cap, a turn beyond the soft cap halts
      // only on a stuck-repetition signal. Changed results must not build
      // that signal, so polling continues past the soft cap.
      const svc = newService(makeConfig(), 'cap-prompt');
      const fired = poll(
        DEFAULT_MAX_TOOL_CALLS_PER_TURN + 20,
        (i) => taskListResult(`board state v${i}`),
        { svc },
      );
      expect(fired).toBe(false);
    });

    it('does not accumulate an oscillating board toward the global-duplicate halt (heuristics on)', () => {
      // A board flipping between two byte-identical states differs from its
      // predecessor on EVERY poll (changed-state progress), though each (call,
      // result) pair recurs across the turn. Turn-wide pair totals would reach
      // the threshold here; the consecutive identical-result count must not.
      const svc = newService(heuristicsOn(), 'oscillating-global');
      const detected = poll(4 * GLOBAL_DUPLICATE_THRESHOLD, oscillating, {
        svc,
        counted: true,
        viaAddAndCheck: true,
      });
      expect(detected).toBe(false);
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('keeps an oscillating board alive past the adaptive cap (skipLoopDetection default)', () => {
      // CLI default (skipLoopDetection=true): the pair totals previously
      // fed capMaxKeyRepeat, so an oscillating board past the 100-call soft
      // cap was halted by the always-on adaptive cap. Every poll changing
      // the result must keep the stuck signal at bay instead.
      const svc = newService(makeConfig(), 'oscillating-cap');
      const fired = poll(DEFAULT_MAX_TOOL_CALLS_PER_TURN + 20, oscillating, {
        svc,
        counted: true,
      });
      expect(fired).toBe(false);
      expect(loggers.logLoopDetected).not.toHaveBeenCalled();
    });

    it('still halts an interleaved frozen board via the adaptive cap', () => {
      // The other direction under the CLI default: a genuinely frozen board
      // (same result on every poll) interleaved with other calls must still
      // build the stuck signal and trip the adaptive cap past the soft cap.
      const svc = newService(makeConfig(), 'frozen-cap');
      const fired = fires(
        GLOBAL_DUPLICATE_THRESHOLD,
        (i) =>
          guardTool('filler', { i }, svc) ||
          guard(taskListEvent(`call-${i}`), svc) ||
          record(taskListResult('frozen board'), svc),
      );
      expect(fired).toBe(false);
      // Diverse filler calls push the turn past the soft cap; the frozen
      // result streak (>= threshold) is the stuck signal that halts it.
      expectFired(
        fires(DEFAULT_MAX_TOOL_CALLS_PER_TURN + 20, (i) =>
          guardTool('filler', { j: i }, svc),
        ),
        LoopType.TURN_TOOL_CALL_CAP,
        svc,
      );
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

      it('halts a frozen oversized board despite per-call unique stub paths', () => {
        // Same frozen content persisted to a DIFFERENT per-call path each
        // poll: the envelope varies, the digest does not, so the guard must
        // still see five unchanged results and halt at the same threshold.
        let callCounter = 0;
        const fired = poll(8, () => {
          callCounter += 1;
          return taskListResult(
            persistedStub('frozen oversized board', {
              digest: digestOf('frozen oversized board'),
              path: `/tool-results/call-${callCounter}.txt`,
            }),
            `call-${callCounter}`,
          );
        });
        expectFired(fired, CONSECUTIVE);
      });

      it('keeps an oversized board alive when mutations land beyond the preview window', () => {
        // The preview covers only the first chars; the full-output digest is
        // what keeps the fingerprint sensitive to mutations past it.
        let version = 0;
        const fired = poll(4 * TOOL_CALL_LOOP_THRESHOLD, () => {
          version += 1;
          const content = `board head\n${'x'.repeat(3000)}\ntail v${version}`;
          return taskListResult(
            persistedStub('board head', { digest: digestOf(content) }),
          );
        });
        expect(fired).toBe(false);
      });

      it('falls back to the path-free preview for digest-less stubs', () => {
        // Stubs produced before the digest line existed: identical previews
        // in different envelopes must still collide (halt), changed previews
        // must not.
        let callCounter = 0;
        const frozen = poll(8, () => {
          callCounter += 1;
          return taskListResult(
            persistedStub('legacy frozen preview', {
              path: `/tool-results/legacy-${callCounter}.txt`,
            }),
            `call-${callCounter}`,
          );
        });
        expect(frozen).toBe(true);

        const fired = poll(
          4 * TOOL_CALL_LOOP_THRESHOLD,
          (i) =>
            taskListResult(
              persistedStub(`legacy preview v${i}`, {
                path: `/tool-results/legacy-${i}.txt`,
              }),
            ),
          { svc: newService(makeConfig(), 'legacy-changed'), counted: true },
        );
        expect(fired).toBe(false);
      });

      it('fingerprints quoted stub markers mid-content as ordinary text', () => {
        // Board content can QUOTE a stub (label + hex); only LEADING
        // producer shapes are stubs, so two boards differing only in quoted
        // content must still count as changed.
        const quoted = (hex: string) =>
          `peer said:\n${FULL_OUTPUT_DIGEST_LABEL}${hex}\nend`;
        const fired = poll(
          4 * TOOL_CALL_LOOP_THRESHOLD,
          (i) => taskListResult(quoted(digestOf(`content ${i}`))),
          { counted: true },
        );
        expect(fired).toBe(false);
      });
    });

    it('restarts the streak when a result changed, then halts on a fresh unchanged streak', () => {
      const step = (i: number, state: string) => {
        expect(guard(taskListEvent(`call-${i}`))).toBe(false);
        record(taskListResult(state));
      };
      // R1..R4: the board changes once mid-streak (v2), so R5 must NOT halt.
      ['v1', 'v1', 'v2', 'v1'].forEach((state, i) => step(i, state));
      step(4, 'v1');
      // The streak restarted at call-4 (request #1 of the new streak):
      // call-5..call-7 stay below the threshold and their unchanged results
      // corroborate the loop, so call-8 (its 5th request) halts.
      for (let i = 5; i <= 7; i++) step(i, 'v1');
      expectFired(guard(taskListEvent('call-8')), CONSECUTIVE);
    });

    it('does not change behavior for deterministic (non-stateful) tools', () => {
      const event = toolCall('read_file', { file_path: '/a' });
      for (let i = 0; i < TOOL_CALL_LOOP_THRESHOLD - 1; i++) {
        guard(event);
        // Results are recorded but ignored for non-stateful tools: identical
        // args still mean an identical result, so the argument-only guard
        // must fire unchanged.
        service.recordToolResult(
          { name: 'read_file', args: { file_path: '/a' } },
          [fnResponse('read_file', { output: `content v${i}` }, `call-${i}`)],
        );
      }
      expectFired(guard(event), CONSECUTIVE);
    });

    it('records results by callId pairing from ToolCallRequest events', () => {
      for (let i = 0; i < TOOL_CALL_LOOP_THRESHOLD - 1; i++) {
        expect(guard(taskListEvent(`call-${i}`))).toBe(false);
        expect(
          service.recordToolResultByCallId(
            `call-${i}`,
            taskListResult(`board state v${i}`, `call-${i}`),
          ),
        ).toBe(false);
      }
      // Changed results arrived through the callId pairing, so the
      // threshold-th identical request is accepted.
      expect(guard(taskListEvent(`call-${TOOL_CALL_LOOP_THRESHOLD - 1}`))).toBe(
        false,
      );
      // Unknown callIds (never streamed through this service) are ignored.
      expect(
        service.recordToolResultByCallId('never-seen', taskListResult('x')),
      ).toBe(false);
    });

    it('counts global duplicates on (call, result) pairs when heuristics run', () => {
      const interleaved = ['task_list', 'tool_b', 'tool_c'];
      const argsFor = (name: string, round: number) =>
        name === 'task_list' ? TASK_LIST_ARGS : { step: round };
      // Identical task_list calls whose results CHANGE never reach the
      // global-duplicate threshold, no matter how they are interleaved.
      const heuristicService = newService(heuristicsOn(), 'global-dup');
      let stateOrdinal = 0;
      for (let round = 0; round < 3; round++) {
        for (const name of interleaved) {
          const args = argsFor(name, round);
          expect(heuristicService.addAndCheck(toolCall(name, args))).toBe(
            false,
          );
          if (name === 'task_list') {
            const result = taskListResult(`state-${stateOrdinal++}`);
            expect(record(result, heuristicService)).toBe(false);
          }
        }
      }

      // A genuinely stuck poll — same call, SAME result, interleaved so the
      // consecutive guard never fires — trips the result-aware global
      // duplicate at the threshold.
      const stuckService = newService(heuristicsOn(), 'global-dup-stuck');
      const detected = fires(GLOBAL_DUPLICATE_THRESHOLD, (round) =>
        interleaved.some((name) => {
          const args = argsFor(name, round);
          if (stuckService.addAndCheck(toolCall(name, args))) return true;
          const frozen = taskListResult('frozen board');
          return name === 'task_list' && record(frozen, stuckService);
        }),
      );
      expectFired(detected, LoopType.GLOBAL_TOOL_CALL_DUPLICATE, stuckService);
    });

    it('treats changed results as progress for action stagnation', () => {
      // 8+ same-name task_list calls with VARYING args (the consecutive
      // guard never fires) and CHANGING results: productive polling, no
      // ACTION_STAGNATION halt.
      const heuristicService = newService(heuristicsOn(), 'stagnation');
      for (let i = 0; i < 12; i++) {
        const args = { owner: `peer-${i % 3}` };
        expect(heuristicService.addAndCheck(toolCall('task_list', args))).toBe(
          false,
        );
        const result = taskListResult(`state v${i}`);
        expect(record(result, heuristicService, args)).toBe(false);
      }

      // Same shape but the board is FROZEN: the same-name streak is not
      // reset and stagnation fires.
      const frozenService = newService(heuristicsOn(), 'stagnation-frozen');
      const fired = fires(12, (i) => {
        const args = { owner: `peer-${i % 3}` };
        if (frozenService.addAndCheck(toolCall('task_list', args))) return true;
        record(taskListResult('frozen board'), frozenService, args);
        return false;
      });
      expectFired(fired, LoopType.ACTION_STAGNATION, frozenService);
    });

    it('resets result evidence on retry so a replay is judged on its own results', () => {
      for (let i = 0; i < TOOL_CALL_LOOP_THRESHOLD - 1; i++) {
        guard(taskListEvent(`call-${i}`));
        record(taskListResult(UNCHANGED));
      }
      expect(guard(RETRY)).toBe(false);

      // After the retry the replayed attempt starts with fresh evidence:
      // four unchanged results are not yet enough to halt.
      for (let i = 0; i < TOOL_CALL_LOOP_THRESHOLD - 1; i++) {
        expect(guard(taskListEvent(`replay-${i}`))).toBe(false);
        record(taskListResult(UNCHANGED));
      }
      expect(guard(taskListEvent('replay-4'))).toBe(true);
    });

    it('clears stateful tracking on reset()', () => {
      guard(taskListEvent('call-0'));
      record(taskListResult(UNCHANGED));
      service.reset('fresh-prompt');

      // Changed results in the fresh prompt must not be compared against
      // the previous prompt's fingerprint.
      const fired = poll(4 * TOOL_CALL_LOOP_THRESHOLD, (i) =>
        taskListResult(`fresh v${i}`),
      );
      expect(fired).toBe(false);
    });
  });
});
