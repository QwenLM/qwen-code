#!/usr/bin/env npx tsx
/**
 * Batch run terminal screenshot scenarios
 *
 * Usage:
 *   npx tsx integration-tests/terminal-capture/run.ts integration-tests/terminal-capture/scenarios/about.ts
 *   npx tsx integration-tests/terminal-capture/run.ts integration-tests/terminal-capture/scenarios/         # batch
 *   npx tsx integration-tests/terminal-capture/run.ts integration-tests/terminal-capture/scenarios/*.ts     # glob
 */

import {
  loadScenarios,
  runScenario,
  type RunResult,
} from './scenario-runner.js';
import { readdirSync, statSync } from 'node:fs';
import { resolve, extname, join } from 'node:path';

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(
      `
Usage: npx tsx integration-tests/terminal-capture/run.ts <scenario.ts | directory>...

Examples:
  npx tsx integration-tests/terminal-capture/run.ts integration-tests/terminal-capture/scenarios/about.ts
  npx tsx integration-tests/terminal-capture/run.ts integration-tests/terminal-capture/scenarios/
    `.trim(),
    );
    process.exit(1);
  }

  // Collect all .ts scenario files from arguments
  const scenarioFiles: string[] = [];
  for (const arg of args) {
    const abs = resolve(arg);
    try {
      const stat = statSync(abs);
      if (stat.isDirectory()) {
        const files = readdirSync(abs)
          .filter((f) => extname(f) === '.ts')
          .sort()
          .map((f) => join(abs, f));
        scenarioFiles.push(...files);
      } else {
        scenarioFiles.push(abs);
      }
    } catch {
      console.error(`❌ Not found: ${arg}`);
      process.exit(1);
    }
  }

  if (scenarioFiles.length === 0) {
    console.error('❌ No .ts scenario files found');
    process.exit(1);
  }

  console.log(`🎬 Running ${scenarioFiles.length} scenario(s)...\n`);

  // Run scenarios sequentially (single file can export an array)
  const results: RunResult[] = [];
  for (const file of scenarioFiles) {
    const { configs, basedir } = await loadScenarios(file);
    for (const config of configs) {
      const result = await runScenario(config, basedir);
      results.push(result);
    }
  }

  // Summary
  console.log(`\n${'═'.repeat(60)}`);
  console.log('📊 Summary');
  console.log('═'.repeat(60));

  const passed = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);
  const totalScreenshots = results.reduce(
    (sum, r) => sum + r.screenshots.length,
    0,
  );
  const totalTime = results.reduce((sum, r) => sum + r.durationMs, 0);

  for (const r of results) {
    const icon = r.success ? '✅' : '❌';
    const time = (r.durationMs / 1000).toFixed(1);
    console.log(
      `  ${icon} ${r.name} — ${r.screenshots.length} screenshots, ${time}s`,
    );
    if (r.error) console.log(`     ${r.error}`);
  }

  console.log(
    `\n  Total: ${passed.length} passed, ${failed.length} failed, ${totalScreenshots} screenshots, ${(totalTime / 1000).toFixed(1)}s`,
  );

  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
