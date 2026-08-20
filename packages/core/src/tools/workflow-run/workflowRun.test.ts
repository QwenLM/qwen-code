/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowRunTool } from './workflowRun.js';
import type { Config } from '../../config/config.js';
import type {
  AgentSpawner,
  AgentSpawnResult,
} from '../../workflows/spawner.js';

/** A Config test double exposing only what the tool touches. */
function fakeConfig(spawner: AgentSpawner, runsDir: string) {
  const activities: Array<{ name: string; description: string }> = [];
  const registry = {
    register: vi.fn(() => ({ id: 't1' })),
    appendActivity: vi.fn(
      (_id: string, a: { name: string; description: string }) =>
        activities.push(a),
    ),
    complete: vi.fn(),
    fail: vi.fn(),
    unregisterForeground: vi.fn(),
    assertCanStartBackgroundAgent: vi.fn(() => {
      throw new Error('MUST NOT be called for a workflow');
    }),
  };
  const config = {
    getBackgroundTaskRegistry: () => registry,
    getWorkingDir: () => runsDir,
    // Injected seam the tool uses to build its engine (see Step 3).
    __workflowSpawner: spawner,
    __workflowRunsDir: runsDir,
  } as unknown as Config;
  return { config, registry, activities };
}

describe('WorkflowRunTool', () => {
  it('runs an inline script, surfaces phases, returns { runId, result }', async () => {
    const spawner: AgentSpawner = {
      spawn: async () => ({ text: 'done', tokens: 2 }) as AgentSpawnResult,
    };
    const { config, registry, activities } = fakeConfig(
      spawner,
      '/tmp/wf-test-runs',
    );
    const tool = new WorkflowRunTool(config);
    const inv = tool.build({
      script: `export const meta = { name: 'demo', description: 'd' };\nphase('Go');\nreturn await agent('hi');`,
    });
    const res = await inv.execute(new AbortController().signal);
    const payload = JSON.parse(res.llmContent as string) as {
      runId: string;
      result: unknown;
    };
    expect(payload.result).toBe('done');
    expect(payload.runId).toMatch(/[0-9a-f-]{36}/);
    expect(registry.register).toHaveBeenCalledTimes(1);
    expect(registry.assertCanStartBackgroundAgent).not.toHaveBeenCalled();
    expect(activities.some((a) => a.description.includes('Go'))).toBe(true);
    expect(registry.complete).toHaveBeenCalled();
    // Finding 2: the foreground registry entry is released on success.
    expect(registry.unregisterForeground).toHaveBeenCalledTimes(1);
  });

  it('surfaces an invalid script as a tool error', async () => {
    const spawner: AgentSpawner = {
      spawn: async () => ({ text: '', tokens: 0 }),
    };
    const { config, registry } = fakeConfig(spawner, '/tmp/wf-test-runs');
    const tool = new WorkflowRunTool(config);
    const inv = tool.build({ script: `const broken = (;` });
    const res = await inv.execute(new AbortController().signal);
    expect(res.error?.type).toBeDefined();
    expect(registry.fail).toHaveBeenCalled();
    // Finding 2: the foreground registry entry is released on failure too.
    expect(registry.unregisterForeground).toHaveBeenCalledTimes(1);
  });

  it('rejects a traversal `name` without reading or executing the target', async () => {
    const spawner: AgentSpawner = {
      spawn: async () => ({ text: 'SHOULD-NOT-RUN', tokens: 0 }),
    };
    const { config, registry } = fakeConfig(spawner, '/tmp/wf-test-runs');
    const tool = new WorkflowRunTool(config);
    for (const name of [
      '../../../../etc/passwd',
      '/etc/passwd',
      'a/b',
      '..',
      'foo\\bar',
    ]) {
      const inv = tool.build({ name });
      const res = await inv.execute(new AbortController().signal);
      expect(res.error?.type).toBe('invalid_tool_params');
      expect(res.error?.message).toContain('invalid workflow name');
    }
    // Validation happens before any registry.register / engine.run, so the
    // rejected traversals never registered a foreground entry.
    expect(registry.register).not.toHaveBeenCalled();
    expect(registry.complete).not.toHaveBeenCalled();
    expect(registry.fail).not.toHaveBeenCalled();
  });

  it('resolves a normal `name` project-then-user from .qwen/workflows', async () => {
    const workingDir = await mkdtemp(join(tmpdir(), 'wf-name-'));
    try {
      const dir = join(workingDir, '.qwen', 'workflows');
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'demo.js'),
        `export const meta = { name: 'demo', description: 'd' };\nreturn await agent('hi');`,
      );
      const spawner: AgentSpawner = {
        spawn: async () => ({ text: 'from-project', tokens: 1 }),
      };
      const { config } = fakeConfig(spawner, workingDir);
      const tool = new WorkflowRunTool(config);
      const inv = tool.build({ name: 'demo' });
      const res = await inv.execute(new AbortController().signal);
      const payload = JSON.parse(res.llmContent as string) as {
        result: unknown;
      };
      expect(payload.result).toBe('from-project');
    } finally {
      await rm(workingDir, { recursive: true, force: true });
    }
  });

  it('runs a script from an arbitrary scriptPath outside .qwen/workflows', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wf-path-'));
    try {
      const scriptPath = join(dir, 'anywhere.js');
      await writeFile(
        scriptPath,
        `export const meta = { name: 'p', description: 'd' };\nreturn await agent('hi');`,
      );
      const spawner: AgentSpawner = {
        spawn: async () => ({ text: 'from-path', tokens: 1 }),
      };
      const { config } = fakeConfig(spawner, '/tmp/wf-test-runs');
      const tool = new WorkflowRunTool(config);
      const inv = tool.build({ scriptPath });
      const res = await inv.execute(new AbortController().signal);
      const payload = JSON.parse(res.llmContent as string) as {
        result: unknown;
      };
      expect(payload.result).toBe('from-path');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
