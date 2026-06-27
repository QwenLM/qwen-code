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
} from './loop-tick-resolver.js';
import { LOOP_TASK_FILE_MAX_BYTES } from './loop-task-file.js';

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
    resolver = new LoopTickResolver({
      projectRoot,
      homeDir,
      allowProjectFile: true,
    });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('ignores the project loop.md in an untrusted folder (allowProjectFile: false)', async () => {
    // An untrusted folder's repo-controlled project loop.md must not be read,
    // but the user-owned home loop.md still is.
    await writeProject('- repo-controlled tasks');
    await writeHome('- user tasks');
    const untrusted = new LoopTickResolver({
      projectRoot,
      homeDir,
      allowProjectFile: false,
    });

    const tick = await untrusted.resolve('cron');

    expect(tick.full).toBe(true);
    expect(tick.sourcePath).toBe(homeFile());
    expect(tick.sourceLabel).toBe('home loop.md');
    expect(tick.modelText).toContain('- user tasks');
    expect(tick.modelText).not.toContain('- repo-controlled tasks');
  });

  it('treats a present project loop.md as absent when the folder is untrusted', async () => {
    await writeProject('- repo-controlled tasks');
    const untrusted = new LoopTickResolver({
      projectRoot,
      homeDir,
      allowProjectFile: false,
    });

    const tick = await untrusted.resolve('cron');

    expect(tick.full).toBe(false);
    expect(tick.sourcePath).toBeUndefined();
    expect(tick.modelText).toContain('loop.md is not currently present');
  });

  it('delivers the full task block on first fire', async () => {
    await writeProject('- ship the thing');

    const tick = await resolver.resolve('dynamic');

    expect(tick.full).toBe(true);
    // sourcePath keeps the absolute path for local UI; the model text must not.
    expect(tick.sourcePath).toBe(projectFile());
    expect(tick.modelText).toContain(
      '# /loop tick — loop.md tasks from project loop.md',
    );
    expect(tick.modelText).not.toContain(projectFile());
    expect(tick.modelText).toContain('The user configured a loop-tasks file.');
    expect(tick.modelText).toContain('- ship the thing');
    // The full block carries the mode-specific pacing suffix (dynamic re-arm)...
    expect(tick.modelText).toContain('(dynamic pacing)');
    expect(tick.modelText).toContain('call LoopWakeup again');
    // ...but NOT the "established earlier" reminder: the block is right here in
    // this message, so that phrasing would contradict the INTRO above it.
    expect(tick.modelText).not.toContain('established earlier');
    // Exactly one H1 in the whole message (no duplicated tick heading).
    expect(tick.modelText.match(/^# /gm)).toHaveLength(1);
  });

  it('delivers only the short reminder when content is unchanged', async () => {
    await writeProject('- ship the thing');
    await resolver.resolve('dynamic');
    resolver.markDelivered();

    const tick = await resolver.resolve('dynamic');

    expect(tick.full).toBe(false);
    // The unchanged branch still reports the resolved source so Session.ts can
    // label it even when only the short reminder is sent.
    expect(tick.sourcePath).toBe(projectFile());
    expect(tick.modelText).not.toContain(
      'The user configured a loop-tasks file.',
    );
    // A subsequent tick DOES point back to the earlier full block — that
    // reminder semantics is intact (only the first delivery omits it).
    expect(tick.modelText).toContain('established earlier');
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

  it('re-delivers the full NEW block when an undelivered tick is followed by an edit', async () => {
    // First tick resolved but ABORTED before delivery (no markDelivered), then the
    // file is edited. Delivered content (#lastContent) is still null, so the second
    // resolve must emit the FULL block with the NEW content — this is the
    // #pendingContent-vs-#lastContent divergence path. If #pendingContent were
    // committed eagerly on resolve(), the first tick would collapse to a short
    // reminder (full=false), pointing the model at a block it never received.
    await writeProject('- v1 tasks');
    expect((await resolver.resolve('dynamic')).full).toBe(true);
    // No markDelivered() — the first tick never reached the model.

    await writeProject('- v2 edited tasks');
    const tick = await resolver.resolve('dynamic');

    expect(tick.full).toBe(true);
    expect(tick.modelText).toContain('The user configured a loop-tasks file.');
    expect(tick.modelText).toContain('- v2 edited tasks');
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

  it('gives the absent tick the same shared heading style (and dynamic suffix)', async () => {
    const cron = await resolver.resolve('cron');
    expect(cron.modelText).toContain('# /loop tick — loop.md absent\n');

    const dyn = new LoopTickResolver({
      projectRoot,
      homeDir,
      allowProjectFile: true,
    });
    const dynTick = await dyn.resolve('dynamic');
    expect(dynTick.modelText).toContain(
      '# /loop tick — loop.md absent (dynamic pacing)\n',
    );
    // Exactly one H1 — the heading isn't duplicated by the body.
    expect(dynTick.modelText.match(/^# /gm)).toHaveLength(1);
  });

  it('re-expands after delete→recreate even when the recreated content is identical', async () => {
    await writeProject('- same tasks');
    expect((await resolver.resolve('dynamic')).full).toBe(true);
    resolver.markDelivered();
    // Unchanged content → short reminder, as expected.
    expect((await resolver.resolve('dynamic')).full).toBe(false);

    // Delete → the absent tick clears the delivered-content memory.
    await fs.rm(projectFile());
    const absent = await resolver.resolve('dynamic');
    expect(absent.full).toBe(false);
    expect(absent.modelText).toContain('loop.md is not currently present');

    // Recreate with byte-identical content. Absence was a state change, so the
    // full block must re-expand rather than collapse to a dangling reminder.
    await writeProject('- same tasks');
    const tick = await resolver.resolve('dynamic');
    expect(tick.full).toBe(true);
    expect(tick.modelText).toContain('- same tasks');
  });

  it('uses mode-specific reminders; dynamic names the re-arm sentinel', async () => {
    await writeProject('- tasks');

    const cron = await resolver.resolve('cron');
    expect(cron.modelText).toContain('do not call LoopWakeup from this tick');
    expect(cron.modelText).not.toContain('(dynamic pacing)');

    // Fresh resolver so 'dynamic' is also a first (full) delivery.
    const dyn = new LoopTickResolver({
      projectRoot,
      homeDir,
      allowProjectFile: true,
    });
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

  it('keeps the body when the only newline is at index 0 (no empty truncated block)', async () => {
    // A truncated file whose only newline is the leading byte: there is no
    // complete line to keep, so cutting to the "last full line" would empty the
    // body and leave the INTRO promising tasks that aren't there. The body must
    // survive — guards cutToLastNewline against a `cut >= 0` regression that
    // slices a position-0 newline down to "".
    await writeProject('\n' + 'x'.repeat(LOOP_TASK_FILE_MAX_BYTES + 100));

    const tick = await resolver.resolve('cron');

    expect(tick.full).toBe(true);
    const warning = `> WARNING: loop.md was truncated to ${LOOP_TASK_FILE_MAX_BYTES} bytes. Keep the task list concise.`;
    expect(tick.modelText).toContain(`\n${warning}`);
    // The x-run above the warning is non-empty; a `cut >= 0` regression would
    // empty it, leaving only INTRO + warning.
    const beforeWarning = tick.modelText.slice(
      0,
      tick.modelText.indexOf(`\n${warning}`),
    );
    expect(beforeWarning).toContain('xxxxxxxxxx');
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
      '# /loop tick — loop.md tasks from home loop.md',
    );
    // The absolute home path must not leak into the model-facing text.
    expect(second.modelText).not.toContain(homeFile());
    expect(second.modelText).toContain('- home tasks');
  });
});
