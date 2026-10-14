/**
 * SPDX-License-Identifier: Apache-2.0
 * Run after npm run build. Uses real, pinned interpreters and the built updater;
 * intentionally independent of Vitest's Bun module loader and coverage support.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(import.meta.url);
const repo = path.dirname(path.dirname(script));
const sha = (file) =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const run = (bin, args, options = {}) => {
  const result = spawnSync(bin, args, {
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
  assert.equal(result.error, undefined, `${bin}: ${result.error}`);
  assert.equal(result.signal, null, `${bin}: ${result.signal}`);
  assert.equal(result.status, 0, `${bin}: ${result.stderr}`);
  return result.stdout.trim();
};

async function worker(root, node, bun, expectedHost) {
  const host = process.versions.bun ? 'bun' : 'node';
  assert.equal(host, expectedHost);
  assert.equal(
    host === 'bun' ? process.versions.bun : process.version,
    host === 'bun' ? '1.3.14' : 'v24.19.0',
  );
  console.log(
    JSON.stringify({
      host,
      version: process.version,
      bun: process.versions.bun,
      binarySha256: sha(process.execPath),
    }),
  );
  const originalEnv = { ...process.env };
  const originalCwd = process.cwd();
  const tmp = path.join(root, 'tmp');
  const home = path.join(root, 'home');
  for (const dir of [tmp, home]) fs.mkdirSync(dir);
  Object.assign(process.env, {
    HOME: home,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    SHELL: '/bin/sh',
    QWEN_REQUIRE_SIGNATURE: '0',
    QWEN_UPDATE_TEST_ENV: 'preserved',
  });
  // Observe allocations before importing the real built module. Bun 1.3.14
  // does not synchronize named builtin bindings; only claim zero allocations
  // on a host whose successful update passes the positive control below.
  const allocations = [];
  const originalMkdtemp = fs.mkdtempSync;
  fs.mkdtempSync = (prefix, ...args) => {
    allocations.push(String(prefix));
    return originalMkdtemp(prefix, ...args);
  };
  syncBuiltinESMExports();
  const modulePath = path.join(
    repo,
    'packages/cli/dist/src/ui/standalone-update.js',
  );
  const {
    performStandaloneUpdate,
    prepareStandaloneUpdate,
    rollbackStandaloneUpdate,
  } = await import(pathToFileURL(modulePath).href);
  console.log(
    JSON.stringify({
      moduleSha256: sha(modulePath),
      sourceSha256: sha(
        path.join(repo, 'packages/cli/src/ui/standalone-update.ts'),
      ),
    }),
  );
  const target = `${process.platform}-${process.arch}`;
  const requests = [];
  let archive, filename, sums;
  const server = https.createServer(
    {
      key: fs.readFileSync(path.join(path.dirname(root), 'key.pem')),
      cert: fs.readFileSync(path.join(path.dirname(root), 'cert.pem')),
    },
    (req, res) => {
      requests.push(req.url);
      if (req.url.endsWith('/SHA256SUMS.sig')) {
        res.writeHead(404);
        res.end();
      } else if (req.url.endsWith('/SHA256SUMS')) res.end(sums);
      else if (req.url.endsWith('/' + filename))
        fs.createReadStream(archive).pipe(res);
      else {
        res.writeHead(404);
        res.end();
      }
    },
  );
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    process.env.QWEN_UPDATE_BASE_URL = `https://127.0.0.1:${server.address().port}`;
    const binaries = { node, bun };
    let allocationObservable = false;
    const snapshot = (dir) =>
      fs
        .readdirSync(dir)
        .sort()
        .map((name) => {
          const file = path.join(dir, name);
          return [
            name,
            fs.statSync(file).isDirectory() ? snapshot(file) : sha(file),
          ];
        });
    const installFixture = (dir, manifest) => {
      const live = path.join(dir, 'installed');
      fs.mkdirSync(live, { recursive: true });
      fs.mkdirSync(live + '.old');
      fs.mkdirSync(path.join(live, 'lib'));
      for (const entry of ['cli.js', 'cli-entry.js']) {
        fs.writeFileSync(
          path.join(live, 'lib', entry),
          "console.log('1.0.0');",
        );
      }

      fs.writeFileSync(
        path.join(live, 'manifest.json'),
        JSON.stringify(manifest),
      );
      fs.writeFileSync(path.join(live, 'sentinel'), 'original live');
      fs.writeFileSync(path.join(live + '.old', 'sentinel'), 'original backup');
      return live;
    };
    const clean = (dir) => {
      assert.deepEqual(fs.readdirSync(tmp).sort(), []);
      assert.deepEqual(fs.readdirSync(dir).sort(), [
        'installed',
        'installed.old',
      ]);
    };
    // Each host exercises both real payload interpreters. Reuse each unsigned
    // archive across cwd scenarios; all network requests still use verified TLS.
    for (const runtime of ['node', 'bun']) {
      const payload = path.join(root, `payload-${runtime}`, 'qwen-code');
      fs.mkdirSync(path.join(payload, runtime, 'bin'), { recursive: true });
      fs.copyFileSync(
        binaries[runtime],
        path.join(payload, runtime, 'bin', runtime),
      );
      fs.chmodSync(path.join(payload, runtime, 'bin', runtime), 0o755);
      fs.mkdirSync(path.join(payload, 'lib'));
      const archiveMarker = path.join(root, `archive-preload-${runtime}`);
      fs.writeFileSync(
        path.join(payload, 'bunfig.toml'),
        'preload = ["./archive-preload.cjs"]\n',
      );
      fs.writeFileSync(
        path.join(payload, 'archive-preload.cjs'),
        `require('fs').writeFileSync(${JSON.stringify(archiveMarker)},'executed');`,
      );

      const cli = path.join(
        payload,
        'lib',
        runtime === 'bun' ? 'cli-entry.js' : 'cli.js',
      );
      fs.writeFileSync(
        path.join(payload, 'manifest.json'),
        JSON.stringify({
          name: '@qwen-code/qwen-code',
          version: '1.2.3',
          target,
          runtime,
        }),
      );
      filename = `qwen-code-${target}${runtime === 'bun' ? '-opentui-preview' : ''}.tar.gz`;
      archive = path.join(root, filename);
      const pack = (source) => {
        fs.writeFileSync(cli, source);
        run('tar', ['-czf', archive, '-C', path.dirname(payload), 'qwen-code']);
        sums = `${sha(archive)}  ${filename}\n`;
      };
      pack(
        "if(process.env.QWEN_UPDATE_TEST_ENV!=='preserved')process.exit(19);console.log('1.2.3');",
      );
      for (const scenario of [
        'clean',
        'noisy',
        'silent',
        'version-noisy',
        'version-silent',
        'test',
        'run',
        'legacy',
      ]) {
        if (scenario === 'legacy' && runtime !== 'node') continue;
        const dir = path.join(root, `${runtime}-${scenario}`);
        const live = installFixture(dir, {
          version: '1.0.0',
          target,
          ...(scenario === 'legacy' ? {} : { runtime }),
        });
        const before = snapshot(live);
        const cwd = path.join(root, `cwd-${runtime}-${scenario}`);
        fs.mkdirSync(cwd);
        const marker = path.join(cwd, 'marker');
        const noisy = scenario.includes('noisy');
        const versionOnly = scenario.startsWith('version-');
        const preload = path.join(cwd, 'preload.cjs');
        fs.writeFileSync(
          preload,
          `${versionOnly ? "if(process.argv.some(a=>a.endsWith('cli-entry.js'))){" : ''}require('fs').writeFileSync(${JSON.stringify(marker)},'executed');${noisy ? "console.log('project preload output');" : ''}${versionOnly ? '}' : ''}`,
        );
        if (!['clean', 'legacy'].includes(scenario))
          fs.writeFileSync(
            path.join(cwd, 'bunfig.toml'),
            `${['test', 'run'].includes(scenario) ? `[${scenario}]\n` : ''}preload = ["./preload.cjs"]\n`,
          );
        // Also plant the shared temp root: cwd=os.tmpdir() is insufficient.
        fs.writeFileSync(
          path.join(tmp, 'bunfig.toml'),
          `preload = [${JSON.stringify(preload)}]\n`,
        );
        process.env.NODE_OPTIONS = `--require ${preload}`;
        process.env.BUN_OPTIONS = `--preload ${preload}`;
        const envBefore = { ...process.env };
        const ai = allocations.length,
          ri = requests.length;
        process.chdir(cwd);
        try {
          const pending = await prepareStandaloneUpdate(live, '1.2.3');
          try {
            assert.equal(await pending.activate(), 'done');
          } finally {
            pending.cleanup();
          }
        } finally {
          process.chdir(originalCwd);
        }
        assert.deepEqual({ ...process.env }, envBefore);
        assert.equal(
          fs.existsSync(marker),
          false,
          `${runtime}/${scenario}: preload executed`,
        );
        assert.equal(
          JSON.parse(fs.readFileSync(path.join(live, 'manifest.json'))).version,
          '1.2.3',
        );
        assert.equal(
          fs.existsSync(archiveMarker),
          false,
          'archive config executed',
        );
        assert.deepEqual(
          snapshot(live + '.old').filter(
            ([name]) => name !== '.qwen-rollback-info.json',
          ),
          before,
        );
        assert.deepEqual(rollbackStandaloneUpdate(live), { ok: true });
        assert.deepEqual(
          snapshot(live).filter(
            ([name]) => name !== '.qwen-rollback-info.json',
          ),
          before,
        );
        assert.equal(fs.existsSync(live + '.old'), false);
        assert.deepEqual(
          requests
            .slice(ri)
            .map((url) => path.basename(url))
            .sort(),
          ['SHA256SUMS', 'SHA256SUMS.sig', filename].sort(),
        );
        const observed = allocations.slice(ai);
        if (host === 'node') {
          for (const prefix of [
            'qwen-code-update-',
            '.qwen-code-update-',
            'qwen-code-smoke-',
          ])
            assert(
              observed.some((p) => path.basename(p) === prefix),
              `allocation positive control: ${prefix}`,
            );
          allocationObservable = true;
        }
        fs.rmSync(path.join(tmp, 'bunfig.toml'));
        assert.deepEqual(fs.readdirSync(tmp), []);
        assert.deepEqual(fs.readdirSync(dir), ['installed']);
        console.log(
          JSON.stringify({
            runtime,
            scenario,
            result: 'updated-and-rolled-back',
            allocations: observed,
            allocationObservable,
          }),
        );
      }
      delete process.env.NODE_OPTIONS;
      delete process.env.BUN_OPTIONS;
      // Real interpreter failures: malformed CLI version and nonzero exit.
      for (const [failure, source, message] of [
        [
          'version',
          "console.log('private child output');",
          'Smoke test failed: unexpected version output',
        ],
        [
          'exit',
          "console.error('private child output');process.exit(23);",
          'Smoke test failed: new binary exited with code 23',
        ],
      ]) {
        pack(source);
        const dir = path.join(root, `${runtime}-${failure}`);
        const live = installFixture(dir, { runtime, target });
        const before = snapshot(dir);
        await assert.rejects(performStandaloneUpdate(live, '1.2.3'), {
          message,
        });
        assert.deepEqual(snapshot(dir), before);
        clean(dir);
        console.log(JSON.stringify({ runtime, failure, rejected: true }));
      }
      // A real interpreter of the OTHER runtime must not satisfy identity.
      fs.copyFileSync(
        binaries[runtime === 'bun' ? 'node' : 'bun'],
        path.join(payload, runtime, 'bin', runtime),
      );
      pack("console.log('1.2.3');");
      const dir = path.join(root, `${runtime}-identity`);
      const live = installFixture(dir, { runtime, target });
      const before = snapshot(dir);
      await assert.rejects(performStandaloneUpdate(live, '1.2.3'), {
        message:
          'Smoke test failed: interpreter identity does not match the expected runtime and target',
      });
      assert.deepEqual(snapshot(dir), before);
      clean(dir);
      console.log(
        JSON.stringify({ runtime, failure: 'identity', rejected: true }),
      );
    }
    // Installed manifest gate: direct and prepared must reject before network,
    // lock, download/extract allocation, or any live/backup changes.
    for (const mode of ['direct', 'prepared']) {
      const update =
        mode === 'direct' ? performStandaloneUpdate : prepareStandaloneUpdate;
      for (const [index, manifest] of [
        null,
        123,
        'private manifest content',
        true,
        [],
        { target, runtime: null },
        { target, runtime: 'deno' },
      ].entries()) {
        const dir = path.join(root, `manifest-${mode}-${index}`);
        const live = installFixture(dir, manifest);
        const before = snapshot(dir),
          ai = allocations.length,
          ri = requests.length;
        await assert.rejects(update(live, '1.2.3'), {
          message:
            index < 5
              ? 'Invalid installed standalone manifest'
              : 'Unknown standalone runtime',
        });
        assert.deepEqual(snapshot(dir), before);
        assert.equal(requests.length, ri);
        if (allocationObservable) assert.deepEqual(allocations.slice(ai), []);
        clean(dir);
        console.log(
          JSON.stringify({
            mode,
            manifestCase: index,
            rejected: true,
            zeroAllocationsVerified: allocationObservable,
          }),
        );
      }
    }
    console.log(
      JSON.stringify({
        host,
        complete: true,
        unsignedFixture: 'checksum-only; signature 404',
        tlsVerification: true,
      }),
    );
  } finally {
    process.chdir(originalCwd);
    fs.mkdtempSync = originalMkdtemp;
    syncBuiltinESMExports();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    for (const key of Object.keys(process.env))
      if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  }
}

// Existing test:scripts CI invokes this mode. Provision only the two fixed
// runtime tools; package manifests and the dependency lock remain unchanged.
async function ci() {
  if (process.platform === 'win32') {
    console.log(
      'Standalone runtime regression: POSIX-only fixture; Windows not covered',
    );
    return;
  }
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'standalone-runtime-tools-'),
  );
  const download = async (url) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
    assert.equal(response.status, 200, `runtime download: ${url}`);
    return Buffer.from(await response.arrayBuffer());
  };
  try {
    let node = process.env.PINNED_NODE;
    let bun = process.env.PINNED_BUN;
    if (!node) {
      const filename = `node-v24.19.0-${process.platform}-${process.arch}.tar.gz`;
      const base = 'https://nodejs.org/dist/v24.19.0/';
      const sums = (await download(base + 'SHASUMS256.txt')).toString();
      const expected = sums
        .split('\n')
        .find((line) => line.endsWith('  ' + filename))
        ?.split(' ')[0];
      assert.match(expected || '', /^[a-f0-9]{64}$/);
      const bytes = await download(base + filename);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), expected);
      const archive = path.join(root, 'node.tgz');
      fs.writeFileSync(archive, bytes);
      run('tar', ['-xzf', archive, '-C', root]);
      node = path.join(root, filename.slice(0, -7), 'bin/node');
    }
    if (!bun) {
      const name = `@oven/bun-${process.platform}-${process.arch === 'arm64' ? 'aarch64' : process.arch}`;
      const metadata = JSON.parse(
        (
          await download(`https://registry.npmjs.org/${name}/1.3.14`)
        ).toString(),
      );
      assert.equal(metadata.name, name);
      assert.equal(metadata.version, '1.3.14');
      assert.equal(
        new URL(metadata.dist.tarball).origin,
        'https://registry.npmjs.org',
      );
      const bytes = await download(metadata.dist.tarball);
      assert.equal(
        'sha512-' + createHash('sha512').update(bytes).digest('base64'),
        metadata.dist.integrity,
      );
      const dir = path.join(root, 'bun');
      fs.mkdirSync(dir);
      const archive = path.join(root, 'bun.tgz');
      fs.writeFileSync(archive, bytes);
      run('tar', ['-xzf', archive, '-C', dir]);
      bun = path.join(dir, 'package/bin/bun');
    }
    const result = spawnSync(node, [script], {
      env: { ...process.env, PINNED_NODE: node, PINNED_BUN: bun },
      stdio: 'inherit',
      timeout: 600_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, 'fixed runtime regression failed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--ci') {
  await ci();
} else if (process.argv[2] === '--worker') {
  await worker(...process.argv.slice(3));
} else {
  assert.notEqual(
    process.platform,
    'win32',
    'This POSIX tar fixture does not cover Windows updates',
  );
  const node = process.env.PINNED_NODE || process.execPath;
  const bun = run(process.env.PINNED_BUN || 'bun', ['-p', 'process.execPath']);
  assert.equal(run(node, ['--version']), 'v24.19.0');
  assert.equal(run(bun, ['--version']), '1.3.14');
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'standalone-runtime-test-'),
  );
  try {
    const config = path.join(root, 'openssl.cnf');
    fs.writeFileSync(
      config,
      '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n',
    );
    run('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-config',
      config,
      '-keyout',
      path.join(root, 'key.pem'),
      '-out',
      path.join(root, 'cert.pem'),
    ]);
    const env = {
      ...process.env,
      NODE_EXTRA_CA_CERTS: path.join(root, 'cert.pem'),
    };
    delete env.NODE_TLS_REJECT_UNAUTHORIZED;
    for (const key of Object.keys(env))
      if (/^(NODE_OPTIONS|BUN_OPTIONS)$/i.test(key)) delete env[key];
    for (const [host, bin] of [
      ['node', node],
      ['bun', bun],
    ]) {
      const dir = path.join(root, host);
      fs.mkdirSync(dir);
      const result = spawnSync(
        bin,
        [script, '--worker', dir, node, bun, host],
        {
          cwd: root,
          env,
          encoding: 'utf8',
          timeout: 300_000,
          maxBuffer: 8 * 1024 * 1024,
        },
      );
      process.stdout.write(result.stdout || '');
      process.stderr.write(result.stderr || '');
      console.log(
        JSON.stringify({
          host,
          actualExitCode: result.status,
          signal: result.signal,
        }),
      );
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      assert.equal(result.status, 0, `${host} worker failed`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
