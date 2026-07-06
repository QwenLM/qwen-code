/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Storage,
  readCronTasks,
  updateCronTasks,
  type DurableCronTask,
} from '@qwen-code/qwen-code-core';
import {
  disableTasksForSessions,
  enableTasksForSessions,
  removeTasksForSessions,
} from './scheduled-task-session-lifecycle.js';

function task(over: Partial<DurableCronTask>): DurableCronTask {
  return {
    id: 't',
    cron: '0 9 * * *',
    prompt: 'p',
    recurring: true,
    createdAt: 1_700_000_000_000,
    lastFiredAt: null,
    ...over,
  };
}

describe('scheduled-task session lifecycle', () => {
  let scratch: string;
  let workspace: string;

  beforeEach(async () => {
    scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'sched-lifecycle-'));
    workspace = path.join(scratch, 'workspace');
    await fsp.mkdir(workspace, { recursive: true });
    Storage.setRuntimeBaseDir(scratch);
  });

  afterEach(async () => {
    Storage.setRuntimeBaseDir(null);
    await fsp.rm(scratch, { recursive: true, force: true });
  });

  const seed = (tasks: DurableCronTask[]) =>
    updateCronTasks(workspace, () => tasks);
  const byId = async () =>
    Object.fromEntries((await readCronTasks(workspace)).map((t) => [t.id, t]));

  it('disables only tasks bound to the given sessions', async () => {
    await seed([
      task({ id: 'a', sessionId: 'sess-1' }),
      task({ id: 'b', sessionId: 'sess-2' }),
      task({ id: 'c' }), // unbound
    ]);
    await disableTasksForSessions(workspace, ['sess-1']);
    const tasks = await byId();
    expect(tasks['a']!.enabled).toBe(false);
    expect(tasks['a']!.disabledByArchive).toBe(true); // marked for unarchive
    expect(tasks['b']!.enabled).toBeUndefined(); // other session — untouched
    expect(tasks['c']!.enabled).toBeUndefined(); // unbound — untouched
  });

  it('re-enables archive-disabled tasks (clears flag, resets recurring anchor)', async () => {
    await seed([
      task({
        id: 'a',
        sessionId: 'sess-1',
        enabled: false,
        disabledByArchive: true,
        recurring: true,
        lastFiredAt: 1000,
      }),
      task({
        id: 'b',
        sessionId: 'sess-1',
        enabled: false,
        disabledByArchive: true,
        recurring: false,
        lastFiredAt: 1000,
      }),
    ]);
    const now = 1_700_000_123_456;
    await enableTasksForSessions(workspace, ['sess-1'], now);
    const tasks = await byId();
    expect(tasks['a']!.enabled).toBe(true);
    expect(tasks['a']!.disabledByArchive).toBeUndefined(); // flag cleared
    expect(tasks['a']!.lastFiredAt).toBe(now - (now % 60_000)); // resumed from now
    expect(tasks['b']!.enabled).toBe(true);
    // A one-shot's anchor is createdAt — re-seat it too, or unarchive fires it as
    // a missed slot and deletes it.
    expect(tasks['b']!.createdAt).toBe(now);
    expect(tasks['b']!.lastFiredAt).toBe(now - (now % 60_000));
  });

  it('leaves a user-disabled task disabled across an unarchive (no flag)', async () => {
    // Task the user disabled themselves — enabled:false but NOT disabledByArchive.
    await seed([
      task({ id: 'a', sessionId: 'sess-1', enabled: false, recurring: true }),
    ]);
    await enableTasksForSessions(workspace, ['sess-1'], 1_700_000_123_456);
    expect((await byId())['a']!.enabled).toBe(false); // stays disabled
  });

  it('removes only tasks bound to the given sessions', async () => {
    await seed([
      task({ id: 'a', sessionId: 'sess-1' }),
      task({ id: 'b', sessionId: 'sess-2' }),
      task({ id: 'c' }), // unbound
    ]);
    await removeTasksForSessions(workspace, ['sess-1']);
    expect(Object.keys(await byId()).sort()).toEqual(['b', 'c']);
  });

  it('is a no-op when nothing matches (no write, ordinary sessions untouched)', async () => {
    await seed([task({ id: 'a', sessionId: 'sess-1' })]);
    await disableTasksForSessions(workspace, ['unrelated']);
    await removeTasksForSessions(workspace, ['unrelated']);
    await enableTasksForSessions(workspace, ['unrelated']);
    const tasks = await byId();
    expect(Object.keys(tasks)).toEqual(['a']);
    expect(tasks['a']!.enabled).toBeUndefined();
  });

  it('empty session id list is a no-op', async () => {
    await seed([task({ id: 'a', sessionId: 'sess-1' })]);
    await disableTasksForSessions(workspace, []);
    await removeTasksForSessions(workspace, []);
    await enableTasksForSessions(workspace, []);
    expect(Object.keys(await byId())).toEqual(['a']);
  });
});
