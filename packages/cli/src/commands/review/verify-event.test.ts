/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import yargs from 'yargs';
import type { Argv } from 'yargs';
import { readPendingReviewEvents } from './lib/review-events.js';
import { runVerifyEvent, verifyEventCommand } from './verify-event.js';

let home: string;
let root: string;

const head = 'a'.repeat(40);

function args(overrides: Record<string, unknown> = {}) {
  return {
    pr: 15846,
    repo: 'QwenLM/qwen-code',
    head,
    // The handoff belongs to a session; the environment is deliberately empty
    // here so each test states its owner explicitly.
    sessionId: 'ext-session',
    workspaceRoot: root,
    ...overrides,
  };
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'verify-event-home-')));
  root = realpathSync(mkdtempSync(join(tmpdir(), 'verify-event-root-')));
  vi.stubEnv('QWEN_HOME', join(home, '.qwen'));
  vi.stubEnv('QWEN_RUNTIME_DIR', '');
  vi.stubEnv('QWEN_CODE_SESSION_ID', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('runVerifyEvent', () => {
  it('records an external producer’s clean round, readable by the consumer', () => {
    const result = runVerifyEvent(args({ reviewedBy: 'codex' }));
    expect(result).toMatchObject({
      platform: 'github',
      host: 'github.com',
      eventId: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
    expect(result.path.startsWith(join(home, '.qwen'))).toBe(true);
    expect(result.path.startsWith(root)).toBe(false);
    const { events, unreadable } = readPendingReviewEvents(root);
    expect(unreadable).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toMatchObject({
      schemaVersion: 1,
      reviewedBy: 'codex',
      round: 1,
      target: {
        platform: 'github',
        host: 'github.com',
        ownerRepo: 'qwenlm/qwen-code',
        number: 15846,
        headSha: head,
      },
      verdict: { event: 'APPROVE', critical: 0, suggestion: 0 },
    });
    // The owner is named, but an external producer has no qwen-code artifact.
    expect(events[0]?.event.sessionId).toBe('ext-session');
    expect(events[0]?.event.artifactPath).toBeUndefined();
  });

  it('refuses a handoff with no owning session', () => {
    expect(() => runVerifyEvent(args({ sessionId: undefined }))).toThrow(
      /needs a session/,
    );
    expect(readPendingReviewEvents(root).events).toEqual([]);
  });

  it('defaults the producer attribution and takes the session from the environment', () => {
    vi.stubEnv('QWEN_CODE_SESSION_ID', 'sess-7');
    runVerifyEvent(args({ sessionId: undefined }));
    const { events } = readPendingReviewEvents(root);
    expect(events[0]?.event.reviewedBy).toBe('external-cli');
    expect(events[0]?.event.sessionId).toBe('sess-7');
  });

  it('an explicit session id outranks the environment', () => {
    vi.stubEnv('QWEN_CODE_SESSION_ID', 'sess-7');
    runVerifyEvent(args({ sessionId: 'sess-explicit' }));
    expect(readPendingReviewEvents(root).events[0]?.event.sessionId).toBe(
      'sess-explicit',
    );
  });

  it('records the platform the host selects, without contacting it', () => {
    runVerifyEvent(args({ host: 'code.alibaba-inc.com' }));
    expect(readPendingReviewEvents(root).events[0]?.event.target).toMatchObject(
      {
        platform: 'aone',
        host: 'code.alibaba-inc.com',
      },
    );
  });

  it('normalizes an uppercase head so one head is one dedupe key', () => {
    runVerifyEvent(args({ head: head.toUpperCase() }));
    runVerifyEvent(args({ head }));
    const { events } = readPendingReviewEvents(root);
    expect(events).toHaveLength(1);
    expect(events[0]?.event.target.headSha).toBe(head);
  });

  it('carries the round and the verdict event through', () => {
    runVerifyEvent(args({ round: 4, event: 'COMMENT' }));
    expect(readPendingReviewEvents(root).events[0]?.event).toMatchObject({
      round: 4,
      verdict: { event: 'COMMENT', critical: 0 },
    });
  });

  it.each([
    ['pr', { pr: 0 }],
    ['pr fraction', { pr: 1.5 }],
    ['repo', { repo: 'not-a-repo' }],
    ['head', { head: 'zzz' }],
    ['short head', { head: 'abc' }],
    ['event', { event: 'REQUEST_CHANGES' }],
    ['round', { round: 0 }],
    ['host', { host: 'not a hostname' }],
  ])('refuses a malformed %s as a usage error', (_label, override) => {
    expect(() => runVerifyEvent(args(override))).toThrow(TypeError);
    expect(readPendingReviewEvents(root).events).toEqual([]);
  });

  it('refuses to invent github.com for an Aone target with no --host', () => {
    // Platform detection with no explicit host probes the cwd clone's origin,
    // so the refusal is only reachable from an Aone-origin checkout.
    const clone = realpathSync(
      mkdtempSync(join(tmpdir(), 'verify-event-aone-')),
    );
    const cwd = process.cwd();
    try {
      execFileSync('git', ['init', '--quiet'], { cwd: clone });
      execFileSync(
        'git',
        ['remote', 'add', 'origin', 'https://code.alibaba-inc.com/g/p.git'],
        { cwd: clone },
      );
      process.chdir(clone);
      expect(() => runVerifyEvent(args())).toThrow(/needs --host/);
    } finally {
      process.chdir(cwd);
      rmSync(clone, { recursive: true, force: true });
    }
  });

  it('propagates a write failure as a runtime error, not a usage error', () => {
    writeFileSync(join(home, '.qwen'), 'not a directory');
    let thrown: unknown;
    try {
      runVerifyEvent(args());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(TypeError);
  });
});

describe('verifyEventCommand', () => {
  function parse(argv: string[]) {
    return (verifyEventCommand.builder as (y: Argv) => Argv)(
      yargs([]),
    ).parseSync(argv);
  }

  it('writes the event and prints one JSON object on stdout', () => {
    const stdout: string[] = [];
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown) => {
        stdout.push(String(chunk));
        return true;
      });
    try {
      verifyEventCommand.handler!(
        parse([
          '--pr',
          '15846',
          '--repo',
          'QwenLM/qwen-code',
          '--head',
          head,
          '--reviewed-by',
          'claude-code',
          '--session-id',
          'cli-session',
          '--workspace-root',
          root,
        ]) as never,
      );
    } finally {
      spy.mockRestore();
    }
    expect(process.exitCode ?? 0).toBe(0);
    const printed = JSON.parse(stdout.join(''));
    expect(printed).toMatchObject({ platform: 'github', host: 'github.com' });
    expect(existsSync(printed.path)).toBe(true);
    expect(JSON.parse(readFileSync(printed.path, 'utf8')).reviewedBy).toBe(
      'claude-code',
    );
  });

  it('exit 2 on a usage error, and nothing is written', () => {
    const previous = process.exitCode;
    process.exitCode = undefined;
    try {
      verifyEventCommand.handler!(
        parse([
          '--pr',
          '15846',
          '--repo',
          'QwenLM/qwen-code',
          '--head',
          'nope',
          '--workspace-root',
          root,
        ]) as never,
      );
      expect(process.exitCode).toBe(2);
      expect(readPendingReviewEvents(root).events).toEqual([]);
    } finally {
      process.exitCode = previous;
    }
  });
});
