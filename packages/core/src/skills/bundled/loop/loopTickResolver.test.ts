/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LOOP_SENTINEL_CRON,
  LOOP_SENTINEL_DYNAMIC,
  LoopTickResolver,
  detectLoopSentinel,
} from './loopTickResolver.js';
import { LOOP_TASK_FILE_MAX_BYTES } from './loopTaskFile.js';

describe('detectLoopSentinel', () => {
  it('recognizes the cron and dynamic sentinels exactly (after trim)', () => {
    expect(detectLoopSentinel(LOOP_SENTINEL_CRON)).toBe('cron');
    expect(detectLoopSentinel(LOOP_SENTINEL_DYNAMIC)).toBe('dynamic');
    expect(detectLoopSentinel(`  ${LOOP_SENTINEL_DYNAMIC}\n`)).toBe('dynamic');
  });

  it('returns null for non-sentinel prompts', () => {
    expect(detectLoopSentinel('/loop check the deploy')).toBeNull();
    expect(detectLoopSentinel('<<loop.md>> and more')).toBeNull();
    expect(detectLoopSentinel('')).toBeNull();
  });
});

describe('LoopTickResolver', () => {
  let tempDir: string;
  let projectRoot: string;
  let homeDir: string;
  let resolver: LoopTickResolver;

  const projectFile = () => path.join(projectRoot, '.qwen', 'loop.md');
  const homeFile = () => path.join(homeDir, '.qwen', 'loop.md');
  const writeProject = (content: string) =>
    fs
      .mkdir(path.join(projectRoot, '.qwen'), { recursive: true })
      .then(() => fs.writeFile(projectFile(), content));
  const writeHome = (content: string) =>
    fs
      .mkdir(path.join(homeDir, '.qwen'), { recursive: true })
      .then(() => fs.writeFile(homeFile(), content));

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loop-tick-'));
    projectRoot = path.join(tempDir, 'project');
    homeDir = path.join(tempDir, 'home');
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.mkdir(homeDir, { recursive: true });
    resolver = new LoopTickResolver({ projectRoot, homeDir });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('delivers the full task block on first fire', async () => {
    await writeProject('- ship the thing');

    const tick = await resolver.resolve('dynamic');

    expect(tick.full).toBe(true);
    expect(tick.sourcePath).toBe(projectFile());
    expect(tick.modelText).toContain(
      `# /loop tick — tasks from ${projectFile()}`,
    );
    expect(tick.modelText).toContain('The user configured a loop-tasks file.');
    expect(tick.modelText).toContain('- ship the thing');
    // The full block ends with the same short reminder an unchanged fire emits.
    expect(tick.modelText).toContain('(dynamic pacing)');
  });

  it('delivers only the short reminder when content is unchanged', async () => {
    await writeProject('- ship the thing');
    await resolver.resolve('dynamic');
    resolver.markDelivered();

    const tick = await resolver.resolve('dynamic');

    expect(tick.full).toBe(false);
    expect(tick.modelText).not.toContain(
      'The user configured a loop-tasks file.',
    );
    expect(tick.modelText).toContain(
      '# /loop tick — loop.md tasks (dynamic pacing)',
    );
  });

  it('commits content only on markDelivered, so an undelivered tick re-expands', async () => {
    await writeProject('- tasks');
    expect((await resolver.resolve('dynamic')).full).toBe(true);

    // No markDelivered() — the block was never delivered (e.g. the tick was
    // aborted before the send). The next tick must re-deliver the full block.
    expect((await resolver.resolve('dynamic')).full).toBe(true);

    resolver.markDelivered();
    expect((await resolver.resolve('dynamic')).full).toBe(false);
  });

  it('re-delivers the full block when loop.md is edited', async () => {
    await writeProject('- v1');
    await resolver.resolve('dynamic');
    resolver.markDelivered();

    await writeProject('- v2 edited');
    const tick = await resolver.resolve('dynamic');

    expect(tick.full).toBe(true);
    expect(tick.modelText).toContain('- v2 edited');
  });

  it('re-delivers the full block after resetCache (compaction)', async () => {
    await writeProject('- stable');
    await resolver.resolve('dynamic');
    resolver.markDelivered();
    expect((await resolver.resolve('dynamic')).full).toBe(false);

    resolver.resetCache();
    const tick = await resolver.resolve('dynamic');

    expect(tick.full).toBe(true);
    expect(tick.modelText).toContain('- stable');
  });

  it('emits the absent reminder without poisoning the cache, then re-expands on recreate', async () => {
    const absent = await resolver.resolve('dynamic');
    expect(absent.full).toBe(false);
    expect(absent.sourcePath).toBeUndefined();
    expect(absent.modelText).toContain('loop.md is not currently present');

    await writeProject('- recreated tasks');
    const tick = await resolver.resolve('dynamic');

    expect(tick.full).toBe(true);
    expect(tick.modelText).toContain('- recreated tasks');
  });

  it('uses mode-specific reminders; dynamic names the re-arm sentinel', async () => {
    await writeProject('- tasks');

    const cron = await resolver.resolve('cron');
    expect(cron.modelText).toContain('do not call LoopWakeup from this tick');
    expect(cron.modelText).not.toContain('(dynamic pacing)');

    // Fresh resolver so 'dynamic' is also a first (full) delivery.
    const dyn = new LoopTickResolver({ projectRoot, homeDir });
    const dynTick = await dyn.resolve('dynamic');
    expect(dynTick.modelText).toContain(LOOP_SENTINEL_DYNAMIC);
    expect(dynTick.modelText).toContain('call LoopWakeup again');
  });

  it('appends the truncation warning on a line boundary for oversized files', async () => {
    const line = 'task line padding padding padding\n';
    const body = line.repeat(Math.ceil(LOOP_TASK_FILE_MAX_BYTES / line.length));
    await writeProject(body);

    const tick = await resolver.resolve('cron');

    expect(tick.full).toBe(true);
    const warning = `> WARNING: loop.md was truncated to ${LOOP_TASK_FILE_MAX_BYTES} bytes. Keep the task list concise.`;
    expect(tick.modelText).toContain(`\n${warning}`);
    // The body is trimmed back to a COMPLETE line — the warning never glues onto
    // a half-line. Guards against cutToLastNewline regressing to a no-op (which
    // would leave the body ending mid-line, e.g. "task line ").
    const beforeWarning = tick.modelText.slice(
      0,
      tick.modelText.indexOf(`\n${warning}`),
    );
    expect(beforeWarning.endsWith('task line padding padding padding')).toBe(
      true,
    );
  });

  it('names the home loop.md in the header and re-expands when the source switches', async () => {
    await writeProject('- project tasks');
    const first = await resolver.resolve('cron');
    resolver.markDelivered();
    expect(first.full).toBe(true);
    expect(first.sourcePath).toBe(projectFile());

    // Project gone, home has DIFFERENT content → re-expand (cache keys on
    // content, not path) and the header now names the home file.
    await fs.rm(projectFile());
    await writeHome('- home tasks');
    const second = await resolver.resolve('cron');

    expect(second.full).toBe(true);
    expect(second.sourcePath).toBe(homeFile());
    expect(second.modelText).toContain(
      `# /loop tick — tasks from ${homeFile()}`,
    );
    expect(second.modelText).toContain('- home tasks');
  });
});
