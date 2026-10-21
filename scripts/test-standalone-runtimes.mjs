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
import childProcess, { spawnSync } from 'node:child_process';
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
  const started = performance.now();
  let phase = 'setup';
  const originalExecFile = childProcess.execFile;
  let probeCount = 0;
  childProcess.execFile = (command, args, options, callback) => {
    const probeStarted = performance.now();
    const probePhase = args[0] === '-e' ? 'identity' : args.at(-1);
    return originalExecFile(command, args, options, (err, out, stderr) => {
      probeCount++;
      console.log(
        JSON.stringify({
          host,
          phase,
          probePhase,
          elapsedMs: Math.round(performance.now() - probeStarted),
          code: err?.code ?? 0,
          signal: err?.signal ?? null,
          killed: err?.killed ?? false,
        }),
      );
      callback(err, out, stderr);
    });
  };
  syncBuiltinESMExports();
  const originalEnv = { ...process.env };
  const originalCwd = process.cwd();
  const tmp = path.join(root, 'tmp');
  const home = path.join(root, 'home');
  const compileCache = path.join(root, 'node-compile-cache');
  for (const dir of [tmp, home]) fs.mkdirSync(dir);
  Object.assign(process.env, {
    HOME: home,
    QWEN_HOME: path.join(home, '.qwen'),
    NODE_COMPILE_CACHE: compileCache,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    SHELL: '/bin/sh',
    QWEN_REQUIRE_SIGNATURE: '0',
    QWEN_UPDATE_TEST_ENV: 'preserved',
  });
  delete process.env.NODE_DISABLE_COMPILE_CACHE;
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
      if (req.url === '/-/package/%40qwen-code%2Fqwen-code/dist-tags') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ latest: '1.2.3' }));
      } else if (req.url.endsWith('/SHA256SUMS.sig')) {
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
    const { getInstallationInfo, getNpmCliPath } = await import(
      pathToFileURL(
        path.join(repo, 'packages/cli/dist/src/utils/installationInfo.js'),
      ).href
    );
    const { fetchGlobalNpmUpdateInfo } = await import(
      pathToFileURL(
        path.join(repo, 'packages/cli/dist/src/ui/utils/updateCheck.js'),
      ).href
    );
    const detected = path.join(root, 'detected-install');
    for (const subdir of ['bin', 'lib', 'node/bin', `${host}/bin`])
      fs.mkdirSync(path.join(detected, subdir), { recursive: true });
    fs.copyFileSync(binaries[host], path.join(detected, host, 'bin', host));
    fs.chmodSync(path.join(detected, host, 'bin', host), 0o755);
    if (host === 'bun')
      fs.writeFileSync(
        path.join(detected, 'node/bin/node'),
        '#!/usr/bin/env sh\nexec "$(dirname "$0")/../../bun/bin/bun" "$@"\n',
        { mode: 0o755 },
      );
    fs.writeFileSync(path.join(detected, 'bin/qwen'), '#!/usr/bin/env sh\n', {
      mode: 0o755,
    });
    fs.writeFileSync(path.join(detected, 'lib/cli.js'), '');
    fs.writeFileSync(
      path.join(detected, 'manifest.json'),
      JSON.stringify({
        name: '@qwen-code/qwen-code',
        target,
        runtime: host,
        version: '1.0.0',
      }),
    );
    const savedArgv = process.argv[1];
    const registryEnv = { ...process.env };
    const registryRequestStart = requests.length;
    let npmCalls = 0;
    try {
      process.argv[1] = path.join(detected, 'lib/cli.js');
      for (const key of Object.keys(process.env))
        if (/^npm_config_/i.test(key)) delete process.env[key];
      Object.assign(process.env, {
        npm_config_registry: process.env.QWEN_UPDATE_BASE_URL,
        npm_config_userconfig: path.join(home, 'user.npmrc'),
        npm_config_globalconfig: path.join(home, 'global.npmrc'),
      });
      assert.equal(getInstallationInfo('', false).isStandalone, true);
      const info = await fetchGlobalNpmUpdateInfo(
        '@qwen-code/qwen-code',
        '1.0.0',
        'latest',
        async (command, args) => {
          npmCalls++;
          assert.equal(host, 'node', 'Bun standalone must not invoke npm');
          assert.equal(command, process.execPath);
          assert.deepEqual(args, [
            getNpmCliPath(),
            'view',
            '@qwen-code/qwen-code',
            'dist-tags.latest',
            '--json',
            '--global',
          ]);
          return { stdout: '"1.2.3"', stderr: '' };
        },
      );
      assert.equal(info.latest, '1.2.3');
      assert.equal(npmCalls, host === 'node' ? 1 : 0);
      assert.deepEqual(
        requests.slice(registryRequestStart),
        host === 'bun' ? ['/-/package/%40qwen-code%2Fqwen-code/dist-tags'] : [],
      );
      console.log(
        JSON.stringify({
          host,
          scenario: 'real-installation-registry-entry',
          npmCalls,
          requests: requests.slice(registryRequestStart),
        }),
      );
    } finally {
      process.argv[1] = savedArgv;
      for (const key of Object.keys(process.env))
        if (!(key in registryEnv)) delete process.env[key];
      Object.assign(process.env, registryEnv);
    }
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

      const cli = path.join(payload, 'lib', 'cli.js');
      const launcher = path.join(payload, 'lib', 'cli-entry.js');
      fs.writeFileSync(launcher, 'import "./cli.js";');
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
      const packArchive = () => {
        const uncompressedArchive = archive.slice(0, -3);
        run('tar', [
          '-cf',
          uncompressedArchive,
          '-C',
          path.dirname(payload),
          'qwen-code',
        ]);
        run('gzip', ['-1', '-f', uncompressedArchive]);
        sums = `${sha(archive)}  ${filename}\n`;
      };
      const pack = (source, version = '1.2.3') => {
        fs.writeFileSync(
          path.join(payload, 'manifest.json'),
          JSON.stringify({
            name: '@qwen-code/qwen-code',
            version,
            target,
            runtime,
          }),
        );
        fs.writeFileSync(cli, source);
        packArchive();
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
        phase = `${runtime}/${scenario}`;
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
          `${versionOnly ? "if(process.argv.includes('--version')){" : ''}require('fs').writeFileSync(${JSON.stringify(marker)},'executed');${noisy ? "console.log('project preload output');" : ''}${versionOnly ? '}' : ''}`,
        );
        if (versionOnly) {
          run(binaries[runtime], ['-e', ''], {
            cwd,
            env: {
              ...process.env,
              NODE_OPTIONS: `--require ${preload}`,
              BUN_OPTIONS: `--preload ${preload}`,
            },
          });
          assert.equal(
            fs.existsSync(marker),
            false,
            'version fixture affected identity',
          );
          run(binaries[runtime], [cli, '--version'], {
            cwd,
            env: {
              ...process.env,
              NODE_OPTIONS: `--require ${preload}`,
              BUN_OPTIONS: `--preload ${preload}`,
            },
          });
          assert.equal(
            fs.existsSync(marker),
            true,
            'version fixture did not execute',
          );
          fs.rmSync(marker);
        }
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
      for (const mode of ['direct', 'prepared']) {
        for (const actualVersion of ['0.0.9', '9.9.9']) {
          phase = `${runtime}/${mode}/mismatch/${actualVersion}`;
          pack(
            `if(process.env.QWEN_UPDATE_TEST_ENV!=='preserved')process.exit(19);console.log(${JSON.stringify(actualVersion)});`,
          );
          const dir = path.join(root, `${runtime}-${mode}-${actualVersion}`);
          const live = installFixture(dir, {
            version: '1.0.0',
            runtime,
            target,
          });
          const before = snapshot(dir);
          const envBefore = { ...process.env };
          const pending =
            mode === 'prepared'
              ? await prepareStandaloneUpdate(live, '1.2.3')
              : undefined;
          try {
            await assert.rejects(
              pending
                ? pending.activate()
                : performStandaloneUpdate(live, '1.2.3'),
              {
                message:
                  'Smoke test failed: CLI version does not match the expected version',
              },
            );
          } finally {
            pending?.cleanup();
          }
          assert.deepEqual(snapshot(dir), before);
          assert.deepEqual({ ...process.env }, envBefore);
          assert.equal(fs.existsSync(archiveMarker), false);
          clean(dir);
          console.log(
            JSON.stringify({
              host,
              runtime,
              mode,
              actualVersion,
              rejected: true,
            }),
          );
        }
        for (const [requested, manifest, actual] of [
          ['v1.2.3', '1.2.3', 'v1.2.3'],
          ['1.2.3-rc.1', '1.2.3-rc.1', 'v1.2.3-rc.1'],
        ]) {
          phase = `${runtime}/${mode}/normalized/${requested}`;
          pack(`console.log(${JSON.stringify(actual)});`, manifest);
          const dir = path.join(root, `${runtime}-${mode}-${requested}`);
          const live = installFixture(dir, {
            version: '1.0.0',
            runtime,
            target,
          });
          const before = snapshot(live);
          const pending =
            mode === 'prepared'
              ? await prepareStandaloneUpdate(live, requested)
              : undefined;
          try {
            assert.equal(
              await (pending
                ? pending.activate()
                : performStandaloneUpdate(live, requested)),
              'done',
            );
          } finally {
            pending?.cleanup();
          }
          assert.equal(
            JSON.parse(fs.readFileSync(path.join(live, 'manifest.json')))
              .version,
            manifest,
          );
          assert.deepEqual(rollbackStandaloneUpdate(live), { ok: true });
          assert.deepEqual(
            snapshot(live).filter(
              ([name]) => name !== '.qwen-rollback-info.json',
            ),
            before,
          );
          assert.equal(fs.existsSync(live + '.old'), false);
          assert.deepEqual(fs.readdirSync(tmp), []);
          assert.deepEqual(fs.readdirSync(dir), ['installed']);
          console.log(
            JSON.stringify({
              host,
              runtime,
              mode,
              requested,
              actual,
              result: 'updated-and-rolled-back',
            }),
          );
        }
      }
      // Keep the production wrapper separate from the CLI it launches.
      const wrapper = fs.readFileSync(
        path.join(repo, 'scripts/cli-entry.js'),
        'utf8',
      );
      fs.writeFileSync(launcher, wrapper);
      for (const mode of ['direct', 'prepared']) {
        for (const actualVersion of ['1.2.3', '0.0.9', '9.9.9']) {
          phase = `${runtime}/${mode}/ambient/${actualVersion}`;
          const legStarted = performance.now();
          const ambientVersion = actualVersion === '1.2.3' ? '9.9.9' : '1.2.3';
          fs.writeFileSync(
            path.join(payload, 'lib/package.json'),
            JSON.stringify({
              name: '@qwen-code/qwen-code',
              type: 'module',
              version: actualVersion,
            }),
          );
          pack(
            `console.log(process.env.CLI_VERSION || ${JSON.stringify(actualVersion)});`,
          );
          const controlEnv = { ...process.env };
          for (const key of Object.keys(controlEnv))
            if (
              /^(NODE_OPTIONS|BUN_OPTIONS|CLI_VERSION|QWEN_CODE_RELAUNCH_ARGS)$/i.test(
                key,
              )
            )
              delete controlEnv[key];
          assert.equal(
            run(binaries[runtime], [launcher, '--version'], {
              env: controlEnv,
            }),
            actualVersion,
          );
          assert.equal(
            run(binaries[runtime], [launcher, '--version'], {
              env: { ...controlEnv, CLI_VERSION: ambientVersion },
            }),
            ambientVersion,
            'wrapper pollution positive control',
          );
          const dir = path.join(
            root,
            `${runtime}-${mode}-ambient-${actualVersion}`,
          );
          const live = installFixture(dir, {
            version: '1.0.0',
            runtime,
            target,
          });
          const before = snapshot(dir);
          const parentEnv = { ...process.env };
          process.env.CLI_VERSION = ambientVersion;
          process.env.QWEN_CODE_RELAUNCH_ARGS = '["--version"]';
          const envBefore = { ...process.env };
          let pending;
          try {
            pending =
              mode === 'prepared'
                ? await prepareStandaloneUpdate(live, '1.2.3')
                : undefined;
            const update = pending
              ? pending.activate()
              : performStandaloneUpdate(live, '1.2.3');
            if (actualVersion === '1.2.3') {
              assert.equal(await update, 'done');
              assert.equal(
                sha(path.join(live, 'lib', path.basename(cli))),
                sha(cli),
              );
              assert.equal(
                JSON.parse(fs.readFileSync(path.join(live, 'manifest.json')))
                  .version,
                '1.2.3',
              );
              assert.deepEqual(
                snapshot(live + '.old').filter(
                  ([name]) => name !== '.qwen-rollback-info.json',
                ),
                before.find(([name]) => name === 'installed')[1],
              );
              assert.deepEqual(rollbackStandaloneUpdate(live), { ok: true });
              assert.deepEqual(
                snapshot(live).filter(
                  ([name]) => name !== '.qwen-rollback-info.json',
                ),
                before.find(([name]) => name === 'installed')[1],
              );
              assert.equal(fs.existsSync(live + '.old'), false);
            } else {
              await assert.rejects(update, {
                message:
                  'Smoke test failed: CLI version does not match the expected version',
              });
              assert.deepEqual(snapshot(dir), before);
            }
            assert.deepEqual({ ...process.env }, envBefore);
            assert.equal(fs.existsSync(archiveMarker), false);
          } finally {
            pending?.cleanup();
            for (const key of ['CLI_VERSION', 'QWEN_CODE_RELAUNCH_ARGS']) {
              if (key in parentEnv) process.env[key] = parentEnv[key];
              else delete process.env[key];
            }
          }
          assert.deepEqual({ ...process.env }, parentEnv);
          if (
            runtime === 'node' &&
            mode === 'direct' &&
            actualVersion === '1.2.3'
          ) {
            assert.ok(
              fs
                .readdirSync(compileCache, {
                  recursive: true,
                  withFileTypes: true,
                })
                .some((entry) => entry.isFile()),
              'Node payload probes must create compile-cache files',
            );
          }
          assert.deepEqual(fs.readdirSync(tmp), []);
          assert.deepEqual(
            fs.readdirSync(dir).sort(),
            actualVersion === '1.2.3'
              ? ['installed']
              : ['installed', 'installed.old'],
          );
          console.log(
            JSON.stringify({
              host,
              runtime,
              mode,
              actualVersion,
              ambientVersion,
              wrapperSha256: sha(path.join(repo, 'scripts/cli-entry.js')),
              scenario: 'ambient-wrapper',
              result:
                actualVersion === '1.2.3'
                  ? 'updated-and-rolled-back'
                  : 'rejected',
              elapsedMs: Math.round(performance.now() - legStarted),
            }),
          );
        }
      }
      for (const mode of ['direct', 'prepared']) {
        for (const state of ['missing', 'syntax-error', 'launcher-error']) {
          phase = `${runtime}/${mode}/${state}`;
          fs.writeFileSync(launcher, wrapper);
          fs.writeFileSync(
            path.join(payload, 'lib/package.json'),
            JSON.stringify({ type: 'module', version: '1.2.3' }),
          );
          pack(
            state === 'launcher-error'
              ? 'console.log("1.2.3");'
              : 'export const invalid = ;',
          );
          if (state === 'launcher-error') {
            fs.writeFileSync(launcher, 'export const invalid = ;');
          }
          if (state === 'missing') {
            fs.rmSync(cli);
          }
          if (state !== 'syntax-error') {
            packArchive();
          }
          if (state !== 'launcher-error')
            assert.equal(
              run(binaries[runtime], [launcher, '--version']),
              '1.2.3',
              'metadata-only positive control',
            );
          const dir = path.join(root, `${runtime}-${mode}-cli-${state}`);
          const live = installFixture(dir, { runtime, target });
          const before = snapshot(dir);
          const pending =
            mode === 'prepared'
              ? await prepareStandaloneUpdate(live, '1.2.3')
              : undefined;
          try {
            await assert.rejects(
              pending
                ? pending.activate()
                : performStandaloneUpdate(live, '1.2.3'),
              state === 'missing'
                ? /Smoke test failed: CLI entry not found at /
                : state === 'launcher-error'
                  ? /Smoke test failed: launcher could not load CLI/
                  : /Smoke test failed: new binary exited with code 1/,
            );
          } finally {
            pending?.cleanup();
          }
          assert.deepEqual(snapshot(dir), before);
          clean(dir);
          console.log(
            JSON.stringify({
              host,
              runtime,
              mode,
              scenario: `cli-${state}`,
              rejected: true,
            }),
          );
        }
      }
      fs.rmSync(path.join(payload, 'lib/package.json'));
      fs.writeFileSync(launcher, 'import "./cli.js";');
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
        phase = `${runtime}/${failure}`;
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
      phase = `${runtime}/identity-mismatch`;
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
        phase = `manifest/${mode}/${index}`;
        const dir = path.join(root, `manifest-${mode}-${index}`);
        const live = installFixture(dir, manifest);
        const before = snapshot(dir),
          ai = allocations.length,
          ri = requests.length;
        await assert.rejects(update(live, '1.2.3'), (error) => {
          if (index < 5) {
            assert(
              error.message.startsWith(
                `Invalid installed standalone manifest at ${path.join(live, 'manifest.json')}.`,
              ),
            );
            assert.match(error.message, /known-good backup/);
            assert.match(
              error.message,
              /same runtime flavor in a new directory/,
            );
          } else {
            assert.equal(error.message, 'Unknown standalone runtime');
          }
          return true;
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
        elapsedMs: Math.round(performance.now() - started),
        probeCount,
        rawProbeObservable: probeCount > 0,
        tmpResidue: fs.readdirSync(tmp),
      }),
    );
  } catch (err) {
    console.error(
      JSON.stringify({
        host,
        failurePhase: phase,
        elapsedMs: Math.round(performance.now() - started),
        probeCount,
        rawProbeObservable: probeCount > 0,
      }),
    );
    throw err;
  } finally {
    childProcess.execFile = originalExecFile;
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
      const base =
        process.env.QWEN_TEST_NODE_BASE_URL ||
        'https://nodejs.org/dist/v24.19.0/';
      const source = new URL(base);
      assert.equal(source.protocol, 'https:', 'runtime source must use HTTPS');
      assert.equal(
        source.username + source.password,
        '',
        'runtime source must not contain credentials',
      );
      assert(base.endsWith('/'), 'runtime source must end with /');
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
  const node = run(process.env.PINNED_NODE || process.execPath, [
    '-p',
    'process.execPath',
  ]);
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
      const workerStarted = performance.now();
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
          errorCode: result.error?.code ?? null,
          elapsedMs: Math.round(performance.now() - workerStarted),
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
