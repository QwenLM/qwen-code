/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
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
  until,
  inventory,
  inventoryEntry,
  cells,
  type Entry,
} from './npm-distribution-fixture.js';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const base =
  process.env['QWEN_INSTALLED_OUT'] ??
  fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-installed-'));
fs.mkdirSync(base, { recursive: true });
const node = fs.realpathSync(
  process.env['QWEN_INSTALLED_NODE'] ?? 'NODE26_TOOLCHAIN_REQUIRED',
);
const npm = fs.realpathSync(
  process.env['QWEN_INSTALLED_NPM'] ?? 'NODE26_NPM_REQUIRED',
);
const checkout = () => ({
  head: execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
  }).trim(),
  diff: createHash('sha256')
    .update(
      execFileSync('git', ['diff', 'HEAD', '--binary'], {
        cwd: root,
        timeout: 10_000,
      }),
    )
    .digest('hex'),
});
const initialCheckout = checkout();
const inputs = {
  actualNode26: {
    sha256: sha(node),
    mode: `0o${(fs.statSync(node).mode & 0o777).toString(8)}`,
  },
  actualNpm: { path: npm, sha256: sha(npm) },
  ownedEmptyNpmrc: path.join(base, 'empty-npmrc'),
  ownedEmptyGlobalNpmrc: path.join(base, 'empty-global-npmrc'),
  installAcceptance: { path: path.join(base, 'installation.json') },
};
fs.writeFileSync(inputs.ownedEmptyNpmrc, '');
fs.writeFileSync(inputs.ownedEmptyGlobalNpmrc, '');
let bun: string;
let dylib: string;
let hostPackage: string;
let receipt: {
  prefix: string;
  packageRoot: string;
  privateBun: { path: string; sha256: string; mode: string };
  installedMap: { path: string; sha256: string };
};
let pack: { tarball: { path: string; sha256: string; bytes: number } };
let installedMap: Record<string, Entry>;
let preparedMap: Record<string, Entry>;
let setupEnv: NodeJS.ProcessEnv;
async function command(
  id: string,
  bin: string,
  args: string[],
  cwd: string,
  seconds: number,
  env = setupEnv,
) {
  const started = Date.now();
  let timedOut = false;
  let log: number | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let observer: ReturnType<typeof observe> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let kill: ReturnType<typeof setTimeout> | undefined;
  let code: number | null = null;
  let signal: NodeJS.Signals | null = null;
  let failure: unknown;
  let observerError: string | undefined;
  let captured: ReturnType<typeof descendants> = [];
  let rootProcess: ReturnType<typeof descendants>[number] | undefined;
  let live: ReturnType<typeof descendants> = [];
  const cleanupErrors: string[] = [];
  try {
    log = fs.openSync(path.join(base, id + '.log'), 'wx');
    const pidFile = path.join(base, id + '.pid');
    observer = observe(pidFile);
    child = spawn(bin, args, {
      cwd,
      env,
      stdio: ['ignore', log, log],
      detached: true,
    });
    const completion = new Promise<void>((resolve, reject) => {
      child!.once('error', reject);
      child!.once('exit', (exit, sig) => {
        code = exit;
        signal = sig;
        resolve();
      });
    });
    void completion.catch(() => {});
    assert.ok(child.pid);
    // Capture before the pid-file write, whose failure must still clean this child.
    captured = descendants(child.pid);
    rootProcess = captured.find((row) => row.pid === child!.pid);
    timeout = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child!.pid!, 'SIGTERM');
      } catch {
        /* exited */
      }
    }, seconds * 1000);
    kill = setTimeout(
      () => {
        try {
          process.kill(-child!.pid!, 'SIGKILL');
        } catch {
          /* exited */
        }
      },
      seconds * 1000 + 5000,
    );
    fs.writeFileSync(pidFile, String(child.pid));
    observer.poll();
    await completion;
    assert.equal(timedOut, false);
    assert.equal(signal, null);
    assert.equal(code, 0);
  } catch (error) {
    failure = error;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (kill) clearTimeout(kill);
    try {
      observerError = observer?.stop();
      captured = [
        ...new Map(
          [...captured, ...(observer?.snapshot() ?? [])].map((entry) => [
            entry.pid,
            entry,
          ]),
        ).values(),
      ];
      live = captured.filter(sameProcess);
    } catch (error) {
      cleanupErrors.push(`process observation: ${String(error)}`);
    }
    try {
      await observer?.cleanup();
    } catch (error) {
      cleanupErrors.push(`observer cleanup: ${String(error)}`);
    }
    try {
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        const owned = child;
        try {
          process.kill(-owned.pid!, 'SIGTERM');
        } catch {
          /* exit event may still be queued */
        }
        if (
          !(await until(
            () => owned.exitCode !== null || owned.signalCode !== null,
            5000,
          ))
        ) {
          try {
            process.kill(-owned.pid!, 'SIGKILL');
          } catch {
            /* exited */
          }
          assert.ok(
            await until(
              () => owned.exitCode !== null || owned.signalCode !== null,
              5000,
            ),
            'owned command did not exit after TERM5/KILL5',
          );
        }
      }
      for (const row of captured.filter(sameProcess))
        process.kill(row.pid, 'SIGTERM');
      assert.ok(
        await until(() => captured.every((row) => !sameProcess(row)), 5000),
        'captured setup processes gone',
      );
    } catch (error) {
      cleanupErrors.push(`owned cleanup: ${String(error)}`);
    }
    try {
      if (log !== undefined) fs.closeSync(log);
    } catch (error) {
      cleanupErrors.push(`log close: ${String(error)}`);
    }
    if (observerError) cleanupErrors.push(`observer: ${observerError}`);
    if (live.length)
      cleanupErrors.push('stage left owned children before cleanup');
    try {
      save(path.join(base, id + '.json'), {
        bin,
        args,
        cwd,
        seconds: (Date.now() - started) / 1000,
        code,
        signal,
        timedOut,
        rootPid: child?.pid,
        rootProcess,
        error: failure ? String(failure) : undefined,
        observerError,
        captured,
        liveBeforeCleanup: live,
        cleanupErrors,
      });
    } catch (error) {
      if (!failure) failure = error;
    }
    if (!failure && cleanupErrors.length)
      failure = new Error(cleanupErrors.join('\n'));
  }
  if (failure) throw failure;
  return fs.readFileSync(path.join(base, id + '.log'), 'utf8');
}
beforeAll(async () => {
  let failure: unknown;
  try {
    assert.ok(
      (process.platform === 'darwin' && process.arch === 'arm64') ||
        (process.platform === 'linux' && process.arch === 'x64'),
      'required host not covered; do not silently skip',
    );
    if (process.platform === 'linux') {
      const report = process.report.getReport() as {
        header?: { glibcVersionRuntime?: string };
      };
      assert.ok(report.header?.glibcVersionRuntime, 'GNU Linux required');
    }
    assert.equal(
      execFileSync(node, ['--version'], {
        encoding: 'utf8',
        timeout: 5_000,
      }).trim(),
      'v26.4.0',
    );
    assert.equal(
      fs.realpathSync(
        path.resolve(
          path.dirname(node),
          '../lib/node_modules/npm/bin/npm-cli.js',
        ),
      ),
      npm,
      'npm belongs to actual Node26 toolchain',
    );
    const home = path.join(base, 'setup-home');
    fs.mkdirSync(home);
    fs.mkdirSync(path.join(base, 'tmp'));
    setupEnv = {
      PATH: path.dirname(node) + ':/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: home,
      TMPDIR: path.join(base, 'tmp'),
      npm_config_cache: path.join(base, 'npm-cache'),
      npm_config_userconfig: inputs.ownedEmptyNpmrc,
      npm_config_globalconfig: inputs.ownedEmptyGlobalNpmrc,
      npm_config_update_notifier: 'false',
      QWEN_USAGE_STATISTICS_ENABLED: 'false',
      QWEN_TELEMETRY_ENABLED: 'false',
    };
    await command(
      'prepare',
      process.execPath,
      [
        path.resolve(
          path.dirname(process.execPath),
          '../lib/node_modules/npm/bin/npm-cli.js',
        ),
        'run',
        'prepare:package',
      ],
      root,
      600,
    );
    preparedMap = inventory(path.join(root, 'dist'));
    save(path.join(base, 'prepared-files.json'), preparedMap);
    const tarballs = path.join(base, 'tarballs');
    fs.mkdirSync(tarballs);
    const packed = await command(
      'pack',
      node,
      [npm, 'pack', '--json', '--pack-destination', tarballs],
      path.join(root, 'dist'),
      300,
    );
    const parsed = JSON.parse(packed);
    assert.equal(parsed.length, 1);
    const metadata = parsed[0] as {
      filename: string;
      unpackedSize: number;
      files: Array<{ path: string; size: number; mode: number }>;
    };
    assert.equal(path.basename(metadata.filename), metadata.filename);
    const tarball = path.join(tarballs, metadata.filename);
    const members = execFileSync('tar', ['-tzf', tarball], {
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
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
    const verbose = execFileSync('tar', ['-tvzf', tarball], {
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    })
      .trim()
      .split('\n');
    assert.ok(
      verbose.every((line) => line.startsWith('-') || line.startsWith('d')),
      'archive contains no symlink, hardlink or device',
    );
    const extracted = path.join(base, 'tar-verification');
    fs.mkdirSync(extracted);
    execFileSync('tar', ['-xzf', tarball, '-C', extracted], {
      timeout: 30_000,
    });
    const tarMap = inventory(path.join(extracted, 'package'));
    assert.deepEqual(
      Object.keys(tarMap).sort(),
      metadata.files.map((file) => file.path).sort(),
    );
    let unpacked = 0;
    for (const file of metadata.files) {
      assert.deepEqual(tarMap[file.path], preparedMap[file.path], file.path);
      assert.equal(tarMap[file.path].bytes, file.size);
      assert.equal(Number(tarMap[file.path].mode), file.mode & 0o777);
      unpacked += file.size;
    }
    assert.equal(unpacked, metadata.unpackedSize);
    assert.ok(unpacked <= 160 * 1024 * 1024);
    assert.deepEqual(
      Object.keys(preparedMap).filter((file) => !(file in tarMap)),
      ['review-sources.sha256'],
    );
    pack = {
      tarball: {
        path: tarball,
        sha256: sha(tarball),
        bytes: fs.statSync(tarball).size,
      },
    };
    save(path.join(base, 'packed-artifact.json'), {
      ...pack,
      metadata,
      unpacked,
    });
    const publishedFiles = path.resolve(base, 'published-files.json');
    save(publishedFiles, tarMap);
    save(path.join(base, 'AUDITED-ARTIFACT.json'), {
      source: initialCheckout,
      tarball: { ...pack.tarball, path: path.resolve(pack.tarball.path) },
      files: { path: publishedFiles, sha256: sha(publishedFiles) },
    });
    const prefix = path.join(base, 'install');
    await command(
      'install',
      node,
      [
        npm,
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--package-lock=false',
        '--prefix',
        prefix,
        tarball,
      ],
      root,
      600,
    );
    const packageRoot = path.join(prefix, 'node_modules/@qwen-code/qwen-code');
    for (const [file, row] of Object.entries(tarMap))
      assert.deepEqual(inventoryEntry(path.join(packageRoot, file)), row, file);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
    );
    hostPackage =
      process.platform === 'darwin'
        ? '@oven/bun-darwin-aarch64'
        : '@oven/bun-linux-x64';
    assert.equal(manifest.optionalDependencies[hostPackage], '1.4.4');
    const privateRoot = path.join(prefix, 'node_modules', hostPackage);
    assert.equal(
      JSON.parse(
        fs.readFileSync(path.join(privateRoot, 'package.json'), 'utf8'),
      ).version,
      '1.4.4',
    );
    bun = path.join(privateRoot, 'bin/bun');
    assert.ok(fs.statSync(bun).mode & 0o111);
    dylib = path.join(
      packageRoot,
      'opentui-assets',
      process.platform === 'darwin'
        ? '@opentui/core-darwin-arm64/libopentui.dylib'
        : '@opentui/core-linux-x64/libopentui.so',
    );
    assert.ok(fs.statSync(dylib).isFile());
    dylib = fs.realpathSync(dylib);
    assert.equal(
      fs.realpathSync(path.join(prefix, 'node_modules/.bin/qwen')),
      fs.realpathSync(path.join(packageRoot, 'cli-entry.js')),
    );
    installedMap = inventory(prefix);
    const mapFile = path.join(base, 'installed-files.json');
    save(mapFile, installedMap);
    receipt = {
      prefix,
      packageRoot,
      privateBun: {
        path: bun,
        sha256: sha(bun),
        mode: `0o${(fs.statSync(bun).mode & 0o777).toString(8)}`,
      },
      installedMap: { path: mapFile, sha256: sha(mapFile) },
    };
    save(inputs.installAcceptance.path, {
      ...receipt,
      checkout: initialCheckout,
      platform: process.platform,
      arch: process.arch,
      inputs,
    });
    guard();
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    save(path.join(base, 'setup-result.json'), {
      outcome: failure ? 'FAIL' : 'PASS',
      error: failure ? String(failure) : undefined,
      checkout: checkout(),
    });
  }
}, 1_560_000);
function guard() {
  assert.deepEqual(checkout(), initialCheckout);
  assert.equal(sha(node), inputs.actualNode26.sha256);
  assert.equal(sha(npm), inputs.actualNpm.sha256);
  assert.deepEqual(inventory(path.join(root, 'dist')), preparedMap);
  assert.deepEqual(inventory(receipt.prefix), installedMap);
  assert.equal(sha(bun), receipt.privateBun.sha256);
}
afterAll(() => {
  if (receipt) guard();
});
it('actual installed Node26 hands strict OpenTUI to private Bun144 and exits naturally', async () => {
  process.env['QWEN_E2E_RENDERER'] = 'opentui';
  guard();
  const out = path.join(base, 'strict-smoke');
  assert.equal(fs.existsSync(out), false, 'never overwrite an attempt');
  const home = path.join(out, 'home');
  const workspace = path.join(out, 'workspace');
  for (const dir of [home, workspace, path.join(out, 'tmp')])
    fs.mkdirSync(dir, { recursive: true });
  const system = path.join(out, 'system-settings.json');
  const defaults = path.join(out, 'system-defaults.json');
  save(system, { $version: 4 });
  save(defaults, { $version: 4 });
  save(path.join(home, 'settings.json'), {
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
  const pidFile = path.join(out, 'pty-root.pid');
  const launcher = path.join(out, 'record-pid.sh');
  fs.writeFileSync(
    launcher,
    '#!/bin/sh\nprintf "%s\\n" "$$" > "$R3_PTY_PID_FILE"\nexec "$@"\n',
    { mode: 0o755 },
  );
  const observer = observe(pidFile);
  const server = await startFakeOpenAIServer(() => ({
    contentChunks: [
      '```javascript\nconst R3_HIGHLIGHT_VALUE = 42;\nconsole.log("R3_PARSER_READY", R3_HIGHLIGHT_VALUE);\n```\nR3_REPLY_DONE',
    ],
  }));
  let session: InteractiveSession | undefined;
  let failure: unknown;
  const facts: Record<string, unknown> = {
    outcome: 'RUNNING',
    tarball: pack.tarball,
    installReceipt: inputs.installAcceptance.path,
    privateBunBinary: receipt.privateBun,
    versionProbe:
      'No Bun version probe; installed optional package version and actual executable hash recorded',
    scope: `${process.platform}/${process.arch} owned local npm install; actual executable/native mapping; no NODE_OPTIONS or preload`,
  };
  try {
    session = await InteractiveSession.start({
      command: {
        bin: '/bin/sh',
        args: [
          launcher,
          node,
          path.join(receipt.packageRoot, 'cli-entry.js'),
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
        ],
      },
      cwd: workspace,
      cols: 100,
      rows: 32,
      inheritEnv: false,
      env: {
        PATH: path.dirname(node) + ':/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: home,
        QWEN_HOME: home,
        QWEN_CODE_SYSTEM_SETTINGS_PATH: system,
        QWEN_CODE_SYSTEM_DEFAULTS_PATH: defaults,
        QWEN_RUNTIME_DIR: path.join(out, 'runtime'),
        TMPDIR: path.join(out, 'tmp'),
        TERM: 'xterm-256color',
        LANG: 'en_US.UTF-8',
        QWEN_CODE_LANG: 'en',
        QWEN_SANDBOX: 'false',
        QWEN_CODE_DISABLE_CRON: '1',
        QWEN_CODE_SKIP_UPDATE_CHECK_ONCE: 'true',
        QWEN_CODE_MODELS_DEV_REFRESH: 'off',
        QWEN_USAGE_STATISTICS_ENABLED: 'false',
        QWEN_TELEMETRY_ENABLED: 'false',
        R3_PTY_PID_FILE: pidFile,
      },
    });
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    assert.ok(Number.isInteger(pid) && pid > 1);
    const rows = descendants(pid).map((entry) => ({
      ...entry,
      descriptors: descriptors(entry),
    }));
    facts.initialProcesses = rows;
    assert.ok(
      rows
        .find((row) => row.pid === pid)
        ?.descriptors.split('\n')
        .includes(`n${fs.realpathSync(node)}`),
      'actual launcher executable is accepted Node26',
    );
    const privateBun = rows.filter((row) =>
      row.descriptors.split('\n').includes(`n${fs.realpathSync(bun)}`),
    );
    assert.ok(
      privateBun.length > 0,
      'private installed Bun executable must actually own a live process',
    );
    assert.ok(
      privateBun.some((row) =>
        row.descriptors.split('\n').includes(`n${dylib}`),
      ),
      'private Bun must load installed OpenTUI native dylib',
    );
    observer.poll();
    await sendAboutUntilRendered(session);
    assert.equal(
      server.requests.length,
      0,
      '/about readiness is local, no model HTTP',
    );
    await session.idle(200, 1500);
    await session.send('R3_DISTRIBUTION_HIGHLIGHT');
    assert.ok(
      await until(async () =>
        (await session!.viewport()).includes('R3_REPLY_DONE'),
      ),
      'visible model response',
    );
    assert.equal(server.requests.length, 1);
    assert.ok(
      await until(async () => {
        await session!.viewport();
        return (await cells(session!))?.highlighted ?? false;
      }),
      'distinct nondefault keyword/number colors',
    );
    facts.codeCells = await cells(session);
    assert.ok(
      await until(
        () =>
          server.requests[0]?.transport.closedAt !== undefined &&
          server.requests[0].transport.writableEndedAtClose === true,
      ),
      'model HTTP response closed normally',
    );
    await session.idle();
    await session.send('/quit');
    assert.ok(
      await until(() => session!.exitResult() !== undefined),
      'natural exit before cleanup',
    );
    facts.naturalExit = session.exitResult();
    assert.equal(session.exitResult()!.exitCode, 0);
    assert.ok(!session.exitResult()!.signal, 'natural exit has no signal');
    assert.equal(server.requests.length, 1);
    observer.poll();
    assert.ok(
      await until(
        () => observer.snapshot().every((row) => !sameProcess(row)),
        3000,
      ),
      'all captured processes gone naturally',
    );
    facts.liveBeforeCleanup = observer.snapshot().filter(sameProcess);
    facts.outcome = 'PASS';
  } catch (error) {
    failure = error;
    facts.error = String(error);
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
    await cleanup('ANSI', () =>
      fs.writeFileSync(
        path.join(out, 'terminal.ansi'),
        session?.output() ?? '',
      ),
    );
    await cleanup('viewport', async () =>
      fs.writeFileSync(
        path.join(out, 'viewport.txt'),
        session ? await session.viewport() : 'STARTUP_NOT_RETURNED',
      ),
    );
    await cleanup('process evidence', () => {
      facts.exitBeforeCleanup = session?.exitResult();
      facts.observerError = observer.stop();
      facts.capturedProcesses = observer.snapshot();
      facts.liveBeforeForcedCleanup = observer.snapshot().filter(sameProcess);
    });
    await cleanup('owned processes', () => observer.cleanup());
    await cleanup('PTY', () => session?.close());
    await cleanup('HTTP evidence', () =>
      save(path.join(out, 'requests.json'), server.requests),
    );
    await cleanup('server', () => server.close());
    await cleanup('final guard', guard);
    await cleanup('captured processes gone', async () =>
      assert.ok(
        await until(
          () => observer.snapshot().every((row) => !sameProcess(row)),
          3000,
        ),
        'captured process survived cleanup',
      ),
    );
    if (facts.observerError) errors.push(String(facts.observerError));
    facts.cleanupErrors = errors;
    if (errors.length && !failure) failure = new Error(errors.join('\n'));
    if (failure) facts.outcome = 'FAIL';
    save(path.join(out, 'result.json'), facts);
  }
  if (failure) throw failure;
}, 120_000);

const conditions = [
  {
    id: 'no-relaunch',
    reason: 'QWEN_CODE_NO_RELAUNCH disables runtime handoff',
  },
  { id: 'missing-bun', reason: 'host optional Bun is missing' },
  {
    id: 'ffi-flag',
    reason: 'inherited runtime flags prevent Bun handoff',
  },
];
for (const condition of conditions)
  for (const strict of [false, true]) {
    const id = `${condition.id}-${strict ? 'strict' : 'fallback'}`;
    it(
      id,
      async () => {
        const reason =
          condition.id === 'missing-bun'
            ? `install the published optional dependency ${hostPackage}`
            : condition.reason;
        process.env['QWEN_E2E_RENDERER'] = 'ink';
        guard();
        const out = path.join(base, 'products', id);
        assert.equal(fs.existsSync(out), false, 'never overwrite an attempt');
        const home = path.join(out, 'home');
        const workspace = path.join(out, 'workspace');
        for (const d of [home, workspace, path.join(out, 'tmp')])
          fs.mkdirSync(d, { recursive: true });
        const system = path.join(out, 'system.json');
        const defaults = path.join(out, 'defaults.json');
        save(system, { $version: 4 });
        save(defaults, { $version: 4 });
        save(path.join(home, 'settings.json'), {
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
        const pidFile = path.join(out, 'pty-root.pid');
        const exitFile = path.join(out, 'product-exit.txt');
        const launcher = path.join(out, 'launch.sh');
        const stderrFile = path.join(out, 'product-stderr.log');
        // Override only the test helper's renderer overlay. Node retains real argv and TTY.
        fs.writeFileSync(
          launcher,
          '#!/bin/sh\nprintf "%s\\n" "$$" > "$R3_PTY_PID_FILE"\nexport QWEN_TUI_RENDERER=opentui\nexport QWEN_TUI_RENDERER_STRICT="$R3_CASE_STRICT"\nif [ "$R3_CASE_STRICT" = 1 ]; then\n  "$@" 2> "$R3_STDERR_FILE"\nelse\n  "$@"\nfi\ncode=$?\nprintf "%s\\n" "$code" > "$R3_EXIT_FILE"\nexit "$code"\n',
          { mode: 0o755 },
        );
        const observer = observe(pidFile);
        const server = await startFakeOpenAIServer(() => ({
          contentChunks: ['UNEXPECTED_MODEL_REQUEST'],
        }));
        const parked = bun + '.r3-refusal-' + id;
        const privateBunExecutable = fs.realpathSync(bun);
        let renamed = false;
        let session: InteractiveSession | undefined;
        let failure: unknown;
        const facts: Record<string, unknown> = {
          id,
          outcome: 'RUNNING',
          installedArtifactSource: `${process.platform}/${process.arch} same fresh tarball owned installation`,
          installReceipt: inputs.installAcceptance.path,
          tarball: pack.tarball,
          expectedReason: strict ? reason : undefined,
          processEvidenceScope:
            'captured PID/start identities only; absence of a captured child is not proof no spawn occurred',
        };
        try {
          if (condition.id === 'missing-bun') {
            assert.equal(fs.existsSync(parked), false);
            fs.renameSync(bun, parked);
            renamed = true;
            assert.equal(fs.existsSync(bun), false);
            assert.equal(sha(parked), receipt.privateBun.sha256);
          }
          const args = [
            launcher,
            node,
            ...(condition.id === 'ffi-flag' ? ['--experimental-ffi'] : []),
            path.join(receipt.packageRoot, 'cli-entry.js'),
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
          ];
          facts.actualArgv = ['/bin/sh', ...args];
          let startupError: unknown;
          try {
            session = await InteractiveSession.start({
              command: { bin: '/bin/sh', args },
              cwd: workspace,
              cols: 100,
              rows: 32,
              inheritEnv: false,
              env: {
                PATH: path.dirname(node) + ':/usr/bin:/bin:/usr/sbin:/sbin',
                HOME: home,
                QWEN_HOME: home,
                QWEN_CODE_SYSTEM_SETTINGS_PATH: system,
                QWEN_CODE_SYSTEM_DEFAULTS_PATH: defaults,
                QWEN_RUNTIME_DIR: path.join(out, 'runtime'),
                TMPDIR: path.join(out, 'tmp'),
                TERM: 'xterm-256color',
                LANG: 'en_US.UTF-8',
                QWEN_CODE_LANG: 'en',
                QWEN_SANDBOX: 'false',
                QWEN_CODE_DISABLE_CRON: '1',
                QWEN_CODE_SKIP_UPDATE_CHECK_ONCE: 'true',
                QWEN_CODE_MODELS_DEV_REFRESH: 'off',
                QWEN_USAGE_STATISTICS_ENABLED: 'false',
                QWEN_TELEMETRY_ENABLED: 'false',
                R3_PTY_PID_FILE: pidFile,
                R3_EXIT_FILE: exitFile,
                R3_STDERR_FILE: stderrFile,
                R3_CASE_STRICT: strict ? '1' : '0',
                ...(condition.id === 'no-relaunch'
                  ? { QWEN_CODE_NO_RELAUNCH: '1' }
                  : {}),
              },
            });
          } catch (error) {
            startupError = error;
          }
          facts.startupError = startupError ? String(startupError) : undefined;
          observer.poll();
          if (strict) {
            assert.equal(session, undefined, 'strict must refuse startup');
            assert.ok(startupError, 'strict must throw');
            const stderr = fs.readFileSync(stderrFile, 'utf8');
            facts.productStderr = stderr;
            assert.ok(
              stderr.includes('OpenTUI npm Bun handoff unavailable: ' + reason),
              stderr,
            );
            assert.ok(
              fs.existsSync(exitFile),
              'shell records actual product exit before helper cleanup',
            );
            const code = Number(fs.readFileSync(exitFile, 'utf8').trim());
            assert.ok(Number.isInteger(code) && code !== 0);
            facts.productExitCode = code;
          } else {
            if (startupError) throw startupError;
            assert.ok(session);
            const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
            const rows = descendants(pid).map((row) => ({
              ...row,
              descriptors: descriptors(row),
            }));
            facts.readyProcesses = rows;
            assert.ok(
              rows.some((row) =>
                row.descriptors
                  .split('\n')
                  .includes(`n${fs.realpathSync(node)}`),
              ),
              'actual accepted Node26 owns fallback process',
            );
            await sendAboutUntilRendered(session);
            assert.equal(server.requests.length, 0);
            facts.aboutViewport = await session.viewport();
            const readyRows = descendants(pid).map((row) => ({
              ...row,
              descriptors: descriptors(row),
            }));
            facts.afterAboutProcesses = readyRows;
            assert.ok(
              readyRows.some((row) =>
                row.descriptors
                  .split('\n')
                  .includes(`n${fs.realpathSync(node)}`),
              ),
              'original Node remains live at fallback readiness',
            );
            assert.ok(
              readyRows.every(
                (row) =>
                  !row.descriptors
                    .split('\n')
                    .includes(`n${privateBunExecutable}`) &&
                  !row.descriptors.split('\n').includes(`n${dylib}`),
              ),
              'fallback readiness has neither installed Bun nor OpenTUI native mapping',
            );
            await session.idle();
            await session.send('/quit');
            assert.ok(
              await until(() => session!.exitResult() !== undefined),
              'natural quit before cleanup',
            );
            assert.equal(session.exitResult()!.exitCode, 0);
            assert.ok(!session.exitResult()!.signal);
            facts.naturalExit = session.exitResult();
          }
          assert.equal(server.requests.length, 0);
          observer.poll();
          assert.ok(
            await until(
              () => observer.snapshot().every((row) => !sameProcess(row)),
              3000,
            ),
          );
          facts.outcome = 'PASS';
        } catch (error) {
          failure = error;
          facts.error = String(error);
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
          await cleanup('ANSI', () =>
            fs.writeFileSync(
              path.join(out, 'terminal.ansi'),
              session?.output() ??
                String(facts.startupError ?? 'STARTUP_NOT_RETURNED'),
            ),
          );
          await cleanup('process evidence', () => {
            facts.exitBeforeCleanup = session?.exitResult();
            facts.observerError = observer.stop();
            facts.capturedProcesses = observer.snapshot();
            facts.liveBeforeForcedCleanup = observer
              .snapshot()
              .filter(sameProcess);
          });
          await cleanup('owned processes', () => observer.cleanup());
          await cleanup('PTY', () => session?.close());
          await cleanup('HTTP evidence', () =>
            save(path.join(out, 'requests.json'), server.requests),
          );
          await cleanup('server', () => server.close());
          await cleanup('restore owned Bun', () => {
            if (renamed) {
              assert.equal(fs.existsSync(bun), false);
              fs.renameSync(parked, bun);
              renamed = false;
            }
          });
          await cleanup('final artifact guard', guard);
          if (server.requests.length) errors.push('unexpected model HTTP');
          if (facts.observerError) errors.push(String(facts.observerError));
          facts.cleanupErrors = errors;
          if (errors.length && !failure) failure = new Error(errors.join('\n'));
          if (failure) facts.outcome = 'FAIL';
          save(path.join(out, 'result.json'), facts);
        }
        if (failure) throw failure;
      },
      120_000,
    );
  }

it('actual installed npm registry subprocess retains original Node26 identity', async () => {
  process.env['QWEN_E2E_RENDERER'] = 'opentui';
  guard();
  const out = path.join(base, 'npm-node-identity');
  assert.equal(fs.existsSync(out), false, 'never overwrite an attempt');
  const home = path.join(out, 'home');
  const workspace = path.join(out, 'workspace');
  for (const dir of [home, workspace, path.join(out, 'tmp')])
    fs.mkdirSync(dir, { recursive: true });
  const system = path.join(out, 'system-settings.json');
  const defaults = path.join(out, 'system-defaults.json');
  save(system, { $version: 4 });
  save(defaults, { $version: 4 });
  save(path.join(home, 'settings.json'), {
    $version: 4,
    experimental: { mods: false },
    security: {
      auth: { selectedType: 'openai' },
      folderTrust: { enabled: false },
    },
    general: { enableAutoUpdate: true, showSessionRecap: false },
    ui: { enableFollowupSuggestions: false },
    memory: E2E_MEMORY_SETTINGS_DEFAULTS,
  });
  const pidFile = path.join(out, 'pty-root.pid');
  const launcher = path.join(out, 'record-pid.sh');
  fs.writeFileSync(
    launcher,
    '#!/bin/sh\nprintf "%s\\n" "$$" > "$R3_PTY_PID_FILE"\nexec "$@"\n',
    { mode: 0o755 },
  );
  const observer = observe(pidFile);
  const server = await startFakeOpenAIServer(() => ({
    contentChunks: [
      '```javascript\nconst R3_HIGHLIGHT_VALUE = 42;\nconsole.log("R3_PARSER_READY", R3_HIGHLIGHT_VALUE);\n```\nR3_REPLY_DONE',
    ],
  }));
  let session: InteractiveSession | undefined;
  let failure: unknown;
  let registry: ReturnType<typeof createServer> | undefined;
  const npmLog = path.join(out, 'actual-npm-processes.jsonl');
  const npmExitLog = path.join(out, 'npm-exits.jsonl');
  const registryRequests: string[] = [];
  const observedNode = path.join(out, 'observed-node/bin/node');
  const npmEntry = path.join(
    out,
    'observed-node/lib/node_modules/npm/bin/npm-cli.js',
  );
  let registryBase = '';
  const installedVersion = JSON.parse(
    fs.readFileSync(path.join(receipt.packageRoot, 'package.json'), 'utf8'),
  ).version as string;
  const facts: Record<string, unknown> = {
    outcome: 'RUNNING',
    tarball: pack.tarball,
    installReceipt: inputs.installAcceptance.path,
    privateBunBinary: receipt.privateBun,
    versionProbe:
      'No Bun version probe; installed optional package version and actual executable hash recorded',
    scope: `${process.platform}/${process.arch} owned local npm install; actual executable/native mapping; no NODE_OPTIONS or preload`,
  };
  try {
    // Exact core11 identity branch: real Node bytes and logging delegation to unchanged real npm.
    fs.mkdirSync(path.dirname(observedNode), { recursive: true });
    fs.mkdirSync(path.dirname(npmEntry), { recursive: true });
    fs.copyFileSync(node, observedNode, fs.constants.COPYFILE_FICLONE);
    assert.equal(sha(observedNode), inputs.actualNode26.sha256);
    assert.equal(
      fs.statSync(observedNode).mode & 0o777,
      Number(inputs.actualNode26.mode),
    );
    fs.writeFileSync(
      npmEntry,
      `const fs=require('node:fs');process.once('exit',code=>fs.appendFileSync(${JSON.stringify(npmExitLog)},JSON.stringify({pid:process.pid,execPath:process.execPath,bun:process.versions.bun??null,code})+'\\n'));fs.appendFileSync(${JSON.stringify(npmLog)},JSON.stringify({pid:process.pid,execPath:process.execPath,bun:process.versions.bun??null,argv:process.argv,context:process.env.QWEN_CODE_NPM_RUNTIME_CONTEXT??null})+'\\n');require(${JSON.stringify(inputs.actualNpm.path)});\n`,
    );
    fs.symlinkSync(npmEntry, path.join(out, 'observed-node/bin/npm'));
    registry = createServer((request, response) => {
      registryRequests.push(request.url ?? '');
      const requested = decodeURIComponent(
        new URL(request.url ?? '/', 'http://127.0.0.1').pathname,
      );
      if (request.method !== 'GET' || requested !== '/@qwen-code/qwen-code') {
        response.writeHead(404);
        response.end();
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          name: '@qwen-code/qwen-code',
          'dist-tags': { latest: installedVersion, nightly: installedVersion },
          versions: {
            [installedVersion]: {
              name: '@qwen-code/qwen-code',
              version: installedVersion,
            },
          },
        }),
      );
    });
    await new Promise<void>((done) => registry!.listen(0, '127.0.0.1', done));
    const address = registry.address();
    assert.ok(address && typeof address !== 'string');
    registryBase = `http://127.0.0.1:${address.port}/`;
    facts.identityObserver = {
      node: observedNode,
      nodeSha256: sha(observedNode),
      originalNpm: inputs.actualNpm.path,
      syntheticRegistry: true,
      realNpmDelegation: true,
      installationScope:
        'same current owned local-prefix install; not historical global-layout acceptance',
    };
    session = await InteractiveSession.start({
      command: {
        bin: '/bin/sh',
        args: [
          launcher,
          observedNode,
          path.join(receipt.packageRoot, 'cli-entry.js'),
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
        ],
      },
      cwd: workspace,
      cols: 100,
      rows: 32,
      inheritEnv: false,
      env: {
        PATH:
          path.dirname(observedNode) +
          ':' +
          path.dirname(node) +
          ':/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: home,
        QWEN_HOME: home,
        QWEN_CODE_SYSTEM_SETTINGS_PATH: system,
        QWEN_CODE_SYSTEM_DEFAULTS_PATH: defaults,
        QWEN_RUNTIME_DIR: path.join(out, 'runtime'),
        TMPDIR: path.join(out, 'tmp'),
        TERM: 'xterm-256color',
        LANG: 'en_US.UTF-8',
        QWEN_CODE_LANG: 'en',
        QWEN_SANDBOX: 'false',
        QWEN_CODE_DISABLE_CRON: '1',
        QWEN_CODE_MODELS_DEV_REFRESH: 'off',
        npm_config_registry: registryBase,
        npm_config_cache: path.join(out, 'npm-cache'),
        npm_config_userconfig: inputs.ownedEmptyNpmrc,
        npm_config_globalconfig: inputs.ownedEmptyGlobalNpmrc,
        npm_config_update_notifier: 'false',
        QWEN_USAGE_STATISTICS_ENABLED: 'false',
        QWEN_TELEMETRY_ENABLED: 'false',
        R3_PTY_PID_FILE: pidFile,
      },
    });
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    assert.ok(Number.isInteger(pid) && pid > 1);
    const rows = descendants(pid).map((entry) => ({
      ...entry,
      descriptors: descriptors(entry),
    }));
    facts.initialProcesses = rows;
    assert.ok(
      rows
        .find((row) => row.pid === pid)
        ?.descriptors.split('\n')
        .includes(`n${fs.realpathSync(observedNode)}`),
      'actual launcher executable is accepted same-byte Node26 copy',
    );
    const privateBun = rows.filter((row) =>
      row.descriptors.split('\n').includes(`n${fs.realpathSync(bun)}`),
    );
    assert.ok(
      privateBun.length > 0,
      'private installed Bun executable must actually own a live process',
    );
    assert.ok(
      privateBun.some((row) =>
        row.descriptors.split('\n').includes(`n${dylib}`),
      ),
      'private Bun must load installed OpenTUI native dylib',
    );
    observer.poll();
    const expectedChecks = installedVersion.includes('nightly') ? 2 : 1;
    assert.ok(
      await until(
        () =>
          fs.existsSync(npmLog) && registryRequests.length >= expectedChecks,
      ),
      'actual npm registry subprocesses must run',
    );
    const invocations = fs
      .readFileSync(npmLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    facts.npmInvocations = invocations;
    facts.registryRequests = registryRequests;
    assert.ok(invocations.length >= expectedChecks);
    for (const invocation of invocations) {
      assert.equal(
        fs.realpathSync(invocation.execPath),
        fs.realpathSync(observedNode),
      );
      assert.equal(invocation.bun, null);
      assert.ok(invocation.argv.includes('view'));
      assert.equal(
        JSON.parse(invocation.context).node,
        fs.realpathSync(observedNode),
      );
    }
    assert.ok(
      await until(() => {
        if (!fs.existsSync(npmExitLog)) return false;
        const starts = fs
          .readFileSync(npmLog, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        const exits = fs
          .readFileSync(npmExitLog, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        return (
          starts.length >= expectedChecks &&
          exits.length === starts.length &&
          starts.every(
            (entry) =>
              exits.filter((exit) => exit.pid === entry.pid).length === 1,
          )
        );
      }),
      'all observed npm registry subprocesses complete before foreground verification',
    );
    const finalInvocations = fs
      .readFileSync(npmLog, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const npmExits = fs
      .readFileSync(npmExitLog, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    facts.npmInvocations = finalInvocations;
    facts.npmExits = npmExits;
    assert.ok(finalInvocations.length >= expectedChecks);
    assert.equal(
      new Set(finalInvocations.map((entry) => entry.pid)).size,
      finalInvocations.length,
      'one start per npm PID',
    );
    assert.equal(
      new Set(npmExits.map((entry) => entry.pid)).size,
      npmExits.length,
      'one exit per npm PID',
    );
    assert.deepEqual(
      finalInvocations.map((entry) => entry.pid).sort(),
      npmExits.map((entry) => entry.pid).sort(),
      'bidirectional complete npm PID matching',
    );
    for (const invocation of finalInvocations) {
      assert.equal(
        fs.realpathSync(invocation.execPath),
        fs.realpathSync(observedNode),
      );
      assert.equal(invocation.bun, null);
      assert.ok(invocation.argv.includes('view'));
      assert.equal(
        JSON.parse(invocation.context).node,
        fs.realpathSync(observedNode),
      );
    }
    for (const entry of npmExits) {
      assert.equal(
        fs.realpathSync(entry.execPath),
        fs.realpathSync(observedNode),
      );
      assert.equal(entry.bun, null);
      assert.equal(entry.code, 0, 'real npm query exits successfully');
    }
    const afterNpm = descendants(pid).map((entry) => ({
      ...entry,
      descriptors: descriptors(entry),
    }));
    facts.processesAfterNpm = afterNpm;
    assert.ok(
      afterNpm.some(
        (entry) =>
          entry.descriptors.split('\n').includes(`n${fs.realpathSync(bun)}`) &&
          entry.descriptors.split('\n').includes(`n${dylib}`),
      ),
      'same installation private Bun/native remains foreground after npm query',
    );
    await sendAboutUntilRendered(session);
    assert.equal(
      server.requests.length,
      0,
      '/about readiness is local, no model HTTP',
    );
    await session.idle(200, 1500);
    await session.send('R3_DISTRIBUTION_HIGHLIGHT');
    assert.ok(
      await until(async () =>
        (await session!.viewport()).includes('R3_REPLY_DONE'),
      ),
      'visible model response',
    );
    assert.equal(server.requests.length, 1);
    assert.ok(
      await until(async () => {
        await session!.viewport();
        return (await cells(session!))?.highlighted ?? false;
      }),
      'distinct nondefault keyword/number colors',
    );
    facts.codeCells = await cells(session);
    assert.ok(
      await until(
        () =>
          server.requests[0]?.transport.closedAt !== undefined &&
          server.requests[0].transport.writableEndedAtClose === true,
      ),
      'model HTTP response closed normally',
    );
    await session.idle();
    await session.send('/quit');
    assert.ok(
      await until(() => session!.exitResult() !== undefined),
      'natural exit before cleanup',
    );
    facts.naturalExit = session.exitResult();
    assert.equal(session.exitResult()!.exitCode, 0);
    assert.ok(!session.exitResult()!.signal, 'natural exit has no signal');
    assert.equal(server.requests.length, 1);
    observer.poll();
    assert.ok(
      await until(
        () => observer.snapshot().every((row) => !sameProcess(row)),
        3000,
      ),
      'all captured processes gone naturally',
    );
    facts.liveBeforeCleanup = observer.snapshot().filter(sameProcess);
    facts.outcome = 'PASS';
  } catch (error) {
    failure = error;
    facts.error = String(error);
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
    await cleanup('ANSI', () =>
      fs.writeFileSync(
        path.join(out, 'terminal.ansi'),
        session?.output() ?? '',
      ),
    );
    await cleanup('viewport', async () =>
      fs.writeFileSync(
        path.join(out, 'viewport.txt'),
        session ? await session.viewport() : 'STARTUP_NOT_RETURNED',
      ),
    );
    await cleanup('process evidence', () => {
      facts.exitBeforeCleanup = session?.exitResult();
      facts.observerError = observer.stop();
      facts.capturedProcesses = observer.snapshot();
      facts.liveBeforeForcedCleanup = observer.snapshot().filter(sameProcess);
    });
    await cleanup('owned processes', () => observer.cleanup());
    await cleanup('PTY', () => session?.close());
    await cleanup('HTTP evidence', () =>
      save(path.join(out, 'requests.json'), server.requests),
    );
    await cleanup('server', () => server.close());
    await cleanup('registry evidence', () =>
      save(path.join(out, 'registry-requests.json'), registryRequests),
    );
    await cleanup('registry', async () => {
      registry?.closeAllConnections();
      await new Promise<void>((done, reject) =>
        registry
          ? registry.close((error) => (error ? reject(error) : done()))
          : done(),
      );
    });
    await cleanup('observed Node identity', () =>
      assert.equal(sha(observedNode), inputs.actualNode26.sha256),
    );
    await cleanup('final guard', guard);
    await cleanup('captured processes gone', async () =>
      assert.ok(
        await until(
          () => observer.snapshot().every((row) => !sameProcess(row)),
          3000,
        ),
        'captured process survived cleanup',
      ),
    );
    if (facts.observerError) errors.push(String(facts.observerError));
    facts.cleanupErrors = errors;
    if (errors.length && !failure) failure = new Error(errors.join('\n'));
    if (failure) facts.outcome = 'FAIL';
    save(path.join(out, 'result.json'), facts);
  }
  if (failure) throw failure;
}, 120_000);

it('actual installed private Bun cold-reads Node legacy secrets with correct, absent and wrong USER', async () => {
  guard();
  const out = path.join(base, 'legacy-secret');
  assert.equal(fs.existsSync(out), false, 'never overwrite an attempt');
  const home = path.join(out, 'home');
  const workspace = path.join(out, 'workspace');
  const tmp = path.join(out, 'tmp');
  for (const directory of [home, workspace, tmp])
    fs.mkdirSync(directory, { recursive: true });
  const system = path.join(out, 'system.json');
  const defaults = path.join(out, 'defaults.json');
  save(system, { $version: 4 });
  save(defaults, { $version: 4 });
  const name = 'owned-legacy-secret';
  const secret = 'OWNED_NODE_LEGACY_SECRET_019';
  const writer = path.join(out, 'node-legacy-writer.mjs');
  fs.writeFileSync(
    writer,
    `
import { createCipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const [home, name] = process.argv.slice(2);
const secret = 'OWNED_NODE_LEGACY_SECRET_019';
const dir = path.join(home, 'extensions', name);
fs.mkdirSync(dir, { recursive: true });
const envVar = 'OWNED_LEGACY_SECRET';
const id = createHash('sha256').update(name).digest('hex');
const bundleKey = '$qwen:extension-settings:v2:11111111-1111-4111-8111-111111111111';
fs.writeFileSync(path.join(dir, 'qwen-extension.json'), JSON.stringify({ name, version: '1.0.0', settings: [{ name: 'Owned legacy secret', description: 'Test-only existing Node encrypted data', envVar, sensitive: true }] }));
fs.writeFileSync(path.join(dir, '.env'), '');
fs.writeFileSync(path.join(dir, '.qwen-extension-settings.json'), JSON.stringify({ version: 1, backend: 'encrypted_file', bundleKey }), { mode: 0o600 });
const username = os.userInfo().username;
const key = scryptSync('qwen-code-oauth', os.hostname() + '-' + username + '-qwen-code', 32);
const iv = randomBytes(16);
const cipher = createCipheriv('aes-256-gcm', key, iv);
const plaintext = JSON.stringify({ ['Qwen Code Extensions ' + name + ' ' + id]: { [envVar]: secret, [bundleKey]: JSON.stringify({ [envVar]: secret }) } });
const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
fs.writeFileSync(path.join(home, 'extension-secrets-v1.json'), [iv.toString('hex'), cipher.getAuthTag().toString('hex'), encrypted.toString('hex')].join(':'), { mode: 0o600 });
console.log(JSON.stringify({ username, node: process.versions.node, id }));
`,
  );
  let failure: unknown;
  let server: Awaited<ReturnType<typeof startFakeOpenAIServer>> | undefined;
  const facts: Record<string, unknown> = { outcome: 'RUNNING', rows: [] };
  try {
    const seeded = JSON.parse(
      await command(
        'legacy-secret-writer',
        node,
        [writer, home, name],
        workspace,
        15,
      ),
    ) as { username: string; node: string; id: string };
    assert.equal(seeded.node, '26.4.0');
    assert.equal(seeded.id, createHash('sha256').update(name).digest('hex'));
    assert.ok(seeded.username && seeded.username !== 'unknown');
    facts.nodeWriter = seeded;
    const immutable = [
      path.join(home, 'extension-secrets-v1.json'),
      path.join(home, 'extensions', name, '.qwen-extension-settings.json'),
      path.join(home, 'extensions', name, 'qwen-extension.json'),
      path.join(home, 'extensions', name, '.env'),
    ];
    const before = immutable.map((file) => ({
      path: file,
      ...inventoryEntry(file),
    }));
    assert.equal(before[0].mode, '0o600');
    assert.equal(before[1].mode, '0o600');
    save(path.join(out, 'before.json'), before);
    server = await startFakeOpenAIServer(() => ({
      content: 'UNEXPECTED_SECRET_MODEL_HTTP',
    }));
    for (const mode of ['correct', 'missing', 'wrong'] as const) {
      const env: NodeJS.ProcessEnv = {
        ...setupEnv,
        HOME: home,
        USERPROFILE: home,
        QWEN_HOME: home,
        TMPDIR: tmp,
        TMP: tmp,
        TEMP: tmp,
        QWEN_RUNTIME_DIR: path.join(out, 'runtime'),
        QWEN_CODE_FORCE_FILE_STORAGE: 'true',
        QWEN_CODE_SYSTEM_SETTINGS_PATH: system,
        QWEN_CODE_SYSTEM_DEFAULTS_PATH: defaults,
        QWEN_CODE_LANG: 'en',
        QWEN_CODE_MODELS_DEV_REFRESH: 'off',
        QWEN_CODE_SKIP_UPDATE_CHECK_ONCE: 'true',
        OPENAI_API_KEY: 'owned-test-only',
        OPENAI_BASE_URL: server.baseUrl,
      };
      if (mode === 'missing') delete env['USER'];
      else
        env['USER'] =
          mode === 'correct'
            ? seeded.username
            : seeded.username + '-owned-wrong';
      const id = 'legacy-secret-' + mode;
      const stdout = await command(
        id,
        bun,
        [
          path.join(receipt.packageRoot, 'cli-entry.js'),
          'extensions',
          'settings',
          'list',
          name,
        ],
        workspace,
        15,
        env,
      );
      assert.ok(stdout.includes('Settings for "owned-legacy-secret":'));
      assert.ok(stdout.includes('Owned legacy secret (OWNED_LEGACY_SECRET)'));
      assert.ok(stdout.includes('Value: [value stored in keychain] (user)'));
      assert.ok(!stdout.includes('[not set]'));
      assert.ok(!stdout.includes(secret));
      const completed = JSON.parse(
        fs.readFileSync(path.join(base, id + '.json'), 'utf8'),
      );
      assert.equal(completed.bin, bun);
      assert.equal(completed.code, 0);
      assert.equal(completed.signal, null);
      assert.equal(completed.timedOut, false);
      assert.deepEqual(completed.liveBeforeCleanup, []);
      assert.deepEqual(completed.cleanupErrors, []);
      assert.ok(completed.rootProcess);
      assert.equal(completed.rootProcess.pid, completed.rootPid);
      assert.ok(completed.rootProcess.birth);
      assert.ok(!completed.rootProcess.state.startsWith('Z'));
      assert.ok(
        completed.rootProcess.command.includes(
          path.join(receipt.packageRoot, 'cli-entry.js'),
        ),
      );
      assert.ok(
        completed.captured.some(
          (row: { pid: number; birth: string }) =>
            row.pid === completed.rootProcess.pid &&
            row.birth === completed.rootProcess.birth,
        ),
      );
      assert.deepEqual(
        immutable.map((file) => ({ path: file, ...inventoryEntry(file) })),
        before,
      );
      assert.equal(server.requests.length, 0);
      guard();
      (facts.rows as unknown[]).push({
        mode,
        USER: env['USER'] ?? null,
        commandReceipt: id + '.json',
      });
    }
    facts.outcome = 'PASS';
  } catch (error) {
    failure = error;
    facts.outcome = 'FAIL';
    facts.error = String(error);
  } finally {
    const errors: string[] = [];
    try {
      save(path.join(out, 'requests.json'), server?.requests ?? []);
    } catch (error) {
      errors.push(String(error));
    }
    try {
      await server?.close();
    } catch (error) {
      errors.push(String(error));
    }
    try {
      guard();
    } catch (error) {
      errors.push(String(error));
    }
    facts.cleanupErrors = errors;
    if (errors.length) {
      facts.outcome = 'FAIL';
      failure ??= new Error(errors.join('\n'));
    }
    save(path.join(out, 'result.json'), facts);
  }
  if (failure) throw failure;
}, 120_000);
