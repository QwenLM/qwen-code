/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveReviewWorkflowConcurrency,
  resolveReviewWorkflowLimits,
} from './review-workflow.js';

describe('generated review workflow limits', () => {
  let root: string;
  let generated: string;
  let script: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-workflow-'));
    generated = path.join(root, 'generated');
    script = path.join(generated, 'review', 'session', 'wave.js');
    await fs.mkdir(path.dirname(script), { recursive: true });
    await fs.writeFile(script, 'return 1;');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('gives generated review scripts enough time for a large review wave', async () => {
    expect(await resolveReviewWorkflowLimits(script, generated, {})).toEqual({
      subagent: { max_turns: 500, max_time_minutes: 100 },
      concurrency: 10,
      maxWallClockMs: 21_600_000,
    });
  });

  it('honors operator limits and clamps the per-agent hard ceilings', async () => {
    expect(
      await resolveReviewWorkflowLimits(script, generated, {
        QWEN_CODE_WORKFLOW_AGENT_MAX_TURNS: '120',
        QWEN_CODE_WORKFLOW_AGENT_MAX_MINUTES: '45',
        QWEN_CODE_MAX_WORKFLOW_SECONDS: '12000',
        QWEN_CODE_MAX_WORKFLOW_CONCURRENCY: '3',
      }),
    ).toEqual({
      subagent: { max_turns: 120, max_time_minutes: 45 },
      concurrency: 3,
      maxWallClockMs: 12_000_000,
    });
    expect(
      (
        await resolveReviewWorkflowLimits(script, generated, {
          QWEN_CODE_WORKFLOW_AGENT_MAX_TURNS: '999',
          QWEN_CODE_WORKFLOW_AGENT_MAX_MINUTES: '999',
        })
      )?.subagent,
    ).toEqual({ max_turns: 500, max_time_minutes: 100 });
  });

  it('uses review defaults for invalid limits and deadlines', async () => {
    expect(
      await resolveReviewWorkflowLimits(script, generated, {
        QWEN_CODE_WORKFLOW_AGENT_MAX_TURNS: 'invalid',
        QWEN_CODE_WORKFLOW_AGENT_MAX_MINUTES: '-2',
        QWEN_CODE_MAX_WORKFLOW_SECONDS: 'NaN',
        QWEN_REVIEW_DEADLINE_EPOCH: 'invalid',
      }),
    ).toEqual({
      subagent: { max_turns: 500, max_time_minutes: 100 },
      concurrency: 10,
      maxWallClockMs: 21_600_000,
    });
  });

  it('reserves time for compose and never widens an operator timeout', async () => {
    const env = { QWEN_REVIEW_DEADLINE_EPOCH: '4600' };
    expect(
      (await resolveReviewWorkflowLimits(script, generated, env, 1_000_000))
        ?.maxWallClockMs,
    ).toBe(2_400_000);
    expect(
      (
        await resolveReviewWorkflowLimits(
          script,
          generated,
          {
            ...env,
            QWEN_CODE_MAX_WORKFLOW_SECONDS: '30',
          },
          1_000_000,
        )
      )?.maxWallClockMs,
    ).toBe(30_000);
    expect(
      (
        await resolveReviewWorkflowLimits(
          script,
          generated,
          {
            ...env,
            QWEN_REVIEW_DEADLINE_COMPOSE_FLOOR_SECONDS: '0',
          },
          1_000_000,
        )
      )?.maxWallClockMs,
    ).toBe(3_600_000);
    await expect(
      resolveReviewWorkflowLimits(script, generated, env, 3_400_000),
    ).rejects.toThrow(/compose reserve floor/);
  });

  it('classifies the canonical location, not metadata, path prefixes or symlinks', async () => {
    const generic = path.join(generated, 'review-copy', 'wave.js');
    await fs.mkdir(path.dirname(generic));
    await fs.writeFile(
      generic,
      "export const meta = {name:'review-step-3a', description:'review'}; return 1;",
    );
    const link = path.join(path.dirname(script), 'escape.js');
    await fs.symlink(generic, link);
    expect(
      await resolveReviewWorkflowLimits(generic, generated, {}),
    ).toBeUndefined();
    expect(
      await resolveReviewWorkflowLimits(link, generated, {}),
    ).toBeUndefined();
    const alias = path.join(root, 'alias');
    await fs.symlink(generated, alias);
    expect(
      await resolveReviewWorkflowLimits(
        path.join(alias, 'review', 'session', 'wave.js'),
        generated,
        {},
      ),
    ).toBeDefined();
    expect(
      await resolveReviewWorkflowLimits(script, alias, {}),
    ).toBeUndefined();
  });
});

describe('review workflow concurrency shared with admission estimates', () => {
  it.each([
    [{}, 10],
    [{ QWEN_CODE_MAX_TOOL_CONCURRENCY: '7' }, 7],
    [
      {
        QWEN_CODE_MAX_TOOL_CONCURRENCY: '7',
        QWEN_CODE_MAX_WORKFLOW_CONCURRENCY: '3',
      },
      3,
    ],
    [{ QWEN_CODE_MAX_WORKFLOW_CONCURRENCY: '1' }, 1],
    [{ QWEN_CODE_MAX_WORKFLOW_CONCURRENCY: '999' }, 64],
    [
      {
        QWEN_CODE_MAX_WORKFLOW_CONCURRENCY: 'oops',
        QWEN_CODE_MAX_TOOL_CONCURRENCY: '7',
      },
      7,
    ],
    [
      {
        QWEN_CODE_MAX_WORKFLOW_CONCURRENCY: 'oops',
        QWEN_CODE_MAX_TOOL_CONCURRENCY: '0',
      },
      10,
    ],
  ])('resolves %j to %i', (env, expected) => {
    expect(resolveReviewWorkflowConcurrency(env)).toBe(expected);
  });
});
