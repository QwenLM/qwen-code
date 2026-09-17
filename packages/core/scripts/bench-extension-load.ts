/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Micro-benchmark for the extension cold-load path
 * (`ExtensionManager.refreshCacheWithSnapshot`).
 *
 * Builds a fresh fixture on each run (30 extensions x 15 skills / 5 commands
 * / 3 agents), loads it N times from a new process-external directory each
 * iteration, and reports wall-clock median / P90 / min / max.
 *
 * Usage:
 *   npx tsx packages/core/scripts/bench-extension-load.ts [--baseline] [--runs 10]
 *
 * `--baseline` stores the result in .qwen/bench-baseline.json; a later run
 * without the flag loads that file (if present) and prints the delta.
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
}

interface BaselineFile {
  date: string;
  medianMs: number;
  p90Ms: number;
  minMs: number;
  maxMs: number;
  runs: number;
}

function createFixtureFixture(): string {
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
          'Agent prompt body.',
        ].join('\n'),
      );
    }
  }
  return extensionsDir;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(0, index)]!;
}

async function runOnce(extensionsDir: string): Promise<{
  elapsedMs: number;
  extensionCount: number;
  skillCount: number;
}> {
  const manager = new ExtensionManager({
    workspaceDir: extensionsDir,
    isWorkspaceTrusted: true,
    extensionStore: new ExtensionStore({ extensionsDir }),
  });
  const start = performance.now();
  await manager.refreshCacheWithSnapshot();
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isBaseline = args.includes('--baseline');
  const runsFlagIndex = args.indexOf('--runs');
  const runs = runsFlagIndex >= 0 ? Number(args[runsFlagIndex + 1]) || 10 : 10;

  const extensionsDir = createFixtureFixture();

  const samples: number[] = [];
  let extensionCount = 0;
  let skillCount = 0;
  try {
    for (let i = 0; i < runs; i += 1) {
      const result = await runOnce(extensionsDir);
      samples.push(result.elapsedMs);
      extensionCount = result.extensionCount;
      skillCount = result.skillCount;
    }
  } finally {
    fs.rmSync(extensionsDir, { recursive: true, force: true });
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
  };

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
    const delta =
      ((result.medianMs - baseline.medianMs) / baseline.medianMs) * 100;
    console.log('\n--- vs baseline ---');
    console.log(`baseline date: ${baseline.date}`);
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
