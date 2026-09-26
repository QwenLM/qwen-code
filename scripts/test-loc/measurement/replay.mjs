#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
const command = args[0];
let activeTestProcess;
let activeCleanup;
let receivedSignal;
const interrupt = (signal) => {
  receivedSignal = signal;
  if (activeTestProcess?.pid) signalGroup(activeTestProcess.pid, signal);
  activeCleanup?.();
};
const onInterrupt = () => interrupt('SIGINT');
const onTerminate = () => interrupt('SIGTERM');
function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}
async function cleanGroup(pid) {
  signalGroup(pid, 'SIGTERM');
  const started = Date.now();
  while (true) {
    const running = execFileSync('ps', ['-axo', 'pid=,pgid=,stat='], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .some((line) => {
        const [, group, status] = line.trim().split(/\s+/);
        return Number(group) === pid && !status.startsWith('Z');
      });
    if (!running) return;
    if (Date.now() - started > 1000) signalGroup(pid, 'SIGKILL');
    if (Date.now() - started > 5000)
      throw new Error(`Owned process group ${pid} did not terminate`);
    await delay(25);
  }
}
async function executeOwned(file, argv, options) {
  if (process.platform === 'win32')
    throw new Error(
      'Measurement replay requires POSIX process groups; run on Linux or macOS',
    );
  let child, cleanup, failure, timer;
  const stdout = [],
    stderr = [];
  let buffered = 0;
  const beginCleanup = () => {
    if (child.pid && !cleanup) {
      cleanup = cleanGroup(child.pid);
      cleanup.catch(() => {});
    }
    return cleanup;
  };
  const result = await new Promise((resolve) => {
    child = spawn(file, argv, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeTestProcess = child;
    activeCleanup = beginCleanup;
    const collect = (chunks, chunk) => {
      buffered += chunk.length;
      if (buffered > options.maxBuffer) {
        failure ||= new Error('Child process output exceeded maxBuffer');
        beginCleanup();
      } else chunks.push(chunk);
    };
    child.stdout.on('data', (chunk) => collect(stdout, chunk));
    child.stderr.on('data', (chunk) => collect(stderr, chunk));
    child.once('error', (error) => {
      failure = error;
    });
    // Descendants may retain stdio after the leader exits, delaying close.
    child.once('exit', beginCleanup);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        status: code,
        signal,
        error: failure,
      });
    });
    if (options.timeout)
      timer = setTimeout(() => {
        failure = new Error(
          `Child process timed out after ${options.timeout}ms`,
        );
        beginCleanup();
      }, options.timeout);
  });
  try {
    await beginCleanup();
  } finally {
    activeTestProcess = undefined;
    activeCleanup = undefined;
  }
  if (receivedSignal) result.signal = receivedSignal;
  return result;
}

const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? fallback : args[index + 1];
};
const required = (name) => {
  const value = option(name);
  if (!value || value.startsWith('--')) throw new Error(`Missing --${name}`);
  return value;
};
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const save = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};
const git = (repo, ...gitArgs) =>
  execFileSync('git', ['-C', repo, ...gitArgs], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
const sourceFile = (repo, name) => {
  const file = path.resolve(repo, name);
  if (!file.startsWith(`${repo}${path.sep}`))
    throw new Error(`Outside repository: ${name}`);
  return file;
};
const clean = (repo, pkg) => {
  if (
    git(repo, 'status', '--porcelain', '--untracked-files=no', '--', pkg).trim()
  ) {
    throw new Error(
      `Tracked changes in ${pkg}; use an isolated clean checkout`,
    );
  }
};

const testPath =
  /(\.test\.|\.spec\.|\/__tests__\/|\/__mocks__\/|\/__fixtures__\/|\/fixtures\/|\/test-utils\/|\/testUtils\/|\.snap$)/;
function implementation(repo) {
  return git(repo, 'ls-files', '-z')
    .split('\0')
    .filter(Boolean)
    .filter(
      (file) =>
        !testPath.test('/' + file) && !file.startsWith('scripts/test-loc/'),
    )
    .filter(
      (file) =>
        file.startsWith('packages/') ||
        /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig[^/]*\.json)$/.test(
          file,
        ) ||
        (file.startsWith('scripts/') && /\.(mjs|cjs|js|ts)$/.test(file)),
    )
    .map((file) => ({
      file,
      sha256: hash(fs.readFileSync(sourceFile(repo, file))),
    }));
}

function candidates(repo, pkg, fault, allTests, importIndex, maxTests) {
  const selected = new Set();
  for (const file of fault.tests) {
    if (fs.existsSync(sourceFile(repo, file))) selected.add(file);
  }
  for (const file of fault.impl) {
    const base = file.replace(/\.(ts|tsx)$/, '');
    for (const extension of ['.test.ts', '.test.tsx']) {
      if (fs.existsSync(sourceFile(repo, base + extension)))
        selected.add(base + extension);
    }
    for (const test of importIndex.get(base) || []) selected.add(test);
  }
  const result = [...selected];
  const legacyCandidateTests =
    maxTests > 0 ? result.slice(0, maxTests) : allTests;
  return {
    candidateCount: result.length,
    legacyCandidateTests,
    candidateTests: legacyCandidateTests.filter((file) =>
      file.startsWith(`${pkg}/`),
    ),
    ignoredCandidateTests: legacyCandidateTests.filter(
      (file) => !file.startsWith(`${pkg}/`),
    ),
    collectionRule:
      maxTests > 0 ? 'changed-tests,siblings,depth-1-imports' : 'whole-package',
  };
}

function prepareFaults(repo, out) {
  const pkg = option('pkg', 'packages/core');
  const maxTests = Number(option('max-tests', '40'));
  const maxWorkers = Number(option('max-workers', '4'));
  if (!Number.isInteger(maxWorkers) || maxWorkers < 1)
    throw new Error('Invalid --max-workers');
  if (!Number.isInteger(maxTests) || maxTests < 0)
    throw new Error('Invalid --max-tests');
  clean(repo, pkg);
  const corpusFiles = required('corpus')
    .split(',')
    .map((file) => path.resolve(file));
  const faults = new Map();
  for (const file of corpusFiles) {
    for (const fault of json(file).corpus) {
      const previous = faults.get(fault.sha);
      if (previous && JSON.stringify(previous) !== JSON.stringify(fault)) {
        throw new Error(`Conflicting definitions for ${fault.sha}`);
      }
      faults.set(fault.sha, fault);
    }
  }
  if (!faults.size) throw new Error('Empty fault corpus');
  const allTests = git(repo, 'ls-files', '--', `${pkg}/src`)
    .split('\n')
    .filter((file) => /\.(test|spec)\.tsx?$/.test(file));
  const importIndex = new Map();
  for (const test of allTests) {
    const source = fs.readFileSync(sourceFile(repo, test), 'utf8');
    for (const match of source.matchAll(/from\s+['"](\.[^'"]+)\.js['"]/g)) {
      const target = path.posix.normalize(
        path.posix.join(path.posix.dirname(test), match[1]),
      );
      if (!importIndex.has(target)) importIndex.set(target, new Set());
      importIndex.get(target).add(test);
    }
  }
  const results = [];
  for (const fault of faults.values()) {
    const patch = git(
      repo,
      'diff',
      `${fault.sha}^`,
      fault.sha,
      '--',
      ...fault.impl,
    );
    if (!patch.trim()) throw new Error(`Empty patch for ${fault.sha}`);
    const checked = spawnSync('git', ['-C', repo, 'apply', '-R', '--check'], {
      input: patch,
      encoding: 'utf8',
    });
    if (checked.error || checked.signal)
      throw checked.error || new Error(checked.signal);
    const selected = candidates(
      repo,
      pkg,
      fault,
      allTests,
      importIndex,
      maxTests,
    );
    const testSupport = fault.impl.filter((file) => testPath.test('/' + file));
    const applicable = checked.status === 0 && testSupport.length === 0;
    if (!selected.candidateTests.length)
      throw new Error(`No candidates for ${fault.sha}`);
    const sources = fault.impl.map((file) => {
      const absolute = sourceFile(repo, file);
      return {
        file,
        sha256: fs.existsSync(absolute)
          ? hash(fs.readFileSync(absolute))
          : null,
      };
    });
    results.push({
      ...fault,
      ...selected,
      patch,
      patchSha256: hash(patch),
      sources,
      applicable,
      ...(applicable
        ? {}
        : {
            reason: testSupport.length
              ? 'corpus-patch-includes-test-support'
              : 'reverse-patch-does-not-apply-to-frozen-implementation',
            testSupport,
            applyError: checked.stderr.trim(),
          }),
    });
  }
  save(out, {
    schemaVersion: 1,
    kind: 'frozen-historical-faults',
    pkg,
    maxTests,
    maxWorkers,
    implementation: implementation(repo),
    excludeNames: args.flatMap((value, index) =>
      value === '--exclude-name' ? [args[index + 1]] : [],
    ),
    implementationRevision: git(repo, 'rev-parse', 'HEAD').trim(),
    createdAt: new Date().toISOString(),
    candidateProvenance:
      'reconstructed from the named revision using the original runner selection order and cap',
    corpora: corpusFiles.map((file) => ({
      file,
      sha256: hash(fs.readFileSync(file)),
    })),
    faults: results,
  });
  console.log(
    JSON.stringify({
      out,
      faults: results.length,
      eligible: results.filter((f) => f.applicable).length,
    }),
  );
}

async function collectTests(
  repo,
  pkg,
  tests,
  directory,
  label,
  timeout,
  maxWorkers,
  excludeNames,
  phase,
) {
  const report = path.join(directory, `${label}.json`);
  const vitest = path.join(repo, 'node_modules/vitest/vitest.mjs');
  if (!fs.existsSync(vitest))
    throw new Error('Install and build checkout dependencies first');
  const excluded = excludeNames.map((name) =>
    name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  );
  const run = await executeOwned(
    process.execPath,
    [
      vitest,
      'run',
      ...tests.map((test) => path.posix.relative(pkg, test)),
      '--coverage.enabled=false',
      '--dangerouslyIgnoreUnhandledErrors=false',
      '--retry=0',
      `--maxWorkers=${maxWorkers}`,
      '--reporter=json',
      `--outputFile=${report}`,
      ...(excluded.length
        ? [`--testNamePattern=^(?!(?:${excluded.join('|')})$)[\\s\\S]*$`]
        : []),
    ],
    {
      cwd: path.join(repo, pkg),
      encoding: 'utf8',
      timeout,
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, CI: '1', NO_COLOR: '1' },
    },
  );
  fs.writeFileSync(
    path.join(directory, `${label}.log`),
    `${run.stdout || ''}${run.stderr || ''}`,
  );
  if (run.error || run.signal)
    throw run.error || new Error(`Test process killed: ${run.signal}`);
  if (![0, 1].includes(run.status))
    throw new Error(`Vitest exited ${run.status}`);
  const result = json(report);
  if (
    !Number.isInteger(result.numTotalTests) ||
    result.numTotalTests <= 0 ||
    !Array.isArray(result.testResults)
  ) {
    throw new Error(`Incomplete test report: ${report}`);
  }
  if ((result.unhandledErrors?.length || 0) > 0)
    throw new Error(`Unhandled test errors: ${report}`);
  const assertions = result.testResults.flatMap(
    (suite) => suite.assertionResults || [],
  );
  const counts = { passed: 0, failed: 0, pending: 0, todo: 0 };
  for (const assertion of assertions) {
    const status =
      assertion.status === 'skipped' ? 'pending' : assertion.status;
    if (!(status in counts))
      throw new Error(`Unknown assertion status: ${assertion.status}`);
    counts[status]++;
  }
  if (
    assertions.length !== result.numTotalTests ||
    counts.passed !== result.numPassedTests ||
    counts.failed !== result.numFailedTests ||
    counts.pending !== result.numPendingTests ||
    counts.todo !== result.numTodoTests ||
    counts.passed + counts.failed === 0
  ) {
    throw new Error(
      `Incomplete or inconsistent assertion collection: ${report}`,
    );
  }
  const failures = [];
  const collectionFailures = [];
  const collected = new Set();
  for (const suite of result.testResults) {
    const name = path.relative(repo, suite.name).split(path.sep).join('/');
    collected.add(name);
    const seen = new Map();
    let failedAssertions = 0;
    for (const assertion of suite.assertionResults || []) {
      const fullName = assertion.fullName || assertion.title;
      const occurrence = seen.get(fullName) || 0;
      seen.set(fullName, occurrence + 1);
      if (assertion.status === 'failed') {
        failures.push({
          key: JSON.stringify([name, fullName, occurrence]),
          file: name,
          test: fullName,
        });
        failedAssertions++;
      }
    }
    if (suite.status === 'failed' && !failedAssertions) {
      collectionFailures.push({
        file: name,
        message:
          suite.message || 'Suite failed without an executed failing assertion',
      });
    }
  }
  const missing = tests.filter((test) => !collected.has(test));
  if (missing.length)
    throw new Error(`Missing requested test files: ${missing.join(', ')}`);
  if (phase === 'health' && collectionFailures.length) {
    const error = new Error(`Health test collection failed; see ${report}`);
    error.collectionFailures = collectionFailures;
    throw error;
  }
  if (
    (run.status === 0) !==
    (failures.length + collectionFailures.length === 0)
  )
    throw new Error(`Exit/report disagreement: ${report}`);
  return {
    totalTests: result.numTotalTests,
    failures,
    collectionFailures,
    exit: run.status,
    report,
  };
}

async function runFaults(repo, out) {
  const planFile = path.resolve(required('plan'));
  const plan = json(planFile);
  const timeout = Number(option('timeout-ms', '600000'));
  if (!Number.isInteger(timeout) || timeout <= 0)
    throw new Error('Invalid timeout');
  if (plan.kind !== 'frozen-historical-faults' || !plan.faults?.length)
    throw new Error('Invalid plan');
  clean(repo, plan.pkg);
  if (
    !Number.isInteger(plan.maxWorkers) ||
    plan.maxWorkers < 1 ||
    !Array.isArray(plan.implementation)
  )
    throw new Error('Plan must freeze implementation and maxWorkers');
  const actualImplementation = implementation(repo);
  if (
    JSON.stringify(actualImplementation) !== JSON.stringify(plan.implementation)
  )
    throw new Error(
      'Implementation or runtime configuration differs from frozen plan',
    );
  for (const fault of plan.faults) {
    if (hash(fault.patch) !== fault.patchSha256)
      throw new Error(`Patch changed: ${fault.sha}`);
    for (const source of fault.sources) {
      const absolute = sourceFile(repo, source.file);
      const actual = fs.existsSync(absolute)
        ? hash(fs.readFileSync(absolute))
        : null;
      if (actual !== source.sha256)
        throw new Error(
          `Implementation differs from frozen plan: ${source.file}`,
        );
    }
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const runDirectory = fs.mkdtempSync(
    path.join(path.dirname(out), 'fault-replay-'),
  );
  const result = {
    schemaVersion: 1,
    corpus: planFile,
    planSha256: hash(fs.readFileSync(planFile)),
    revision: git(repo, 'rev-parse', 'HEAD').trim(),
    ran: new Date().toISOString(),
    execution: {
      replaySha256: hash(fs.readFileSync(new URL(import.meta.url))),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      maxWorkers: plan.maxWorkers,
      runnerName: process.env.RUNNER_NAME || null,
    },
    expectedSHAs: plan.faults.map((fault) => fault.sha),
    complete: false,
    artifacts: runDirectory,
    detected: 0,
    missed: 0,
    other: 0,
    results: [],
  };
  const healthCache = new Map();
  let restoreActive;
  save(out, result);
  for (const [index, fault] of plan.faults.entries()) {
    const started = Date.now();
    const prefix = `${String(index).padStart(3, '0')}-${fault.sha.slice(0, 10)}`;
    const base = {
      sha: fault.sha,
      subject: fault.subject,
      candidateFiles: fault.candidateTests.length,
    };
    let record;
    if (!fault.applicable) {
      record = { ...base, status: 'ineligible', reason: fault.reason };
    } else {
      const originals = fault.sources.map(({ file }) => {
        const absolute = sourceFile(repo, file);
        return {
          absolute,
          content: fs.existsSync(absolute) ? fs.readFileSync(absolute) : null,
          mode: fs.existsSync(absolute) ? fs.statSync(absolute).mode : null,
        };
      });
      const recovery = path.join(runDirectory, `${prefix}-restore.json`);
      save(
        recovery,
        originals.map(({ absolute, content, mode }) => ({
          absolute,
          base64: content?.toString('base64') ?? null,
          mode,
        })),
      );
      restoreActive = () => {
        for (const original of originals) {
          if (original.content === null)
            fs.rmSync(original.absolute, { force: true });
          else {
            fs.mkdirSync(path.dirname(original.absolute), { recursive: true });
            fs.writeFileSync(original.absolute, original.content);
            fs.chmodSync(original.absolute, original.mode);
          }
        }
      };
      try {
        const healthKey = JSON.stringify(fault.candidateTests);
        if (!healthCache.has(healthKey)) {
          healthCache.set(
            healthKey,
            await collectTests(
              repo,
              plan.pkg,
              fault.candidateTests,
              runDirectory,
              `${prefix}-health`,
              timeout,
              plan.maxWorkers,
              plan.excludeNames || [],
              'health',
            ),
          );
        }
        const health = healthCache.get(healthKey);
        const applied = spawnSync('git', ['-C', repo, 'apply', '-R'], {
          input: fault.patch,
          encoding: 'utf8',
        });
        if (applied.status !== 0)
          throw new Error(`Frozen patch failed: ${applied.stderr}`);
        const injected = await collectTests(
          repo,
          plan.pkg,
          fault.candidateTests,
          runDirectory,
          `${prefix}-fault`,
          timeout,
          plan.maxWorkers,
          plan.excludeNames || [],
          'fault',
        );
        const inherited = new Set(
          health.failures.map((failure) => failure.key),
        );
        const newlyFailed = injected.failures.filter(
          (failure) => !inherited.has(failure.key),
        );
        if (injected.collectionFailures.length && newlyFailed.length === 0) {
          const error = new Error(
            `Fault has collection failures and no new failed assertions; see ${injected.report}`,
          );
          error.collectionFailures = injected.collectionFailures;
          throw error;
        }
        record = {
          ...base,
          collectionFailures: injected.collectionFailures,
          status: newlyFailed.length ? 'detected' : 'missed',
          failedTests: newlyFailed.length,
          totalTests: injected.totalTests,
          exit: injected.exit,
          failedFiles: [...new Set(newlyFailed.map((failure) => failure.file))],
          newFailures: newlyFailed,
          healthFailures: health.failures.length,
          baselineFailures: health.failures,
          healthReport: health.report,
          faultReport: injected.report,
        };
      } catch (error) {
        record = {
          ...base,
          status: 'no-result',
          reason: error.message,
          ...(error.collectionFailures
            ? { collectionFailures: error.collectionFailures }
            : {}),
        };
      } finally {
        restoreActive();
        restoreActive = undefined;
      }
    }
    record.seconds = Number(((Date.now() - started) / 1000).toFixed(1));
    result.results.push(record);
    if (record.status === 'detected') result.detected++;
    else if (record.status === 'missed') result.missed++;
    else result.other++;
    save(out, result);
    console.log(
      `${index + 1}/${plan.faults.length} ${fault.sha.slice(0, 10)} ${record.status} ${record.seconds}s`,
    );
    if (receivedSignal)
      throw new Error(`Interrupted by ${receivedSignal}; source restored`);
  }
  clean(repo, plan.pkg);
  result.complete = true;
  save(out, result);
  if (result.results.some((record) => record.status === 'no-result'))
    process.exitCode = 2;
}

function prepareMutations(repo, out) {
  const pkg = option('pkg', 'packages/core');
  const modules = required('modules').split(',');
  const profile = option('profile', 'sampled');
  if (!['sampled', 'deletion'].includes(profile))
    throw new Error('Unknown mutation profile');
  const seed = Number(option('seed', '20260926'));
  const maxWorkers = Number(option('max-workers', '4'));
  if (
    !Number.isInteger(seed) ||
    !Number.isInteger(maxWorkers) ||
    maxWorkers < 1
  )
    throw new Error('Invalid mutation options');
  clean(repo, pkg);
  const allTests = git(repo, 'ls-files', '--', `${pkg}/src`)
    .split('\n')
    .filter((file) => /\.(test|spec)\.tsx?$/.test(file));
  const samples = modules.map((module) => {
    const file = `${pkg}/${module}`;
    if (testPath.test('/' + file))
      throw new Error(`Test file is not a mutation target: ${file}`);
    const source = fs.readFileSync(sourceFile(repo, file), 'utf8');
    const base = module.replace(/\.(ts|tsx)$/, '');
    const tests = new Set();
    for (const ext of ['.test.ts', '.test.tsx']) {
      if (fs.existsSync(sourceFile(repo, `${pkg}/${base}${ext}`)))
        tests.add(base + ext);
    }
    for (const test of allTests) {
      const relative = path.posix.relative(pkg, test);
      for (const match of fs
        .readFileSync(sourceFile(repo, test), 'utf8')
        .matchAll(
          /import\s+(?!type\b)[^;]*?from\s+['"](\.[^'"]+?)(?:\.js)?['"]/gs,
        )) {
        if (
          path.posix.normalize(
            path.posix.join(path.posix.dirname(relative), match[1]),
          ) === base
        )
          tests.add(relative);
      }
    }
    const suppliedTests = option('tests');
    const requestedTests = suppliedTests
      ? suppliedTests.split(',')
      : [...tests].sort();
    if (!requestedTests.length)
      throw new Error(`No mutation tests selected for ${module}`);
    const lines = source.split('\n').length;
    let state = seed + module.length;
    const random = () => {
      state |= 0;
      state = (state + 0x6d2b79f5) | 0;
      let value = Math.imul(state ^ (state >>> 15), 1 | state);
      value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
    const ranges = [];
    for (const start of Array.from(
      { length: 6 },
      () => 1 + Math.floor(random() * Math.max(1, lines - 150)),
    ).sort((x, y) => x - y)) {
      const end = Math.min(lines, start + 149),
        previous = ranges.at(-1);
      if (previous && start <= previous[1])
        previous[1] = Math.max(previous[1], end);
      else ranges.push([start, end]);
    }
    return {
      module,
      sourceSha256: hash(source),
      requestedTests,
      mutate:
        profile === 'deletion'
          ? [module]
          : ranges.map(([start, end]) => `${module}:${start}-${end}`),
    };
  });
  save(out, {
    schemaVersion: 1,
    kind: 'frozen-mutation-samples',
    pkg,
    profile,
    seed,
    windows: 6,
    windowSize: 150,
    maxWorkers,
    implementation: implementation(repo),
    implementationRevision: git(repo, 'rev-parse', 'HEAD').trim(),
    samples,
  });
  console.log(JSON.stringify({ out, samples: samples.length }));
}

async function runMutations(repo, out) {
  const planFile = path.resolve(required('plan'));
  const plan = json(planFile);
  const runtime = path.resolve(required('runtime'));
  if (plan.kind !== 'frozen-mutation-samples' || !plan.samples?.length)
    throw new Error('Invalid mutation plan');
  clean(repo, plan.pkg);
  if (
    JSON.stringify(implementation(repo)) !== JSON.stringify(plan.implementation)
  )
    throw new Error(
      'Implementation or runtime configuration differs from frozen plan',
    );
  for (const name of ['core', 'vitest-runner']) {
    if (
      json(
        path.join(
          runtime,
          `node_modules/@stryker-mutator/${name}/package.json`,
        ),
      ).version !== '10.0.0'
    )
      throw new Error(`Install pinned Stryker ${name} 10.0.0`);
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const directory = fs.mkdtempSync(
    path.join(path.dirname(out), 'mutation-replay-'),
  );
  const configFile = path.join(
    repo,
    plan.pkg,
    `.test-loc-${path.basename(directory)}.config.ts`,
  );
  const vitestConfig = fs
    .readFileSync(
      new URL('./vitest.stryker.config.ts', import.meta.url),
      'utf8',
    )
    .replace(
      'coverage: { enabled: false },',
      'coverage: { enabled: false },\n      dangerouslyIgnoreUnhandledErrors: false,',
    );
  const originals = git(repo, 'ls-files', '--', plan.pkg)
    .split('\n')
    .filter(Boolean)
    .map((file) => sourceFile(repo, file))
    .filter((file) => fs.lstatSync(file).isFile())
    .map((absolute) => ({
      absolute,
      content: fs.readFileSync(absolute),
      mode: fs.statSync(absolute).mode,
    }));
  const restore = () => {
    for (const original of originals) {
      if (
        !fs.existsSync(original.absolute) ||
        !fs.readFileSync(original.absolute).equals(original.content)
      )
        fs.writeFileSync(original.absolute, original.content);
      if (fs.statSync(original.absolute).mode !== original.mode)
        fs.chmodSync(original.absolute, original.mode);
    }
  };
  const results = {
    schemaVersion: 1,
    planSha256: hash(fs.readFileSync(planFile)),
    revision: git(repo, 'rev-parse', 'HEAD').trim(),
    complete: false,
    expectedModules: plan.samples.map((sample) => sample.module),
    execution: {
      replaySha256: hash(fs.readFileSync(new URL(import.meta.url))),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      maxWorkers: plan.maxWorkers,
    },
    configurations: [],
    results: [],
  };
  save(out, results);
  try {
    fs.writeFileSync(configFile, vitestConfig, { flag: 'wx' });
    for (const [index, sample] of plan.samples.entries()) {
      const report = path.join(directory, `${index}-mutation.json`);
      const config = json(new URL('./stryker.core.json', import.meta.url));
      config.plugins = [
        path.join(
          runtime,
          'node_modules/@stryker-mutator/vitest-runner/dist/src/index.js',
        ),
      ];
      config.vitest.configFile = configFile;
      config.jsonReporter.fileName = report;
      config.mutate = sample.mutate;
      config.concurrency = plan.maxWorkers;
      config.ignoreStatic = plan.profile !== 'deletion';
      config.disableBail = plan.profile === 'deletion';
      if (plan.profile === 'deletion') config.mutator.excludedMutations = [];
      config.inPlace = true;
      config.logLevel = 'warn';
      const configPath = path.join(directory, `${index}-stryker.json`);
      save(configPath, config);
      results.configurations.push({
        module: sample.module,
        strykerConfig: configPath,
        strykerSha256: hash(fs.readFileSync(configPath)),
        vitestSha256: hash(vitestConfig),
      });
      save(out, results);
      const log = fs.openSync(
        path.join(directory, `${index}-stryker.log`),
        'w',
      );
      let exit;
      try {
        const run = await executeOwned(
          process.execPath,
          [
            path.join(
              runtime,
              'node_modules/@stryker-mutator/core/bin/stryker.js',
            ),
            'run',
            configPath,
          ],
          {
            cwd: path.join(repo, plan.pkg),
            maxBuffer: 256 * 1024 * 1024,
            env: {
              ...process.env,
              CI: '1',
              NO_COLOR: '1',
              STRYKER_TEST_INCLUDE: sample.requestedTests.join(','),
            },
          },
        );
        fs.writeSync(log, `${run.stdout || ''}${run.stderr || ''}`);
        if (run.error || run.signal)
          throw run.error || new Error(`Stryker process killed: ${run.signal}`);
        exit = run.status;
      } finally {
        fs.closeSync(log);
        restore();
      }
      if (receivedSignal || exit !== 0)
        throw new Error(
          `Stryker failed for ${sample.module}: ${receivedSignal || exit}`,
        );
      const observed = json(report);
      if (
        Object.keys(observed.files).length !== 1 ||
        !observed.files[sample.module] ||
        hash(observed.files[sample.module].source) !== sample.sourceSha256
      )
        throw new Error(`Mutation source mismatch: ${sample.module}`);
      const mutants = observed.files[sample.module].mutants;
      if (
        !mutants.length ||
        !mutants.some((mutant) =>
          ['Killed', 'Survived', 'Timeout'].includes(mutant.status),
        )
      )
        throw new Error(`No tested mutants for ${sample.module}`);
      const reportedTests = Object.keys(observed.testFiles || {}).sort();
      const omittedTests = sample.requestedTests.filter(
        (test) => !reportedTests.includes(test),
      );
      const threadExclusions = [
        'src/tools/ripGrep.test.ts',
        'src/extension/github.test.ts',
        'src/utils/projectSummary.test.ts',
        'src/utils/openaiLogger.test.ts',
        'src/ipc/peer-controllers.test.ts',
      ];
      if (omittedTests.some((test) => !threadExclusions.includes(test)))
        throw new Error(
          `Requested mutation tests missing from report: ${omittedTests.join(', ')}`,
        );
      results.results.push({
        module: sample.module,
        report,
        sha256: hash(fs.readFileSync(report)),
        mutants: mutants.length,
        requestedTests: sample.requestedTests,
        reportedTests,
        omittedTests: omittedTests.map((file) => ({
          file,
          reason: 'process.chdir is unavailable in Stryker worker threads',
        })),
      });
      save(out, results);
      console.log(
        `${index + 1}/${plan.samples.length} ${sample.module} ${mutants.length} mutants`,
      );
    }
  } finally {
    restore();
    fs.rmSync(configFile, { force: true });
  }
  clean(repo, plan.pkg);
  results.complete = true;
  save(out, results);
}

let lockFile;
try {
  const repo = fs.realpathSync(path.resolve(required('repo')));
  const out = path.resolve(required('out'));
  if (fs.existsSync(out))
    throw new Error(`Refusing to overwrite existing output: ${out}`);
  if (command === 'prepare-faults') prepareFaults(repo, out);
  else if (command === 'prepare-mutations') prepareMutations(repo, out);
  else if (command === 'run-faults' || command === 'run-mutations') {
    const lock = path.resolve(
      repo,
      git(repo, 'rev-parse', '--git-path', 'test-loc-replay.lock').trim(),
    );
    fs.writeFileSync(lock, `${process.pid}\n`, { flag: 'wx' });
    lockFile = lock;
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onTerminate);
    if (command === 'run-faults') await runFaults(repo, out);
    else await runMutations(repo, out);
  } else
    throw new Error(
      'Use prepare-faults, run-faults, prepare-mutations or run-mutations',
    );
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
} finally {
  process.off('SIGINT', onInterrupt);
  process.off('SIGTERM', onTerminate);
  if (lockFile) fs.rmSync(lockFile, { force: true });
}
