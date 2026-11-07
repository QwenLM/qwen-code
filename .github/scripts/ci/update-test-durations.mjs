#!/usr/bin/env node
// Refreshes test-durations.json from the job logs of recent ci.yml runs: the
// per-file times Vitest prints for the Linux unit-test and no-AK integration
// shards. Run it by hand (needs an authenticated `gh`), review the diff and
// commit it.
//
//   node .github/scripts/ci/update-test-durations.mjs [--runs N] [run-id ...]
//
// Without run ids it reads the latest N (default 10) successful pull_request
// runs: those collect no coverage, which slows the push runs. Only shards that
// ran on the ECS pool count, so one host class sets the times.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUTPUT = fileURLToPath(new URL('./test-durations.json', import.meta.url));
const REPO = 'QwenLM/qwen-code';
// Files under this many seconds cost about the per-file overhead alone.
const MIN_SECONDS = 2;
const UNIT_SUITES = {
  '@qwen-code/qwen-code': 'packages/cli',
  '@qwen-code/qwen-code-core': 'packages/core',
};

const gh = (...args) =>
  execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1 << 30 });

// Newer gh refuses to print a log's color codes without the flag; older gh
// does not know it. The log endpoint drops connections now and then.
function jobLog(jobId) {
  const path = `repos/${REPO}/actions/jobs/${jobId}/logs`;
  for (let attempt = 1; ; attempt++) {
    try {
      return gh('api', '--allow-escape-sequences', path);
    } catch (error) {
      if (String(error.stderr).includes('unknown flag')) return gh('api', path);
      if (attempt === 3) throw error;
    }
  }
}

function parseJobLog(log, integration) {
  const times = [];
  let suite = integration ? 'integration-tests' : undefined;
  for (const raw of log.split('\n')) {
    // Strip the Actions timestamp and any color codes.
    const line = raw
      .replace(/^\S+Z /, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9;]*m/g, '');
    const script = line.match(/^> (\S+)@\S+ (\S+)$/);
    if (script && !integration) {
      suite = script[2] === 'test:ci' ? UNIT_SUITES[script[1]] : undefined;
    }
    const file = line.match(
      /^ ✓ (\S+\.test\.tsx?) \(\d+ tests?[^)]*\) (\d+)ms$/,
    );
    if (file && suite) times.push([suite, file[1], Number(file[2]) / 1000]);
  }
  return times;
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

function main(argv) {
  let runs = 10;
  const ids = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--runs') runs = Number(argv[++i]);
    else ids.push(argv[i]);
  }
  if (ids.length === 0) {
    ids.push(
      ...gh(
        'run',
        'list',
        '-R',
        REPO,
        '--workflow',
        'ci.yml',
        '--event',
        'pull_request',
        '--status',
        'success',
        '--limit',
        String(runs),
        '--json',
        'databaseId',
        '--jq',
        '.[].databaseId',
      )
        .trim()
        .split('\n'),
    );
  }
  const samples = new Map();
  for (const id of ids) {
    const jobs = gh(
      'api',
      '--paginate',
      `repos/${REPO}/actions/runs/${id}/jobs?per_page=100`,
      '--jq',
      '.jobs[] | [.id, .name, .runner_name // ""] | @tsv',
    )
      .trim()
      .split('\n')
      .map((row) => row.split('\t'));
    for (const [jobId, name, runner] of jobs) {
      const integration = name.startsWith('Integration Tests (no-AK, shard');
      if (!integration && !name.startsWith('Linux unit tests (shard')) continue;
      if (!runner.startsWith('ecs-qwen-')) continue;
      const log = jobLog(jobId);
      for (const [suite, file, seconds] of parseJobLog(log, integration)) {
        const key = `${suite}\0${file}`;
        samples.set(key, [...(samples.get(key) ?? []), seconds]);
      }
    }
    console.error(`read run ${id}`);
  }
  const durations = JSON.parse(readFileSync(OUTPUT, 'utf8'));
  for (const suite of Object.values(durations)) suite.files = {};
  for (const [key, values] of [...samples].sort()) {
    const [suite, file] = key.split('\0');
    const seconds = Math.round(median(values));
    if (durations[suite] && seconds >= MIN_SECONDS) {
      durations[suite].files[file] = seconds;
    }
  }
  writeFileSync(OUTPUT, `${JSON.stringify(durations, null, 2)}\n`);
}

main(process.argv.slice(2));
