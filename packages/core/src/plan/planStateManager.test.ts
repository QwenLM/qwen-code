/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PlanStateManager } from './planStateManager.js';
import {
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
} from '../tools/tool-names.js';
import type { Message } from '../protocol/transcript/message.js';

describe('PlanStateManager.copyPlanForResume', () => {
  let tempDir: string;
  let plansDir: string;
  let manager: PlanStateManager;

  const SOURCE_SESSION = 'source-session-id';
  const TARGET_SESSION = 'target-session-id';
  const ORIGINAL_SLUG = 'tender-juggling-karp';

  beforeEach(() => {
    tempDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'plan-state-mgr-')),
    );
    plansDir = path.join(tempDir, 'plans');
    fs.mkdirSync(plansDir, { recursive: true });
    manager = new PlanStateManager();
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  /** Build a synthetic transcript for a session that entered plan mode. */
  function buildTranscriptWithEnterPlanModeResult(
    planFilePath: string,
  ): Message[] {
    const enterToolUseId = 'toolu_enter_01';
    return [
      {
        type: 'user',
        message: {
          role: 'user',
          content: 'implement a snake game',
        },
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: enterToolUseId,
              name: ENTER_PLAN_MODE_TOOL_NAME,
              input: {},
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: enterToolUseId,
              is_error: false,
              content: 'Entered plan mode.',
            },
          ],
        },
        toolUseResult: {
          summary: 'Switching to Plan mode',
          payload: planFilePath,
        },
      },
      // Pending ExitPlanMode (no matching tool_result — process was killed).
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_exit_01',
              name: EXIT_PLAN_MODE_TOOL_NAME,
              input: {},
            },
          ],
        },
      },
    ] as unknown as Message[];
  }

  it('recovers source slug from EnterPlanMode toolUseResult payload', async () => {
    const planFilePath = path.join(plansDir, `${ORIGINAL_SLUG}.md`);
    fs.writeFileSync(planFilePath, '# Snake game plan\n\nStep 1...');

    const messages = buildTranscriptWithEnterPlanModeResult(planFilePath);

    await manager.copyPlanForResume(
      messages,
      SOURCE_SESSION,
      TARGET_SESSION,
      plansDir,
    );

    // Source slug must now resolve to the original plan path.
    expect(manager.getPlanFilePath(plansDir, SOURCE_SESSION)).toBe(
      planFilePath,
    );

    // Target session got a copy of the recovered plan content.
    const targetPath = manager.getPlanFilePath(plansDir, TARGET_SESSION);
    expect(fs.existsSync(targetPath)).toBe(true);
    expect(fs.readFileSync(targetPath, 'utf-8')).toContain('Snake game plan');
  });

  it('falls back to plan_file_reference attachment when source plan file is missing', async () => {
    // EnterPlanMode references a file that no longer exists on disk.
    const ghostPath = path.join(plansDir, 'ghost-slug.md');
    const messages = [
      ...buildTranscriptWithEnterPlanModeResult(ghostPath),
      {
        type: 'attachment',
        attachment: {
          type: 'plan_file_reference',
          planContent: '# Recovered via attachment',
        },
      },
    ] as unknown as Message[];

    await manager.copyPlanForResume(
      messages,
      SOURCE_SESSION,
      TARGET_SESSION,
      plansDir,
    );

    const targetPath = manager.getPlanFilePath(plansDir, TARGET_SESSION);
    expect(fs.existsSync(targetPath)).toBe(true);
    expect(fs.readFileSync(targetPath, 'utf-8')).toContain('via attachment');
  });

  it('ignores EnterPlanMode results pointing outside the plans directory', async () => {
    const outsidePath = path.join(tempDir, 'outside.md');
    fs.writeFileSync(outsidePath, 'malicious');

    const messages = buildTranscriptWithEnterPlanModeResult(outsidePath);

    await manager.copyPlanForResume(
      messages,
      SOURCE_SESSION,
      TARGET_SESSION,
      plansDir,
    );

    // Source slug should NOT have been set to the outside path; a fresh
    // random slug is generated instead, so the resolved path stays inside
    // plansDir and never matches outsidePath.
    const resolved = manager.getPlanFilePath(plansDir, SOURCE_SESSION);
    expect(resolved).not.toBe(outsidePath);
    expect(path.dirname(resolved)).toBe(plansDir);
  });

  it('skips recovery when the slug is already cached', async () => {
    const cachedSlug = 'already-cached-slug';
    manager.setPlanSlug(SOURCE_SESSION, cachedSlug);

    const otherPath = path.join(plansDir, `${ORIGINAL_SLUG}.md`);
    fs.writeFileSync(otherPath, 'should not be picked up');
    const messages = buildTranscriptWithEnterPlanModeResult(otherPath);

    await manager.copyPlanForResume(
      messages,
      SOURCE_SESSION,
      TARGET_SESSION,
      plansDir,
    );

    expect(manager.getPlanFilePath(plansDir, SOURCE_SESSION)).toBe(
      path.join(plansDir, `${cachedSlug}.md`),
    );
  });

  it('ignores tool_result blocks marked is_error=true', async () => {
    const planFilePath = path.join(plansDir, `${ORIGINAL_SLUG}.md`);
    fs.writeFileSync(planFilePath, '# Plan');

    const messages = [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_enter_01',
              name: ENTER_PLAN_MODE_TOOL_NAME,
              input: {},
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_enter_01',
              is_error: true,
              content: 'failed',
            },
          ],
        },
        toolUseResult: {
          summary: 'Switching to Plan mode',
          payload: planFilePath,
        },
      },
    ] as unknown as Message[];

    await manager.copyPlanForResume(
      messages,
      SOURCE_SESSION,
      TARGET_SESSION,
      plansDir,
    );

    // Recovery should NOT have used the errored result, so source slug
    // is still freshly generated and points elsewhere.
    expect(manager.getPlanFilePath(plansDir, SOURCE_SESSION)).not.toBe(
      planFilePath,
    );
  });

  it('ignores toolUseResult on non-EnterPlanMode tool_result blocks', async () => {
    const planFilePath = path.join(plansDir, `${ORIGINAL_SLUG}.md`);
    fs.writeFileSync(planFilePath, '# Plan');

    // The payload is attached to an unrelated tool's result. It must NOT be
    // picked up because no EnterPlanMode tool_use exists.
    const messages = [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_read_01',
              name: 'Read',
              input: {},
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_read_01',
              is_error: false,
              content: 'unrelated content',
            },
          ],
        },
        toolUseResult: {
          summary: 'Read OK',
          payload: planFilePath,
        },
      },
    ] as unknown as Message[];

    await manager.copyPlanForResume(
      messages,
      SOURCE_SESSION,
      TARGET_SESSION,
      plansDir,
    );

    expect(manager.getPlanFilePath(plansDir, SOURCE_SESSION)).not.toBe(
      planFilePath,
    );
  });
});

// ─── isActive lifecycle tests ─────────────────────────────────────────────────

describe('PlanStateManager.isActive', () => {
  let manager: PlanStateManager;

  beforeEach(() => {
    manager = new PlanStateManager();
  });

  it('should be false initially', () => {
    expect(manager.isActive).toBe(false);
  });

  it('should be true after enter()', () => {
    manager.enter();
    expect(manager.isActive).toBe(true);
  });

  it('should be false after exit()', () => {
    manager.enter();
    manager.exit();
    expect(manager.isActive).toBe(false);
  });
});
