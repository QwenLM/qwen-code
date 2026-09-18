import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const source = readFileSync(
  new URL('./qwen-docker-cleanup.sh', import.meta.url),
  'utf8',
);

function run({ daemonLock = true, busy = false, fail = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qwen-cleanup-test-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const lockDir = join(dir, '.cache/qwen-code-ci');
    mkdirSync(lockDir, { recursive: true });
    if (daemonLock)
      writeFileSync(join(lockDir, 'docker-sandbox-daemon.lock'), '');
    const commands = {
      getent:
        '#!/bin/bash\nprintf "github-runner:x:1000:1000::%s:/bin/bash\\n" "$CASE_DIR"\n',
      flock: '#!/bin/bash\n[[ "$*" != "--nonblock 8" || "$BUSY" != 1 ]]\n',
      timeout:
        '#!/bin/bash\nprintf "timeout %s\\n" "$*" >> "$CASE_DIR/calls"\nshift\nexec "$@"\n',
      docker:
        '#!/bin/bash\nprintf "%s\\n" "$*" >> "$CASE_DIR/calls"\nif [[ "$1 $2" == "builder prune" && "$FAIL" == 1 ]]; then exit 1; fi\n',
    };
    for (const [name, script] of Object.entries(commands)) {
      writeFileSync(join(bin, name), script, { mode: 0o755 });
    }
    // Only relocate the root-owned mutex; exercise the actual cleanup logic.
    const script = join(dir, 'cleanup.sh');
    writeFileSync(
      script,
      source.replace(
        '/run/qwen-docker-cleanup.lock',
        join(dir, 'cleanup.lock'),
      ),
    );
    const result = spawnSync('bash', [script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        CASE_DIR: dir,
        BUSY: busy ? '1' : '0',
        FAIL: fail ? '1' : '0',
      },
      timeout: 5000,
    });
    assert.ifError(result.error);
    return { ...result, calls: readFileSync(join(dir, 'calls'), 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const options of [{}, { busy: true }, { daemonLock: false }]) {
  test(`reclaims old unused cache even with ${JSON.stringify(options)}`, () => {
    const result = run(options);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.calls,
      /^builder prune --all --force --filter until=24h --reserved-space 30GB$/m,
    );
    assert.match(
      result.calls,
      /^timeout 20m docker builder prune --all --force --filter until=24h --reserved-space 30GB$/m,
    );
    assert.equal(
      result.calls.includes('image prune --all'),
      !options.busy && options.daemonLock !== false,
    );
  });
}

test('reports cache-prune failure instead of a successful service exit', () => {
  const result = run({ fail: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Docker build cache cleanup failed/);
  assert.match(result.calls, /^image prune --all --force/m);
});
