import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(
  new URL('./run-in-isolated-netns.sh', import.meta.url),
);

const PROXY_VARS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
];

function withTempDir(fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'isolated-netns-')));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeExecutable(path, content) {
  writeFileSync(path, content, 'utf8');
  chmodSync(path, 0o755);
}

// Stub `bwrap` that records every invocation's argv + environment to a JSONL
// file, handles the `-- true` preflight probe, and executes the wrapped command
// after `--` so exit codes and argument quoting are exercised end-to-end.
function installFakeBwrap(binDir, logPath, { failProbe = false } = {}) {
  const helper = join(binDir, 'fake-bwrap-impl.cjs');
  writeFileSync(
    helper,
    `
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const bwrapFlags = sep === -1 ? argv : argv.slice(0, sep);
const cmd = sep === -1 ? [] : argv.slice(sep + 1);
const envSnapshot = {};
for (const key of ${JSON.stringify([...PROXY_VARS, 'TMPDIR', 'PLAYWRIGHT_PORT', 'KEEP_ME'])}) {
  if (Object.prototype.hasOwnProperty.call(process.env, key)) {
    envSnapshot[key] = process.env[key];
  }
}
fs.appendFileSync(
  ${JSON.stringify(logPath)},
  JSON.stringify({ bwrapFlags, cmd, env: envSnapshot }) + '\\n',
);
if (${JSON.stringify(failProbe)} && cmd.length === 1 && cmd[0] === 'true') {
  process.stderr.write('bwrap: setting up uid map: Operation not permitted\\n');
  process.exit(1);
}
if (cmd.length === 0) process.exit(2);
const res = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit', env: process.env });
process.exit(res.status ?? 1);
`,
    'utf8',
  );
  writeExecutable(
    join(binDir, 'bwrap'),
    `#!/bin/sh\nexec "${process.execPath}" "${helper}" "$@"\n`,
  );
}

function readJsonLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function buildPathWithStub(binDir) {
  return `${binDir}:${process.env.PATH ?? '/usr/bin:/bin'}`;
}

// Minimal PATH that has standard utilities (`env`, `bash`, `sh`) but never
// exposes any real `bwrap` installed on the host.
function buildPathWithoutBwrap(dir) {
  const cleanBin = join(dir, 'no-bwrap-bin');
  mkdirSync(cleanBin, { recursive: true });
  for (const tool of ['env', 'sh', 'bash', 'true']) {
    const resolved = spawnSync('sh', ['-c', 'command -v "$1"', 'sh', tool], {
      encoding: 'utf8',
    });
    if (resolved.status === 0) {
      const target = resolved.stdout.trim();
      writeExecutable(
        join(cleanBin, tool),
        `#!/bin/sh\nexec "${target}" "$@"\n`,
      );
    }
  }
  return cleanBin;
}

describe('run-in-isolated-netns.sh', () => {
  it('wraps self-hosted commands with bwrap --unshare-net, strips proxies, and forwards args and exit status', () => {
    withTempDir((root) => {
      const binDir = join(root, 'bin');
      const workDir = join(root, 'work dir with spaces');
      mkdirSync(binDir, { recursive: true });
      mkdirSync(workDir, { recursive: true });
      const bwrapLog = join(root, 'bwrap.jsonl');
      const cmdLog = join(root, 'cmd.json');
      installFakeBwrap(binDir, bwrapLog);

      const targetScript = join(root, 'target.cjs');
      writeFileSync(
        targetScript,
        `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(cmdLog)}, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  proxies: Object.fromEntries(${JSON.stringify(PROXY_VARS)}.map((k) => [k, process.env[k] ?? null])),
  keepMe: process.env.KEEP_ME ?? null,
  port: process.env.PLAYWRIGHT_PORT ?? null,
}));
process.exit(42);
`,
        'utf8',
      );

      const proxyEnv = Object.fromEntries(
        PROXY_VARS.map((k) => [k, 'http://127.0.0.1:7890']),
      );
      const res = spawnSync(
        'bash',
        [
          SCRIPT,
          '--',
          process.execPath,
          targetScript,
          '--workspace=packages/web-shell',
          '--',
          '--shard=2/2',
          '--workers=2',
          'arg with spaces',
        ],
        {
          cwd: workDir,
          encoding: 'utf8',
          env: {
            ...process.env,
            ...proxyEnv,
            PATH: buildPathWithStub(binDir),
            RUNNER_ENVIRONMENT: 'self-hosted',
            QWEN_FORCE_ISOLATED_NETNS: '',
            KEEP_ME: 'preserved',
            PLAYWRIGHT_PORT: '35333',
          },
        },
      );

      assert.equal(res.status, 42);
      assert.match(res.stdout, /isolated loopback-only network namespace/);

      const calls = readJsonLines(bwrapLog);
      assert.equal(calls.length, 2, 'expected preflight probe + real exec');
      assert.deepEqual(calls[0].bwrapFlags, [
        '--unshare-net',
        '--die-with-parent',
        '--dev-bind',
        '/',
        '/',
      ]);
      assert.deepEqual(calls[0].cmd, ['true']);

      assert.deepEqual(calls[1].bwrapFlags, [
        '--unshare-net',
        '--die-with-parent',
        '--dev-bind',
        '/',
        '/',
        '--chdir',
        workDir,
      ]);
      assert.deepEqual(calls[1].cmd, [
        process.execPath,
        targetScript,
        '--workspace=packages/web-shell',
        '--',
        '--shard=2/2',
        '--workers=2',
        'arg with spaces',
      ]);
      for (const k of PROXY_VARS) {
        assert.equal(calls[1].env[k], undefined, `${k} must be unset`);
      }
      assert.equal(calls[1].env.KEEP_ME, 'preserved');
      assert.equal(calls[1].env.PLAYWRIGHT_PORT, '35333');

      const observed = JSON.parse(readFileSync(cmdLog, 'utf8'));
      assert.deepEqual(observed.argv, [
        '--workspace=packages/web-shell',
        '--',
        '--shard=2/2',
        '--workers=2',
        'arg with spaces',
      ]);
      for (const k of PROXY_VARS) {
        assert.equal(observed.proxies[k], null);
      }
      assert.equal(observed.keepMe, 'preserved');
      assert.equal(observed.port, '35333');
    });
  });

  it('fails closed on self-hosted when bwrap is missing and never runs the target command', () => {
    withTempDir((root) => {
      const marker = join(root, 'ran.txt');
      const res = spawnSync(
        'bash',
        [
          SCRIPT,
          '--',
          process.execPath,
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'oops')`,
        ],
        {
          encoding: 'utf8',
          env: {
            PATH: buildPathWithoutBwrap(root),
            RUNNER_ENVIRONMENT: 'self-hosted',
          },
        },
      );

      assert.equal(res.status, 1);
      assert.match(res.stderr, /::error::.*bwrap.*not found/i);
      assert.equal(existsSync(marker), false);
    });
  });

  it('fails closed on self-hosted when bwrap preflight fails and never runs the target command', () => {
    withTempDir((root) => {
      const binDir = join(root, 'bin');
      mkdirSync(binDir, { recursive: true });
      const bwrapLog = join(root, 'bwrap.jsonl');
      const marker = join(root, 'ran.txt');
      installFakeBwrap(binDir, bwrapLog, { failProbe: true });

      const res = spawnSync(
        'bash',
        [
          SCRIPT,
          '--',
          process.execPath,
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'oops')`,
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: buildPathWithStub(binDir),
            RUNNER_ENVIRONMENT: 'self-hosted',
            QWEN_FORCE_ISOLATED_NETNS: '',
          },
        },
      );

      assert.equal(res.status, 1);
      assert.match(
        res.stderr,
        /refusing to fall back to the shared host network/,
      );
      assert.equal(existsSync(marker), false);
      assert.equal(readJsonLines(bwrapLog).length, 1);
    });
  });

  it('runs directly without bwrap on github-hosted and when RUNNER_ENVIRONMENT is unset', () => {
    for (const runnerEnv of ['github-hosted', '']) {
      withTempDir((root) => {
        const outFile = join(root, 'direct.json');
        const res = spawnSync(
          'bash',
          [
            SCRIPT,
            '--',
            process.execPath,
            '-e',
            `require('node:fs').writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({ args: process.argv.slice(1), httpProxy: process.env.HTTP_PROXY ?? null }))`,
            '--',
            '--flag',
          ],
          {
            encoding: 'utf8',
            env: {
              PATH: buildPathWithoutBwrap(root),
              RUNNER_ENVIRONMENT: runnerEnv,
              HTTP_PROXY: 'http://127.0.0.1:8888',
            },
          },
        );

        assert.equal(
          res.status,
          0,
          `runnerEnv=${JSON.stringify(runnerEnv)} stderr=${res.stderr}`,
        );
        const observed = JSON.parse(readFileSync(outFile, 'utf8'));
        assert.deepEqual(observed.args, ['--flag']);
        assert.equal(observed.httpProxy, 'http://127.0.0.1:8888');
      });
    }
  });

  it('honors QWEN_FORCE_ISOLATED_NETNS=1 even when RUNNER_ENVIRONMENT is github-hosted', () => {
    withTempDir((root) => {
      const binDir = join(root, 'bin');
      mkdirSync(binDir, { recursive: true });
      const bwrapLog = join(root, 'bwrap.jsonl');
      installFakeBwrap(binDir, bwrapLog);

      const res = spawnSync(
        'bash',
        [SCRIPT, process.execPath, '-e', 'process.exit(0)'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: buildPathWithStub(binDir),
            RUNNER_ENVIRONMENT: 'github-hosted',
            QWEN_FORCE_ISOLATED_NETNS: '1',
          },
        },
      );

      assert.equal(res.status, 0);
      assert.equal(readJsonLines(bwrapLog).length, 2);
    });
  });

  it('rejects an unrecognized RUNNER_ENVIRONMENT instead of silently skipping isolation', () => {
    withTempDir((root) => {
      const marker = join(root, 'ran.txt');
      const res = spawnSync(
        'bash',
        [
          SCRIPT,
          '--',
          process.execPath,
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'oops')`,
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            RUNNER_ENVIRONMENT: 'self_hosted',
            QWEN_FORCE_ISOLATED_NETNS: '',
          },
        },
      );

      assert.equal(res.status, 2);
      assert.match(res.stderr, /unexpected RUNNER_ENVIRONMENT='self_hosted'/);
      assert.equal(existsSync(marker), false);
    });
  });

  it('rejects an unrecognized QWEN_FORCE_ISOLATED_NETNS value instead of silently ignoring it', () => {
    withTempDir((root) => {
      const marker = join(root, 'ran.txt');
      const res = spawnSync(
        'bash',
        [
          SCRIPT,
          '--',
          process.execPath,
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'oops')`,
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            RUNNER_ENVIRONMENT: 'github-hosted',
            QWEN_FORCE_ISOLATED_NETNS: 'true',
          },
        },
      );

      assert.equal(res.status, 2);
      assert.match(res.stderr, /unexpected QWEN_FORCE_ISOLATED_NETNS='true'/);
      assert.equal(existsSync(marker), false);
    });
  });

  it('exits 2 when invoked with no command', () => {
    for (const args of [[SCRIPT], [SCRIPT, '--']]) {
      const res = spawnSync('bash', args, { encoding: 'utf8' });
      assert.equal(res.status, 2);
      assert.match(res.stderr, /missing command/);
    }
  });
});
