/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * End-to-end tests for the cron pipeline: tool → cron-tasks → cron-scheduler
 * → cron manager → message queue.
 *
 * Mock surface (kept minimal and limited to environment seams):
 *   - chokidar:                 watcher is captured but does not touch fs.
 *   - messageQueueManager:      enqueuePendingNotification is replaced with a
 *                               spy so we can assert what would have been
 *                               injected into the conversation queue.
 *   - utils/events, runLogger:  silenced (noisy and irrelevant here).
 *
 * Real surface (NOT mocked):
 *   - cron-tasks (session-only path; no fs needed)
 *   - cron-scheduler (full check loop with fake timers)
 *   - CronManager (per-session lifecycle)
 *   - the three cron tools (CronCreate / CronDelete / CronList)
 *   - registerLoopSkill (skill body assertions for the /loop interval mapping)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock state — shared between the vi.mock factories and the test body.
// ---------------------------------------------------------------------------

const { watcherCapture, enqueueMock, emitFeedbackMock } = vi.hoisted(() => ({
  watcherCapture: {
    changeHandler: null as null | (() => void),
    addHandler: null as null | (() => void),
    unlinkHandler: null as null | (() => void),
  },
  enqueueMock: vi.fn(),
  emitFeedbackMock: vi.fn(),
}));

vi.mock('chokidar', () => ({
  default: {
    watch: vi.fn(() => {
      const watcher: {
        on: (event: string, handler: () => void) => typeof watcher;
        close: () => Promise<void>;
      } = {
        on: vi.fn((event: string, handler: () => void) => {
          if (event === 'change') watcherCapture.changeHandler = handler;
          else if (event === 'add') watcherCapture.addHandler = handler;
          else if (event === 'unlink') watcherCapture.unlinkHandler = handler;
          return watcher;
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };
      return watcher;
    }),
  },
}));

vi.mock('../services/messageQueueManager.js', () => ({
  enqueuePendingNotification: enqueueMock,
}));

vi.mock('../utils/events.js', () => ({
  coreEvents: {
    emitFeedback: emitFeedbackMock,
  },
}));

vi.mock('../utils/runLogger.js', () => ({
  runLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports — must come after vi.mock above.
// ---------------------------------------------------------------------------

import { CronCreateTool } from '../tools/cron-create.js';
import { CronDeleteTool } from '../tools/cron-delete.js';
import { CronListTool } from '../tools/cron-list.js';
import { CronManager } from './cronManager.js';
import { registerLoopSkill } from '../skills/bundled/loop.js';
import type { CronCreateResultDisplay } from '../tools/tools.js';
import type { SkillDefinition } from '@qwen-code/resource';

/**
 * One real manager standing in for one real session.
 *
 * The tools no longer reach the scheduler through module-level functions, so
 * the seam is the Config they are built with. A real manager keeps this an
 * end-to-end test: create → schedule → fire → enqueue all run for real, and
 * only the queue, the feedback bus and the file watcher stay mocked.
 */
const cronManager = new CronManager({
  getSessionId: () => 'test-session',
});

/** Minimal Config stand-in: the cron tools only need the manager. */
const fakeConfig = {
  getSessionId: () => 'test-session',
  getProjectRoot: () => process.cwd(),
  getCronManager: () => cronManager,
} as unknown as import('../config/config.js').Config;

const clearSessionTasks = (): void => cronManager.clearSessionTasks();

// ---------------------------------------------------------------------------
// Helpers — same patterns used by cron-integration.test.ts.
// ---------------------------------------------------------------------------

/**
 * Yield to libuv so real fs callbacks can complete even while
 * setInterval/setTimeout are mocked. setImmediate is intentionally left real
 * (see toFake list) so this loop actually drains.
 *
 * The leading `await import('chokidar')` works around vitest's fake-timer
 * interaction with the scheduler's dynamic chokidar import — forcing a fresh
 * resolution unblocks the scheduler's pending `await import()` inside enable().
 */
async function flushAsync(): Promise<void> {
  await import('chokidar');
  for (let i = 0; i < 60; i++) {
    await new Promise(resolve => setImmediate(resolve));
    await Promise.resolve();
  }
}

/**
 * Block until the scheduler's enable() finishes (it captures chokidar
 * handlers only after `await import()` and the lock acquisition resolve).
 */
async function waitForSchedulerReady(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (watcherCapture.changeHandler) {
      await flushAsync();
      return;
    }
    await import('chokidar');
    await new Promise(resolve => setImmediate(resolve));
    await Promise.resolve();
  }
  throw new Error('scheduler enable() did not complete in time');
}

/**
 * Advance the fake clock in 1s slices so every check-tick can flush its
 * fire-and-forget IO before the next tick lands.
 */
async function advanceChunked(totalMs: number): Promise<void> {
  let remaining = totalMs;
  while (remaining > 0) {
    const step = Math.min(remaining, 1000);
    await vi.advanceTimersByTimeAsync(step);
    await flushAsync();
    remaining -= step;
  }
}

function makeAbortSignal(): AbortSignal {
  return new AbortController().signal;
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Reset mocks / hoisted capture between tests so cross-test bleed cannot
  // mask a failure.
  enqueueMock.mockClear();
  emitFeedbackMock.mockClear();
  watcherCapture.changeHandler = null;
  watcherCapture.addHandler = null;
  watcherCapture.unlinkHandler = null;

  // Drop any session tasks left behind by an earlier scenario.
  clearSessionTasks();

  // Match cron-integration.test.ts: keep setImmediate real so libuv work
  // (hypothetical fs callbacks, etc.) can still drain between ticks.
  vi.useFakeTimers({
    toFake: [
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
      'Date',
    ],
  });
  // Anchored before a top-of-minute for a `* * * * *` cron — first match is
  // the next minute boundary.
  vi.setSystemTime(new Date('2026-05-20T10:00:30Z'));
});

afterEach(() => {
  // Reset this session's cron manager so the next test starts cleanly.
  cronManager.stop();
  clearSessionTasks();
  vi.useRealTimers();
});

// ===========================================================================
// Scenario 1 — create → trigger → enqueue
// ===========================================================================

describe('cron E2E', () => {
  describe('Scenario 1: create → trigger → enqueue', () => {
    it('drives a recurring task end-to-end into enqueuePendingNotification', async () => {
      // Step 1 — invoke the public CronCreate tool. This exercises:
      //   • addTask    (session-only because durable=false)
      //   • manager.ensureStarted (lazy per-session bring-up)
      //   • scheduler.start → enable → check timer
      const createInv = new CronCreateTool(fakeConfig).build({
        cron: '* * * * *',
        prompt: 'recurring ping',
        recurring: true,
        durable: false,
      });
      const createResult = await createInv.execute(makeAbortSignal());
      expect(createResult.error).toBeUndefined();

      // Step 2 — wait for enable() to finish (chokidar handler captured).
      await waitForSchedulerReady();

      // Step 3 — advance ~40s so we cross the 10:01:00 boundary plus the
      // jitter cap (~6s) for `* * * * *` under DEFAULT_CRON_JITTER_CONFIG.
      await advanceChunked(40_000);

      // Step 4 — assert the manager forwarded the fire to the message queue
      // with the dedicated commandMode the agent uses to recognize cron
      // injections.
      expect(enqueueMock).toHaveBeenCalled();
      const call = enqueueMock.mock.calls[0][0] as {
        prompt: string;
        commandMode: string;
        priority: string;
        sessionId: string | undefined;
      };
      // Fired prompts carry a "[Running scheduled task (...)]" timestamp prefix.
      expect(call.prompt).toMatch(/^\[Running scheduled task \(.+\)\]\nrecurring ping$/);
      expect(call.commandMode).toBe('task-notification');
      expect(call.priority).toBe('later');
      // Ownership stamp, so the fire is drained by this session and not by
      // whichever session happens to be idle.
      expect(call.sessionId).toBe('test-session');
    });
  });

  // =========================================================================
  // Scenario 2 — create → delete → no fire
  // =========================================================================

  describe('Scenario 2: create → delete → no fire', () => {
    it('does not enqueue after a task is deleted via CronDelete', async () => {
      // Step 1 — create.
      const createInv = new CronCreateTool(fakeConfig).build({
        cron: '* * * * *',
        prompt: 'doomed',
        recurring: true,
        durable: false,
      });
      const createResult = await createInv.execute(makeAbortSignal());
      const createDisplay = createResult.returnDisplay as CronCreateResultDisplay;
      expect(createDisplay.cronResultType).toBe('create');
      const id = createDisplay.id;

      await waitForSchedulerReady();

      // Sanity: CronList sees the new task before deletion.
      const listBefore = await new CronListTool(fakeConfig)
        .build({})
        .execute(makeAbortSignal());
      const listDisplayBefore = listBefore.returnDisplay as {
        cronResultType: string;
        jobs: Array<{ id: string }>;
      };
      expect(listDisplayBefore.jobs.some(j => j.id === id)).toBe(true);

      // Step 2 — delete via the CronDelete tool.
      const deleteInv = new CronDeleteTool(fakeConfig).build({ id });
      const deleteResult = await deleteInv.execute(makeAbortSignal());
      expect(deleteResult.error).toBeUndefined();
      expect(deleteResult.returnDisplay).toMatchObject({
        cronResultType: 'delete',
        id,
      });

      // CronList should now be empty.
      const listAfter = await new CronListTool(fakeConfig)
        .build({})
        .execute(makeAbortSignal());
      const listDisplayAfter = listAfter.returnDisplay as {
        cronResultType: string;
        jobs: Array<{ id: string }>;
      };
      expect(listDisplayAfter.jobs.some(j => j.id === id)).toBe(false);

      // Step 3 — advance well past the trigger boundary; nothing should fire.
      await advanceChunked(90_000);
      expect(enqueueMock).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Scenario 3 — /loop skill: interval → cron mapping & "every" clause
  // =========================================================================

  describe('Scenario 3: /loop skill interval → cron mapping', () => {
    it('skill body documents the leading-token, every-clause, and cron table rules', async () => {
      // Capture whatever registerLoopSkill registers; the body is a prompt
      // template, so we assert its instructions to the LLM are well-formed.
      const captured: SkillDefinition[] = [];
      const registrar = {
        registerBundledSkill: (skill: SkillDefinition) => {
          captured.push(skill);
        },
      };
      registerLoopSkill(registrar);

      expect(captured).toHaveLength(1);
      const skill = captured[0];
      expect(skill.name).toBe('loop');
      expect(skill.userInvocable).toBe(true);
      expect(typeof skill.getBody).toBe('function');

      const getBody = skill.getBody as (args: string) => Promise<string>;

      // Empty input → usage message (the skill's documented escape hatch).
      const usage = await getBody('');
      expect(usage).toMatch(/Usage:\s*\/loop/);
      expect(usage).toContain('Ns, Nm, Nh, Nd');

      // Non-empty input → full prompt template. Parsing now happens in TS
      // (parseLoopArgs): the skill body receives the already-extracted
      // interval + prompt and only documents the interval → cron table.
      const body = await getBody('5m run tests');

      // The pre-parsed interval and prompt are stated explicitly.
      expect(body).toContain('The interval is: `5m`');
      expect(body).toContain('The prompt is: `run tests`');

      // The interval → cron conversion table rows.
      expect(body).toContain('`*/N * * * *`'); // every N minutes row
      expect(body).toContain('`0 */N * * *`'); // every N hours row
      expect(body).toContain('`0 0 */N * *`'); // every N days row

      // Trailing-every parsing is a TS-layer concern now — verify it end to
      // end: an "every" clause input must land in fixed mode with the clause
      // stripped from the prompt.
      const everyBody = await getBody('check the deploy every 20m');
      expect(everyBody).toContain('The interval is: `20m`');
      expect(everyBody).toContain('The prompt is: `check the deploy`');

      // "every PR" is not a time expression — must fall through to dynamic mode.
      const dynamicBody = await getBody('check every PR');
      expect(dynamicBody).toContain('dynamic-pacing mode');
      expect(dynamicBody).toContain('check every PR');
    });
  });

  // =========================================================================
  // Scenario 4 — isLoading delays fire until the agent is idle
  // =========================================================================

  describe('Scenario 4: isLoading delays fire', () => {
    it('suppresses enqueue while loading=true and resumes after the gate flips', async () => {
      // Step 1 — pre-start the scheduler with our gated isLoading. The tool's
      // own ensureStarted() call later is a no-op because this manager is
      // already started, so the provider installed here is the one it uses.
      let loading = true;
      cronManager.setIsLoadingProvider(() => loading);
      cronManager.ensureStarted();

      // Step 2 — create the task.
      const inv = new CronCreateTool(fakeConfig).build({
        cron: '* * * * *',
        prompt: 'busy-prompt',
        recurring: true,
        durable: false,
      });
      const createResult = await inv.execute(makeAbortSignal());
      expect(createResult.error).toBeUndefined();

      await waitForSchedulerReady();

      // Step 3 — advance well past the first minute boundary while loading.
      // check() bails before any fire while isLoading() is true, so no
      // enqueue should land.
      await advanceChunked(60_000);
      expect(enqueueMock).not.toHaveBeenCalled();

      // Step 4 — flip the gate; the next tick observes loading=false and
      // fires (the task is by now well past its scheduled time).
      loading = false;
      await advanceChunked(2_000);

      expect(enqueueMock).toHaveBeenCalled();
      const call = enqueueMock.mock.calls[0][0] as {
        prompt: string;
        commandMode: string;
      };
      // Fired prompts carry a "[Running scheduled task (...)]" timestamp prefix.
      expect(call.prompt).toMatch(/^\[Running scheduled task \(.+\)\]\nbusy-prompt$/);
      expect(call.commandMode).toBe('task-notification');
    });
  });
});
