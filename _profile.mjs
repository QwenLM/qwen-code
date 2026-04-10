/**
 * Profile: direct native Rust vs full JS wrapper
 * Tests: / (full filesystem) with *.js search
 */
import { FileSearchFactory } from './packages/core/dist/src/utils/filesearch/fileSearch.js';
import { loadIgnoreRules } from './packages/core/dist/src/utils/filesearch/ignore.js';
import { crawl } from './packages/core/dist/src/utils/filesearch/crawler.js';
import { filter } from './packages/core/dist/src/utils/filesearch/fileSearch.js';

const testDir = '/';
console.log(`Profiling: ${testDir}\n`);

// ── 1. Full JS fallback path ──
console.log('=== 1. Pure JavaScript fallback ===');
const jsT0 = performance.now();
const ignore = loadIgnoreRules({
  projectRoot: testDir,
  ignoreDirs: [],
  useGitignore: true,
  useQwenignore: true,
});
const allFiles = await crawl({
  crawlDirectory: testDir,
  cwd: testDir,
  ignore,
  cache: false,
  cacheTtl: 0,
});
const crawlMs = performance.now() - jsT0;
console.log(`  Crawl:    ${crawlMs.toFixed(0)}ms (${allFiles.length} files)`);

const jsT1 = performance.now();
const jsResults = await filter(allFiles, '*.js', undefined);
const jsFilterMs = performance.now() - jsT1;
console.log(`  Filter:   ${jsFilterMs.toFixed(0)}ms (${jsResults.length} results)`);
console.log(`  Total:    ${(crawlMs + jsFilterMs).toFixed(0)}ms\n`);

// ── 2. Full Rust wrapper path ──
console.log('=== 2. Rust via JS wrapper (RustAcceleratedFileSearch) ===');
const rustT0 = performance.now();
const searcher = FileSearchFactory.create({
  projectRoot: testDir,
  ignoreDirs: [],
  useGitignore: true,
  useQwenignore: true,
  cache: false,
  enableRecursiveFileSearch: true,
  enableFuzzySearch: false,
});
await searcher.initialize();
const rustInitMs = performance.now() - rustT0;
console.log(`  Init:     ${rustInitMs.toFixed(0)}ms`);

const rustT1 = performance.now();
const rustResults = await searcher.search('*.js');
const rustSearchMs = performance.now() - rustT1;
console.log(`  Search:   ${rustSearchMs.toFixed(0)}ms (${rustResults.length} results)`);
console.log(`  Total:    ${(rustInitMs + rustSearchMs).toFixed(0)}ms\n`);

// ── 3. Direct native calls (bypass JS wrapper) ──
console.log('=== 3. Direct native Rust (.node) ===');

// Load the native module directly
const native = require('./packages/file-search-rs/index.js');
console.log('  Creating native FileSearch...');

const nativeT0 = performance.now();
const nativeSearch = new native.FileSearch({
  projectRoot: testDir,
  useGitignore: true,
  useQwenignore: true,
  ignoreDirs: [],
  enableFuzzySearch: false,
});
console.log('  Native constructor returned');

const nativeT1 = performance.now();
await nativeSearch.initialize();
const nativeInitMs = performance.now() - nativeT1;
const nativeFileCount = nativeSearch.getAllFiles().length;
console.log(`  Init:     ${nativeInitMs.toFixed(0)}ms (${nativeFileCount} files)`);

const nativeT2 = performance.now();
const nativeResults = await nativeSearch.search('*.js', null);
const nativeSearchMs = performance.now() - nativeT2;
console.log(`  Search:   ${nativeSearchMs.toFixed(0)}ms (${nativeResults.length} results)`);
console.log(`  Total:    ${(nativeInitMs + nativeSearchMs).toFixed(0)}ms\n`);

// ── Summary ──
console.log('═══════════════════════════════════════════════');
console.log('  Summary');
console.log('═══════════════════════════════════════════════');
console.log(`  JS crawl only:      ${crawlMs.toFixed(0)}ms`);
console.log(`  JS total:           ${(crawlMs + jsFilterMs).toFixed(0)}ms`);
console.log(`  Rust wrapper init:  ${rustInitMs.toFixed(0)}ms`);
console.log(`  Rust wrapper search: ${rustSearchMs.toFixed(0)}ms`);
console.log(`  Rust wrapper total: ${(rustInitMs + rustSearchMs).toFixed(0)}ms`);
console.log(`  Rust native init:   ${nativeInitMs.toFixed(0)}ms`);
console.log(`  Rust native search: ${nativeSearchMs.toFixed(0)}ms`);
console.log(`  Rust native total:  ${(nativeInitMs + nativeSearchMs).toFixed(0)}ms`);
console.log('');

const wrapperOverhead = (rustInitMs + rustSearchMs) - (nativeInitMs + nativeSearchMs);
console.log(`  JS wrapper overhead: ${wrapperOverhead.toFixed(0)}ms`);
console.log(`  Pure Rust time:      ${(nativeInitMs + nativeSearchMs).toFixed(0)}ms`);
