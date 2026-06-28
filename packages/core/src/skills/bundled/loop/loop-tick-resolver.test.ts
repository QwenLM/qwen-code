/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LOOP_SENTINEL_CRON,
  LOOP_SENTINEL_DYNAMIC,
  LoopTickResolver,
  detectLoopSentinel,
} from './loop-tick-resolver.js';
import { LOOP_TASK_FILE_MAX_BYTES } from './loop-task-file.js';

// Make only realpath observable; every other fs call stays real so the temp-dir
// fixtures keep working. The default impl calls through, so behavior is unchanged
// — the spy just lets a test count how often a boundary is re-resolved.
vi.mock('node:fs/promises', async (importActual) => {
  const actual = await importActual<typeof import('node:fs/promises')>();
  return { ...actual, realpath: vi.fn(actual.realpath) };
});

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
      allowProjectFile: () => true,
    });
  });

  afterEach(async () => {
    // Reset realpath call history (keep the call-through impl) between tests.
    vi.mocked(fs.realpath).mockClear();
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
      allowProjectFile: () => false,
    });

    const tick = await untrusted.resolve('cron');

    expect(tick.full).toBe(true);
    expect(tick.sourceLabel).toBe('home loop.md');
    expect(tick.modelText).toContain('- user tasks');
    expect(tick.modelText).not.toContain('- repo-controlled tasks');
  });

  it('treats a present project loop.md as absent when the folder is untrusted', async () => {
    await writeProject('- repo-controlled tasks');
    const untrusted = new LoopTickResolver({
      projectRoot,
      homeDir,
      allowProjectFile: () => false,
    });

    const tick = await untrusted.resolve('cron');

    expect(tick.full).toBe(false);
    expect(tick.sourceLabel).toBeUndefined();
    // A genuinely-absent tick is NOT flagged transient, so the echo says "not
    // present" rather than "temporarily unavailable".
    expect(tick.transientError).toBe(false);
    expect(tick.modelText).toContain('loop.md is not currently present');
    // The project candidate was never read (untrusted), so the absent message
    // must not claim it was checked — only the home candidate is named, via a
    // leak-safe label (this fixture's homeDir is a temp dir outside the real
    // $HOME, so the absolute path must never reach the model text).
    expect(tick.modelText).not.toContain('(project)');
    expect(tick.modelText).toContain('(home)');
    expect(tick.modelText).not.toContain(homeFile());
  });

  it('re-reads folder trust per tick: a trusted→untrusted flip stops reading the project file', async () => {
    // allowProjectFile is a getter, not a snapshot: isTrustedFolder() can flip
    // mid-session (IDE workspace-trust update) and the resolver outlives a tick.
    // A resolver built while trusted must skip the repo-controlled project
    // loop.md on the very next tick once trust flips — not keep reading it.
    await writeProject('- repo-controlled tasks');
    let trusted = true;
    const flipping = new LoopTickResolver({
      projectRoot,
      homeDir,
      allowProjectFile: () => trusted,
    });

    const trustedTick = await flipping.resolve('cron');
    expect(trustedTick.full).toBe(true);
    expect(trustedTick.sourceLabel).toBe('project loop.md');
    expect(trustedTick.modelText).toContain('- repo-controlled tasks');
    flipping.markDelivered();

    // Trust revoked. With no user-owned home loop.md, the next tick must be a
    // labelled no-op — the project file is no longer read by the SAME resolver.
    trusted = false;
    const untrustedTick = await flipping.resolve('cron');
    expect(untrustedTick.full).toBe(false);
    expect(untrustedTick.sourceLabel).toBeUndefined();
    expect(untrustedTick.modelText).toContain(
      'loop.md is not currently present',
    );
    expect(untrustedTick.modelText).not.toContain('- repo-controlled tasks');
    // Trust is revoked, so the project file was not read — don't claim it.
    expect(untrustedTick.modelText).not.toContain('(project)');
  });

  it('delivers the full task block on first fire', async () => {
    await writeProject('- ship the thing');

    const tick = await resolver.resolve('dynamic');

    expect(tick.full).toBe(true);
    // sourceLabel is the relative label, never the absolute path — the model
    // text (and this label) must not leak projectFile().
    expect(tick.sourceLabel).toBe('project loop.md');
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
    expect(tick.sourceLabel).toBe('project loop.md');
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

  it('clears the boundary realpath cache on resetCache so it is re-resolved', async () => {
    // The fs.realpath of the confinement boundary (projectRoot) is cached per
    // resolver for the per-tick perf win. resetCache must invalidate it too —
    // otherwise a long-lived process keeps a stale boundary after a /cd or symlink
    // re-point. Prove projectRoot is re-resolved only after a reset.
    await writeProject('- tasks');
    const rootResolves = () =>
      vi
        .mocked(fs.realpath)
        .mock.calls.filter((c) => String(c[0]) === projectRoot).length;

    await resolver.resolve('cron');
    expect(rootResolves()).toBe(1);
    await resolver.resolve('cron');
    expect(rootResolves()).toBe(1); // served from the instance cache, not re-resolved

    resolver.resetCache();
    await resolver.resolve('cron');
    expect(rootResolves()).toBe(2); // cache cleared → boundary re-resolved
  });

  it('emits the absent reminder without poisoning the cache, then re-expands on recreate', async () => {
    const absent = await resolver.resolve('dynamic');
    expect(absent.full).toBe(false);
    expect(absent.sourceLabel).toBeUndefined();
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
      allowProjectFile: () => true,
    });
    const dynTick = await dyn.resolve('dynamic');
    expect(dynTick.modelText).toContain(
      '# /loop tick — loop.md absent (dynamic pacing)\n',
    );
    // The absent dynamic tail names the re-arm sentinel by interpolating the
    // constant — asserting against LOOP_SENTINEL_DYNAMIC catches a future rename
    // drift between the constant and the user-facing instruction.
    expect(dynTick.modelText).toContain(LOOP_SENTINEL_DYNAMIC);
    // Exactly one H1 — the heading isn't duplicated by the body.
    expect(dynTick.modelText.match(/^# /gm)).toHaveLength(1);
  });

  it('resolve() honors an explicit allowProjectFile override over the getter', async () => {
    // FIX 3: the caller captures folder-trust ONCE per tick and threads it in,
    // so the per-tick getter is bypassed. Build a resolver whose getter would
    // ALLOW the project file, but pass `false`: the repo-controlled project
    // loop.md must be skipped on this tick, exactly as the getter-false path.
    await writeProject('- repo-controlled tasks');
    const threaded = new LoopTickResolver({
      projectRoot,
      homeDir,
      allowProjectFile: () => true, // getter would allow...
    });

    const tick = await threaded.resolve('cron', false); // ...override forbids

    expect(tick.full).toBe(false);
    expect(tick.modelText).not.toContain('- repo-controlled tasks');
    expect(tick.modelText).not.toContain('(project)');
    expect(tick.modelText).toContain('(home)');
  });

  it('buildTransientErrorTick mirrors the absent tick with a re-arm and errno note', () => {
    // FIX 4: a transient, non-whitelisted read error must NOT kill a dynamic
    // loop. The degraded tick mirrors the absent path's re-arm + cache-clear, plus
    // a note that the file was unreadable this tick, so the model still re-arms
    // LoopWakeup and the loop survives.
    const tick = resolver.buildTransientErrorTick('dynamic', true, 'EIO');

    expect(tick.full).toBe(false);
    // Flagged transient (file present, unreadable this tick) so the caller's echo
    // can say "temporarily unavailable" rather than the genuinely-absent label.
    expect(tick.transientError).toBe(true);
    // The heading says "unavailable", NOT "absent"/"not present": the file exists,
    // it just couldn't be read this tick, so the heading must mirror the body.
    // Mutation guard: revert the heading to { absent: true } and these fail.
    expect(tick.modelText).toContain(
      '# /loop tick — loop.md unavailable (dynamic pacing)\n',
    );
    expect(tick.modelText).not.toContain('absent');
    expect(tick.modelText).not.toContain('not present');
    expect(tick.modelText).toContain('could not be read this tick (EIO)');
    // The dynamic re-arm instruction (the literal sentinel) keeps the loop alive.
    expect(tick.modelText).toContain(LOOP_SENTINEL_DYNAMIC);
    // projectChecked=true names BOTH candidates (the set that was probed).
    expect(tick.modelText).toContain('(project)');
    expect(tick.modelText).toContain('(home)');
  });

  it('cron buildTransientErrorTick uses the cron tail and omits an unprobed project', () => {
    // cron mode degrades only via its own next interval, but the tick text still
    // uses the cron no-op tail (no LoopWakeup re-arm). With projectChecked=false
    // (untrusted) the never-probed project candidate must NOT be named.
    const tick = resolver.buildTransientErrorTick('cron', false, 'EACCES');

    // Heading conveys "unavailable" (file exists, unreadable this tick), never
    // the misleading "absent".
    expect(tick.modelText).toContain('# /loop tick — loop.md unavailable');
    expect(tick.modelText).not.toContain('absent');
    expect(tick.modelText).toContain('could not be read this tick (EACCES)');
    expect(tick.modelText).toContain('the recurring cron fires the next tick');
    expect(tick.modelText).not.toContain(LOOP_SENTINEL_DYNAMIC);
    expect(tick.modelText).not.toContain('(project)');
    expect(tick.modelText).toContain('(home)');
  });

  it('a transient-error tick clears the change-detection cache so the next read re-delivers full', async () => {
    // The degraded tick must behave like absent for caching: after it, a read of
    // byte-identical content re-expands the FULL block rather than a dangling
    // short reminder pointing at a block no longer guaranteed to be in context.
    // Mutation guard: if buildTransientErrorTick doesn't clear the caches, the
    // second resolve sees "unchanged" and returns a short reminder (full:false).
    await writeProject('- tasks');
    const full = await resolver.resolve('dynamic');
    expect(full.full).toBe(true);
    resolver.markDelivered();

    resolver.buildTransientErrorTick('dynamic', true, 'EIO');

    const next = await resolver.resolve('dynamic');
    expect(next.full).toBe(true);
  });

  it('names the real home loop.md in the absent reminder (QWEN_HOME-aware, not a hardcoded ~/.qwen)', async () => {
    // Regression: the absent body hardcoded `~/.qwen/loop.md (home)`, which is
    // wrong once the global dir is relocated (QWEN_HOME). The resolver checks
    // `<homeQwenDir>/loop.md`, but the label is MODEL-FACING, so a $QWEN_HOME
    // outside $HOME (tildeifyPath no-op there) must read as the literal
    // `$QWEN_HOME/loop.md`, never the raw absolute path it would otherwise leak.
    const relocated = path.join(tempDir, 'relocated-qwen');
    const prevQwenHome = process.env['QWEN_HOME'];
    process.env['QWEN_HOME'] = relocated;
    try {
      const relocatedTick = await new LoopTickResolver({
        projectRoot,
        homeDir: relocated,
        homeQwenDir: relocated,
        allowProjectFile: () => true,
      }).resolve('cron');

      expect(relocatedTick.full).toBe(false);
      expect(relocatedTick.modelText).toContain(
        'loop.md is not currently present',
      );
      expect(relocatedTick.modelText).toContain('$QWEN_HOME/loop.md (home)');
      // The old hardcoded home location is gone; the project label stays relative.
      expect(relocatedTick.modelText).not.toContain('~/.qwen/loop.md');
      expect(relocatedTick.modelText).toContain('.qwen/loop.md (project)');
      // Privacy: the raw absolute global dir never reaches the model text.
      expect(relocatedTick.modelText).not.toContain(relocated);
    } finally {
      if (prevQwenHome === undefined) delete process.env['QWEN_HOME'];
      else process.env['QWEN_HOME'] = prevQwenHome;
    }

    // Under the real OS home (the QWEN_HOME-unset case) the home prefix tilde-
    // abbreviates, so the message reads `~/…/loop.md`, never the absolute $HOME.
    const underHome = path.join(
      os.homedir(),
      `.qwen-loop-absent-${process.pid}`,
    );
    const homeTick = await new LoopTickResolver({
      projectRoot,
      homeDir: os.homedir(),
      homeQwenDir: underHome,
      allowProjectFile: () => true,
    }).resolve('dynamic');

    expect(homeTick.modelText).toContain(
      `~/${path.basename(underHome)}/loop.md (home)`,
    );
    expect(homeTick.modelText).not.toContain(os.homedir());
  });

  it('homeLoopLabel never leaks an absolute $QWEN_HOME path outside $HOME (privacy)', async () => {
    // The label is sent to the model/API. $QWEN_HOME may point OUTSIDE $HOME
    // (supported relocation; common in containers/CI), where tildeifyPath is a
    // no-op — so the resolved absolute dir must be swapped for the literal
    // `$QWEN_HOME`. Mutation guard: revert homeLoopLabel to
    // `tildeifyPath(join(homeQwenDir,'loop.md'))` and `outside` (the absolute
    // path) reappears in BOTH assertions below, failing this test.
    const outside = path.join(tempDir, 'srv-qwen-home');
    const prevQwenHome = process.env['QWEN_HOME'];
    process.env['QWEN_HOME'] = outside;
    try {
      const relocated = new LoopTickResolver({
        projectRoot,
        homeDir: outside,
        homeQwenDir: outside,
        allowProjectFile: () => true,
      });
      expect(relocated.homeLoopLabel()).toBe('$QWEN_HOME/loop.md');
      const tick = await relocated.resolve('cron');
      expect(tick.modelText).toContain('$QWEN_HOME/loop.md (home)');
      expect(tick.modelText).not.toContain(outside);

      // Defensive case: an out-of-$HOME global dir with $QWEN_HOME UNSET still
      // never surfaces the absolute path — a generic placeholder is used.
      delete process.env['QWEN_HOME'];
      const generic = new LoopTickResolver({
        projectRoot,
        homeDir: outside,
        homeQwenDir: outside,
        allowProjectFile: () => true,
      });
      expect(generic.homeLoopLabel()).toBe('the configured global loop.md');
      expect(generic.homeLoopLabel()).not.toContain(outside);
    } finally {
      if (prevQwenHome === undefined) delete process.env['QWEN_HOME'];
      else process.env['QWEN_HOME'] = prevQwenHome;
    }
  });

  it('homeLoopLabel keeps the separator when $QWEN_HOME has a trailing slash', async () => {
    // Storage.getGlobalQwenDir() does NOT strip a trailing slash, so a
    // `QWEN_HOME=/srv/qwen/` reaches homeQwenDir as `/srv/qwen/`. Slicing the
    // joined loop.md path by the raw homeQwenDir length over-counts the trailing
    // separator and garbles the label into `$QWEN_HOMEloop.md`. Mutation guard:
    // revert the slice base to `homeQwenDir.length` and the first assertion below
    // fails with the separator-less `$QWEN_HOMEloop.md`.
    const outsideTrailing = path.join(tempDir, 'srv-qwen-home') + path.sep;
    const prevQwenHome = process.env['QWEN_HOME'];
    process.env['QWEN_HOME'] = outsideTrailing;
    try {
      const trailing = new LoopTickResolver({
        projectRoot,
        homeDir: outsideTrailing,
        homeQwenDir: outsideTrailing,
        allowProjectFile: () => true,
      });
      expect(trailing.homeLoopLabel()).toBe('$QWEN_HOME/loop.md');
      // Never the raw absolute dir, and never the garbled separator-less form.
      expect(trailing.homeLoopLabel()).not.toContain(outsideTrailing);
      expect(trailing.homeLoopLabel()).not.toContain('$QWEN_HOMEloop.md');

      // out-of-$HOME branch still behaves with QWEN_HOME UNSET: generic placeholder.
      delete process.env['QWEN_HOME'];
      const generic = new LoopTickResolver({
        projectRoot,
        homeDir: outsideTrailing,
        homeQwenDir: outsideTrailing,
        allowProjectFile: () => true,
      });
      expect(generic.homeLoopLabel()).toBe('the configured global loop.md');
    } finally {
      if (prevQwenHome === undefined) delete process.env['QWEN_HOME'];
      else process.env['QWEN_HOME'] = prevQwenHome;
    }

    // under-$HOME branch still behaves with a trailing slash: tilde-abbreviated.
    const underHomeTrailing =
      path.join(os.homedir(), `.qwen-loop-trailing-${process.pid}`) + path.sep;
    const underHome = new LoopTickResolver({
      projectRoot,
      homeDir: os.homedir(),
      homeQwenDir: underHomeTrailing,
      allowProjectFile: () => true,
    });
    expect(underHome.homeLoopLabel()).toBe(
      `~/.qwen-loop-trailing-${process.pid}/loop.md`,
    );
    expect(underHome.homeLoopLabel()).not.toContain(os.homedir());
  });

  it('homeLoopLabel keeps the separator when $QWEN_HOME is the filesystem root', async () => {
    // `QWEN_HOME=/` makes homeQwenDir the root, so homeLoopPath is
    // path.join('/', 'loop.md') = '/loop.md', whose path.dirname is '/' (length 1).
    // Slicing the joined path past that length drops the leading separator,
    // garbling the label into the separator-less `$QWEN_HOMEloop.md`. Mutation
    // guard: revert homeLoopLabel to the slice-by-dirname-length approach and the
    // first assertion below fails with `$QWEN_HOMEloop.md`.
    const root = path.sep; // the filesystem root ('/' on POSIX)
    const prevQwenHome = process.env['QWEN_HOME'];
    process.env['QWEN_HOME'] = root;
    try {
      const atRoot = new LoopTickResolver({
        projectRoot,
        homeDir: root,
        homeQwenDir: root,
        allowProjectFile: () => true,
      });
      expect(atRoot.homeLoopLabel()).toBe(`$QWEN_HOME${path.sep}loop.md`);
      // The garbled, separator-less form must never appear.
      expect(atRoot.homeLoopLabel()).not.toContain('$QWEN_HOMEloop.md');
    } finally {
      if (prevQwenHome === undefined) delete process.env['QWEN_HOME'];
      else process.env['QWEN_HOME'] = prevQwenHome;
    }
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
      allowProjectFile: () => true,
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
    expect(first.sourceLabel).toBe('project loop.md');

    // Project gone, home has DIFFERENT content → re-expand (cache keys on
    // content, not path) and the header now names the home file.
    await fs.rm(projectFile());
    await writeHome('- home tasks');
    const second = await resolver.resolve('cron');

    expect(second.full).toBe(true);
    expect(second.sourceLabel).toBe('home loop.md');
    expect(second.modelText).toContain(
      '# /loop tick — loop.md tasks from home loop.md',
    );
    // The absolute home path must not leak into the model-facing text.
    expect(second.modelText).not.toContain(homeFile());
    expect(second.modelText).toContain('- home tasks');
  });
});
