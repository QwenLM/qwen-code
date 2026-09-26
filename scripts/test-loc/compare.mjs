#!/usr/bin/env node
import fs from 'node:fs';
import {
  compareCoverage,
  compareFaults,
  compareMutations,
  compareTests,
} from './reports.mjs';

try {
  const [kind, before, after, ...options] = process.argv.slice(2);
  if (!after)
    throw new Error(
      'usage: compare.mjs tests|coverage|mutation|faults <before> <after> [--files a.ts,b.ts] [--mode compression|experiment] [--mapping file.json] [--expected frozen-mutation.json]',
    );
  const settings = { mode: 'compression' };
  while (options.length) {
    const key = options.shift();
    const value = options.shift();
    if (key === '--files') settings.files = value.split(',');
    else if (key === '--expected')
      settings.expected = JSON.parse(fs.readFileSync(value, 'utf8'));
    else if (key === '--mode') settings.mode = value;
    else if (key === '--mapping') {
      const mapping = JSON.parse(fs.readFileSync(value, 'utf8'));
      settings.mappings = mapping.mappings;
      settings.removed = mapping.removed;
    } else throw new Error(`Unknown option: ${key}`);
  }
  const a = fs.readFileSync(before, 'utf8');
  const b = fs.readFileSync(after, 'utf8');
  const compare = {
    tests: compareTests,
    mutation: compareMutations,
    faults: compareFaults,
  }[kind];
  const result =
    kind === 'coverage'
      ? compareCoverage(a, b, settings.files)
      : compare?.(JSON.parse(a), JSON.parse(b), settings);
  if (!result) throw new Error(`Unknown comparison: ${kind}`);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error.message }));
  process.exitCode = 2;
}
