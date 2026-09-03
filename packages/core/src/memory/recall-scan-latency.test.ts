/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { getAutoMemoryFilePath } from './paths.js';
import { resolveRelevantAutoMemoryPromptForQuery } from './recall.js';
import type { AutoMemoryDocumentCache } from './scan.js';
import { selectRelevantAutoMemoryDocumentsByModel } from './relevanceSelector.js';
import { ensureAutoMemoryScaffold } from './store.js';

/**
 * Measures steady-state recall latency with a warm document cache.
 *
 * `recall-delivery-eval.test.ts` times the deterministic *scoring*, which is
 * microseconds. That is not what decides whether the fast path delivers. The
 * fast result is published from `onFastResult`, which fires only after recall
 * has enumerated every topic file. The first run also reads and parses each
 * file; measured runs reuse the same session-like document cache.
 *
 * So this file measures wall-clock time from the recall call to the fast
 * callback, against a real temporary memory tree, with the model selector
 * mocked to hang the way a network round trip does.
 *
 * Timings are machine-dependent and CI is shared, so the assertions are
 * deliberately loose; the printed table is the artifact worth reading. What
 * is asserted is the narrower steady-state claim. This benchmark does not
 * certify first-session cold-cache latency.
 */

vi.mock('./relevanceSelector.js', () => ({
  selectRelevantAutoMemoryDocumentsByModel: vi.fn(),
}));

/** Mirrors INITIAL_MEMORY_RECALL_WAIT_MS in client.ts. */
const INITIAL_BUDGET_MS = 100;
const TOPIC_COUNTS = [200, 500, 1000] as const;
const REPEATS = 5;

let tempDir: string;
const projectRootByCount = new Map<number, string>();
const documentCacheByProject = new Map<string, AutoMemoryDocumentCache>();

async function buildMemoryTree(topicCount: number): Promise<string> {
  const projectRoot = path.join(tempDir, `project-${topicCount}`);
  await fs.mkdir(projectRoot, { recursive: true });
  await ensureAutoMemoryScaffold(
    projectRoot,
    new Date('2026-04-01T00:00:00.000Z'),
  );

  const referenceDir = path.dirname(
    getAutoMemoryFilePath(projectRoot, 'reference/topic-0000.md'),
  );
  await fs.mkdir(referenceDir, { recursive: true });

  // Bodies are sized like real notes rather than one-liners: the scan reads
  // and parses whole files, so a corpus of stubs would understate the cost.
  const filler = 'Historical note about an unrelated subsystem. '.repeat(20);
  await Promise.all(
    Array.from({ length: topicCount }, (_, index) =>
      fs.writeFile(
        path.join(referenceDir, `topic-${String(index).padStart(4, '0')}.md`),
        [
          '---',
          'type: reference',
          `name: Topic ${index}`,
          `description: Reference note number ${index} about deployment history`,
          '---',
          '',
          filler,
          index === topicCount - 1 ? 'The saved codeword is SCANBENCH.' : '',
          '',
        ].join('\n'),
        'utf-8',
      ),
    ),
  );

  return projectRoot;
}

/** Wall-clock ms from the recall call until the fast result is published. */
async function measureTimeToFastResultMs(projectRoot: string): Promise<number> {
  let elapsed = Number.NaN;
  let documentCache = documentCacheByProject.get(projectRoot);
  if (!documentCache) {
    documentCache = new Map();
    documentCacheByProject.set(projectRoot, documentCache);
  }
  const startedAt = performance.now();
  const recall = resolveRelevantAutoMemoryPromptForQuery(
    projectRoot,
    'what is the saved scanbench codeword for deployment',
    {
      config: {
        getSessionId: () => 'session-scan-bench',
        getModel: () => 'qwen3-coder-plus',
      } as Config,
      documentCache,
      onFastResult: () => {
        elapsed = performance.now() - startedAt;
      },
    },
  );

  // Let the pending recall settle so it does not leak into the next sample.
  await recall;
  return elapsed;
}

describe('auto-memory recall scan latency', () => {
  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'recall-scan-bench-'));
    // The selector stands in for the network round trip: it must not settle
    // before the fast callback, or the measurement would race it. Returning
    // an empty selection keeps recall finishing promptly after that.
    vi.mocked(selectRelevantAutoMemoryDocumentsByModel).mockResolvedValue([]);
    for (const topicCount of TOPIC_COUNTS) {
      projectRootByCount.set(topicCount, await buildMemoryTree(topicCount));
    }
  }, 120_000);

  afterAll(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('publishes the warm-cache fast result inside the turn budget', async () => {
    const rows: Array<[number, number, number]> = [];

    for (const topicCount of TOPIC_COUNTS) {
      const projectRoot = projectRootByCount.get(topicCount)!;
      // Populate the session-like document cache before steady-state samples.
      await measureTimeToFastResultMs(projectRoot);

      const samples: number[] = [];
      for (let i = 0; i < REPEATS; i += 1) {
        samples.push(await measureTimeToFastResultMs(projectRoot));
      }
      samples.sort((a, b) => a - b);
      const median = samples[Math.floor(samples.length / 2)];
      const worst = samples[samples.length - 1];
      rows.push([topicCount, median, worst]);

      expect(Number.isFinite(median)).toBe(true);
    }

    const [smallest] = rows;
    // The ordinary case must leave the rest of the budget to spare. Loose
    // because CI is shared; the table is what carries the detail.
    expect(smallest[0]).toBe(TOPIC_COUNTS[0]);
    expect(smallest[1]).toBeLessThan(INITIAL_BUDGET_MS / 2);

    console.log(
      [
        '',
        'Warm-cache scan — time from recall start to fast result (single project scope)',
        `turn wait ceiling: ${INITIAL_BUDGET_MS} ms`,
        '',
        `| topics | median | worst of ${REPEATS} | share of budget | fast result inside budget? |`,
        '| --- | --- | --- | --- | --- |',
        ...rows.map(
          ([topicCount, median, worst]) =>
            `| ${topicCount} | ${median.toFixed(1)} ms | ${worst.toFixed(1)} ms | ${((median / INITIAL_BUDGET_MS) * 100).toFixed(1)}% | ${worst < INITIAL_BUDGET_MS ? 'yes' : 'no'} |`,
        ),
        '',
        'These samples reuse the in-process document cache and represent later',
        'recalls in the same session. They do not measure the cold first scan.',
        '',
        'Where a row reads "no", the turn spends the whole budget and still',
        'delivers nothing, which is worse than the zero-wait behaviour this',
        'branch replaced. That is why the wait ends on the fast result rather',
        'than always running to the ceiling: it removes the cost for every tree',
        'small enough to scan in time, and bounds it for the rest.',
      ].join('\n'),
    );
  }, 120_000);
});
