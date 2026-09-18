/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Micro-benchmark for the extension cold-load path
 * (`ExtensionManager.refreshCacheWithSnapshot`).
 *
 * Builds a throwaway fixture under the system temp dir (100 extensions x 40
 * skills / 10 commands / 5 agents) and refreshes the cache N times against
 * it. Both the extensions dir and the extension store live inside the
 * fixture root, so a run never touches the real `~/.qwen` state; the whole
 * root is removed afterwards.
 *
 * Each sample is validated against the fixture constants before it is
 * accepted — a truncated load (e.g. under a low file-descriptor limit)
 * aborts the run instead of recording a faster median. `--baseline`
 * persists the workload dimensions alongside the timings, and a later run
 * whose fixture no longer matches refuses to compare.
 *
 * `--manifest-only` benchmarks `refreshCatalogSnapshot` against the same
 * fixture: only manifest headers load, no skills / commands / agents scans
 * (the `GET /extensions` catalog path). Baselines record which mode ran, so
 * a manifest-only run never compares against a full-load baseline.
 *
 * Usage:
 *   npx tsx packages/core/scripts/bench-extension-load.ts [--manifest-only] [--baseline] [--runs 10]
 *
 * `--baseline` stores the result in .qwen/bench-baseline.json at the repo
 * root; a later run without the flag loads that file (if present) and
 * prints the delta.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { ExtensionManager } from '../src/extension/extensionManager.js';
import { ExtensionStore } from '../src/extension/extension-store.js';

const EXTENSION_COUNT = 100;
const SKILLS_PER_EXTENSION = 40;
const COMMANDS_PER_EXTENSION = 10;
const AGENTS_PER_EXTENSION = 5;
const EXPECTED_EXTENSIONS = EXTENSION_COUNT;
const EXPECTED_SKILLS = EXTENSION_COUNT * SKILLS_PER_EXTENSION;

// import.meta.url is packages/core/scripts/bench-extension-load.ts, so three
// dirname hops land on the repo root.
const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const BASELINE_PATH = path.join(REPO_ROOT, '.qwen', 'bench-baseline.json');

interface RunResult {
  medianMs: number;
  p90Ms: number;
  minMs: number;
  maxMs: number;
  runs: number;
  extensionCount: number;
  skillCount: number;
  mode: 'full' | 'manifest-only';
}

interface BaselineFile {
  date: string;
  medianMs: number;
  p90Ms: number;
  minMs: number;
  maxMs: number;
  runs: number;
  extensionCount: number;
  skillCount: number;
  mode: 'full' | 'manifest-only';
}

function createFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-bench-ext-'));
  const extensionsDir = path.join(root, 'extensions');
  fs.mkdirSync(extensionsDir, { recursive: true });

  for (let e = 0; e < EXTENSION_COUNT; e += 1) {
    const extDir = path.join(extensionsDir, `bench-ext-${e}`);
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(
      path.join(extDir, 'qwen-extension.json'),
      JSON.stringify({ name: `bench-ext-${e}`, version: '1.0.0' }),
    );

    const skillsDir = path.join(extDir, 'skills');
    for (let s = 0; s < SKILLS_PER_EXTENSION; s += 1) {
      const skillDir = path.join(skillsDir, `skill-${s}`);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        [
          '---',
          `name: skill-${s}`,
          'description: Benchmark skill with a reasonably detailed description string.',
          '---',
          `# Skill ${s}`,
          '',
          'Body paragraph repeated to give the parser a realistic file size.',
          'Lorem ipsum dolor sit amet, consectetur adipiscing elit.',
        ].join('\n'),
      );
    }

    const commandsDir = path.join(extDir, 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    for (let c = 0; c < COMMANDS_PER_EXTENSION; c += 1) {
      fs.writeFileSync(
        path.join(commandsDir, `command-${c}.md`),
        `---\ndescription: Command ${c}\n---\nCommand body`,
      );
    }

    const agentsDir = path.join(extDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    for (let a = 0; a < AGENTS_PER_EXTENSION; a += 1) {
      fs.writeFileSync(
        path.join(agentsDir, `agent-${a}.md`),
        [
          '---',
          `name: agent-${a}`,
          'description: Benchmark agent.',
          '---',
          'Agent prompt body long enough for the validator.',
        ].join('\n'),
      );
    }
  }
  return root;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(0, index)]!;
}

async function runOnce(
  extensionsDir: string,
  mode: 'full' | 'manifest-only',
): Promise<{
  elapsedMs: number;
  extensionCount: number;
  skillCount: number;
}> {
  const manager = new ExtensionManager({
    workspaceDir: extensionsDir,
    isWorkspaceTrusted: true,
    extensionStore: new ExtensionStore({
      extensionsDir,
      // Keep the store inside the throwaway fixture root; the default would
      // be the real ~/.qwen/extension-store.
      storeDir: path.join(extensionsDir, '..', 'extension-store'),
    }),
  });
  const start = performance.now();
  if (mode === 'manifest-only') {
    await manager.refreshCatalogSnapshot();
  } else {
    await manager.refreshCacheWithSnapshot();
  }
  const elapsedMs = performance.now() - start;
  const extensions = manager.getLoadedExtensions();
  return {
    elapsedMs,
    extensionCount: extensions.length,
    skillCount: extensions.reduce(
      (sum, extension) => sum + (extension.skills?.length ?? 0),
      0,
    ),
  };
}

function parseRuns(args: string[]): number {
  const runsFlagIndex = args.indexOf('--runs');
  if (runsFlagIndex < 0) return 10;
  const parsed = Number(args[runsFlagIndex + 1]);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `--runs must be a positive integer, got "${args[runsFlagIndex + 1]}"`,
    );
  }
  return parsed;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isBaseline = args.includes('--baseline');
  const runs = parseRuns(args);
  const mode = args.includes('--manifest-only')
    ? ('manifest-only' as const)
    : ('full' as const);

  const fixtureRoot = createFixture();
  const extensionsDir = path.join(fixtureRoot, 'extensions');

  const samples: number[] = [];
  let extensionCount = 0;
  let skillCount = 0;
  try {
    for (let i = 0; i < runs; i += 1) {
      const result = await runOnce(extensionsDir, mode);
      // The manifest-only mode never loads skills, so its skill count is
      // expected to be zero; only the extension count is workload-validated.
      if (
        result.extensionCount !== EXPECTED_EXTENSIONS ||
        (mode === 'full' && result.skillCount !== EXPECTED_SKILLS)
      ) {
        throw new Error(
          `run ${i}: loaded ${result.extensionCount}/${EXPECTED_EXTENSIONS} extensions, ` +
            `${result.skillCount}/${mode === 'full' ? EXPECTED_SKILLS : 0} skills — refusing to record a truncated sample`,
        );
      }
      samples.push(result.elapsedMs);
      extensionCount = result.extensionCount;
      skillCount = result.skillCount;
    }
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const result: RunResult = {
    medianMs: percentile(sorted, 50),
    p90Ms: percentile(sorted, 90),
    minMs: sorted[0]!,
    maxMs: sorted[sorted.length - 1]!,
    runs,
    extensionCount,
    skillCount,
    mode,
  };

  console.log(`mode: ${result.mode}`);
  console.log(
    `fixture: ${result.extensionCount} extensions, ${result.skillCount} skills`,
  );
  console.log(`runs: ${result.runs}`);
  console.log(`median: ${result.medianMs.toFixed(1)} ms`);
  console.log(`p90:    ${result.p90Ms.toFixed(1)} ms`);
  console.log(`min:    ${result.minMs.toFixed(1)} ms`);
  console.log(`max:    ${result.maxMs.toFixed(1)} ms`);

  if (isBaseline) {
    fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
    const baseline: BaselineFile = {
      date: new Date().toISOString(),
      medianMs: result.medianMs,
      p90Ms: result.p90Ms,
      minMs: result.minMs,
      maxMs: result.maxMs,
      runs: result.runs,
      extensionCount: result.extensionCount,
      skillCount: result.skillCount,
      mode: result.mode,
    };
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2));
    console.log(
      `\nbaseline saved to ${path.relative(REPO_ROOT, BASELINE_PATH)}`,
    );
    return;
  }

  if (fs.existsSync(BASELINE_PATH)) {
    const baseline = JSON.parse(
      fs.readFileSync(BASELINE_PATH, 'utf-8'),
    ) as BaselineFile;
    console.log('\n--- vs baseline ---');
    console.log(`baseline date: ${baseline.date}`);
    if (
      baseline.mode !== result.mode ||
      baseline.extensionCount !== result.extensionCount ||
      baseline.skillCount !== result.skillCount
    ) {
      console.log(
        `workload changed (baseline: ${baseline.mode}, ${baseline.extensionCount} extensions / ${baseline.skillCount} skills), baseline not comparable`,
      );
      return;
    }
    const delta =
      ((result.medianMs - baseline.medianMs) / baseline.medianMs) * 100;
    console.log(
      `baseline median: ${baseline.medianMs.toFixed(1)} ms -> now: ${result.medianMs.toFixed(1)} ms (${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%)`,
    );
  } else {
    console.log(
      `\n(no baseline at ${path.relative(REPO_ROOT, BASELINE_PATH)}; run with --baseline to record one)`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
