#!/usr/bin/env node
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable no-console */
/**
 * Simple benchmark to compare Rust vs JavaScript file search performance
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Create a test directory with many files
async function createTestDirectory(
  baseDir: string,
  numDirs: number,
  numFilesPerDir: number,
) {
  console.log(`Creating test directory: ${baseDir}`);
  console.log(`  - ${numDirs} directories`);
  console.log(`  - ${numFilesPerDir} files per directory`);
  console.log(`  - Total: ${numDirs * numFilesPerDir} files`);

  if (existsSync(baseDir)) {
    await rm(baseDir, { recursive: true, force: true });
  }

  await mkdir(baseDir, { recursive: true });

  // Create .gitignore
  const gitignorePath = path.join(baseDir, '.gitignore');
  await writeFile(gitignorePath, 'node_modules/\n.git/\n*.log\n');

  // Create directories and files
  for (let d = 0; d < numDirs; d++) {
    const dirName = path.join(baseDir, `dir_${d}`);
    await mkdir(dirName, { recursive: true });

    for (let f = 0; f < numFilesPerDir; f++) {
      const fileName = path.join(dirName, `file_${f}.txt`);
      await writeFile(fileName, `Content of file ${f} in directory ${d}\n`);
    }
  }

  console.log('Test directory created!\n');
}

// Benchmark JavaScript implementation
async function benchmarkJS(crawlDir: string): Promise<number> {
  const { FileSearchFactory } = await import('./fileSearch.js');

  const options = {
    projectRoot: crawlDir,
    ignoreDirs: [],
    useGitignore: true,
    useQwenignore: false,
    cache: false,
    cacheTtl: 0,
    enableRecursiveFileSearch: true,
    enableFuzzySearch: false,
  };

  const start = performance.now();
  const searcher = FileSearchFactory.create(options);
  await searcher.initialize();
  const results = await searcher.search('*.txt');
  const end = performance.now();

  console.log(`JavaScript: Found ${results.length} files in ${end - start}ms`);
  return end - start;
}

// Benchmark Rust implementation
async function benchmarkRust(crawlDir: string): Promise<number> {
  const { FileSearchFactory } = await import('./fileSearch.js');

  const options = {
    projectRoot: crawlDir,
    ignoreDirs: [],
    useGitignore: true,
    useQwenignore: false,
    cache: false,
    cacheTtl: 0,
    enableRecursiveFileSearch: true,
    enableFuzzySearch: true,
  };

  const start = performance.now();
  const searcher = FileSearchFactory.create(options);
  await searcher.initialize();
  const results = await searcher.search('*.txt');
  const end = performance.now();

  console.log(`Rust: Found ${results.length} files in ${end - start}ms`);
  return end - start;
}

// Main benchmark runner
async function runBenchmark() {
  const testDir = path.join(__dirname, '../../../../../benchmark_test_dir');
  const numDirs = 100;
  const numFilesPerDir = 50;

  await createTestDirectory(testDir, numDirs, numFilesPerDir);

  console.log('Running benchmarks...\n');

  // Run JavaScript benchmark
  const jsTime = await benchmarkJS(testDir);

  // Small delay between runs
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Run Rust benchmark
  const rustTime = await benchmarkRust(testDir);

  console.log('\n=== Results ===');
  console.log(`JavaScript: ${jsTime.toFixed(2)}ms`);
  console.log(`Rust:       ${rustTime.toFixed(2)}ms`);
  console.log(`Speedup:    ${(jsTime / rustTime).toFixed(2)}x`);

  // Cleanup
  console.log('\nCleaning up test directory...');
  await rm(testDir, { recursive: true, force: true });
}

runBenchmark().catch(console.error);
