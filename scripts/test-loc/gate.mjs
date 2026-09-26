#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compareCoverage, compareTests, testReport } from './reports.mjs';

export function runGate({
  repo,
  test,
  impl,
  base,
  out,
  mode = 'compression',
  mapping = {},
}) {
  repo = path.resolve(repo);
  const pkg = path.join(repo, 'packages/core');
  out = path.resolve(out);
  fs.mkdirSync(out, { recursive: true });
  const runDir = fs.mkdtempSync(path.join(out, 'run-'));
  const token = randomUUID();
  const owned = [];
  const report = {
    schemaVersion: 1,
    ok: false,
    mode,
    repo,
    test,
    impl,
    base,
    runDir,
    commands: [],
  };
  const writeOwned = (file, value) => {
    fs.writeFileSync(file, value, { flag: 'wx' });
    owned.push(file);
    return file;
  };
  const run = (command, args, cwd, label) => {
    const log = path.join(runDir, `${label}.log`);
    const fd = fs.openSync(log, 'wx');
    let result;
    try {
      result = spawnSync(command, args, {
        cwd,
        env: { ...process.env, CI: '1', NO_COLOR: '1', QWEN_CI_COVERAGE: '0' },
        stdio: ['ignore', fd, fd],
        timeout: 600_000,
      });
    } finally {
      fs.closeSync(fd);
    }
    report.commands.push({
      command,
      args,
      cwd,
      log,
      exit: result.status,
      signal: result.signal,
      error: result.error?.message,
    });
    if (result.error || result.signal || result.status !== 0)
      throw new Error(`${label} failed; see ${log}`);
    return result.status;
  };
  try {
    const revision = spawnSync(
      'git',
      ['-C', repo, 'rev-parse', '--verify', `${base}^{commit}`],
      { encoding: 'utf8' },
    );
    if (revision.status !== 0)
      throw new Error('Baseline does not resolve to a commit');
    report.baseCommit = revision.stdout.trim();
    if (
      !/^src\/.+\.(test|spec)\.[cm]?[jt]sx?$/.test(test) ||
      test.split('/').includes('..')
    )
      throw new Error('Expected a test path relative to packages/core');
    const sources = impl.split(',').filter(Boolean);
    if (
      !sources.length ||
      sources.some(
        (p) =>
          !p.startsWith('src/') ||
          p.split('/').includes('..') ||
          /[*?]/.test(p),
      )
    )
      throw new Error('Provide exact implementation paths separated by commas');
    const testPath = path.join(pkg, test);
    const digest = (content) =>
      createHash('sha256').update(content).digest('hex');
    report.sourceHashes = Object.fromEntries(
      [test, ...sources].map((source) => [
        source,
        digest(fs.readFileSync(path.join(pkg, source))),
      ]),
    );
    const beforePath = path.join(
      path.dirname(testPath),
      `.test-loc-${token}.test${path.extname(test)}`,
    );
    const baseline = spawnSync(
      'git',
      ['-C', repo, 'show', `${report.baseCommit}:packages/core/${test}`],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    if (baseline.status !== 0 || !baseline.stdout)
      throw new Error(`Cannot read baseline test: ${baseline.stderr}`);
    writeOwned(beforePath, baseline.stdout);
    report.baselineTestHash = digest(baseline.stdout);
    const snapshot = `packages/core/${path.posix.dirname(test)}/__snapshots__/${path.posix.basename(test)}.snap`;
    const snapshotResult = spawnSync(
      'git',
      ['-C', repo, 'show', `${report.baseCommit}:${snapshot}`],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    if (snapshotResult.status === 0) {
      const snapshotDir = path.join(path.dirname(testPath), '__snapshots__');
      if (!fs.existsSync(snapshotDir))
        throw new Error('Baseline snapshot directory is missing in candidate');
      writeOwned(
        path.join(snapshotDir, `${path.basename(beforePath)}.snap`),
        snapshotResult.stdout,
      );
    }
    const hook = writeOwned(
      path.join(pkg, `.test-loc-${token}-setup.ts`),
      `import { afterEach, expect } from 'vitest';
afterEach(({ task }) => { task.meta.testLocAssertions = expect.getState().assertionCalls; });
`,
    );
    const config = writeOwned(
      path.join(pkg, `.test-loc-${token}-config.ts`),
      `import { mergeConfig } from 'vitest/config';
import base from './vitest.config.js';
export default mergeConfig(base, { test: { setupFiles: [${JSON.stringify(hook)}] } });
`,
    );
    const require = createRequire(path.join(repo, 'package.json'));
    const vitest = path.join(
      path.dirname(require.resolve('vitest/package.json')),
      'vitest.mjs',
    );
    report.versions = {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      vitest: require('vitest/package.json').version,
    };
    const results = {};
    for (const [label, file] of [
      ['before', beforePath],
      ['after', testPath],
    ]) {
      const jsonPath = path.join(runDir, `${label}.json`);
      const coverageDir = path.join(runDir, `coverage-${label}`);
      run(
        process.execPath,
        [
          vitest,
          'run',
          file,
          '--config',
          config,
          '--reporter=json',
          `--outputFile=${jsonPath}`,
          '--retry=0',
          '--maxWorkers=1',
          '--maxConcurrency=1',
          '--dangerouslyIgnoreUnhandledErrors=false',
          '--coverage.enabled=true',
          '--coverage.reporter=lcov',
          `--coverage.reportsDirectory=${coverageDir}`,
          ...sources.map((source) => `--coverage.include=${source}`),
        ],
        pkg,
        label,
      );
      const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      if (
        json.testResults?.length !== 1 ||
        path.resolve(json.testResults[0].name) !== file
      )
        throw new Error(`${label}: expected exactly the requested test file`);
      testReport(json);
      results[label] = {
        json,
        coverage: fs.readFileSync(path.join(coverageDir, 'lcov.info'), 'utf8'),
      };
    }
    for (const [source, hash] of Object.entries(report.sourceHashes)) {
      if (digest(fs.readFileSync(path.join(pkg, source))) !== hash)
        throw new Error(`Source changed during measurement: ${source}`);
    }
    report.tests = compareTests(results.before.json, results.after.json, {
      ...mapping,
      mode,
    });
    report.coverage = compareCoverage(
      results.before.coverage,
      results.after.coverage,
      sources,
    );
    const prettier = path.join(
      path.dirname(require.resolve('prettier/package.json')),
      'bin/prettier.cjs',
    );
    const eslint = path.join(
      path.dirname(require.resolve('eslint/package.json')),
      'bin/eslint.js',
    );
    run(process.execPath, [prettier, '--check', testPath], repo, 'prettier');
    run(
      process.execPath,
      [eslint, '--max-warnings', '0', testPath],
      repo,
      'eslint',
    );
    report.ok = report.tests.ok && report.coverage.ok;
    report.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    report.error = error.message;
    report.exitCode = 2;
  } finally {
    for (const file of owned.reverse()) fs.rmSync(file, { force: true });
    fs.writeFileSync(
      path.join(runDir, 'gate.json'),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  return report;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  try {
    const [repo, test, impl, base, out, ...options] = process.argv.slice(2);
    if (!out)
      throw new Error(
        'usage: gate.mjs <repo> <test relative to core> <impl relative to core> <base rev> <out dir> [--mode compression|experiment] [--mapping file.json]',
      );
    let mode = 'compression';
    let mapping = {};
    while (options.length) {
      const name = options.shift();
      const value = options.shift();
      if (name === '--mode') mode = value;
      else if (name === '--mapping')
        mapping = JSON.parse(fs.readFileSync(value, 'utf8'));
      else throw new Error(`Unknown option: ${name}`);
    }
    const report = runGate({ repo, test, impl, base, out, mode, mapping });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.exitCode;
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 2;
  }
}
