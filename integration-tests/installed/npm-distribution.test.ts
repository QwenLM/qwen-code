/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, afterAll, it } from 'vitest';
import {
  InteractiveSession,
  sendAboutUntilRendered,
} from '../interactive/interactive-session.js';
import { startFakeOpenAIServer } from '../fake-openai-server.js';
import { E2E_MEMORY_SETTINGS_DEFAULTS } from '../e2e-memory-defaults.js';
import {
  descendants,
  descriptors,
  observe,
  sameProcess,
} from './process-observer.js';
import {
  sha,
  save,
  inventory,
  inventoryEntry,
  until,
  cells,
  checkout,
  ownedCommand,
  type Entry,
} from './npm-distribution-fixture.js';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const base =
  process.env['QWEN_DISTRIBUTION_OUT'] ??
  fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-distribution-'));
fs.mkdirSync(base, { recursive: true });
const node = fs.realpathSync(
  process.env['QWEN_DISTRIBUTION_NODE'] ?? 'ACTUAL_NODE_REQUIRED',
);
const npm = fs.realpathSync(
  process.env['QWEN_DISTRIBUTION_NPM'] ?? 'MATCHING_NPM_REQUIRED',
);
const expectedNode = process.env['QWEN_DISTRIBUTION_NODE_VERSION'];
const runnerGitPath = execFileSync('/bin/sh', ['-c', 'command -v git'], {
  encoding: 'utf8',
  timeout: 10_000,
}).trim();
assert.ok(path.isAbsolute(runnerGitPath));
const runnerGit = fs.realpathSync(runnerGitPath);
const initialSource = checkout(root);
const tools = {
  git: {
    path: runnerGit,
    sha256: sha(runnerGit),
    mode: fs.statSync(runnerGit).mode & 0o777,
  },
  node: { path: node, sha256: sha(node), mode: fs.statSync(node).mode & 0o777 },
  npm: { path: npm, sha256: sha(npm), mode: fs.statSync(npm).mode & 0o777 },
};
const hosts: Record<string, { bun: string; native: string }> = {
  'darwin-arm64': {
    bun: '@oven/bun-darwin-aarch64',
    native: '@opentui/core-darwin-arm64/libopentui.dylib',
  },
  'darwin-x64': {
    bun: '@oven/bun-darwin-x64',
    native: '@opentui/core-darwin-x64/libopentui.dylib',
  },
  'linux-arm64': {
    bun: '@oven/bun-linux-aarch64',
    native: '@opentui/core-linux-arm64/libopentui.so',
  },
  'linux-x64': {
    bun: '@oven/bun-linux-x64',
    native: '@opentui/core-linux-x64/libopentui.so',
  },
};
const host = hosts[`${process.platform}-${process.arch}`];
type Artifact = {
  source: { head: string; diff: string };
  tarball: { path: string; sha256: string; bytes: number };
  files: { path: string; sha256: string };
};
type Layout = {
  id: string;
  kind: 'global' | 'npx';
  ignoreScripts: boolean;
  out: string;
  home: string;
  cwd: string;
  prefix: string;
  cache: string;
  env: NodeJS.ProcessEnv;
  packageRoot: string;
  installRoot: string;
  bin: string;
  bun: string;
  native: string;
  installation: Record<string, Entry>;
};
const layouts: Layout[] = [];
let artifact: Artifact;
let artifactReceipt: { path: string; sha256: string };
let published: Record<string, Entry>;
let distBefore: Record<string, Entry>;
function frozenInputs() {
  assert.deepEqual(checkout(root), initialSource);
  assert.equal(sha(runnerGit), tools.git.sha256);
  assert.equal(fs.statSync(runnerGit).mode & 0o777, tools.git.mode);
  assert.equal(sha(node), tools.node.sha256);
  assert.equal(sha(npm), tools.npm.sha256);
  assert.equal(fs.statSync(node).mode & 0o777, tools.node.mode);
  assert.equal(fs.statSync(npm).mode & 0o777, tools.npm.mode);
  assert.equal(sha(artifactReceipt.path), artifactReceipt.sha256);
  assert.equal(sha(artifact.tarball.path), artifact.tarball.sha256);
  assert.equal(sha(artifact.files.path), artifact.files.sha256);
  assert.deepEqual(inventory(path.join(root, 'dist')), distBefore);
}
function installed(layout: Layout) {
  frozenInputs();
  assert.deepEqual(inventory(layout.installRoot), layout.installation);
  if (layout.kind === 'npx')
    assert.deepEqual(
      inventory(layout.prefix),
      {},
      'npx does not mutate owned global prefix',
    );
}
function qwen(layout: Layout, args: string[]) {
  return layout.kind === 'global'
    ? { bin: layout.bin, args }
    : {
        bin: node,
        args: [
          npm,
          'exec',
          '--yes',
          '--offline',
          '--package',
          artifact.tarball.path,
          '--',
          'qwen',
          ...args,
        ],
      };
}
beforeAll(async () => {
  let failure: unknown;
  try {
    assert.ok(
      host,
      'only four declared POSIX hosts; unsupported hosts must not silently skip',
    );
    if (process.platform === 'linux') {
      const report = process.report.getReport() as {
        header?: { glibcVersionRuntime?: string };
      };
      assert.ok(report.header?.glibcVersionRuntime, 'glibc Linux required');
    }
    assert.ok(
      expectedNode === '22.23.2' || expectedNode === '26.4.0',
      'explicit fixed actual Node boundary required',
    );
    assert.equal(
      execFileSync(node, ['--version'], {
        encoding: 'utf8',
        timeout: 5000,
      }).trim(),
      `v${expectedNode}`,
    );
    assert.equal(
      fs.realpathSync(
        path.resolve(
          path.dirname(node),
          '../lib/node_modules/npm/bin/npm-cli.js',
        ),
      ),
      npm,
      'npm belongs to invoking Node toolchain',
    );
    artifactReceipt = {
      path: fs.realpathSync(
        process.env['QWEN_DISTRIBUTION_ARTIFACT'] ??
          'FROZEN_AUDITED_ARTIFACT_REQUIRED',
      ),
      sha256: '',
    };
    artifactReceipt.sha256 = sha(artifactReceipt.path);
    artifact = JSON.parse(
      fs.readFileSync(artifactReceipt.path, 'utf8'),
    ) as Artifact;
    assert.deepEqual(
      artifact.source,
      initialSource,
      'audited tarball belongs to this exact source',
    );
    for (const entry of [artifact.tarball, artifact.files]) {
      assert.equal(path.isAbsolute(entry.path), true);
      assert.match(entry.sha256, /^[0-9a-f]{64}$/);
      assert.equal(sha(entry.path), entry.sha256);
    }
    assert.equal(
      fs.statSync(artifact.tarball.path).size,
      artifact.tarball.bytes,
    );
    published = JSON.parse(
      fs.readFileSync(artifact.files.path, 'utf8'),
    ) as Record<string, Entry>;
    const members = execFileSync('tar', ['-tzf', artifact.tarball.path], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
    })
      .trim()
      .split('\n');
    for (const member of members)
      assert.ok(
        member.startsWith('package/') &&
          !member.split('/').includes('..') &&
          !member.includes('\\'),
        member,
      );
    const verbose = execFileSync('tar', ['-tvzf', artifact.tarball.path], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
    })
      .trim()
      .split('\n');
    assert.ok(
      verbose.every((line) => line.startsWith('-') || line.startsWith('d')),
      'no archive links/devices',
    );
    const unpacked = path.join(base, 'verified-tar');
    assert.equal(fs.existsSync(unpacked), false);
    fs.mkdirSync(unpacked);
    execFileSync('tar', ['-xzf', artifact.tarball.path, '-C', unpacked], {
      timeout: 30_000,
    });
    assert.deepEqual(
      inventory(path.join(unpacked, 'package')),
      published,
      'receipt covers exact published files, bytes and modes',
    );
    const unpackedBytes = Object.values(published).reduce(
      (total, entry) => total + (entry.bytes ?? 0),
      0,
    );
    assert.ok(unpackedBytes > 0 && unpackedBytes <= 160 * 1024 * 1024);
    distBefore = inventory(path.join(root, 'dist'));
    for (const kind of ['global', 'npx'] as const) {
      for (const ignoreScripts of [false, true]) {
        const id = `${kind}-${ignoreScripts ? 'ignore-scripts' : 'lifecycle-enabled'}`;
        const out = path.join(base, id);
        assert.equal(fs.existsSync(out), false);
        const home = path.join(out, 'home');
        const cwd = path.join(out, 'workspace');
        const prefix = path.join(out, 'prefix');
        const cache = path.join(home, '.npm');
        for (const directory of [home, cwd, prefix, path.join(out, 'tmp')])
          fs.mkdirSync(directory, { recursive: true });
        const userconfig = path.join(out, 'user.npmrc');
        const globalconfig = path.join(out, 'global.npmrc');
        fs.writeFileSync(userconfig, '');
        fs.writeFileSync(globalconfig, '');
        const env: NodeJS.ProcessEnv = {
          PATH: path.dirname(node) + ':/usr/bin:/bin:/usr/sbin:/sbin',
          HOME: home,
          TMPDIR: path.join(out, 'tmp'),
          npm_config_cache: cache,
          npm_config_prefix: prefix,
          npm_config_userconfig: userconfig,
          npm_config_globalconfig: globalconfig,
          npm_config_ignore_scripts: String(ignoreScripts),
          npm_config_update_notifier: 'false',
          QWEN_USAGE_STATISTICS_ENABLED: 'false',
          QWEN_TELEMETRY_ENABLED: 'false',
        };
        assert.equal(
          execFileSync(
            '/bin/sh',
            ['-c', 'if command -v bun; then exit 73; fi'],
            { cwd, env, encoding: 'utf8', timeout: 10_000 },
          ),
          '',
        );
        const decoy = path.join(cwd, 'bun');
        fs.writeFileSync(
          decoy,
          '#!/bin/sh\nprintf called > "$PWD/decoy-called"\nexit 74\n',
          { mode: 0o755 },
        );
        env.PATH = cwd + ':' + env.PATH;
        assert.equal(
          execFileSync('/bin/sh', ['-c', 'command -v bun'], {
            cwd,
            env,
            encoding: 'utf8',
            timeout: 10_000,
          }).trim(),
          decoy,
          'decoy must actually be discoverable on PATH',
        );
        const priorCleanGit = execFileSync(
          '/bin/sh',
          ['-c', 'command -v git'],
          {
            cwd,
            env,
            encoding: 'utf8',
            timeout: 10_000,
          },
        ).trim();
        const gitLink = path.join(cwd, 'git');
        fs.symlinkSync(runnerGit, gitLink);
        assert.equal(
          execFileSync('/bin/sh', ['-c', 'command -v git'], {
            cwd,
            env,
            encoding: 'utf8',
            timeout: 10_000,
          }).trim(),
          gitLink,
        );
        assert.equal(fs.realpathSync(gitLink), runnerGit);
        save(path.join(out, 'git-selection.json'), {
          runnerGitPath,
          runnerGit: tools.git,
          priorCleanGit,
          gitLink,
          selected: gitLink,
        });
        let packageRoot: string;
        let installRoot: string;
        let bin: string;
        if (kind === 'global') {
          await ownedCommand(
            path.join(out, 'install'),
            node,
            [
              npm,
              'install',
              '--global',
              '--prefix',
              prefix,
              '--no-audit',
              '--no-fund',
              artifact.tarball.path,
            ],
            cwd,
            env,
          );
          const globalRoot = (
            await ownedCommand(
              path.join(out, 'global-root'),
              node,
              [npm, 'root', '--global', '--prefix', prefix],
              cwd,
              env,
              30,
            )
          ).trim();
          assert.equal(path.isAbsolute(globalRoot), true);
          assert.ok(globalRoot.startsWith(prefix + path.sep));
          packageRoot = path.join(globalRoot, '@qwen-code/qwen-code');
          installRoot = prefix;
          bin = path.join(prefix, 'bin/qwen');
        } else {
          assert.equal(
            fs.existsSync(cache),
            false,
            'npx starts from empty owned cache',
          );
          await ownedCommand(
            path.join(out, 'materialize'),
            node,
            [
              npm,
              'exec',
              '--yes',
              '--package',
              artifact.tarball.path,
              '--',
              'qwen',
              '--version',
            ],
            cwd,
            env,
          );
          const npxRoot = path.join(cache, '_npx');
          const candidates = fs
            .readdirSync(npxRoot)
            .map((name) =>
              path.join(npxRoot, name, 'node_modules/@qwen-code/qwen-code'),
            )
            .filter(
              (candidate) =>
                fs.existsSync(path.join(candidate, 'package.json')) &&
                sha(path.join(candidate, 'cli-entry.js')) ===
                  published['cli-entry.js'].sha256,
            );
          assert.equal(
            candidates.length,
            1,
            'one exact candidate installed in fresh real npx cache',
          );
          packageRoot = candidates[0];
          installRoot = path.resolve(packageRoot, '../../..');
          bin = path.resolve(packageRoot, '../../.bin/qwen');
        }
        assert.equal(
          fs.realpathSync(bin),
          fs.realpathSync(path.join(packageRoot, 'cli-entry.js')),
        );
        for (const [file, expected] of Object.entries(published))
          assert.deepEqual(
            inventoryEntry(path.join(packageRoot, file)),
            expected,
            file,
          );
        const manifest = JSON.parse(
          fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
        );
        assert.equal(manifest.name, '@qwen-code/qwen-code');
        assert.equal(manifest.optionalDependencies[host.bun], '1.4.4');
        const require = createRequire(path.join(packageRoot, 'package.json'));
        const bunRoot = fs.realpathSync(
          path.dirname(require.resolve(host.bun + '/package.json')),
        );
        const ownedRoot = fs.realpathSync(installRoot) + path.sep;
        assert.ok(
          bunRoot.startsWith(ownedRoot),
          'private Bun package is owned',
        );
        assert.equal(
          JSON.parse(
            fs.readFileSync(path.join(bunRoot, 'package.json'), 'utf8'),
          ).version,
          '1.4.4',
        );
        const bun = fs.realpathSync(path.join(bunRoot, 'bin/bun'));
        assert.ok(bun.startsWith(ownedRoot), 'private Bun executable is owned');
        assert.ok(fs.statSync(bun).mode & 0o111);
        const native = fs.realpathSync(
          path.join(packageRoot, 'opentui-assets', host.native),
        );
        const layout: Layout = {
          id,
          kind,
          ignoreScripts,
          out,
          home,
          cwd,
          prefix,
          cache,
          env,
          packageRoot,
          installRoot,
          bin,
          bun,
          native,
          installation: inventory(installRoot),
        };
        layouts.push(layout);
        save(path.join(out, 'installation.json'), {
          ...layout,
          env: undefined,
          artifact,
          source: initialSource,
          tools,
          expectedNode,
          privateBun: { path: bun, sha256: sha(bun) },
          native: { path: native, sha256: sha(native) },
          scope:
            'actual layout; not released upgrade/authentication/other target acceptance',
        });
        frozenInputs();
      }
    }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    save(path.join(base, 'setup-result.json'), {
      outcome: failure ? 'FAIL' : 'PASS',
      error: failure ? String(failure) : undefined,
      source: initialSource,
      tools,
      expectedNode,
      platform: process.platform,
      arch: process.arch,
    });
  }
}, 2_700_000);

afterAll(() => {
  for (const layout of layouts) installed(layout);
});

for (const kind of ['global', 'npx'] as const) {
  for (const ignoreScripts of [false, true]) {
    for (const mode of [
      'native',
      'no-relaunch-strict',
      'no-relaunch-fallback',
    ] as const) {
      const id = `${kind}-${ignoreScripts ? 'ignore-scripts' : 'lifecycle-enabled'}`;
      it(`${id} ${mode} uses actual installed entry and exits naturally`, async () => {
        const layout = layouts.find((row) => row.id === id)!;
        assert.ok(layout);
        installed(layout);
        process.env['QWEN_E2E_RENDERER'] =
          mode === 'native' ? 'opentui' : 'ink';
        const out = path.join(layout.out, mode);
        assert.equal(fs.existsSync(out), false);
        const qwenHome = path.join(out, 'qwen-home');
        fs.mkdirSync(qwenHome, { recursive: true });
        const system = path.join(out, 'system.json');
        const defaults = path.join(out, 'defaults.json');
        save(system, { $version: 4 });
        save(defaults, { $version: 4 });
        save(path.join(qwenHome, 'settings.json'), {
          $version: 4,
          experimental: { mods: false },
          security: {
            auth: { selectedType: 'openai' },
            folderTrust: { enabled: false },
          },
          general: { enableAutoUpdate: false, showSessionRecap: false },
          ui: { enableFollowupSuggestions: false },
          memory: E2E_MEMORY_SETTINGS_DEFAULTS,
        });
        const pidFile = path.join(out, 'pid');
        const exitFile = path.join(out, 'exit');
        const stderr = path.join(out, 'stderr');
        const launcher = path.join(out, 'launch.sh');
        const strict = mode !== 'no-relaunch-fallback';
        fs.writeFileSync(
          launcher,
          '#!/bin/sh\nprintf "%s\\n" "$$" > "$DISTRIBUTION_PID"\nexport QWEN_TUI_RENDERER=opentui\nexport QWEN_TUI_RENDERER_STRICT="$DISTRIBUTION_STRICT"\n"$@" 2> "$DISTRIBUTION_STDERR"\ncode=$?\nprintf "%s\\n" "$code" > "$DISTRIBUTION_EXIT"\nexit "$code"\n',
          { mode: 0o755 },
        );
        const observer = observe(pidFile);
        const server = await startFakeOpenAIServer(() => ({
          contentChunks: [
            '```javascript\nconst R3_HIGHLIGHT_VALUE = 42;\nconsole.log("R3_PARSER_READY", R3_HIGHLIGHT_VALUE);\n```\nR3_REPLY_DONE',
          ],
        }));
        let session: InteractiveSession | undefined;
        let startupOutput: string | undefined;
        let failure: unknown;
        const facts: Record<string, unknown> = {
          outcome: 'RUNNING',
          artifact,
          source: initialSource,
          tools,
          expectedNode,
          layout: id,
          mode,
          scope:
            'this actual layout/toolchain only; no update/auth/manual/platform PASS inferred',
        };
        try {
          const command = qwen(layout, [
            '--auth-type',
            'openai',
            '--openai-api-key',
            'local-fixture',
            '--openai-base-url',
            server.baseUrl,
            '--model',
            'fake-model',
            '--approval-mode',
            'default',
          ]);
          let startupError: unknown;
          const startupStartedAt = Date.now();
          try {
            session = await InteractiveSession.start({
              onStartupFailure: (output) => {
                startupOutput = output;
              },
              command: {
                bin: '/bin/sh',
                args: [launcher, command.bin, ...command.args],
              },
              cwd: layout.cwd,
              cols: 100,
              rows: 32,
              inheritEnv: false,
              env: {
                ...layout.env,
                QWEN_HOME: qwenHome,
                QWEN_RUNTIME_DIR: path.join(out, 'runtime'),
                QWEN_CODE_SYSTEM_SETTINGS_PATH: system,
                QWEN_CODE_SYSTEM_DEFAULTS_PATH: defaults,
                TERM: 'xterm-256color',
                LANG: 'en_US.UTF-8',
                QWEN_CODE_LANG: 'en',
                QWEN_SANDBOX: 'false',
                QWEN_CODE_DISABLE_CRON: '1',
                QWEN_CODE_SKIP_UPDATE_CHECK_ONCE: 'true',
                QWEN_CODE_MODELS_DEV_REFRESH: 'off',
                QWEN_DEBUG_LOG_FILE: '1',
                QWEN_CODE_PROFILE_STARTUP: '1',
                QWEN_CODE_PROFILE_STARTUP_OUTER: '1',
                QWEN_CODE_PROFILE_STARTUP_NO_HEAP: '1',
                DISTRIBUTION_PID: pidFile,
                DISTRIBUTION_EXIT: exitFile,
                DISTRIBUTION_STDERR: stderr,
                DISTRIBUTION_STRICT: strict ? '1' : '0',
                ...(mode === 'native' ? {} : { QWEN_CODE_NO_RELAUNCH: '1' }),
              },
            });
          } catch (error) {
            startupError = error;
          }
          facts.startupElapsedMs = Date.now() - startupStartedAt;
          facts.startupObserverTiming = observer.timing();
          facts.startupError = startupError ? String(startupError) : undefined;
          observer.poll();
          if (mode === 'no-relaunch-strict') {
            assert.equal(session, undefined);
            assert.ok(startupError);
            assert.ok(
              fs
                .readFileSync(stderr, 'utf8')
                .includes(
                  'OpenTUI npm Bun handoff unavailable: QWEN_CODE_NO_RELAUNCH disables runtime handoff',
                ),
            );
            const code = Number(fs.readFileSync(exitFile, 'utf8').trim());
            assert.ok(Number.isInteger(code) && code !== 0);
            facts.productExitCode = code;
          } else {
            if (startupError) throw startupError;
            assert.ok(session);
            const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
            const processes = descendants(pid).map((row) => ({
              ...row,
              descriptors: descriptors(row),
            }));
            facts.readyProcesses = processes;
            assert.ok(
              processes.some(
                (row) =>
                  row.descriptors.split('\n').includes(`n${node}`) &&
                  (row.command.includes(layout.bin) ||
                    row.command.includes(
                      path.join(layout.packageRoot, 'cli-entry.js'),
                    ) ||
                    row.command.includes(
                      path.join(layout.packageRoot, 'cli.js'),
                    )),
              ),
              'actual invoking Node owns selected installed global/npx product, not merely the npm ancestor',
            );
            await sendAboutUntilRendered(session);
            assert.equal(server.requests.length, 0);
            const ready = descendants(pid).map((row) => ({
              ...row,
              descriptors: descriptors(row),
            }));
            facts.afterAboutProcesses = ready;
            if (mode === 'native') {
              assert.ok(
                ready.some(
                  (row) =>
                    row.descriptors.split('\n').includes(`n${layout.bun}`) &&
                    row.descriptors.split('\n').includes(`n${layout.native}`),
                ),
                'same installed private Bun actually loads same installed native library',
              );
              await session.idle();
              await session.send('R3_DISTRIBUTION_HIGHLIGHT');
              assert.ok(
                await until(async () =>
                  (await session!.viewport()).includes('R3_REPLY_DONE'),
                ),
              );
              assert.equal(server.requests.length, 1);
              assert.ok(
                await until(
                  async () => (await cells(session!))?.highlighted ?? false,
                ),
                'independent literal parser color oracle',
              );
              facts.codeCells = await cells(session);
              assert.ok(
                await until(
                  () =>
                    server.requests[0]?.transport.closedAt !== undefined &&
                    server.requests[0].transport.writableEndedAtClose === true,
                ),
              );
            } else {
              assert.ok(
                ready.every(
                  (row) =>
                    !row.descriptors.split('\n').includes(`n${layout.bun}`) &&
                    !row.descriptors.split('\n').includes(`n${layout.native}`),
                ),
                'working fallback is Node/Ink, no native/Bun mapping at readiness',
              );
              assert.equal(server.requests.length, 0);
            }
            await session.idle();
            await session.send('/quit');
            assert.ok(await until(() => session!.exitResult() !== undefined));
            assert.equal(session.exitResult()!.exitCode, 0);
            assert.ok(!session.exitResult()!.signal);
            facts.naturalExit = session.exitResult();
          }
          assert.equal(server.requests.length, mode === 'native' ? 1 : 0);
          assert.ok(
            await until(
              () => observer.snapshot().every((row) => !sameProcess(row)),
              3000,
            ),
            'all captured processes exited naturally',
          );
          assert.equal(
            fs.existsSync(path.join(layout.cwd, 'decoy-called')),
            false,
          );
          assert.equal(
            fs.existsSync(path.join(qwenHome, 'updates/npm')),
            false,
            'these cases do not perform self-update',
          );
          installed(layout);
        } catch (error) {
          failure = error;
        } finally {
          const errors: string[] = [];
          const cleanup = async (
            name: string,
            run: () => unknown | Promise<unknown>,
          ) => {
            try {
              await run();
            } catch (error) {
              errors.push(`${name}: ${String(error)}`);
            }
          };
          await cleanup('output', () =>
            fs.writeFileSync(
              path.join(out, 'terminal.ansi'),
              session?.output() ??
                startupOutput ??
                String(facts.startupError ?? 'STARTUP_NOT_RETURNED'),
            ),
          );
          await cleanup('observer', () => {
            facts.observerError = observer.stop();
            facts.captured = observer.snapshot();
            facts.liveBeforeCleanup = observer.snapshot().filter(sameProcess);
            if (facts.observerError)
              throw new Error(String(facts.observerError));
            const rootPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
            assert.ok(
              observer.snapshot().some((row) => row.pid === rootPid),
              'the actual launcher must have been observed before an absence claim',
            );
            assert.deepEqual(facts.liveBeforeCleanup, []);
          });
          await cleanup('owned processes', () => observer.cleanup());
          await cleanup('PTY', () => session?.close());
          await cleanup('HTTP evidence', () =>
            save(path.join(out, 'requests.json'), server.requests),
          );
          await cleanup('HTTP close', () => server.close());
          await cleanup('immutable installation', () => installed(layout));
          if (errors.length) failure ??= new Error(errors.join('\n'));
          facts.outcome = failure ? 'FAIL' : 'PASS';
          facts.error = failure ? String(failure) : undefined;
          facts.cleanupErrors = errors;
          save(path.join(out, 'result.json'), facts);
        }
        if (failure) throw failure;
      }, 120_000);
    }
  }
}
