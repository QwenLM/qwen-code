/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * #15924 integration pin for the opt-in stable extraction window over the REAL
 * `MemoryManager.scheduleExtract` -> `runAutoMemoryExtract` ->
 * `runAutoMemoryExtractionByAgent` seam. Only the model boundary
 * (`runForkedAgent`), the cache-safe getters and the topic scan are faked; the
 * manager, the cursor I/O, the window epoch rules and the planner all run for
 * real, so a regression in any of them (e.g. dropping a parked #13004 slice
 * while marking its debt settled) fails here instead of only in unit mocks.
 *
 * The three cases drive the cadence schedule from `manager.test.ts`: a short
 * engaged run arms the experiment, the next short turn is parked, and the long
 * turn runs the extraction whose `extraHistory` is inspected.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import {
  getCacheSafeParams,
  getCacheSafeParamsSessionId,
  runForkedAgent,
} from '../agents/forkedAgent.js';
import { EXTRACT_NOOP_SKIP_TURNS_ENV } from './extract-cadence.js';
import { EXTRACT_STABLE_WINDOW_ENV } from './extract-window.js';
import { MemoryManager } from './manager.js';
import { getAutoMemoryExtractCursorPath } from './paths.js';
import { modelText, userText } from '../test-utils/model-fixtures.js';

vi.mock('../agents/forkedAgent.js', () => ({
  runForkedAgent: vi.fn(),
  getCacheSafeParams: vi.fn(),
  getCacheSafeParamsSessionId: vi.fn(),
}));

vi.mock('./structured-scan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./structured-scan.js')>();
  return {
    ...actual,
    scanAutoMemoryTopicDocuments: vi.fn().mockResolvedValue([]),
    scanUserAutoMemoryTopicDocuments: vi.fn().mockResolvedValue([]),
  };
});

/** Unique text on curated index 2, the turn a cadence skip parks. */
const SENTINEL = 'PARKED-OWED-PREFERENCE-15924';

/**
 * Alternating raw/curated turns. Raw history and the curated snapshot share
 * this shape, so raw index 2 (parked by the manager) is curated index 2 (which
 * a last-40 window seed moves behind).
 */
function turns(count: number): Content[] {
  return Array.from({ length: count }, (_, index) =>
    index % 2 === 0
      ? userText(index === 2 ? SENTINEL : `turn ${index}`)
      : modelText(`ack ${index}`),
  );
}

function textParts(entries: Content[]): string[] {
  return entries.flatMap((entry) =>
    (entry.parts ?? []).flatMap((part) =>
      typeof part.text === 'string' ? [part.text] : [],
    ),
  );
}

const sentinelCount = (entries: Content[]): number =>
  textParts(entries).filter((text) => text.includes(SENTINEL)).length;

describe('stable extraction window over the real manager seam (#15924)', () => {
  let tempDir: string;
  let projectRoot: string;
  let manager: MemoryManager;
  let config: Config;
  let previousSkipTurns: string | undefined;
  let previousStableWindow: string | undefined;
  let previousMemoryBaseDir: string | undefined;

  beforeEach(async () => {
    previousSkipTurns = process.env[EXTRACT_NOOP_SKIP_TURNS_ENV];
    previousStableWindow = process.env[EXTRACT_STABLE_WINDOW_ENV];
    previousMemoryBaseDir = process.env['QWEN_CODE_MEMORY_BASE_DIR'];
    // Every case opts the experiment in explicitly; the cadence budget is the
    // one the manager tests use for a single park.
    delete process.env[EXTRACT_STABLE_WINDOW_ENV];
    process.env[EXTRACT_NOOP_SKIP_TURNS_ENV] = '2';

    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'extract-window-cadence-'),
    );
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
    // The user-level scaffold/scan must never touch the real ~/.qwen.
    process.env['QWEN_CODE_MEMORY_BASE_DIR'] = path.join(tempDir, 'memories');

    config = {
      getSessionId: vi.fn().mockReturnValue('sess'),
      getModel: vi.fn().mockReturnValue('test-model'),
      getApprovalMode: vi.fn(),
      getMemoryAgentTimeoutMinutes: vi.fn().mockReturnValue(undefined),
      getMemoryAgentMaxTurns: vi.fn().mockReturnValue(undefined),
      getAutoMemoryPrompt: vi.fn().mockReturnValue('session routing contract'),
      getEffectiveInputModalities: vi.fn().mockReturnValue({}),
    } as unknown as Config;

    vi.mocked(getCacheSafeParamsSessionId).mockReturnValue('sess');
    vi.mocked(getCacheSafeParams).mockReturnValue({
      generationConfig: {},
      history: turns(4),
      model: 'test-model',
      version: 1,
    });
    // A completed fork that only READ memory: engaged (arms the cadence) but
    // saved nothing (no topic write, no index/instruction work).
    const readPath = path.join(
      projectRoot,
      '.qwen',
      'memory',
      'project',
      'project.md',
    );
    vi.mocked(runForkedAgent).mockResolvedValue({
      status: 'completed',
      finalText: '',
      filesTouched: [readPath],
      filesRead: [readPath],
      filesWritten: [],
    });

    manager = new MemoryManager();
  });

  afterEach(async () => {
    if (previousSkipTurns === undefined) {
      delete process.env[EXTRACT_NOOP_SKIP_TURNS_ENV];
    } else {
      process.env[EXTRACT_NOOP_SKIP_TURNS_ENV] = previousSkipTurns;
    }
    if (previousStableWindow === undefined) {
      delete process.env[EXTRACT_STABLE_WINDOW_ENV];
    } else {
      process.env[EXTRACT_STABLE_WINDOW_ENV] = previousStableWindow;
    }
    if (previousMemoryBaseDir === undefined) {
      delete process.env['QWEN_CODE_MEMORY_BASE_DIR'];
    } else {
      process.env['QWEN_CODE_MEMORY_BASE_DIR'] = previousMemoryBaseDir;
    }
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  /** One turn of the real schedule path, with the curated snapshot grown to match. */
  function schedule(historyLength: number, curatedLength = historyLength) {
    return manager.scheduleExtract({
      projectRoot,
      sessionId: 'sess',
      history: turns(historyLength),
      config,
      belowCompactionWarn: true,
      getCuratedHistory: () => turns(curatedLength),
    });
  }

  async function readCursor(): Promise<Record<string, unknown>> {
    return JSON.parse(
      await fs.readFile(getAutoMemoryExtractCursorPath(projectRoot), 'utf-8'),
    ) as Record<string, unknown>;
  }

  function lastExtraHistory(): Content[] {
    const calls = vi.mocked(runForkedAgent).mock.calls;
    return calls[calls.length - 1]?.[0].extraHistory ?? [];
  }

  it('keeps an owed parked slice when the flag is on from the first run', async () => {
    process.env[EXTRACT_STABLE_WINDOW_ENV] = '1';

    expect((await schedule(2)).skippedReason).toBeUndefined();
    const afterFirst = await readCursor();
    // The first epoch seeds at 0 (2 < the last-40 tail) and pins there.
    expect(afterFirst['epoch']).toBe(1);
    expect(afterFirst['windowStartCurated']).toBe(0);
    expect(afterFirst['coveredCurated']).toBe(2);

    // The parked slice is turns(4).slice(2): the run that follows is long
    // enough (60 - 2 > 40) that the manager splices it into the extraction.
    expect((await schedule(4)).skippedReason).toBe('cadence');
    expect(await readCursor()).toEqual(afterFirst);

    expect((await schedule(60)).skippedReason).toBeUndefined();
    expect(sentinelCount(lastExtraHistory())).toBe(1);

    const afterThird = await readCursor();
    // Pinned, not slid forward as the history grew: the prefix before the task
    // prompt stays reusable.
    expect(afterThird['windowStartCurated']).toBe(
      afterFirst['windowStartCurated'],
    );
    expect(afterThird['epoch']).toBe(afterFirst['epoch']);
    expect(afterThird['coveredCurated']).toBe(60);
  });

  it('recovers the parked slice when the flag turns on without a window cursor', async () => {
    // Two legacy runs persist only {sessionId, processedOffset, updatedAt}, so
    // the first windowed epoch has no coverage and seeds at the last-40 tail —
    // curated index 20, after the parked turns at 2..3.
    expect((await schedule(2)).skippedReason).toBeUndefined();
    expect((await readCursor())['windowStartCurated']).toBeUndefined();
    expect((await schedule(4)).skippedReason).toBe('cadence');

    // Test-only mid-process transition (production pins the flag per process):
    // the reviewer's exact probe.
    process.env[EXTRACT_STABLE_WINDOW_ENV] = '1';
    expect((await schedule(60)).skippedReason).toBeUndefined();

    const cursor = await readCursor();
    expect(cursor['epoch']).toBe(1);
    expect(cursor['windowStartCurated']).toBe(20);
    expect(cursor['coveredCurated']).toBe(60);

    const extraHistory = lastExtraHistory();
    // The stable branch drops the slice only when the window proves coverage;
    // here it cannot, so the owed turn must reach the model exactly once.
    expect(sentinelCount(extraHistory)).toBe(1);
    // The window entries stay first (pinned prefix bytes unchanged) and the
    // unproven residue is appended after them.
    expect(textParts(extraHistory).slice(0, 40)).toEqual(
      textParts(turns(60).slice(20)),
    );
    expect(textParts(extraHistory).slice(40)).toEqual([SENTINEL, 'ack 3']);
  });

  it('is a no-op when the window already proves coverage (steady state)', async () => {
    process.env[EXTRACT_STABLE_WINDOW_ENV] = '1';

    await schedule(2);
    expect((await schedule(4)).skippedReason).toBe('cadence');
    await schedule(60);

    const windowStart = (await readCursor())['windowStartCurated'] as number;
    expect(windowStart).toBe(0);
    // The parked slice run 2 left is fully inside the pinned window, so the
    // appended residue is empty and the input is exactly the slimmed curated
    // slice — no duplicated turns, no growth from the hardening.
    expect(lastExtraHistory()).toEqual(turns(60).slice(windowStart));
  });
});
