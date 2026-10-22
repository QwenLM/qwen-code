/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const sha = (file) =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const save = (file, value) => {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
  fs.renameSync(`${file}.tmp`, file);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const versions = {
  node22: null,
  'bun1.3.14':
    '0a0620930b6675d7ba440e81f4e0e00d3cfbe096c4b140d3fff02205e9e18922',
  'bun1.4.3':
    '0bf84e808552beea67bf1202a287a35c6c825d837b287b3f8e9dd513dba35d3d',
};
const packages = {
  'node-pty':
    'Fv+A3+MZVA8qhkBIZsM1E6dCdHNMyXXz22mAYiMWd03LlyK///F3OH6CKPX9mj4id7LUlxpr45yPzyBVy9aDPw==',
  'node-pty-win32-x64':
    'ExFgWrzyldNAMi45U9PLIOu+g/RatP+f0c/dZxaooifME6yLW32BoHveH26/TtoAjZyJrc2iL0u48pgnR1fzmg==',
};

function processes(ids, timeout = 5000) {
  assert.ok(
    ids.length > 0 && ids.every((id) => Number.isInteger(id) && id > 0),
  );
  const filter = [...new Set(ids)]
    .map((id) => `ProcessId=${id} OR ParentProcessId=${id}`)
    .join(' OR ');
  const command = `Get-CimInstance Win32_Process -Filter '${filter}' | Where-Object { $_.CreationDate } | ForEach-Object { [pscustomobject]@{ pid=$_.ProcessId; ppid=$_.ParentProcessId; start=$_.CreationDate.ToUniversalTime().ToString('O'); command=$_.CommandLine } } | ConvertTo-Json -Compress`;
  const output = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', command],
    { encoding: 'utf8', timeout },
  );
  return output.trim() ? [].concat(JSON.parse(output.trim())) : [];
}

async function controller(runtime) {
  assert.equal(process.platform, 'win32');
  assert.equal(process.arch, 'x64');
  assert.equal(process.version, 'v22.23.2');
  assert.ok(Object.hasOwn(versions, runtime));
  const out = path.resolve('.qwen/e2e-tests/windows-pty-probe', runtime);
  assert.equal(fs.existsSync(out), false, 'never replace an earlier attempt');
  fs.mkdirSync(out, { recursive: true });
  const owned = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-conpty-'));
  const nonce = randomUUID().replaceAll('-', '').slice(0, 16);
  const facts = {
    status: 'RUNNING',
    runtime,
    nonce,
    phase: 'prepare',
    sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim(),
    sourceTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
      encoding: 'utf8',
    }).trim(),
    driverSha256: sha(self),
    archives: [],
    processes: [],
    cleanupErrors: [],
  };
  let child,
    ended = false,
    exit,
    stdout = '',
    stderr = '';
  const captured = new Map();
  const sample = () => {
    const before = path.join(out, 'worker-before.json');
    if (fs.existsSync(before)) {
      const identity = JSON.parse(
        fs.readFileSync(before, 'utf8'),
      ).processIdentity;
      if (identity)
        captured.set(identity.pid, captured.get(identity.pid) ?? identity);
    }
    const queried = new Set([...captured.keys(), child.pid]);
    const rows = processes([...queried]);
    const ids = new Set(
      rows
        .filter(
          (row) =>
            captured.get(row.pid)?.start === row.start ||
            row.command?.includes(owned),
        )
        .map((row) => row.pid),
    );
    for (;;) {
      for (const row of rows) if (ids.has(row.ppid)) ids.add(row.pid);
      const parents = [...ids].filter((pid) => !queried.has(pid));
      if (!parents.length) break;
      parents.forEach((pid) => queried.add(pid));
      for (const row of processes(parents)) {
        const index = rows.findIndex((seen) => seen.pid === row.pid);
        if (index < 0) rows.push(row);
        else rows[index] = row;
      }
    }
    for (const row of rows) if (ids.has(row.pid)) captured.set(row.pid, row);
    return rows.filter((row) => captured.get(row.pid)?.start === row.start);
  };
  const download = async (url, file, algorithm, expected, encoding) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    assert.ok(response.ok, `download ${response.status}: ${url}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = createHash(algorithm).update(bytes).digest(encoding);
    assert.equal(digest, expected, url);
    fs.writeFileSync(file, bytes);
    facts.archives.push({
      url,
      algorithm,
      expected,
      actual: digest,
      bytes: bytes.length,
    });
  };
  try {
    const lock = fs.readFileSync('pnpm-lock.yaml', 'utf8');
    facts.lockSha256 = sha('pnpm-lock.yaml');
    for (const [name, integrity] of Object.entries(packages)) {
      assert.ok(
        lock.includes(
          `'@lydell/${name}@1.2.0-beta.10':\n    resolution: {integrity: sha512-${integrity}}`,
        ),
      );
      const archive = path.join(owned, `${name}.tgz`);
      await download(
        `https://registry.npmjs.org/@lydell/${name}/-/${name}-1.2.0-beta.10.tgz`,
        archive,
        'sha512',
        integrity,
        'base64',
      );
      const target = path.join(owned, 'node_modules', '@lydell', name);
      fs.mkdirSync(target, { recursive: true });
      execFileSync(
        'tar',
        ['-xzf', archive, '-C', target, '--strip-components=1'],
        { timeout: 30_000 },
      );
    }
    let executable = process.execPath;
    if (runtime !== 'node22') {
      const archive = path.join(owned, 'bun-windows-x64.zip');
      execFileSync(
        'gh',
        [
          'release',
          'download',
          `bun-v${runtime.slice(3)}`,
          '--repo',
          'oven-sh/bun',
          '--pattern',
          'bun-windows-x64.zip',
          '--dir',
          owned,
        ],
        { timeout: 30_000 },
      );
      const digest = sha(archive);
      assert.equal(digest, versions[runtime]);
      facts.archives.push({
        url: `https://github.com/oven-sh/bun/releases/download/bun-v${runtime.slice(3)}/bun-windows-x64.zip`,
        algorithm: 'sha256',
        expected: versions[runtime],
        actual: digest,
        bytes: fs.statSync(archive).size,
      });
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Expand-Archive -LiteralPath $env:PROBE_ARCHIVE -DestinationPath $env:PROBE_RUNTIME',
        ],
        {
          env: { ...process.env, PROBE_ARCHIVE: archive, PROBE_RUNTIME: owned },
          timeout: 30_000,
        },
      );
      executable = path.join(owned, 'bun-windows-x64', 'bun.exe');
    }
    facts.executable = {
      path: executable,
      sha256: sha(executable),
      version: execFileSync(executable, ['--version'], {
        encoding: 'utf8',
        timeout: 5000,
      }).trim(),
    };
    facts.phase = 'process-sampler-warmup';
    facts.processSamplerWarmupBudgetMs = 15_000;
    const warmupStartedAt = performance.now();
    try {
      facts.processSamplerWarmup = processes(
        [process.pid],
        facts.processSamplerWarmupBudgetMs,
      ).find((row) => row.pid === process.pid);
    } finally {
      facts.processSamplerWarmupElapsedMs = performance.now() - warmupStartedAt;
    }
    assert.ok(
      facts.processSamplerWarmup,
      'controller PID/start warmup required',
    );
    facts.phase = 'worker';
    child = spawn(
      executable,
      [self, '--worker', runtime, owned, out, process.execPath, nonce],
      {
        env: { ...process.env, HOME: owned, USERPROFILE: owned },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    child.on('error', (error) => {
      facts.spawnError = error.stack;
      ended = true;
    });
    child.on('close', (code, signal) => {
      exit = { code, signal };
      ended = true;
    });
    const deadline = Date.now() + 45_000;
    do {
      sample();
      if (ended) break;
      await sleep(500);
    } while (Date.now() < deadline);
    assert.ok(ended, 'worker exceeded original 45 second budget');
    assert.deepEqual(exit, { code: 0, signal: null });
    const result = JSON.parse(
      fs.readFileSync(path.join(out, 'worker.json'), 'utf8'),
    );
    assert.equal(result.status, 'PASS');
    facts.worker = result;
    facts.status = 'PASS';
  } catch (error) {
    facts.status = 'FAIL';
    facts.error = error.stack;
  } finally {
    fs.writeFileSync(path.join(out, 'worker-stdout.txt'), stdout);
    fs.writeFileSync(path.join(out, 'worker-stderr.txt'), stderr);
    if (child?.pid) {
      try {
        const remaining = sample();
        facts.liveBeforeCleanup = remaining;
        if (remaining.length) {
          facts.status = 'FAIL';
          for (const row of remaining.reverse()) {
            const command = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${row.pid}'; if ($p -and $p.CreationDate.ToUniversalTime().ToString('O') -eq $env:PROBE_PROCESS_START) { Stop-Process -Id ${row.pid} -Force -ErrorAction Stop }`;
            execFileSync(
              'powershell.exe',
              ['-NoProfile', '-NonInteractive', '-Command', command],
              {
                env: { ...process.env, PROBE_PROCESS_START: row.start },
                timeout: 5000,
              },
            );
          }
          await sleep(250);
        }
        facts.liveAfterCleanup = sample();
        if (facts.liveAfterCleanup.length)
          throw new Error('owned PID/start identities survived cleanup');
      } catch (error) {
        facts.status = 'FAIL';
        facts.cleanupErrors.push(error.stack);
      }
    }
    facts.processes = [...captured.values()];
    facts.exit = exit;
    if (!facts.cleanupErrors.length && !facts.liveAfterCleanup?.length)
      fs.rmSync(owned, { recursive: true, force: true });
    facts.ownedScratchRemoved = !fs.existsSync(owned);
    save(path.join(out, 'result.json'), facts);
  }
  process.exitCode = facts.status === 'PASS' ? 0 : 1;
}

async function worker([runtime, owned, out, node, nonce]) {
  const facts = {
    status: 'RUNNING',
    phase: 'load-native',
    pid: process.pid,
    runtime,
    executable: {
      path: process.execPath,
      sha256: sha(process.execPath),
      versions: process.versions,
    },
    native: [],
  };
  let terminal,
    output = '';
  const frames = (kind) =>
    [
      ...output.matchAll(
        new RegExp(`PTY-PROBE-${kind}:(\\[[^\\r\\n]+\\])`, 'g'),
      ),
    ].map((match) => JSON.parse(match[1]));
  try {
    if (runtime === 'node22') assert.equal(process.version, 'v22.23.2');
    else assert.equal(process.versions.bun, runtime.slice(3));
    const require = createRequire(path.join(owned, 'probe.cjs'));
    const wrapper = require.resolve('@lydell/node-pty');
    facts.wrapper = { path: wrapper, sha256: sha(wrapper) };
    const platform = path.join(
      owned,
      'node_modules/@lydell/node-pty-win32-x64',
    );
    const walk = (directory) =>
      fs
        .readdirSync(directory, { withFileTypes: true })
        .flatMap((entry) =>
          entry.isDirectory()
            ? walk(path.join(directory, entry.name))
            : [path.join(directory, entry.name)],
        );
    facts.native = walk(platform)
      .filter((file) => /\.(node|dll|exe)$/i.test(file))
      .map((file) => ({
        path: file,
        sha256: sha(file),
        bytes: fs.statSync(file).size,
      }));
    assert.ok(facts.native.some((file) => file.path.endsWith('.node')));
    facts.processIdentity = processes([process.pid]).find(
      (row) => row.pid === process.pid,
    );
    assert.ok(facts.processIdentity, 'worker PID/start identity required');
    save(path.join(out, 'worker-before.json'), facts);
    const pty = require('@lydell/node-pty');
    facts.phase = 'spawn-conpty';
    const payload = path.join(owned, 'payload.cjs');
    fs.writeFileSync(
      payload,
      `const nonce=${JSON.stringify(nonce)};\nconst emit=(kind)=>process.stdout.write('PTY-PROBE-'+kind+':'+JSON.stringify([nonce,process.pid,process.stdin.isTTY,process.stdout.isTTY,process.stderr.isTTY,process.stdout.getWindowSize()])+'\\n');\nemit('ready');let input='';process.stdin.on('data',chunk=>{input+=chunk;let i;while((i=input.search(/[\\r\\n]/))>=0){const line=input.slice(0,i);input=input.slice(i+1);if(line==='INPUT '+nonce)emit('input');if(line==='SIZE '+nonce)emit('size');if(line==='QUIT '+nonce)process.stdout.write('PTY-PROBE-bye:'+nonce+'\\n',()=>process.exit(0));}});`,
    );
    facts.payload = {
      path: payload,
      sha256: sha(payload),
      executable: node,
      executableSha256: sha(node),
    };
    terminal = pty.spawn(node, [payload], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: owned,
      env: { ...process.env, HOME: owned, USERPROFILE: owned },
      useConpty: true,
      useConptyDll: true,
    });
    facts.ptyPid = terminal.pid;
    facts.loadedAddons = Object.keys(require.cache)
      .filter((file) => file.endsWith('.node'))
      .map((file) => ({ path: file, sha256: sha(file) }));
    assert.ok(
      facts.loadedAddons.some((file) => /[/\\]conpty\.node$/i.test(file.path)),
      'loaded ConPTY addon identity required; missing cache evidence is inconclusive, not a runtime defect',
    );
    save(path.join(out, 'worker-spawned.json'), facts);
    let ended;
    terminal.onData((data) => {
      output += data;
    });
    terminal.onExit((event) => {
      ended = event;
    });
    const until = async (predicate) => {
      const deadline = Date.now() + 8000;
      while (!predicate()) {
        assert.ok(Date.now() < deadline, 'protocol phase timed out');
        await sleep(25);
      }
    };
    const frame = (kind) => {
      const match = output.match(
        new RegExp(`PTY-PROBE-${kind}:(\\[[^\\r\\n]+\\])`),
      );
      return match ? JSON.parse(match[1]) : null;
    };
    await until(() => frame('ready'));
    assert.deepEqual(frame('ready'), [
      nonce,
      terminal.pid,
      true,
      true,
      true,
      [80, 24],
    ]);
    facts.phase = 'input';
    terminal.write(`INPUT ${nonce}\r`);
    await until(() => frame('input'));
    assert.equal(frame('input')[0], nonce);
    facts.phase = 'resize';
    terminal.resize(97, 31);
    let nextSizeQuery = 0;
    await until(() => {
      const sizes = frames('size');
      for (const size of sizes)
        assert.deepEqual(size.slice(0, 5), [
          nonce,
          terminal.pid,
          true,
          true,
          true,
        ]);
      const latest = sizes.at(-1);
      if (latest?.[5]?.[0] === 97 && latest[5][1] === 31) return true;
      if (Date.now() >= nextSizeQuery) {
        terminal.write(`SIZE ${nonce}\r`);
        nextSizeQuery = Date.now() + 100;
      }
      return false;
    });
    assert.deepEqual(frames('size').at(-1), [
      nonce,
      terminal.pid,
      true,
      true,
      true,
      [97, 31],
    ]);
    facts.phase = 'natural-exit';
    terminal.write(`QUIT ${nonce}\r`);
    await until(() => ended && output.includes(`PTY-PROBE-bye:${nonce}`));
    assert.equal(ended.exitCode, 0);
    facts.exit = ended;
    facts.frames = {
      ready: frame('ready'),
      input: frame('input'),
      size: frames('size').at(-1),
    };
    facts.status = 'PASS';
  } catch (error) {
    facts.status = 'FAIL';
    facts.error = error.stack;
  } finally {
    facts.resizeFrames = frames('size');
    facts.firstResizeFrame = facts.resizeFrames[0] ?? null;
    fs.writeFileSync(path.join(out, 'terminal.ansi'), output);
    save(path.join(out, 'worker.json'), facts);
  }
  process.exit(facts.status === 'PASS' ? 0 : 1);
}

if (process.argv[2] === '--worker') await worker(process.argv.slice(3));
else await controller(process.argv[2]);
