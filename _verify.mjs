/**
 * Verify: is the wrapper actually using Rust search?
 */
import { FileSearchFactory } from './packages/core/dist/src/utils/filesearch/fileSearch.js';

const testDir = '/';
console.log(`Testing: ${testDir}\n`);

const searcher = FileSearchFactory.create({
  projectRoot: testDir,
  ignoreDirs: [],
  useGitignore: true,
  useQwenignore: true,
  cache: false,
  enableRecursiveFileSearch: true,
  enableFuzzySearch: false,
});

console.log('[1] Initializing via wrapper...');
await searcher.initialize();

// Check if native is available
const isNative = searcher._nativeSearch !== null && searcher._nativeSearch !== undefined;
console.log(`[2] Native search available: ${isNative}`);

// Time the wrapper search
console.log('[3] Searching *.js via wrapper...');
const t0 = performance.now();
const results = await searcher.search('*.js');
const elapsed = performance.now() - t0;
console.log(`    Wrapper search: ${elapsed.toFixed(0)}ms (${results.length} results)`);

// Time the direct native search
if (isNative) {
  console.log('[4] Searching *.js via direct native...');
  const t1 = performance.now();
  const nativeResults = await searcher._nativeSearch.search('*.js', null);
  const nativeElapsed = performance.now() - t1;
  console.log(`    Direct native:  ${nativeElapsed.toFixed(0)}ms (${nativeResults.length} results)`);
  console.log(`\n  Wrapper overhead: ${(elapsed - nativeElapsed).toFixed(0)}ms`);
}
