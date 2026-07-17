/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { WorkflowTool } from './workflow.js';
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

describe('WorkflowTool', () => {
  it('runs an inline script, surfaces phases, returns { runId, result }', async () => {
    const spawner: AgentSpawner = {
      spawn: async () => ({ text: 'done', tokens: 2 }) as AgentSpawnResult,
    };
    const { config, registry, activities } = fakeConfig(
      spawner,
      '/tmp/wf-test-runs',
    );
    const tool = new WorkflowTool(config);
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
  });

  it('surfaces an invalid script as a tool error', async () => {
    const spawner: AgentSpawner = {
      spawn: async () => ({ text: '', tokens: 0 }),
    };
    const { config, registry } = fakeConfig(spawner, '/tmp/wf-test-runs');
    const tool = new WorkflowTool(config);
    const inv = tool.build({ script: `const broken = (;` });
    const res = await inv.execute(new AbortController().signal);
    expect(res.error?.type).toBeDefined();
    expect(registry.fail).toHaveBeenCalled();
  });
});
