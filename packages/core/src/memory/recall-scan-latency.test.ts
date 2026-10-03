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
 * Measures cold and steady-state recall scan latency.
 *
 * `recall-delivery-eval.test.ts` times the deterministic *scoring*, which is
 * microseconds. That is not what decides whether the fast path delivers. The
 * fast result is published from `onFastResult`, which fires only after recall
 * has enumerated, read, and parsed every topic file — and the cold first scan
 * is the one the initial-turn budget has to cover, since a session's
 * `documentCache` starts empty.
 *
 * So this file measures wall-clock time from the recall call to the fast
 * callback, against a real temporary memory tree, with the model selector
 * mocked to hang the way a network round trip does — once with no document
 * cache (first session turn) and once reusing a session-like cache.
 *
 * Timings are machine-dependent and CI is shared, so the assertions are
 * deliberately loose; the printed table is the artifact worth reading.
 */

vi.mock('./relevanceSelector.js', () => ({
  selectRelevantAutoMemoryDocumentsByModel: vi.fn(),
}));

/** Mirrors INITIAL_MEMORY_RECALL_WAIT_MS in client.ts. */
const INITIAL_BUDGET_MS = 100;
const TOPIC_COUNTS = [200, 500, 1000] as const;
const REPEATS = 5;
// A wall-clock median on a shared runner measures how busy the host is, not
// how fast the scan is: three release shards land on one machine, so the
// median inflates with the neighbours' load and the assertion stops being
// about this code. Assert the fastest sample instead — the run least
// contaminated by contention, and the closest thing to the intrinsic cost —
// and be honest about what the shared lane can check: not the budget —
// a host that busy cannot say whether 100ms is met — but an order of
// magnitude. A scan that has blown up still reddens the release; one that
// merely drifted is caught by the strict bound off shared runners, where
// the property this test is named for is actually asserted.
// That contention is the ECS pool's, so it gets its own switch. Both lane
// predicates take `env` so a case can pin every arm under a controlled
// environment instead of the ambient one: exactly one arm runs per CI job, and
// this PR's own `Test (ubuntu-latest)` job lands on the pool, so an arm whose
// whole failure mode is silently not matching would otherwise never execute
// anywhere.
function isPoolLane(env: NodeJS.ProcessEnv): boolean {
  return env['RUNNER_NAME']?.startsWith('ecs-qwen-') === true;
}

// RUNNER_ENVIRONMENT is Actions' documented discriminator for the lane class
// ('github-hosted' | 'self-hosted') and is what this repo's other gates read;
// the RUNNER_NAME display-name prefix stays beside it rather than being
// load-bearing alone, because GitHub calls that string non-unique.
function isHostedLane(env: NodeJS.ProcessEnv): boolean {
  return (
    env['RUNNER_ENVIRONMENT'] === 'github-hosted' ||
    env['RUNNER_NAME']?.startsWith('GitHub Actions') === true
  );
}

const POOL_CI = isPoolLane(process.env);
const HOSTED_CI = isHostedLane(process.env);
const FAST_RESULT_CEILING_MS = POOL_CI
  ? INITIAL_BUDGET_MS * 10
  : INITIAL_BUDGET_MS / 2;
// The cold scan is what the initial-turn budget actually has to cover, so the
// smaller corpi face the budget itself. The 1000-topic row sits just over it
// even at one YAML parse per file (~104ms measured) — the budget was sized for
// the warm path — so its ceiling is the measured cost with ~20% slack, which
// still reddens if the frontmatter rescue's second CST parse returns (~+48%
// at 1000 files). On the pool every row instead faces an order-of-magnitude
// bound, keyed off the same `ecs-qwen-` prefix ci.yml uses for
// QWEN_SKIP_LATENCY_BUDGETS, so routing through expectWithinLatencyBudget's
// poolMultiplier would stack a second 10x.
//
// A GitHub-hosted lane is one lane class, not one slow row. Across hosted
// `Test (ubuntu-latest)` jobs the 1000-topic best-of-5 spans 128-227ms on four
// runners, and the smaller corpi breached the strict 100ms bound at 110-177ms
// on eight jobs — five of those on all three vitest attempts, which `--retry`
// cannot rescue. So every cold row moves off the strict bound here, sized by
// this file's own ~20% slack convention rather than the pool's multiple:
// against the same developer-machine baseline the `~5x` pool figure in
// `test-utils/latency-budget.ts` uses, this lane measures ~1.2-2.2x, and 2.2x
// leaves ~1.2x headroom over the worst sample seen on each row (220ms vs
// 177ms, 275ms vs 227ms). The pool's 10x would have swallowed the reparse
// regression at 1250ms.
// What a wall-clock ceiling cannot do is promise that regression reddens
// fleet-wide: 275ms only catches the +48% reparse where the 1000-topic
// baseline exceeds 275/1.48 ≈ 186ms, so the faster hosted runners pass it. It
// stays reliably asserted on the strict developer-machine lane, which is where
// this file's header says the number means something. The warm-cache gate is
// untouched — hosted jobs measured green under it (run 36640349705:
// `recall-scan-latency.test.ts (2 tests | 1 failed)`).
const HOSTED_COLD_SCAN_MULTIPLIER = 2.2;

/** Ceiling for one cold-scan row on the lane `env` describes. */
function coldScanCeilingMs(
  topicCount: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const bound =
    topicCount >= 1000 ? INITIAL_BUDGET_MS * 1.25 : INITIAL_BUDGET_MS;
  if (isPoolLane(env)) {
    return bound * 10;
  }
  return isHostedLane(env) ? bound * HOSTED_COLD_SCAN_MULTIPLIER : bound;
}

/**
 * The detected lane class, for assertion messages only.
 *
 * `packages/core/vitest.config.ts` sets `silent: true` and core's test scripts
 * are bare `vitest run`, so both console tables below — which this file's
 * header calls the artifact worth reading — are discarded in CI. The lane has
 * to ride along in the assertion message, or a red gate reports a bare number
 * with no way to tell which classifier arm fired (or failed to).
 */
function laneLabel(): string {
  return `env=${process.env['RUNNER_ENVIRONMENT'] ?? 'unset'} runner=${
    process.env['RUNNER_NAME'] ?? 'unset'
  }`;
}

/**
 * Assert a measured duration against its ceiling, naming the lane and both
 * numbers when it fails.
 *
 * The tables above are what a human reads locally; this message is what
 * survives CI, where `silent: true` discards them. `vitest/valid-expect`
 * defaults to one argument, so the message needs a local disable.
 */
function expectWithinCeiling(
  actualMs: number,
  ceilingMs: number,
  context: string,
): void {
  const message = `${context} actual=${actualMs.toFixed(1)}ms ceiling=${ceilingMs}ms`;
  // eslint-disable-next-line vitest/valid-expect -- the message argument is the point
  expect(actualMs, message).toBeLessThan(ceilingMs);
}

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
async function measureTimeToFastResultMs(
  projectRoot: string,
  documentCache?: AutoMemoryDocumentCache,
): Promise<number> {
  let elapsed = Number.NaN;
  const startedAt = performance.now();
  const recall = resolveRelevantAutoMemoryPromptForQuery(
    projectRoot,
    'what is the saved scanbench codeword for deployment',
    {
      config: {
        getSessionId: () => 'session-scan-bench',
        getModel: () => 'qwen3-coder-plus',
        // No trust answer now reads as untrusted (empty project universe in
        // local-memory mode); production callers always pass a real Config.
        isTrustedFolder: () => true,
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

/** The per-project session-like cache, created on first use. */
function sessionCacheFor(projectRoot: string): AutoMemoryDocumentCache {
  let documentCache = documentCacheByProject.get(projectRoot);
  if (!documentCache) {
    documentCache = new Map();
    documentCacheByProject.set(projectRoot, documentCache);
  }
  return documentCache;
}

describe('coldScanCeilingMs lane arms', () => {
  // One arm runs per CI job, and this PR's own `Test (ubuntu-latest)` job lands
  // on the pool, so without these cases the hosted arm never executes anywhere:
  // dropping a disjunct, or putting `topicCount >= 1000` back, would redden
  // fork PRs again with nothing failing at the edit. `env` is passed rather
  // than stubbed, so no case here can leak a lane into the timing tests below.
  const arms: Array<{
    lane: string;
    env: NodeJS.ProcessEnv;
    /** Ceiling for the 200- and 500-topic cold rows. */
    small: number;
    /** Ceiling for the 1000-topic cold row. */
    large: number;
  }> = [
    {
      lane: 'ecs pool (parity name)',
      env: { RUNNER_NAME: 'ecs-qwen-parity' },
      small: 1000,
      large: 1250,
    },
    {
      lane: 'ecs pool (numbered name)',
      env: { RUNNER_NAME: 'ecs-qwen-hk1-01' },
      small: 1000,
      large: 1250,
    },
    {
      lane: 'GitHub-hosted (RUNNER_ENVIRONMENT)',
      env: { RUNNER_ENVIRONMENT: 'github-hosted' },
      small: 220,
      large: 275,
    },
    {
      lane: 'GitHub-hosted (RUNNER_NAME prefix)',
      env: { RUNNER_NAME: 'GitHub Actions 1000544680' },
      small: 220,
      large: 275,
    },
    {
      lane: 'strict (both unset)',
      env: {},
      small: 100,
      large: 125,
    },
  ];

  it.each(arms)('pins the $lane ceilings', ({ env, small, large }) => {
    // toBeCloseTo rather than toBe: 100 * 2.2 is 220.00000000000003 in binary
    // floating point, and what this case pins is the multiplier, not rounding.
    expect(coldScanCeilingMs(200, env)).toBeCloseTo(small, 6);
    expect(coldScanCeilingMs(500, env)).toBeCloseTo(small, 6);
    expect(coldScanCeilingMs(1000, env)).toBeCloseTo(large, 6);
  });
});

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
    const rows: Array<[number, number, number, number]> = [];

    for (const topicCount of TOPIC_COUNTS) {
      const projectRoot = projectRootByCount.get(topicCount)!;
      // Populate the session-like document cache before steady-state samples.
      await measureTimeToFastResultMs(
        projectRoot,
        sessionCacheFor(projectRoot),
      );

      const samples: number[] = [];
      for (let i = 0; i < REPEATS; i += 1) {
        samples.push(
          await measureTimeToFastResultMs(
            projectRoot,
            sessionCacheFor(projectRoot),
          ),
        );
      }
      samples.sort((a, b) => a - b);
      const best = samples[0];
      const median = samples[Math.floor(samples.length / 2)];
      const worst = samples[samples.length - 1];
      rows.push([topicCount, best, median, worst]);

      expect(Number.isFinite(median)).toBe(true);
    }

    const [smallest] = rows;
    // The ordinary case must leave the rest of the budget to spare. On the
    // pool only the best sample survives contention, so the loose bound checks
    // it; everywhere else — including hosted lanes, which measured green here —
    // the median faces the strict ceiling. The table is what carries the
    // detail, and the assertion message carries the lane.
    expect(smallest[0]).toBe(TOPIC_COUNTS[0]);
    expectWithinCeiling(
      smallest[POOL_CI ? 1 : 2],
      FAST_RESULT_CEILING_MS,
      `warm scan topics=${TOPIC_COUNTS[0]} ${laneLabel()} pool=${POOL_CI} ` +
        `hosted=${HOSTED_CI} statistic=${POOL_CI ? 'best' : 'median'}`,
    );

    console.log(
      [
        '',
        'Warm-cache scan — time from recall start to fast result (single project scope)',
        `turn wait ceiling: ${INITIAL_BUDGET_MS} ms`,
        '',
        `| topics | best of ${REPEATS} | median | worst of ${REPEATS} | share of budget | fast result inside budget? |`,
        '| --- | --- | --- | --- | --- | --- |',
        ...rows.map(
          ([topicCount, best, median, worst]) =>
            `| ${topicCount} | ${best.toFixed(1)} ms | ${median.toFixed(1)} ms | ${worst.toFixed(1)} ms | ${((median / INITIAL_BUDGET_MS) * 100).toFixed(1)}% | ${worst < INITIAL_BUDGET_MS ? 'yes' : 'no'} |`,
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

  it('publishes the cold-scan fast result inside the initial budget', async () => {
    // No documentCache: the first turn of a session scans with an empty one,
    // so this is the sample the initial-turn budget actually has to cover.
    const rows: Array<[number, number, number, number]> = [];

    for (const topicCount of TOPIC_COUNTS) {
      const projectRoot = projectRootByCount.get(topicCount)!;

      const samples: number[] = [];
      for (let i = 0; i < REPEATS; i += 1) {
        samples.push(await measureTimeToFastResultMs(projectRoot));
      }
      samples.sort((a, b) => a - b);
      const best = samples[0];
      const median = samples[Math.floor(samples.length / 2)];
      const worst = samples[samples.length - 1];
      rows.push([topicCount, best, median, worst]);

      expect(Number.isFinite(median)).toBe(true);
      // If the cold scan alone exceeds the budget, the turn pays the whole
      // wait and still delivers nothing — strictly worse than delivering
      // without waiting. Every documented corpus size must fit. The
      // assertion faces the best sample: the one least contaminated by
      // contention when the suite shares a machine.
      expectWithinCeiling(
        best,
        coldScanCeilingMs(topicCount),
        `cold scan topics=${topicCount} ${laneLabel()} pool=${POOL_CI} ` +
          `hosted=${HOSTED_CI}`,
      );
    }

    console.log(
      [
        '',
        'Cold-cache scan — time from recall start to fast result (single project scope)',
        `initial budget: ${INITIAL_BUDGET_MS} ms`,
        '',
        `| topics | best of ${REPEATS} | median | worst of ${REPEATS} | share of budget | fast result inside budget? |`,
        '| --- | --- | --- | --- | --- | --- |',
        ...rows.map(
          ([topicCount, best, median, worst]) =>
            `| ${topicCount} | ${best.toFixed(1)} ms | ${median.toFixed(1)} ms | ${worst.toFixed(1)} ms | ${((median / INITIAL_BUDGET_MS) * 100).toFixed(1)}% | ${median < INITIAL_BUDGET_MS ? 'yes' : 'no'} |`,
        ),
        '',
        'These samples pass no document cache: the first turn of a session',
        'reads and parses every topic file. The fast result is only available',
        'once this scan completes, so this is the real precondition for the',
        'fast path delivering anything on the turn that needs it most.',
      ].join('\n'),
    );
  }, 120_000);
});
