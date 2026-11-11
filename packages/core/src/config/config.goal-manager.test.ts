/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { makeFakeConfig } from '../test-utils/config.js';
import { setConfigHomeDirOverride } from '../utils/paths.js';
import { Storage } from './storage.js';
import { getGoalStateAttachment } from '../attachments/generators/goal-generators.js';
import { getGoalHooksConfiguration } from '../goal/registerGoalHooks.js';
import { HookEventName, HookType } from '../hooks/types.js';
import {
  CreateGoalTool,
  GetGoalTool,
  UpdateGoalTool,
} from '../tools/goalTools.js';

describe('Config.getGoalManager', () => {
  let configHome: string;

  beforeEach(() => {
    configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-manager-'));
    setConfigHomeDirOverride(configHome);
  });

  afterEach(() => {
    setConfigHomeDirOverride(undefined);
    fs.rmSync(configHome, { recursive: true, force: true });
  });

  const goalFile = (sessionId: string) =>
    path.join(Storage.getProjectStateDir(), 'goals', `${sessionId}.json`);

  it('skips attachments before a Config exists without creating session files', () => {
    expect(getGoalStateAttachment(undefined)).toEqual([]);
    expect(
      fs.existsSync(path.join(Storage.getProjectStateDir(), 'goals')),
    ).toBe(false);
  });

  it('keeps tools, attachments and registered Stop hooks on their owning Config', async () => {
    const a = makeFakeConfig({ sessionId: 'session-a' });
    const createA = new CreateGoalTool(a);
    const readA = new GetGoalTool(a);
    const updateA = new UpdateGoalTool(a);
    const hook = getGoalHooksConfiguration(a)[HookEventName.Stop]![0].hooks[0];
    if (hook.type !== HookType.Runtime)
      throw new Error('Expected a runtime hook');

    // Constructing B must not disturb A: A's consumers continue using A,
    // including tools and hooks created before B existed.
    const b = makeFakeConfig({ sessionId: 'session-b' });
    b.getGoalManager().setGoal({ objective: 'Goal of B' });
    const signal = new AbortController().signal;
    await createA.build({ objective: 'Goal of A' }).execute(signal);
    expect((await readA.build({}).execute(signal)).llmContent).toContain(
      'Goal of A',
    );
    expect(getGoalStateAttachment(a)[0].objective).toBe('Goal of A');
    expect(getGoalStateAttachment(b)[0].objective).toBe('Goal of B');

    const input = {
      session_id: 'session-a',
      transcript_path: '',
      cwd: process.cwd(),
      hook_event_name: 'Stop',
    };
    expect((await hook.action(input, { signal }))?.decision).toBe('deny');
    expect(a.getGoalManager().getGoal()?.turnsUsed).toBe(1);
    expect(b.getGoalManager().getGoal()?.turnsUsed).toBe(0);
    await updateA.build({ status: 'complete' }).execute(signal);
    expect((await hook.action(input, { signal }))?.decision).toBe('allow');
    expect(a.getGoalManager().getGoal()).toBeNull();
    expect(b.getGoalManager().isGoalActive).toBe(true);

    // /clear reuses Config: retained tools/hooks resolve the new manager when
    // their next invocation begins instead of caching the previous instance.
    const createC = createA.build({ objective: 'Goal of C' });
    a.setSessionId('session-c');
    await createC.execute(signal);
    expect((await readA.build({}).execute(signal)).llmContent).toContain(
      'Goal of C',
    );
    await hook.action({ ...input, session_id: 'session-c' }, { signal });
    expect(a.getGoalManager().getGoal()?.turnsUsed).toBe(1);
    expect(b.getGoalManager().getGoal()?.objective).toBe('Goal of B');
    expect(fs.existsSync(goalFile('session-c'))).toBe(true);
    expect(fs.existsSync(goalFile('unknown'))).toBe(false);
  });

  it('reuses the manager until the session changes and persists each goal in its own file', () => {
    const config = makeFakeConfig({ sessionId: 'session-a' });
    const before = config.getGoalManager();
    expect(config.getGoalManager()).toBe(before);
    expect(before.sessionId).toBe('session-a');
    before.setGoal({ objective: 'Goal of A' });
    expect(fs.existsSync(goalFile('session-a'))).toBe(true);

    config.setSessionId('session-b');
    const after = config.getGoalManager();

    expect(after).not.toBe(before);
    expect(after.sessionId).toBe('session-b');
    expect(after.getGoal()).toBeNull();

    after.setGoal({ objective: 'Goal of B' });

    expect(fs.existsSync(goalFile('session-b'))).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(goalFile('session-a'), 'utf-8')).objective,
    ).toBe('Goal of A');
    expect(
      JSON.parse(fs.readFileSync(goalFile('session-b'), 'utf-8')).objective,
    ).toBe('Goal of B');
  });
});
