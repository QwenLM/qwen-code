/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, '..');
const DEFAULT_BASELINE_PATH = join(
  SCRIPT_DIR,
  'architecture-debt-baseline.json',
);
export const SOURCE_ROOTS = ['packages/core/src', 'packages/cli/src'];
const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);
export const EXCLUDED_DIRECTORY_NAMES = [
  '__fixtures__',
  '__mocks__',
  'fixtures',
  'generated',
  'schema',
  'schemas',
  'test',
  'tests',
];
const EXCLUDED_DIRECTORY_SET = new Set(EXCLUDED_DIRECTORY_NAMES);
export const EXCLUDED_FILE_PATTERNS = [
  '*.test.*',
  '*.spec.*',
  '*adapter*',
  '*schema*',
];
const EXCLUDED_FILE_REGEXES = [
  /(?:\.test|\.spec)\.[^.]+$/i,
  /adapter/i,
  /schema/i,
];
export const OVERSIZED_FILE_LINE_THRESHOLD = 1000;
const GENAI_IMPORT_PATTERN = /^\s*import\b[\s\S]*?['"]@google\/genai['"];?/m;

/**
 * Return whether a source path is production code covered by the ratchet.
 *
 * @param {string} filePath repository-relative source path
 * @returns {boolean} whether the path is eligible
 */
export function isEligibleProductionPath(filePath) {
  const normalized = filePath.replaceAll('\\', '/');
  const name = basename(normalized);
  const extension = name.slice(name.lastIndexOf('.'));
  if (!SOURCE_EXTENSIONS.has(extension)) return false;
  if (normalized.split('/').some((part) => EXCLUDED_DIRECTORY_SET.has(part))) {
    return false;
  }
  return !EXCLUDED_FILE_REGEXES.some((pattern) => pattern.test(name));
}

/**
 * Count physical source lines in a file.
 *
 * @param {string} content source text
 * @returns {number} number of source lines
 */
export function countSourceLines(content) {
  const lines = content.split(/\r?\n/);
  return lines.at(-1) === '' ? lines.length - 1 : lines.length;
}

/**
 * Count public export declarations in the core entry barrel.
 *
 * @param {string} source core src/index.ts source
 * @returns {number} number of export declarations
 */
export function countCorePublicExports(source) {
  return source.split(/\r?\n/).filter((line) => /^\s*export\b/.test(line))
    .length;
}

function walkProductionFiles(root, directory, files) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filePath = join(directory, entry.name);
    const relativePath = relative(root, filePath).replaceAll('\\', '/');
    if (entry.isDirectory()) {
      if (
        !relativePath
          .split('/')
          .some((part) => EXCLUDED_DIRECTORY_SET.has(part))
      ) {
        walkProductionFiles(root, filePath, files);
      }
      continue;
    }
    if (isEligibleProductionPath(relativePath)) {
      files.push({
        path: relativePath,
        content: readFileSync(filePath, 'utf8'),
      });
    }
  }
}

/**
 * Collect eligible production source files from the selected packages.
 *
 * @param {string} root repository root
 * @returns {Array<{path: string, content: string}>} deterministic source files
 */
export function collectProductionFiles(root) {
  const files = [];
  for (const sourceRoot of SOURCE_ROOTS) {
    const directory = join(root, sourceRoot);
    if (statSync(directory).isDirectory()) {
      walkProductionFiles(root, directory, files);
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * Measure the three architecture debt metrics from injected source data.
 *
 * @param {object} input measurement inputs
 * @param {Array<{path: string, content: string}>} input.files eligible source files
 * @param {string} input.coreIndexSource core src/index.ts source
 * @returns {{oversizedFiles: Record<string, number>, genaiImportFiles: string[], corePublicExports: number}}
 */
export function measureArchitectureDebt({ files, coreIndexSource }) {
  const oversizedFiles = {};
  const genaiImportFiles = [];
  for (const file of [...files].sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    const lineCount = countSourceLines(file.content);
    if (lineCount >= OVERSIZED_FILE_LINE_THRESHOLD) {
      oversizedFiles[file.path] = lineCount;
    }
    if (GENAI_IMPORT_PATTERN.test(file.content)) {
      genaiImportFiles.push(file.path);
    }
    GENAI_IMPORT_PATTERN.lastIndex = 0;
  }
  return {
    oversizedFiles,
    genaiImportFiles,
    corePublicExports: countCorePublicExports(coreIndexSource),
  };
}

/**
 * Compare measured debt with one checked-in baseline.
 *
 * @param {object} input comparison inputs
 * @param {ReturnType<typeof measureArchitectureDebt>} input.measurement current metrics
 * @param {object} input.baseline reviewed baseline JSON data
 * @returns {string[]} actionable growth findings
 */
export function findArchitectureDebtGrowth({ measurement, baseline }) {
  const findings = [];
  const baselineFiles = baseline.metrics.oversizedFiles;
  for (const [filePath, lineCount] of Object.entries(
    measurement.oversizedFiles,
  )) {
    const baselineLineCount = baselineFiles[filePath];
    if (baselineLineCount === undefined) {
      findings.push(
        `oversized production file added: ${filePath} has ${lineCount} lines (threshold ${OVERSIZED_FILE_LINE_THRESHOLD}); add it to scripts/architecture-debt-baseline.json only after review`,
      );
    } else if (lineCount > baselineLineCount) {
      findings.push(
        `oversized production file grew: ${filePath} is ${lineCount} lines (baseline ${baselineLineCount}); reduce it or update scripts/architecture-debt-baseline.json in the same reviewed change`,
      );
    }
  }

  const baselineGenai = new Set(baseline.metrics.genaiImportFiles);
  for (const filePath of measurement.genaiImportFiles) {
    if (!baselineGenai.has(filePath)) {
      findings.push(
        `new production @google/genai import: ${filePath}; remove the import or add it to scripts/architecture-debt-baseline.json only after review`,
      );
    }
  }

  if (measurement.corePublicExports > baseline.metrics.corePublicExports) {
    findings.push(
      `core public export surface grew: ${measurement.corePublicExports} declarations (baseline ${baseline.metrics.corePublicExports}); update scripts/architecture-debt-baseline.json only after reviewing the public API change`,
    );
  }
  return findings;
}

/**
 * Validate the checked-in baseline shape before comparing it.
 *
 * @param {object} baseline parsed baseline data
 * @returns {void}
 */
export function validateBaseline(baseline) {
  if (
    baseline?.version !== 1 ||
    baseline?.policy?.lineThreshold !== OVERSIZED_FILE_LINE_THRESHOLD ||
    JSON.stringify(baseline?.policy?.sourceRoots) !==
      JSON.stringify(SOURCE_ROOTS) ||
    JSON.stringify(baseline?.policy?.excludedDirectoryNames) !==
      JSON.stringify(EXCLUDED_DIRECTORY_NAMES) ||
    JSON.stringify(baseline?.policy?.excludedFilePatterns) !==
      JSON.stringify(EXCLUDED_FILE_PATTERNS) ||
    baseline?.metrics?.oversizedFiles == null ||
    !Array.isArray(baseline?.metrics?.genaiImportFiles) ||
    !Number.isInteger(baseline?.metrics?.corePublicExports)
  ) {
    throw new Error(
      'Invalid architecture debt baseline: expected version 1, explicit policy, and oversizedFiles, genaiImportFiles, and corePublicExports metrics.',
    );
  }
}

/**
 * Run the architecture debt ratchet against the repository.
 *
 * @param {object} [options] checker options
 * @param {string} [options.root] repository root
 * @param {string} [options.baselinePath] baseline path
 * @returns {number} process-style exit code
 */
export function checkArchitectureDebt({
  root = DEFAULT_ROOT,
  baselinePath = DEFAULT_BASELINE_PATH,
} = {}) {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  validateBaseline(baseline);
  const files = collectProductionFiles(root);
  const coreIndexSource = readFileSync(
    join(root, 'packages/core/src/index.ts'),
    'utf8',
  );
  const measurement = measureArchitectureDebt({ files, coreIndexSource });
  const findings = findArchitectureDebtGrowth({ measurement, baseline });
  if (findings.length > 0) {
    console.error(
      'Architecture debt ratchet failed; current debt may not grow:',
    );
    for (const finding of findings) console.error(`- ${finding}`);
    return 1;
  }
  console.log(
    `Architecture debt ratchet passed: ${Object.keys(measurement.oversizedFiles).length} oversized files, ${measurement.genaiImportFiles.length} @google/genai import files, ${measurement.corePublicExports} core public exports.`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = checkArchitectureDebt();
}
