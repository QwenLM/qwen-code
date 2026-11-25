/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ENV_REPEATED_TOOL_CALL_THRESHOLD } from '../config/brand.js';
import {
  buildRepeatedToolCallKey,
  DoomLoopGuard,
  stableJson,
} from './doom-loop-guard.js';
import type { ModelToolUseBlock } from '../provider/event/modelCompleteEvent.js';

function block(input: Record<string, unknown>, name = 'Read'): ModelToolUseBlock {
  return {
    type: 'tool_use',
    id: `toolu_${Math.random().toString(16).slice(2)}`,
    name,
    input,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('stableJson', () => {
  it('recursively sorts object keys', () => {
    expect(stableJson({ b: 1, a: { d: 4, c: 3 } })).toBe(
      stableJson({ a: { c: 3, d: 4 }, b: 1 }),
    );
  });

  it('matches JSON.stringify semantics for undefined and non-finite numbers', () => {
    expect(stableJson({ a: undefined, b: NaN, c: Infinity })).toBe(
      '{"b":null,"c":null}',
    );
  });

  it('serializes Date through toJSON', () => {
    expect(stableJson({ at: new Date('2026-06-09T00:00:00.000Z') })).toBe(
      '{"at":"2026-06-09T00:00:00.000Z"}',
    );
  });

  it('throws on circular references (tool inputs from model JSON are never circular)', () => {
    const value: Record<string, unknown> = {};
    value['self'] = value;
    expect(() => stableJson(value)).toThrow();
  });
});

describe('DoomLoopGuard', () => {
  it('detects the fifth consecutive identical tool call by default', () => {
    const guard = new DoomLoopGuard();
    const input = { file_path: '/tmp/a' };

    for (let i = 0; i < 4; i++) {
      expect(guard.check(block(input)).detected).toBe(false);
    }

    const fifth = guard.check(block(input));
    expect(fifth.detected).toBe(true);
    expect(fifth.detection?.repeatCount).toBe(5);
    expect(fifth.detection?.threshold).toBe(5);
  });

  it('neutralizes repeated polls without allowing subsequent failures forever', () => {
    const guard = new DoomLoopGuard({ threshold: 3 });
    const input = { cell_id: 'cell' };
    const key = buildRepeatedToolCallKey('CodeModeWait', input);
    for (let i = 0; i < 10; i++) {
      expect(guard.check(block(input, 'CodeModeWait')).detected).toBe(false);
      guard.neutralize(key);
    }
    expect(guard.check(block(input, 'CodeModeWait')).detected).toBe(false);
    expect(guard.check(block(input, 'CodeModeWait')).detected).toBe(false);
    expect(guard.check(block(input, 'CodeModeWait')).detected).toBe(true);
  });

  it('does not neutralize a different trailing invocation', () => {
    const guard = new DoomLoopGuard({ threshold: 3 });
    const input = { file_path: '/tmp/a' };
    guard.check(block(input));
    guard.check(block(input));
    guard.neutralize(
      buildRepeatedToolCallKey('CodeModeWait', { cell_id: 'cell' }),
    );
    expect(guard.check(block(input)).detected).toBe(true);
  });

  it('uses the repeated tool call threshold from the environment', () => {
    vi.stubEnv(ENV_REPEATED_TOOL_CALL_THRESHOLD, '4');
    const guard = new DoomLoopGuard();
    const input = { file_path: '/tmp/a' };

    for (let i = 0; i < 3; i++) {
      expect(guard.check(block(input)).detected).toBe(false);
    }

    const fourth = guard.check(block(input));
    expect(fourth.detected).toBe(true);
    expect(fourth.detection?.repeatCount).toBe(4);
    expect(fourth.detection?.threshold).toBe(4);
  });

  it('falls back to the default threshold for invalid environment values', () => {
    vi.stubEnv(ENV_REPEATED_TOOL_CALL_THRESHOLD, 'not-a-number');
    const guard = new DoomLoopGuard();
    const input = { file_path: '/tmp/a' };

    for (let i = 0; i < 4; i++) {
      expect(guard.check(block(input)).detected).toBe(false);
    }

    const fifth = guard.check(block(input));
    expect(fifth.detected).toBe(true);
    expect(fifth.detection?.threshold).toBe(5);
  });

  it('does not record the detected call before permission is resolved', () => {
    const guard = new DoomLoopGuard({ threshold: 3 });
    const input = { file_path: '/tmp/a' };

    guard.check(block(input));
    guard.check(block(input));

    expect(guard.check(block(input)).detected).toBe(true);
    expect(guard.check(block(input)).detected).toBe(true);
  });

  it('records an allow-once decision as the new baseline', () => {
    const guard = new DoomLoopGuard({ threshold: 3 });
    const input = { file_path: '/tmp/a' };

    guard.check(block(input));
    guard.check(block(input));
    const detected = guard.check(block(input));
    expect(detected.detected).toBe(true);
    guard.allowOnce(detected.detection!.inputKey);

    expect(guard.check(block(input)).detected).toBe(false);
    expect(guard.check(block(input)).detected).toBe(true);
  });

  it('resets the trailing count when the tool input changes', () => {
    const guard = new DoomLoopGuard({ threshold: 3 });

    guard.check(block({ command: 'pwd' }, 'Bash'));
    guard.check(block({ command: 'pwd' }, 'Bash'));
    expect(guard.check(block({ command: 'ls' }, 'Bash')).detected).toBe(false);
    expect(guard.check(block({ command: 'pwd' }, 'Bash')).detected).toBe(false);
    expect(guard.check(block({ command: 'pwd' }, 'Bash')).detected).toBe(false);
    expect(guard.check(block({ command: 'pwd' }, 'Bash')).detected).toBe(true);
  });

  it('does not detect an alternating repeated tool-call loop', () => {
    const guard = new DoomLoopGuard({ threshold: 3 });

    expect(guard.check(block({ file_path: '/tmp/a' }, 'Read')).detected).toBe(
      false,
    );
    expect(guard.check(block({ file_path: '/tmp/b' }, 'Read')).detected).toBe(
      false,
    );
    expect(guard.check(block({ file_path: '/tmp/a' }, 'Read')).detected).toBe(
      false,
    );
    expect(guard.check(block({ file_path: '/tmp/b' }, 'Read')).detected).toBe(
      false,
    );

    expect(guard.check(block({ file_path: '/tmp/a' }, 'Read')).detected).toBe(
      false,
    );
    expect(guard.check(block({ file_path: '/tmp/a' }, 'Read')).detected).toBe(
      false,
    );

    const consecutive = guard.check(block({ file_path: '/tmp/a' }, 'Read'));
    expect(consecutive.detected).toBe(true);
    expect(consecutive.detection?.repeatCount).toBe(3);
  });

  it('honors session-scoped exact-call allowlist', () => {
    const allowedKeys = new Set<string>();
    const guard = new DoomLoopGuard({ sessionAllowedKeys: allowedKeys });
    const input = { file_path: '/tmp/a' };
    allowedKeys.add(buildRepeatedToolCallKey('Read', input));

    expect(guard.check(block(input)).detected).toBe(false);
    expect(guard.check(block(input)).detected).toBe(false);
    expect(guard.check(block(input)).detected).toBe(false);
  });

  it('lets a session-allowed call interrupt the current streak', () => {
    const allowedKeys = new Set<string>();
    const guard = new DoomLoopGuard({
      sessionAllowedKeys: allowedKeys,
      threshold: 3,
    });
    const allowedInput = { file_path: '/tmp/allowed' };
    const trackedInput = { command: 'pwd' };
    allowedKeys.add(buildRepeatedToolCallKey('Read', allowedInput));

    guard.check(block(trackedInput, 'Bash'));
    guard.check(block(trackedInput, 'Bash'));
    expect(guard.check(block(allowedInput, 'Read')).detected).toBe(false);

    expect(guard.check(block(trackedInput, 'Bash')).detected).toBe(false);
    expect(guard.check(block(trackedInput, 'Bash')).detected).toBe(false);
    expect(guard.check(block(trackedInput, 'Bash')).detected).toBe(true);
  });

  it('bounds the session-scoped exact-call allowlist', () => {
    const allowedKeys = new Set<string>();
    const guard = new DoomLoopGuard({
      sessionAllowedKeys: allowedKeys,
      sessionAllowedKeyLimit: 2,
    });
    const keyA = buildRepeatedToolCallKey('Read', { file_path: '/tmp/a' });
    const keyB = buildRepeatedToolCallKey('Read', { file_path: '/tmp/b' });
    const keyC = buildRepeatedToolCallKey('Read', { file_path: '/tmp/c' });

    guard.allowForSession(keyA);
    guard.allowForSession(keyB);
    guard.allowForSession(keyC);

    expect(allowedKeys.has(keyA)).toBe(false);
    expect(allowedKeys.has(keyB)).toBe(true);
    expect(allowedKeys.has(keyC)).toBe(true);
  });
});
