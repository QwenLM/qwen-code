/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { parseLoopArgs } from './loopCommand.js';

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

describe('parseLoopArgs — subcommands', () => {
  it('parses "status"', () => {
    expect(parseLoopArgs('status')).toMatchObject({ subcommand: 'status' });
  });

  it('parses "stop"', () => {
    expect(parseLoopArgs('stop')).toMatchObject({ subcommand: 'stop' });
  });

  it('parses "pause"', () => {
    expect(parseLoopArgs('pause')).toMatchObject({ subcommand: 'pause' });
  });

  it('parses "resume"', () => {
    expect(parseLoopArgs('resume')).toMatchObject({ subcommand: 'resume' });
  });

  it('parses "restore"', () => {
    expect(parseLoopArgs('restore')).toMatchObject({ subcommand: 'restore' });
  });

  it('parses "list"', () => {
    expect(parseLoopArgs('list')).toMatchObject({ subcommand: 'list' });
  });

  it('parses subcommand with target ID', () => {
    const result = parseLoopArgs('stop my-loop');
    expect(result.subcommand).toBe('stop');
    expect(result.targetId).toBe('my-loop');
    expect(result.targetAll).toBe(false);
  });

  it('parses subcommand with --all', () => {
    const result = parseLoopArgs('stop --all');
    expect(result.subcommand).toBe('stop');
    expect(result.targetAll).toBe(true);
  });

  it('parses subcommand with target ID and --all', () => {
    const result = parseLoopArgs('pause my-loop --all');
    expect(result.subcommand).toBe('pause');
    expect(result.targetId).toBe('my-loop');
    expect(result.targetAll).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Start — interval parsing
// ---------------------------------------------------------------------------

describe('parseLoopArgs — start with interval', () => {
  it('parses leading interval + prompt', () => {
    const result = parseLoopArgs('5m check CI');
    expect(result.intervalMs).toBe(300_000);
    expect(result.prompt).toBe('check CI');
    expect(result.subcommand).toBeUndefined();
  });

  it('defaults to 10m when no interval', () => {
    const result = parseLoopArgs('check the build');
    expect(result.intervalMs).toBe(600_000);
    expect(result.prompt).toBe('check the build');
  });

  it('parses seconds', () => {
    expect(parseLoopArgs('30s test').intervalMs).toBe(30_000);
  });

  it('parses hours', () => {
    expect(parseLoopArgs('2h test').intervalMs).toBe(7_200_000);
  });

  it('parses days', () => {
    expect(parseLoopArgs('1d test').intervalMs).toBe(86_400_000);
  });

  it('returns empty prompt for interval only', () => {
    expect(parseLoopArgs('5m').prompt).toBe('');
  });

  it('returns empty prompt for empty input', () => {
    expect(parseLoopArgs('').prompt).toBe('');
  });
});

// ---------------------------------------------------------------------------
// --id flag
// ---------------------------------------------------------------------------

describe('parseLoopArgs — --id flag', () => {
  it('parses --id with interval', () => {
    const result = parseLoopArgs('5m --id ci check CI');
    expect(result.loopId).toBe('ci');
    expect(result.intervalMs).toBe(300_000);
    expect(result.prompt).toBe('check CI');
  });

  it('parses --id without interval', () => {
    const result = parseLoopArgs('--id deploy check deploy');
    expect(result.loopId).toBe('deploy');
    expect(result.prompt).toBe('check deploy');
  });

  it('--id without value falls through to prompt', () => {
    const result = parseLoopArgs('5m --id');
    // --id is the last token, no value → not consumed as --id
    // Actually: tokens[startIndex]='--id', startIndex+1 >= length → not consumed
    // prompt = '--id'
    expect(result.prompt).toBe('--id');
    expect(result.loopId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// --max flag
// ---------------------------------------------------------------------------

describe('parseLoopArgs — --max flag', () => {
  it('parses --max with value', () => {
    const result = parseLoopArgs('5m --max 10 check CI');
    expect(result.maxIterations).toBe(10);
    expect(result.prompt).toBe('check CI');
  });

  it('--max without value returns empty prompt (usage error)', () => {
    expect(parseLoopArgs('5m --max').prompt).toBe('');
  });

  it('--max with invalid value returns empty prompt', () => {
    expect(parseLoopArgs('5m --max foo check').prompt).toBe('');
  });

  it('--max with 0 returns empty prompt', () => {
    expect(parseLoopArgs('5m --max 0 check').prompt).toBe('');
  });

  it('--max with negative returns empty prompt', () => {
    expect(parseLoopArgs('5m --max -1 check').prompt).toBe('');
  });

  it('combines --id and --max', () => {
    const result = parseLoopArgs('1h --id ci --max 5 summarize');
    expect(result.loopId).toBe('ci');
    expect(result.maxIterations).toBe(5);
    expect(result.prompt).toBe('summarize');
    expect(result.intervalMs).toBe(3_600_000);
  });
});

// ---------------------------------------------------------------------------
// Trailing "every" syntax
// ---------------------------------------------------------------------------

describe('parseLoopArgs — trailing every', () => {
  it('parses trailing "every Nm"', () => {
    const result = parseLoopArgs('check the deploy every 20m');
    expect(result.intervalMs).toBe(1_200_000);
    expect(result.prompt).toBe('check the deploy');
  });

  it('parses trailing "every N minutes"', () => {
    const result = parseLoopArgs('run tests every 5 minutes');
    expect(result.intervalMs).toBe(300_000);
    expect(result.prompt).toBe('run tests');
  });

  it('parses trailing "every N hours"', () => {
    const result = parseLoopArgs('check status every 2 hours');
    expect(result.intervalMs).toBe(7_200_000);
    expect(result.prompt).toBe('check status');
  });

  it('does not match "every" not followed by time', () => {
    const result = parseLoopArgs('check every PR');
    expect(result.prompt).toBe('check every PR');
    expect(result.intervalMs).toBe(600_000); // default
  });

  it('leading interval takes precedence over trailing every', () => {
    const result = parseLoopArgs('5m check deploy every 20m');
    // Leading interval 5m is parsed, trailing "every" is not checked
    expect(result.intervalMs).toBe(300_000);
    expect(result.prompt).toBe('check deploy every 20m');
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('parseLoopArgs — edge cases', () => {
  it('handles whitespace-only input', () => {
    expect(parseLoopArgs('   ').prompt).toBe('');
  });

  it('normalizes multiple spaces in prompt', () => {
    const result = parseLoopArgs('5m  check   CI   status');
    expect(result.prompt).toBe('check CI status');
  });

  it('prompt that looks like a subcommand after interval', () => {
    // "status" as first token → subcommand. But "5m status check" → prompt
    const result = parseLoopArgs('5m status check');
    expect(result.subcommand).toBeUndefined();
    expect(result.prompt).toBe('status check');
  });
});
