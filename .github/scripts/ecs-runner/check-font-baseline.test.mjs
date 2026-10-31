import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const scriptDir = fileURLToPath(new URL('.', import.meta.url));
const checkScript = join(scriptDir, 'check-font-baseline.sh');
const installScript = join(scriptDir, 'install-qwen-font-baseline.sh');

// Measured on the x64 ECS pool; the ARM64 pool without fonts-dejavu-core
// renders the same strings ~26 px narrower, which is what the gate catches.
const BASELINE = { value: 113.08, label: 49.97, updated: 106.42 };
const DRIFTED = { value: 95.14, label: 47.02, updated: 100.94 };

function makeCase({
  family = 'DejaVu Sans',
  installed = true,
  metrics = BASELINE,
  browser = true,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qwen-font-baseline-test-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const write = (name, body) =>
    writeFileSync(join(bin, name), body, { mode: 0o755 });

  write('fc-match', '#!/usr/bin/env bash\nprintf "%s" "$CASE_FAMILY"\n');
  write(
    'fc-cache',
    '#!/usr/bin/env bash\nprintf "fc-cache %s\\n" "$*" >> "$CASE_DIR/calls"\n',
  );
  write(
    'apt-get',
    '#!/usr/bin/env bash\nprintf "apt-get %s\\n" "$*" >> "$CASE_DIR/calls"\n',
  );
  write(
    'dpkg-query',
    [
      '#!/usr/bin/env bash',
      'if [ "$CASE_INSTALLED" = 1 ]; then printf "install ok installed"; exit 0; fi',
      'exit 1',
      '',
    ].join('\n'),
  );
  write(
    'chromium',
    '#!/usr/bin/env bash\nprintf "<html><head><title>%s</title></head></html>" "$CASE_METRICS"\n',
  );
  writeFileSync(join(dir, 'calls'), '');
  mkdirSync(join(dir, 'home'));

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    CASE_DIR: dir,
    CASE_FAMILY: family,
    CASE_INSTALLED: installed ? '1' : '0',
    CASE_METRICS: JSON.stringify(metrics),
    GITHUB_ACTIONS: '',
    HOME: join(dir, 'home'),
    TMPDIR: join(dir, 'tmp'),
    CHROMIUM_BIN: browser
      ? join(bin, 'chromium')
      : join(dir, 'no-such-browser'),
  };
  mkdirSync(env.TMPDIR);
  return { dir, env };
}

function run(script, args, env) {
  const result = spawnSync('bash', [script, ...args], {
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    calls: (() => {
      try {
        return readFileSync(join(env.CASE_DIR, 'calls'), 'utf8');
      } catch {
        return '';
      }
    })(),
  };
}

function withCase(options, body) {
  const { dir, env } = makeCase(options);
  try {
    body(env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('accepts the x64 pool family', () => {
  withCase({}, (env) => {
    const result = run(checkScript, [], env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /default sans-serif = DejaVu Sans/);
  });
});

test('rejects a host whose default sans-serif is WenQuanYi', () => {
  withCase({ family: 'WenQuanYi Zen Hei' }, (env) => {
    const result = run(checkScript, [], env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /WenQuanYi Zen Hei/);
    assert.match(result.stderr, /fonts-dejavu-core/);
  });
});

test('rejects a host where fc-match resolves nothing', () => {
  withCase({ family: '' }, (env) => {
    const result = run(checkScript, [], env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no default sans-serif family/);
  });
});

test('rejects an unknown argument', () => {
  withCase({}, (env) => {
    const result = run(checkScript, ['--nope'], env);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Unknown argument/);
  });
});

test('accepts baseline metrics in Chromium', () => {
  withCase({}, (env) => {
    const result = run(checkScript, ['--with-metrics'], env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /metrics match/);
  });
});

test('rejects drifted metrics in Chromium', () => {
  withCase({ metrics: DRIFTED }, (env) => {
    const result = run(checkScript, ['--with-metrics'], env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /font metrics drifted/);
    assert.match(result.stderr, /x64 baseline/);
  });
});

test('skips the metric half when no Playwright Chromium is present', () => {
  withCase({ browser: false }, (env) => {
    const result = run(checkScript, ['--with-metrics'], env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /font metrics: skipped/);
  });
});

test('installer refuses to run as non-root', () => {
  withCase({}, (env) => {
    const result = run(installScript, [], {
      ...env,
      QWEN_FONT_BASELINE_TEST_ALLOW_NON_ROOT: '0',
    });
    // The test suite itself may not run as root; when it does, skip the guard.
    if (process.getuid?.() === 0) return;
    assert.equal(result.status, 1);
    assert.match(result.stderr, /as root/);
  });
});

test('installer installs both packages when they are missing', () => {
  withCase({ installed: false }, (env) => {
    const result = run(installScript, [], {
      ...env,
      QWEN_FONT_BASELINE_TEST_ALLOW_NON_ROOT: '1',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /Installing fonts-dejavu-core fonts-dejavu-mono/,
    );
    assert.match(result.calls, /apt-get update -qq/);
    assert.match(
      result.calls,
      /apt-get install -y --no-install-recommends fonts-dejavu-core fonts-dejavu-mono/,
    );
    assert.match(result.stdout, /default sans-serif = DejaVu Sans/);
  });
});

test('installer installs nothing on an already-provisioned host', () => {
  withCase({ installed: true }, (env) => {
    const result = run(installScript, [], {
      ...env,
      QWEN_FONT_BASELINE_TEST_ALLOW_NON_ROOT: '1',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /already installed/);
    assert.doesNotMatch(result.calls, /apt-get install/);
  });
});

test('installer fails when the host still resolves the wrong family', () => {
  withCase({ installed: true, family: 'WenQuanYi Zen Hei' }, (env) => {
    const result = run(installScript, [], {
      ...env,
      QWEN_FONT_BASELINE_TEST_ALLOW_NON_ROOT: '1',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /fonts-dejavu-core/);
  });
});
