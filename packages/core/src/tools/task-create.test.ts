/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { TaskCreateTool } from './task-create.js';

vi.mock('../config/storage.js', () => {
  let mockDir = '/tmp/test';
  return {
    Storage: {
      getGlobalQwenDir: () => mockDir,
    },
    __setMockGlobalDir: (d: string) => {
      mockDir = d;
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { __setMockGlobalDir } = (await import('../config/storage.js')) as any;

let tmpDir: string;

function makeConfig(teamName = 'test-team') {
  return {
    getTeamContext: () => ({ teamName }),
  } as unknown as import('../config/config.js').Config;
}

function makeConfigNoTeam() {
  return {
    getTeamContext: () => null,
  } as unknown as import('../config/config.js').Config;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-create-test-'));
  __setMockGlobalDir(tmpDir);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('TaskCreateTool', () => {
  let tool: TaskCreateTool;

  beforeEach(() => {
    tool = new TaskCreateTool(makeConfig());
  });

  it('has the correct name', () => {
    expect(tool.name).toBe('task_create');
  });

  it('creates a task with real file I/O', async () => {
    const invocation = tool.build({
      subject: 'Fix bug',
      description: 'Fix the login bug',
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('Fix bug');
    expect(result.llmContent).toMatch(/#\d+/);
  });

  it('accepts optional metadata', async () => {
    const invocation = tool.build({
      subject: 'Deploy',
      description: 'Deploy to prod',
      activeForm: 'Deploying',
      metadata: { priority: 'high' },
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
  });

  it('returns error when no team is active', async () => {
    const noTeamTool = new TaskCreateTool(makeConfigNoTeam());
    const invocation = noTeamTool.build({
      subject: 'Test',
      description: 'Test desc',
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeDefined();
    expect(result.llmContent).toContain('No active team');
  });

  it('validates required params', () => {
    expect(() => tool.build({} as never)).toThrow();
    expect(() => tool.build({ subject: 'x' } as never)).toThrow();
  });

  // ─── Permission surface ───────────────────────────────────
  // A regression back to 'allow' (or to the base '' classifier
  // sentinel) silently re-opens the task-injection path: the AUTO
  // classifier would rule on task_create({}) and always allow.

  it("defaults to 'ask' permission", async () => {
    const invocation = tool.build({
      subject: 'Injected',
      description: 'do something sneaky',
    });
    await expect(invocation.getDefaultPermission()).resolves.toBe('ask');
  });

  it('projects subject and description to the AUTO classifier', () => {
    const projected = tool.toAutoClassifierInput({
      subject: 'Fix bug',
      description: 'the instruction text',
    });
    expect(projected).toEqual({
      subject: 'Fix bug',
      description: 'the instruction text',
    });
  });

  it('shows the description in the confirmation prompt', async () => {
    const invocation = tool.build({
      subject: 'Fix bug',
      description: 'The full instruction text a teammate will execute.',
    });
    const details = await invocation.getConfirmationDetails(
      new AbortController().signal,
    );
    expect(details.type).toBe('info');
    expect((details as { prompt: string }).prompt).toContain(
      'The full instruction text a teammate will execute.',
    );
  });
});
