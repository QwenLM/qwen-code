/* eslint-disable no-console -- Benchmark output */
/* eslint-disable no-restricted-syntax -- require needed for CJS NAPI-RS module */
/**
 * Benchmark: Rust File Search vs JavaScript Implementation
 * Compares crawl/initialization and search performance
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { crawl } from './crawler.js';
import { filter } from './fileSearch.js';
import { loadIgnoreRules } from './ignore.js';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const RustModule = require('../../../../../file-search-rs/index.js');

interface BenchmarkResult {
  name: string;
  time: number;
  filesFound: number;
}

const TEST_DIR = path.resolve(__dirname, '../../../../..');

const TEST_PATTERNS = [
  '*.ts',
  '*.js',
  '**/*.json',
  '**/node_modules/**',
  'src/**/*.ts',
  '**/*.test.ts',
  '**/dist/**',
  '*ignore*',
  'package.json',
  '**/*.md',
];

async function countFiles(dir: string): Promise<number> {
  const { execSync } = await import('node:child_process');
  try {
    const result = execSync(`find "${dir}" -type f 2>/dev/null | wc -l`, {
      encoding: 'utf-8',
    });
    return parseInt(result.trim(), 10);
  } catch {
    return 0;
  }
}

async function benchmarkRustCrawl(): Promise<{
  time: number;
  files: string[];
}> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const RustFileSearch = RustModule as any;
  if (!RustFileSearch?.FileSearch) {
    console.error('Rust module not available');
    return { time: 0, files: [] };
  }

  const start = performance.now();
  const searcher = new RustFileSearch.FileSearch({
    projectRoot: TEST_DIR,
    useGitignore: true,
    useQwenignore: false,
    ignoreDirs: [],
    enableFuzzySearch: false,
    maxDepth: undefined,
  });

  await searcher.initialize();
  const files = searcher.getAllFiles();
  const end = performance.now();

  return { time: end - start, files };
}

async function benchmarkJSCrawl(): Promise<{
  time: number;
  files: string[];
}> {
  const options = {
    projectRoot: TEST_DIR,
    ignoreDirs: [] as string[],
    useGitignore: true,
    useQwenignore: false,
    cache: false,
    cacheTtl: 0,
  };

  const ignore = loadIgnoreRules(options);

  const start = performance.now();
  const files = await crawl({
    crawlDirectory: TEST_DIR,
    cwd: TEST_DIR,
    ignore,
    cache: false,
    cacheTtl: 0,
  });
  const end = performance.now();

  return { time: end - start, files };
}

async function benchmarkRustSearch(
  files: string[],
  patterns: string[],
): Promise<BenchmarkResult[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const RustFileSearch = RustModule as any;
  if (!RustFileSearch?.FileSearch) {
    return [];
  }

  const searcher = new RustFileSearch.FileSearch({
    projectRoot: TEST_DIR,
    useGitignore: true,
    useQwenignore: false,
    ignoreDirs: [],
    enableFuzzySearch: false,
    maxDepth: undefined,
  });

  await searcher.initialize();

  const results: BenchmarkResult[] = [];

  for (const pattern of patterns) {
    const start = performance.now();
    const searchResults = await searcher.search(pattern);
    const end = performance.now();

    results.push({
      name: pattern,
      time: end - start,
      filesFound: searchResults.length,
    });
  }

  return results;
}

async function benchmarkJSSearch(
  files: string[],
  patterns: string[],
): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];

  for (const pattern of patterns) {
    const start = performance.now();
    const searchResults = await filter(files, pattern, undefined);
    const end = performance.now();

    results.push({
      name: pattern,
      time: end - start,
      filesFound: searchResults.length,
    });
  }

  return results;
}

function formatTime(ms: number): string {
  if (ms < 1) {
    return `${(ms * 1000).toFixed(0)}μs`;
  }
  if (ms < 1000) {
    return `${ms.toFixed(2)}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
}

function printTable(
  headers: string[],
  rows: string[][],
  alignments: Array<'left' | 'right'> = [],
) {
  const colWidths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)),
  );

  const headerRow = headers.map((h, i) => h.padEnd(colWidths[i])).join(' | ');
  console.log(`| ${headerRow} |`);

  const separator = colWidths.map((w) => '-'.repeat(w)).join('-+-');
  console.log(`|-${separator}-|`);

  for (const row of rows) {
    const formattedRow = row
      .map((cell, i) => {
        const width = colWidths[i];
        if (alignments[i] === 'right') {
          return cell.padStart(width);
        }
        return cell.padEnd(width);
      })
      .join(' | ');
    console.log(`| ${formattedRow} |`);
  }
}

async function runBenchmark() {
  console.log('='.repeat(80));
  console.log('File Search Benchmark: Rust vs JavaScript');
  console.log('='.repeat(80));
  console.log(`\nTest directory: ${TEST_DIR}\n`);

  const totalFiles = await countFiles(TEST_DIR);
  console.log(`Total files in directory: ~${totalFiles}\n`);

  console.log('-'.repeat(80));
  console.log('PHASE 1: Crawl/Initialization');
  console.log('-'.repeat(80));

  console.log('\nRunning Rust crawl...');
  const rustCrawl = await benchmarkRustCrawl();
  console.log(
    `Rust: ${formatTime(rustCrawl.time)} (${rustCrawl.files.length} files)`,
  );

  console.log('\nRunning JS crawl...');
  const jsCrawl = await benchmarkJSCrawl();
  console.log(
    `JS:   ${formatTime(jsCrawl.time)} (${jsCrawl.files.length} files)`,
  );

  const crawlSpeedup = jsCrawl.time / rustCrawl.time;
  console.log(
    `\nCrawl speedup: ${crawlSpeedup.toFixed(2)}x (${crawlSpeedup > 1 ? 'Rust faster' : 'JS faster'})`,
  );

  console.log('\n' + '-'.repeat(80));
  console.log('PHASE 2: Search Performance');
  console.log('-'.repeat(80));

  console.log('\nRunning Rust searches...');
  const rustSearchResults = await benchmarkRustSearch(
    rustCrawl.files,
    TEST_PATTERNS,
  );

  console.log('Running JS searches...');
  const jsSearchResults = await benchmarkJSSearch(jsCrawl.files, TEST_PATTERNS);

  const searchComparison: string[][] = [];

  for (let i = 0; i < TEST_PATTERNS.length; i++) {
    const pattern = TEST_PATTERNS[i];
    const rust = rustSearchResults[i];
    const js = jsSearchResults[i];

    if (rust && js) {
      const speedup = js.time / rust.time;

      searchComparison.push([
        pattern,
        formatTime(rust.time),
        formatTime(js.time),
        rust.filesFound === js.filesFound ? '✓' : '✗',
        `${speedup.toFixed(2)}x`,
      ]);
    }
  }

  console.log('\n');
  printTable(['Pattern', 'Rust', 'JS', 'Match', 'Speedup'], searchComparison, [
    'left',
    'right',
    'right',
    'left',
    'right',
  ]);

  const totalRustSearch = rustSearchResults.reduce((sum, r) => sum + r.time, 0);
  const totalJSSearch = jsSearchResults.reduce((sum, r) => sum + r.time, 0);
  const totalSearchSpeedup = totalJSSearch / totalRustSearch;

  console.log('\n' + '-'.repeat(80));
  console.log('SUMMARY');
  console.log('-'.repeat(80));

  const summary: string[][] = [
    [
      'Crawl',
      formatTime(rustCrawl.time),
      formatTime(jsCrawl.time),
      `${crawlSpeedup.toFixed(2)}x`,
    ],
    [
      'Total Search',
      formatTime(totalRustSearch),
      formatTime(totalJSSearch),
      `${totalSearchSpeedup.toFixed(2)}x`,
    ],
  ];

  printTable(['Phase', 'Rust', 'JS', 'Speedup'], summary, [
    'left',
    'right',
    'right',
    'right',
  ]);

  console.log('\n' + '='.repeat(80));

  if (totalSearchSpeedup > 1) {
    console.log(
      `Rust is ${totalSearchSpeedup.toFixed(2)}x faster overall for search operations`,
    );
  } else {
    console.log(
      `JS is ${(1 / totalSearchSpeedup).toFixed(2)}x faster overall for search operations`,
    );
  }

  if (crawlSpeedup > 1) {
    console.log(
      `Rust is ${crawlSpeedup.toFixed(2)}x faster for crawl operations`,
    );
  } else {
    console.log(
      `JS is ${(1 / crawlSpeedup).toFixed(2)}x faster for crawl operations`,
    );
  }

  console.log('='.repeat(80));
}

runBenchmark().catch(console.error);
