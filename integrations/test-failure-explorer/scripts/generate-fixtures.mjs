/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import process from 'node:process';
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const integrationRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(integrationRoot, '../..');
const fixtureRoot = join(integrationRoot, 'test-fixtures');
const runnerRoot = join(fixtureRoot, 'runner');
const require = createRequire(join(repositoryRoot, 'package.json'));
const prettier = require('prettier');
const prettierOptions = await prettier.resolveConfig(fixtureRoot);
const serialize = (value) =>
  prettier.format(JSON.stringify(value), {
    ...prettierOptions,
    parser: 'json',
  });
const vitestPackage = require.resolve('vitest/package.json');
const runner = JSON.parse(await readFile(vitestPackage, 'utf8'));
if (runner.version !== '3.2.7') {
  throw new Error(`Expected locked Vitest 3.2.7, received ${runner.version}`);
}
const runnerCli = join(dirname(vitestPackage), 'vitest.mjs');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const cases = [
  { name: 'mixed', root: 'mixed', expectedExitCode: 1 },
  { name: 'file-error', root: 'file-error', expectedExitCode: 1 },
  { name: 'statuses', root: 'statuses', expectedExitCode: 0 },
  { name: 'no-tests-fail', root: 'no-tests', expectedExitCode: 1 },
  {
    name: 'no-tests-pass',
    root: 'no-tests',
    expectedExitCode: 0,
    extraArgs: ['--passWithNoTests'],
  },
  { name: 'unhandled', root: 'unhandled', expectedExitCode: 1 },
  { name: 'duplicate-titles', root: 'duplicate-titles', expectedExitCode: 1 },
  { name: 'hostile-text', root: 'hostile-text', expectedExitCode: 1 },
];

async function sourceHashes(directory, prefix = '') {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) {
      Object.assign(
        result,
        await sourceHashes(join(directory, entry.name), name + '/'),
      );
    } else {
      result[name] = hash(await readFile(join(directory, entry.name)));
    }
  }
  return result;
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'test-report-fixtures-'));
const projectRoot = join(temporaryRoot, 'project');
const provenance = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  runnerVersion: runner.version,
  nodeVersion: process.version,
  command:
    'node integrations/test-failure-explorer/scripts/generate-fixtures.mjs',
  sanitization: {
    temporaryProjectRoot: '/fixture-workspace',
    repositoryRoot: '/fixture-repository',
    temporaryOutputDirectory: '/fixture-output',
    policy:
      'Recursively replace only generated absolute path prefixes in JSON string values. Keep reporter counts, states, timings, messages and stacks otherwise unchanged. Hash both original bytes and the committed sanitized JSON.',
  },
  sources: await sourceHashes(runnerRoot),
  generatorSha256: hash(await readFile(fileURLToPath(import.meta.url))),
  reports: [],
};

function sanitize(value) {
  if (typeof value === 'string') {
    return value
      .replaceAll(projectRoot, '/fixture-workspace')
      .replaceAll(repositoryRoot, '/fixture-repository')
      .replaceAll(temporaryRoot, '/fixture-output')
      .replaceAll(process.execPath, '/fixture-node');
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, sanitize(entry)]),
    );
  }
  return value;
}

try {
  await cp(runnerRoot, projectRoot, { recursive: true });
  await symlink(
    join(repositoryRoot, 'node_modules'),
    join(projectRoot, 'node_modules'),
  );
  await writeFile(
    join(projectRoot, 'package.json'),
    '{"private":true,"type":"module"}\n',
  );
  for (const sample of cases) {
    const output = join(temporaryRoot, sample.name + '.json');
    const args = [
      runnerCli,
      'run',
      '--root',
      join(projectRoot, sample.root),
      '--config',
      join(projectRoot, 'vitest.config.mjs'),
      '--reporter=default',
      '--reporter=json',
      '--outputFile.json=' + output,
      ...(sample.extraArgs ?? []),
    ];
    const execution = spawnSync(process.execPath, args, {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    if (execution.error || execution.status !== sample.expectedExitCode) {
      throw new Error(
        `${sample.name}: expected exit ${sample.expectedExitCode}, received ${execution.status}; ${execution.error ?? ''}\n${execution.stdout}\n${execution.stderr}`,
      );
    }
    const raw = await readFile(output);
    const report = sanitize(JSON.parse(raw.toString('utf8')));
    const formatted = await serialize(report);
    await writeFile(join(fixtureRoot, sample.name + '.json'), formatted);
    const statuses = {};
    for (const file of report.testResults) {
      for (const assertion of file.assertionResults) {
        statuses[assertion.status] = (statuses[assertion.status] ?? 0) + 1;
      }
    }
    const consoleOutput = execution.stdout + execution.stderr;
    provenance.reports.push({
      filename: sample.name + '.json',
      origin: 'real-vitest-3.2.7',
      command: sanitize([process.execPath, ...args]).join(' '),
      exitCode: execution.status,
      rawSha256: hash(raw),
      sanitizedSha256: hash(formatted),
      consoleSha256: hash(consoleOutput),
      unhandledRejectionObserved:
        consoleOutput.includes('Unhandled Rejection') &&
        consoleOutput.includes('Fixture unhandled rejection'),
      observed: {
        success: report.success,
        numTotalTestSuites: report.numTotalTestSuites,
        numTotalTests: report.numTotalTests,
        numPassedTests: report.numPassedTests,
        numFailedTests: report.numFailedTests,
        numPendingTests: report.numPendingTests,
        numTodoTests: report.numTodoTests,
        fileEntries: report.testResults.length,
        assertionStatuses: statuses,
        filesWithMessages: report.testResults.filter((file) => file.message)
          .length,
      },
    });
    process.stdout.write(
      `${sample.name}: exit=${execution.status}, report.success=${report.success}\n`,
    );
  }

  const unhandled = provenance.reports.find(
    (entry) => entry.filename === 'unhandled.json',
  );
  if (!unhandled.unhandledRejectionObserved || !unhandled.observed.success) {
    throw new Error(
      'Unhandled sample did not demonstrate successful assertions/report with process exit 1',
    );
  }

  const source = await readFile(
    join(fixtureRoot, 'duplicate-titles.json'),
    'utf8',
  );
  const derived = JSON.parse(source);
  derived.testResults.push(globalThis.structuredClone(derived.testResults[0]));
  for (const key of [
    'numTotalTestSuites',
    'numFailedTestSuites',
    'numTotalTests',
    'numFailedTests',
  ]) {
    derived[key] *= 2;
  }
  const derivedText = await serialize(derived);
  await writeFile(
    join(fixtureRoot, 'duplicate-paths.derived.json'),
    derivedText,
  );
  provenance.reports.push({
    filename: 'duplicate-paths.derived.json',
    origin: 'derived-not-a-real-run',
    source: 'duplicate-titles.json',
    sourceSha256: hash(source),
    sanitizedSha256: hash(derivedText),
    transformation:
      'Duplicate the one testResults entry verbatim and double total/failed suite and test counters. No process execution or exit code is claimed for this derived sample.',
  });
  await writeFile(
    join(fixtureRoot, 'provenance.json'),
    await serialize(provenance),
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
