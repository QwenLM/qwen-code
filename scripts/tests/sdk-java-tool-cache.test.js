import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const fixtures = [];
afterEach(() => {
  for (const base of fixtures.splice(0)) {
    spawnSync('chmod', ['-R', 'u+rwX', base]);
    rmSync(base, { recursive: true, force: true });
  }
});

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'java-tool-cache-'));
  fixtures.push(base);
  const work = join(base, '_work');
  const cache = join(work, '_tool');
  const temp = join(work, '_temp');
  const java = join(cache, 'Java_Temurin-Hotspot_jdk');
  const node = join(cache, 'node');
  const bin = join(base, 'bin');
  const log = join(base, 'commands');
  for (const path of [temp, java, node, bin]) {
    mkdirSync(path, { recursive: true });
  }
  const realChown = spawnSync('which', ['chown'], {
    encoding: 'utf8',
  }).stdout.trim();
  writeFileSync(
    join(bin, 'chown'),
    '#!/bin/bash\necho chown >> "$COMMAND_LOG"\n' +
      '[ "${DENY_CHOWN:-0}" != 1 ] || exit 1\n' +
      'exec "$REAL_CHOWN" "$@"\n',
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, 'sudo'),
    '#!/bin/bash\necho "sudo:$*" >> "$COMMAND_LOG"\n' +
      '[ "${DENY_SUDO:-0}" != 1 ] || exit 1\n' +
      '[ "$1" = -n ] || exit 2\nshift\n' +
      'if [ "$1" = chown ]; then shift; exec "$REAL_CHOWN" "$@"; fi\n' +
      'exec "$@"\n',
    { mode: 0o755 },
  );
  const run = (env = {}) =>
    spawnSync('bash', [resolve('.github/scripts/restore-java-tool-cache.sh')], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        RUNNER_TOOL_CACHE: cache,
        RUNNER_TEMP: temp,
        COMMAND_LOG: log,
        REAL_CHOWN: realChown,
        ...env,
      },
      encoding: 'utf8',
    });
  return { base, cache, java, node, log, run };
}

describe.skipIf(process.platform === 'win32')(
  'runner-local Java tool-cache repair',
  () => {
    it('leaves an absent tool cache for setup-java to create', () => {
      const f = fixture();
      rmSync(f.cache, { recursive: true });
      const result = f.run();
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(f.cache)).toBe(false);
      expect(existsSync(f.log)).toBe(false);
    });
    it('creates a missing Java subtree without changing another tool cache', () => {
      const f = fixture();
      rmSync(f.java, { recursive: true });
      const result = f.run();
      expect(result.status, result.stderr).toBe(0);
      expect(statSync(f.java).isDirectory()).toBe(true);
      expect(statSync(f.node).isDirectory()).toBe(true);
      expect(readFileSync(f.log, 'utf8')).not.toContain('sudo:');
    });

    it('restores JDK writes and retains every version without touching Node or linked targets', () => {
      const f = fixture();
      const outside = join(f.base, 'outside');
      mkdirSync(outside);
      writeFileSync(join(outside, 'marker'), 'outside');
      chmodSync(outside, 0o555);
      chmodSync(f.node, 0o555);
      symlinkSync(outside, join(f.java, 'linked-target'));
      for (const version of ['11.0.32-101', '17.0.20-101', '21.0.12-101']) {
        const parent = join(f.java, version);
        mkdirSync(join(parent, 'arm64'), { recursive: true });
        writeFileSync(join(parent, 'arm64', 'marker'), version);
        chmodSync(parent, 0o555);
      }
      const result = f.run();
      expect(result.status, result.stderr).toBe(0);
      for (const version of ['11.0.32-101', '17.0.20-101', '21.0.12-101']) {
        const parent = join(f.java, version);
        expect(readFileSync(join(parent, 'arm64', 'marker'), 'utf8')).toBe(
          version,
        );
        expect(statSync(parent).mode & 0o200).toBe(0o200);
        writeFileSync(join(parent, 'new-marker'), 'writable');
      }
      expect(statSync(f.node).mode & 0o777).toBe(0o555);
      expect(statSync(outside).mode & 0o777).toBe(0o555);
      expect(readFileSync(f.log, 'utf8')).not.toContain('sudo:');
    });

    it.each(['external-cache', 'cache-symlink', 'java-symlink'])(
      'rejects %s before any ownership change',
      (kind) => {
        const f = fixture();
        const outside = join(f.base, 'outside');
        mkdirSync(outside);
        const env = {};
        if (kind === 'external-cache') {
          env.RUNNER_TOOL_CACHE = outside;
        } else {
          const target = kind === 'cache-symlink' ? f.cache : f.java;
          rmSync(target, { recursive: true });
          symlinkSync(outside, target);
        }
        const result = f.run(env);
        expect(result.status).not.toBe(0);
        expect(result.stdout).toContain('::error::Refusing');
        expect(existsSync(f.log)).toBe(false);
      },
    );

    it('uses noninteractive sudo only after ordinary ownership repair fails', () => {
      const f = fixture();
      const result = f.run({ DENY_CHOWN: '1' });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(f.log, 'utf8')).toContain('sudo:-n chown -hR');
    });

    it('fails clearly when ownership repair requires unavailable sudo', () => {
      const f = fixture();
      const result = f.run({ DENY_CHOWN: '1', DENY_SUDO: '1' });
      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain('::error::Could not restore');
    });
  },
);
