/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
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
  const source = 'return 1;';
  const filename = `qwen-review-0123456789-${createHash('sha256').update(source).digest('hex')}.js`;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-workflow-'));
    generated = path.join(root, 'generated');
    script = path.join(generated, 'review', 'session', filename);
    await fs.mkdir(path.dirname(script), { recursive: true });
    await fs.writeFile(script, source);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('does not grant review limits to an arbitrary file in the review directory', async () => {
    const arbitrary = path.join(path.dirname(script), 'wave.js');
    await fs.writeFile(arbitrary, source);
    expect(
      await resolveReviewWorkflowLimits(arbitrary, generated, source, {}),
    ).toBeUndefined();
  });

  it('checks the exact source loaded for execution against the filename digest', async () => {
    expect(
      await resolveReviewWorkflowLimits(script, generated, 'return 2;', {}),
    ).toBeUndefined();
    await fs.writeFile(script, 'return 2;');
    expect(
      await resolveReviewWorkflowLimits(script, generated, source, {}),
    ).toBeDefined();
  });

  it('does not fail a loaded workflow when its script disappears during classification', async () => {
    await fs.unlink(script);
    await expect(
      resolveReviewWorkflowLimits(script, generated, source, {}),
    ).resolves.toBeUndefined();
  });

  it('does not fail a loaded workflow when the generated root is not a directory', async () => {
    const rootFile = path.join(root, 'file');
    await fs.writeFile(rootFile, 'not a directory');
    await expect(
      resolveReviewWorkflowLimits(
        script,
        path.join(rootFile, 'generated'),
        source,
        {},
      ),
    ).resolves.toBeUndefined();
  });

  it('gives generated review scripts enough time for a large review wave', async () => {
    expect(
      await resolveReviewWorkflowLimits(script, generated, source, {}),
    ).toEqual({
      subagent: { max_turns: 500, max_time_minutes: 100 },
      concurrency: 10,
      maxWallClockMs: 21_600_000,
    });
  });

  it('honors operator limits and clamps the per-agent hard ceilings', async () => {
    expect(
      await resolveReviewWorkflowLimits(script, generated, source, {
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
        await resolveReviewWorkflowLimits(script, generated, source, {
          QWEN_CODE_WORKFLOW_AGENT_MAX_TURNS: '999',
          QWEN_CODE_WORKFLOW_AGENT_MAX_MINUTES: '999',
        })
      )?.subagent,
    ).toEqual({ max_turns: 500, max_time_minutes: 100 });
  });

  it('uses review defaults for invalid limits and deadlines', async () => {
    expect(
      await resolveReviewWorkflowLimits(script, generated, source, {
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
      (
        await resolveReviewWorkflowLimits(
          script,
          generated,
          source,
          env,
          1_000_000,
        )
      )?.maxWallClockMs,
    ).toBe(2_400_000);
    expect(
      (
        await resolveReviewWorkflowLimits(
          script,
          generated,
          source,
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
          source,
          {
            ...env,
            QWEN_REVIEW_DEADLINE_COMPOSE_FLOOR_SECONDS: '0',
          },
          1_000_000,
        )
      )?.maxWallClockMs,
    ).toBe(3_600_000);
    await expect(
      resolveReviewWorkflowLimits(script, generated, source, env, 3_400_000),
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
      await resolveReviewWorkflowLimits(generic, generated, source, {}),
    ).toBeUndefined();
    expect(
      await resolveReviewWorkflowLimits(link, generated, source, {}),
    ).toBeUndefined();
    const alias = path.join(root, 'alias');
    await fs.symlink(generated, alias);
    expect(
      await resolveReviewWorkflowLimits(
        path.join(alias, 'review', 'session', filename),
        generated,
        source,
        {},
      ),
    ).toBeDefined();
    expect(
      await resolveReviewWorkflowLimits(script, alias, source, {}),
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
