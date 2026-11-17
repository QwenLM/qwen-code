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
  uid = '1000',
  repairFamily = false,
  rootFamily,
  sudoStatus = '0',
  aptStatus = '0',
  extractStatus = '0',
  customDataHome = false,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qwen-font-baseline-test-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const write = (name, body) =>
    writeFileSync(join(bin, name), body, { mode: 0o755 });

  write(
    'fc-match',
    '#!/usr/bin/env bash\nif [ "${CASE_AS_ROOT:-0}" = 1 ] && [ -n "${CASE_ROOT_FAMILY:-}" ]; then printf "%s" "$CASE_ROOT_FAMILY"; elif [ -f "$CASE_DIR/repaired" ]; then printf "DejaVu Sans"; else printf "%s" "$CASE_FAMILY"; fi\n',
  );
  write(
    'fc-cache',
    '#!/usr/bin/env bash\nprintf "fc-cache %s\\n" "$*" >> "$CASE_DIR/calls"\nif [ "$CASE_REPAIR_FAMILY" = 1 ] && [ -f "${XDG_DATA_HOME:-$HOME/.local/share}/fonts/qwen-ci/truetype/dejavu/DejaVuSans.ttf" ]; then touch "$CASE_DIR/repaired"; fi\n',
  );
  write(
    'apt-get',
    [
      '#!/usr/bin/env bash',
      'printf "apt-get %s\\n" "$*" >> "$CASE_DIR/calls"',
      '[ "$CASE_APT_STATUS" = 0 ] || exit "$CASE_APT_STATUS"',
      'if [ "$1" = -o ]; then shift 2; fi',
      'if [ "$1" = download ]; then touch fonts-dejavu-core_1_all.deb fonts-dejavu-mono_1_all.deb; fi',
      'if [ "$1" = install ] && [ "$CASE_REPAIR_FAMILY" = 1 ]; then touch "$CASE_DIR/repaired"; fi',
      '',
    ].join('\n'),
  );
  write(
    'dpkg-deb',
    [
      '#!/usr/bin/env bash',
      'printf "dpkg-deb %s\\n" "$*" >> "$CASE_DIR/calls"',
      '[ "$CASE_EXTRACT_STATUS" = 0 ] || exit "$CASE_EXTRACT_STATUS"',
      '[ "$1" = --extract ] || exit 2',
      'mkdir -p "$3/usr/share/fonts/truetype/dejavu"',
      'printf fixture-font > "$3/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"',
      '',
    ].join('\n'),
  );
  write(
    'id',
    '#!/usr/bin/env bash\nif [ "${CASE_AS_ROOT:-0}" = 1 ]; then printf "0\\n"; else printf "%s\\n" "$CASE_UID"; fi\n',
  );
  write(
    'sudo',
    '#!/usr/bin/env bash\nprintf "sudo %s\\n" "$*" >> "$CASE_DIR/calls"\nif [ "$CASE_SUDO_STATUS" != 0 ]; then exit "$CASE_SUDO_STATUS"; fi\n[ "$1" = -n ] || exit 2\nshift\nCASE_AS_ROOT=1 exec "$@"\n',
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
    CASE_UID: uid,
    CASE_REPAIR_FAMILY: repairFamily ? '1' : '0',
    CASE_ROOT_FAMILY: rootFamily ?? '',
    CASE_SUDO_STATUS: sudoStatus,
    CASE_APT_STATUS: aptStatus,
    CASE_EXTRACT_STATUS: extractStatus,
    CASE_METRICS: JSON.stringify(metrics),
    GITHUB_ACTIONS: '',
    HOME: join(dir, 'home'),
    TMPDIR: join(dir, 'tmp'),
    RUNNER_TEMP: join(dir, 'tmp'),
    XDG_DATA_HOME: customDataHome ? join(dir, 'xdg-data') : '',
    CHROMIUM_BIN: browser
      ? join(bin, 'chromium')
      : join(dir, 'no-such-browser'),
  };
  mkdirSync(env.TMPDIR);
  return { dir, env };
}

function run(script, args, env, cwd = join(scriptDir, '../../..')) {
  const result = spawnSync('bash', [script, ...args], {
    env,
    cwd,
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

function runCiFontStep(env, { installer, checker } = {}) {
  const workflow = readFileSync(
    join(scriptDir, '../../workflows/ci.yml'),
    'utf8',
  );
  const step = workflow.match(
    /- name: 'Check host font baseline \(self-hosted\)'[\s\S]*?run: \|-\n([\s\S]*?)(?=\n {6}- name:)/,
  );
  assert.ok(step, 'the actual CI font step must be present');
  const checkout = join(env.CASE_DIR, 'checkout');
  const fontScripts = join(checkout, '.github/scripts/ecs-runner');
  mkdirSync(fontScripts, { recursive: true });
  writeFileSync(
    join(fontScripts, 'install-qwen-font-baseline.sh'),
    installer ?? readFileSync(installScript),
  );
  writeFileSync(
    join(fontScripts, 'check-font-baseline.sh'),
    checker ?? readFileSync(checkScript),
  );
  const script = join(env.CASE_DIR, 'ci-font-step.sh');
  writeFileSync(script, `set -eo pipefail\n${step[1].replace(/^ {10}/gm, '')}`);
  return run(script, [], { ...env, GITHUB_ACTIONS: 'true' }, checkout);
}

test('CI leaves a healthy runner unmodified', () => {
  withCase({}, (env) => {
    const result = runCiFontStep(env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.calls, '');
    assert.match(result.stdout, /default sans-serif = DejaVu Sans/);
  });
});

for (const uid of ['0', '1000']) {
  test(`CI prepares user fonts without elevation for runner uid ${uid}`, () => {
    withCase(
      {
        uid,
        installed: false,
        family: 'WenQuanYi Zen Hei',
        repairFamily: true,
      },
      (env) => {
        const result = runCiFontStep(env);
        assert.equal(result.status, 0, result.stderr);
        assert.match(
          result.calls,
          /apt-get .* download fonts-dejavu-core fonts-dejavu-mono/,
        );
        assert.match(
          result.calls,
          /Dir::State::lists=.*\/qwen-fonts\.[^/]+\/lists/,
        );
        assert.match(result.calls, /dpkg-deb --extract/);
        assert.equal(
          readFileSync(
            join(
              env.HOME,
              '.local/share/fonts/qwen-ci/truetype/dejavu/DejaVuSans.ttf',
            ),
            'utf8',
          ),
          'fixture-font',
        );
        assert.match(result.stdout, /default sans-serif = DejaVu Sans/);
        assert.doesNotMatch(result.stdout, /::error::/);
        assert.doesNotMatch(result.calls, /sudo|apt-get install/);
      },
    );
  });
}

test('CI rejects runner font drift after extracting user fonts', () => {
  withCase(
    { family: 'WenQuanYi Zen Hei', rootFamily: 'DejaVu Sans' },
    (env) => {
      const result = runCiFontStep(env);
      assert.equal(result.status, 1);
      assert.match(result.calls, /dpkg-deb --extract/);
      assert.doesNotMatch(result.calls, /sudo/);
      assert.match(result.stdout, /::error::default sans-serif is 'WenQuanYi/);
    },
  );
});

for (const failure of ['aptStatus', 'extractStatus']) {
  test(`CI fails closed when ${failure} fails`, () => {
    withCase({ family: 'WenQuanYi Zen Hei', [failure]: '1' }, (env) => {
      const result = runCiFontStep(env);
      assert.equal(result.status, 1);
      assert.doesNotMatch(result.calls, /sudo|apt-get install/);
      assert.doesNotMatch(result.stdout, /default sans-serif = DejaVu Sans/);
    });
  });
}

test('CI keeps fonts in the configured XDG data directory', () => {
  withCase(
    { family: 'WenQuanYi Zen Hei', repairFamily: true, customDataHome: true },
    (env) => {
      const result = runCiFontStep(env);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        readFileSync(
          join(
            env.XDG_DATA_HOME,
            'fonts/qwen-ci/truetype/dejavu/DejaVuSans.ttf',
          ),
          'utf8',
        ),
        'fixture-font',
      );
    },
  );
});

test('CI never executes a PR-provided installer', () => {
  withCase({ family: 'WenQuanYi Zen Hei', repairFamily: true }, (env) => {
    const result = runCiFontStep(env, {
      installer: 'printf "head-installer\\n" >> "$CASE_DIR/calls"\nexit 0\n',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.calls, /head-installer|sudo/);
  });
});

test('CI never elevates a PR-provided checker', () => {
  withCase({ family: 'WenQuanYi Zen Hei', repairFamily: true }, (env) => {
    const result = runCiFontStep(env, {
      checker:
        'if [ "${CASE_AS_ROOT:-0}" = 1 ]; then printf "privileged-checker\\n" >> "$CASE_DIR/calls"; fi\n' +
        readFileSync(checkScript, 'utf8'),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.calls, /privileged-checker|sudo/);
  });
});
