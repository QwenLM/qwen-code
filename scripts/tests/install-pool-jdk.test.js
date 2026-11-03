import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve, sep } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import semver from 'semver';
import { afterEach, describe, expect, it } from 'vitest';

const script = resolve('.github/scripts/install-pool-jdk.sh');
const fixtures = [];
afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true });
});

// The directory actions/setup-java actually keys its tool-cache entry by:
// getToolcacheVersionName() rewrites the first '+' of Adoptium's semver to '-'
// BEFORE tc.cacheDir() applies semver.clean(), and clean() keeps a prerelease.
// semver.clean(semver) alone would drop the build suffix and never match.
function toolcacheVersionName(version) {
  return semver.clean(version.replace('+', '-')) || version;
}

function fixture(mode = 'ok') {
  const root = mkdtempSync(join(tmpdir(), 'pool-jdk-test-'));
  fixtures.push(root);
  const bin = join(root, 'bin');
  const cache = join(root, 'cache');
  const payload = join(root, 'payload');
  for (const dir of [bin, cache, join(payload, 'jdk-fixture/bin')]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(payload, 'jdk-fixture/bin/java'), 'verified-jdk');
  const archive = join(root, 'fixture.tgz');
  expect(
    spawnSync('tar', ['-czf', archive, '-C', payload, 'jdk-fixture']).status,
  ).toBe(0);
  const digest = createHash('sha256')
    .update(readFileSync(archive))
    .digest('hex');
  const shim = (name, body) =>
    writeFileSync(join(bin, name), `#!/usr/bin/env python3\n${body}`, {
      mode: 0o755,
    });
  shim('uname', 'print("x86_64")\n');
  shim(
    'curl',
    `import os, pathlib, shutil, sys, time
root = pathlib.Path(os.environ['FIXTURE'])
if os.environ['MODE'] == 'network': sys.exit(22)
with (root / 'downloads').open('a') as f: f.write('download\\n')
(root / 'download-started').touch()
if os.environ['MODE'] == 'publisher':
    deadline = time.monotonic() + 5
    while not (root / 'release').exists():
        if time.monotonic() > deadline: sys.exit(23)
        time.sleep(.01)
else: time.sleep(.15)
output = pathlib.Path(sys.argv[sys.argv.index('-o') + 1])
shutil.copyfile(root / 'fixture.tgz', output)
if os.environ['MODE'] == 'checksum': output.write_bytes(b'corrupted')
`,
  );
  // The pinned archive is replaced by a tiny offline fixture. Compute its
  // real digest; this still fails if the script bypasses a checksum rejection.
  shim(
    'sha256sum',
    `import hashlib, os, pathlib, sys
expected, path = sys.stdin.read().strip().split(None, 1)
assert expected == '5c3f68887c325d36d852ba534303e1f5f1f5cae7d6cc1e951d73e0d8e98a058d'
assert sys.argv[1:] == ['--check', '--status']
sys.exit(hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest() != '${digest}')
`,
  );
  if (mode === 'lock') {
    shim('flock', 'import sys\nsys.exit(73)\n');
  } else if (process.platform !== 'linux') {
    // Linux uses its real flock CLI. macOS has no flock command; retain
    // kernel locking there through the same inherited file descriptor.
    shim(
      'flock',
      `import fcntl, sys
fcntl.flock(int(sys.argv[-1]), fcntl.LOCK_UN if '-u' in sys.argv else fcntl.LOCK_EX)
`,
    );
  }
  const shared = join(
    cache,
    'Java_Temurin-Hotspot_jdk',
    toolcacheVersionName('11.0.32+101'),
    'x64',
  );
  const prepare = (name) => {
    const temp = join(root, name);
    mkdirSync(temp);
    return {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      MODE: mode,
      FIXTURE: root,
      JAVA_SPEC: '11',
      RUNNER_TOOL_CACHE: cache,
      RUNNER_TEMP: temp,
      GITHUB_ENV: join(temp, 'env'),
      GITHUB_PATH: join(temp, 'path'),
    };
  };
  const run = (env) =>
    spawnSync('bash', [script], { env, encoding: 'utf8', timeout: 10_000 });
  const start = (env) => {
    const child = spawn('bash', [script], { env, timeout: 10_000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    return new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
  };
  const home = (env) =>
    readFileSync(env.GITHUB_ENV, 'utf8').trim().slice('JAVA_HOME='.length);
  const downloads = () =>
    existsSync(join(root, 'downloads'))
      ? readFileSync(join(root, 'downloads'), 'utf8').trim().split('\n').length
      : 0;
  return { root, cache, shared, prepare, run, start, home, downloads };
}

function seed(shared, marker = `${shared}.complete`) {
  mkdirSync(join(shared, 'bin'), { recursive: true });
  writeFileSync(join(shared, 'bin/java'), 'in-use-jdk');
  if (marker) writeFileSync(marker, '');
  return statSync(join(shared, 'bin/java')).ino;
}

function success(result) {
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
}

describe.skipIf(process.platform === 'win32')(
  'pool JDK cache publication',
  () => {
    it.each([
      ['11', 'x86_64', '11.0.32+101', '11.0.32.1_1'],
      ['11', 'aarch64', '11.0.32+101', '11.0.32.1_1'],
      ['17', 'aarch64', '17.0.20+101', '17.0.20.1_1'],
      ['17', 'x86_64', '17.0.21+9', '17.0.21_9'],
      ['21', 'aarch64', '21.0.13+9.0.LTS', '21.0.13_9'],
      ['21', 'x86_64', '21.0.13+9.0.LTS', '21.0.13_9'],
      ['25', 'aarch64', '25.0.5+8.0.LTS', '25.0.5_8'],
    ])(
      'uses mirror and normalized setup-java coordinates for Java %s on %s',
      (spec, machine, setupVersion, release) => {
        const f = fixture('network');
        const cacheArch = machine === 'x86_64' ? 'x64' : 'arm64';
        const mirrorArch = cacheArch === 'arm64' ? 'aarch64' : 'x64';
        writeFileSync(
          join(f.root, 'bin/uname'),
          `#!/usr/bin/env python3\nprint('${machine}')\n`,
          { mode: 0o755 },
        );
        const cold = f.run({ ...f.prepare('cold'), JAVA_SPEC: spec });
        expect(cold.status).not.toBe(0);
        expect(cold.stdout).toContain(
          `::error::could not download https://mirrors.tuna.tsinghua.edu.cn/Adoptium/${spec}/jdk/${mirrorArch}/linux/OpenJDK${spec}U-jdk_${mirrorArch}_linux_hotspot_${release}.tar.gz`,
        );
        const shared = join(
          f.cache,
          'Java_Temurin-Hotspot_jdk',
          toolcacheVersionName(setupVersion),
          cacheArch,
        );
        const inode = seed(shared);
        const warm = { ...f.prepare('warm'), JAVA_SPEC: spec };
        success(f.run(warm));
        expect(f.home(warm)).toBe(shared);
        expect(statSync(join(shared, 'bin/java')).ino).toBe(inode);
      },
    );

    it('reuses setup-java sibling completion markers when the private namespace cannot be created', () => {
      const f = fixture('network');
      writeFileSync(join(f.cache, 'qwen-pool-jdk'), 'not a directory');
      const inode = seed(f.shared);
      const env = f.prepare('job');
      success(f.run(env));
      expect(f.home(env)).toBe(f.shared);
      expect(statSync(join(f.shared, 'bin/java')).ino).toBe(inode);
      expect(readFileSync(env.GITHUB_PATH, 'utf8').trim()).toBe(
        `${f.shared}/bin`,
      );
      expect(
        readFileSync(
          join(env.RUNNER_TEMP, 'setup-java-m2', 'toolchains.xml'),
          'utf8',
        ),
      ).toContain(`<jdkHome>${f.shared}</jdkHome>`);
    });

    it('fails closed when the private namespace cannot be created on a cold install', () => {
      const f = fixture('network');
      writeFileSync(join(f.cache, 'qwen-pool-jdk'), 'not a directory');
      const env = f.prepare('cold');
      const result = f.run(env);
      expect(result.status).not.toBe(0);
      // `mkdir` itself prints "cannot create directory", so the script's own
      // marker is what has to be asserted here.
      expect(`${result.stdout}${result.stderr}`).toContain(
        '::error::cannot create',
      );
      expect(existsSync(env.GITHUB_ENV)).toBe(false);
    });

    it('reinstalls a private JDK when only its completion marker remains', () => {
      const f = fixture();
      const toolDir = join(f.cache, 'qwen-pool-jdk/11.0.32-101');
      mkdirSync(toolDir, { recursive: true });
      writeFileSync(join(toolDir, 'x64.complete'), '');
      const env = f.prepare('job');
      success(f.run(env));
      expect(f.downloads()).toBe(1);
      expect(existsSync(join(f.home(env), 'bin/java'))).toBe(true);
    });

    it('keeps legacy internal-marker entries intact and reuses its own completed installation', () => {
      const f = fixture();
      const inode = seed(f.shared, join(f.shared, '.complete'));
      const first = f.prepare('first');
      success(f.run(first));
      const home = f.home(first);
      expect(home).toBe(join(f.cache, 'qwen-pool-jdk/11.0.32-101/x64'));
      expect(home.startsWith(`${f.cache}${sep}`)).toBe(true);
      expect(home.startsWith(join(f.cache, 'Java_Temurin-Hotspot_jdk'))).toBe(
        false,
      );
      expect(existsSync(`${home}.complete`)).toBe(true);
      expect(statSync(join(f.shared, 'bin/java')).ino).toBe(inode);
      const installed = statSync(join(home, 'bin/java')).ino;
      const second = f.prepare('second');
      success(f.run(second));
      expect(f.home(second)).toBe(home);
      expect(statSync(join(home, 'bin/java')).ino).toBe(installed);
      expect(f.downloads()).toBe(1);
    });

    it('preserves a setup-java entry completed during the fallback download', async () => {
      const f = fixture('publisher');
      const inode = seed(f.shared, null);
      const env = f.prepare('job');
      const completed = f.start(env);
      const deadline = Date.now() + 5_000;
      while (!existsSync(join(f.root, 'download-started'))) {
        if (Date.now() > deadline)
          throw new Error('fallback never reached download');
        await setTimeout(10);
      }
      writeFileSync(join(f.shared, 'bin/java'), 'setup-java-finished');
      writeFileSync(`${f.shared}.complete`, '');
      writeFileSync(join(f.root, 'release'), '');
      success(await completed);
      expect(statSync(join(f.shared, 'bin/java')).ino).toBe(inode);
      expect(readFileSync(join(f.shared, 'bin/java'), 'utf8')).toBe(
        'setup-java-finished',
      );
      expect(existsSync(`${f.shared}.complete`)).toBe(true);
      expect(f.home(env)).not.toBe(f.shared);
    });

    it('serializes two cold fallback jobs into one installation', async () => {
      const f = fixture();
      const envs = [f.prepare('first'), f.prepare('second')];
      for (const result of await Promise.all(envs.map(f.start)))
        success(result);
      expect(f.home(envs[0])).toBe(f.home(envs[1]));
      expect(f.downloads()).toBe(1);
    });

    it.each([
      ['network', 'could not download'],
      ['checksum', 'checksum mismatch'],
      ['lock', 'timed out waiting'],
    ])('fails closed on %s failure', (mode, reason) => {
      const f = fixture(mode);
      const env = f.prepare('job');
      const result = f.run(env);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain(reason);
      expect(existsSync(env.GITHUB_ENV)).toBe(false);
      expect(
        readdirSync(f.cache, { recursive: true }).filter((p) =>
          p.endsWith('.complete'),
        ),
      ).toHaveLength(0);
      if (mode === 'lock') expect(f.downloads()).toBe(0);
    });
  },
);
