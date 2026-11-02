/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { arePermissionBitsEnforced } from '../../packages/cli/src/test-utils/permission-bits.js';
import {
  isProcessAlive,
  isTeardownTargetAlive,
} from '../../packages/desktop/scripts/process-liveness.js';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const smokeScript = path.join(
  repoRoot,
  'packages',
  'desktop',
  'scripts',
  'smoke-packaged.js',
);
const runtimeScriptName = 'fake-runtime.js';

// The packaged app spawns its runtime through command_group's `group_spawn`
// (src-tauri/src/runtime.rs), so the daemon leads a process group the app's own
// signal never reaches, and the app only reports readiness once that runtime is
// serving. The stand-in keeps that topology. Its runtime records its pid the
// way the daemon does and keeps writing under $HOME: a teardown that only
// signals the app leaves that writer alive to recreate entries as the smoke
// workspace is deleted, the ENOTEMPTY/EBUSY race that failed the v0.24.0
// desktop build.
const FAKE_RUNTIME = `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const debugDir = path.join(process.env.HOME, '.qwen', 'debug', 'daemon');
fs.mkdirSync(debugDir, { recursive: true });
const write = () => {
  try {
    fs.appendFileSync(path.join(debugDir, 'trace.log'), Date.now() + '\\n');
  } catch {}
};
if (process.env.SMOKE_FIXTURE_GRANDCHILD === '1') {
  // A child of the runtime's group that only a group SIGKILL can end.
  process.on('SIGTERM', () => {});
  fs.writeFileSync(process.env.SMOKE_FIXTURE_READY_FILE, 'ready');
  setInterval(write, 25);
} else {
  fs.appendFileSync(
    path.join(debugDir, 'daemon.log'),
    \`2026-01-01T00:00:00.000Z [INFO] [DAEMON] runId=smoke-fixture pid=\${process.pid} starting\\n\`,
  );
  if (process.env.SMOKE_FIXTURE_PID_FILE) {
    fs.writeFileSync(process.env.SMOKE_FIXTURE_PID_FILE, String(process.pid));
  }
  if (process.env.SMOKE_FIXTURE_EXIT_AFTER_SPAWN === '1') {
    // The leader exits, so the recorded pid is the only handle on the group
    // the writer it just spawned keeps running in.
    const child = spawn(process.execPath, [process.argv[1]], {
      stdio: 'ignore',
      env: { ...process.env, SMOKE_FIXTURE_GRANDCHILD: '1' },
    });
    fs.writeFileSync(
      process.env.SMOKE_FIXTURE_GRANDCHILD_PID_FILE,
      String(child.pid),
    );
    process.exit(0);
  }
  process.on('SIGTERM', () => {
    // A runtime that outlives the signal the app forwarded only ends on SIGKILL.
    if (process.env.SMOKE_FIXTURE_STUBBORN === '1') return;
    const deadline = Date.now() + 300;
    const timer = setInterval(() => {
      write();
      if (Date.now() >= deadline) {
        clearInterval(timer);
        process.exit(0);
      }
    }, 25);
  });
  setInterval(write, 25);
}
`;

const FAKE_APP = `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const home = process.env.HOME;
const runtime = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), '${runtimeScriptName}')], {
  detached: true,
  stdio: 'ignore',
});
runtime.unref();
if (process.env.SMOKE_FIXTURE_APP_HOLDS_SIGTERM === '1') {
  process.on('SIGTERM', () => {});
}
if (process.env.SMOKE_FIXTURE_LOCK_WORKSPACE === '1') {
  // A directory the removal cannot enter stands in for teardown that cannot
  // delete its workspace: that must be reported, not turned into a failure.
  const locked = path.join(home, '..', 'locked');
  fs.mkdirSync(locked, { recursive: true });
  fs.writeFileSync(path.join(locked, 'secret'), 'x');
  fs.chmodSync(locked, 0o500);
}
const runtimeLog = path.join(home, '.qwen', 'debug', 'daemon', 'daemon.log');
const server = http.createServer((req, res) => {
  if (req.url === '/' && (req.headers['sec-fetch-mode'] === 'navigate' || (req.headers['accept'] || '').includes('text/html'))) {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>shell</title>');
    return;
  }
  res.writeHead(401);
  res.end('unauthorized');
});
server.listen(0, '127.0.0.1', async () => {
  // The smoke can only tear down once the daemon it has to stop is running, so
  // wait for the runtime's own log before reporting readiness. A contended host
  // can take seconds to exec the runtime; never report ready without it.
  const readyMarker = process.env.SMOKE_FIXTURE_READY_FILE;
  const deadline = Date.now() + 45_000;
  while (
    !fs.existsSync(runtimeLog) ||
    (readyMarker && !fs.existsSync(readyMarker))
  ) {
    if (Date.now() >= deadline) {
      console.error('fixture: the runtime never wrote ' + runtimeLog);
      process.exit(4);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const { port } = server.address();
  const logRoot =
    process.platform === 'darwin'
      ? path.join(home, 'Library', 'Logs', 'com.alibaba.qwen-code')
      : path.join(process.env.XDG_STATE_HOME || home, 'com.alibaba.qwen-code', 'logs');
  fs.mkdirSync(logRoot, { recursive: true });
  fs.appendFileSync(path.join(logRoot, 'desktop-runtime.log'),
    \`qwen serve listening on http://127.0.0.1:\${port}\\n\`);
});
`;

let fixtureRoot;
let fakeApp;
const created = [];

function smokeWorkspaces() {
  return fs
    .readdirSync(os.tmpdir())
    .filter((name) => name.startsWith('qwen-desktop-smoke-'));
}

function writeFixture(name, source, { executable = true } = {}) {
  const file = path.join(fixtureRoot, 'bin', name);
  fs.writeFileSync(file, source);
  if (executable) fs.chmodSync(file, 0o755);
  return file;
}

function runSmoke(executable, env = {}) {
  const before = new Set(smokeWorkspaces());
  const result = spawnSync(process.execPath, [smokeScript, executable], {
    encoding: 'utf8',
    env: { ...process.env, QWEN_CODE_COMMIT: 'smoke-test-commit', ...env },
    // Above the smoke's own 60s readiness deadline, below the suite's 90s
    // per-test ceiling, so a stalled run reports the smoke's diagnostics.
    timeout: 80_000,
  });
  const left = smokeWorkspaces().filter((name) => !before.has(name));
  created.push(...left);
  return { ...result, created: left };
}

// The runtime records its own pid the way the daemon does, so the smoke can be
// checked for the leak it has to prevent — a surviving writer — instead of the
// filesystem error that leak happens to cause.
function recordedPid(pidFile) {
  return Number(fs.readFileSync(pidFile, 'utf8'));
}

// Keeps a failed assertion from leaving smoke workspaces behind, including the
// one a fixture locks against removal.
afterAll(() => {
  for (const name of created) {
    const workspace = path.join(os.tmpdir(), name);
    const locked = path.join(workspace, 'locked');
    if (fs.existsSync(locked)) fs.chmodSync(locked, 0o700);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

beforeAll(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-fixture-'));
  fs.mkdirSync(path.join(fixtureRoot, 'bin'));
  writeFixture(runtimeScriptName, FAKE_RUNTIME);
  fakeApp = writeFixture('fake-app.js', FAKE_APP);
  const manifestDir = path.join(
    fixtureRoot,
    'Resources',
    'runtime',
    'qwen-code',
  );
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(
    path.join(manifestDir, 'manifest.json'),
    JSON.stringify({ qwenCodeCommit: 'smoke-test-commit' }),
  );
});

describe('process liveness', () => {
  it('treats Linux zombies as stopped while keeping live states alive', () => {
    const readStat = (state) =>
      `123 (runtime with spaces (and parentheses)) ${state} 1 2`;
    const options = { platform: 'linux', kill: () => {} };

    expect(
      isProcessAlive(123, { ...options, readStat: () => readStat('Z') }),
    ).toBe(false);
    expect(
      isProcessAlive(123, { ...options, readStat: () => readStat('S') }),
    ).toBe(true);
  });

  it('keeps conservative liveness for missing or unreadable proc stats', () => {
    const options = { platform: 'linux', kill: () => {} };
    const missing = Object.assign(new Error('gone'), { code: 'ENOENT' });
    const unreadable = Object.assign(new Error('denied'), { code: 'EACCES' });

    expect(
      isProcessAlive(123, {
        ...options,
        readStat: () => {
          throw missing;
        },
      }),
    ).toBe(false);
    expect(
      isProcessAlive(123, {
        ...options,
        readStat: () => {
          throw unreadable;
        },
      }),
    ).toBe(true);
    for (const platform of ['darwin', 'win32']) {
      let reads = 0;
      expect(
        isProcessAlive(123, {
          platform,
          kill: () => {},
          readStat: () => {
            reads += 1;
            return '';
          },
        }),
      ).toBe(true);
      expect(reads).toBe(0);
    }
  });

  it('reads a failed signal probe by its error code', () => {
    const withKillError = (code) => () => {
      throw Object.assign(new Error(code), { code });
    };

    // ESRCH is the only answer that means the process is gone; EPERM/EACCES
    // mean it exists under another owner, so teardown must not retire it.
    expect(isProcessAlive(123, { kill: withKillError('ESRCH') })).toBe(false);
    expect(isProcessAlive(123, { kill: withKillError('EPERM') })).toBe(true);
    expect(isProcessAlive(123, { kill: withKillError('EACCES') })).toBe(true);
  });

  it('keeps a teardown target alive while its group outlives the leader', () => {
    const leaderGoneGroupAlive = (pid) => {
      if (pid < 0) return;
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    };
    const groupGone = () => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    };

    // The recorded pid is the group: reporting it dead on the leader alone
    // ends the drain while the group's writer still runs.
    expect(
      isTeardownTargetAlive(123, {
        platform: 'linux',
        kill: leaderGoneGroupAlive,
      }),
    ).toBe(true);
    expect(
      isTeardownTargetAlive(123, { platform: 'linux', kill: groupGone }),
    ).toBe(false);
  });
});

// The smoke spawns the app path it is handed, and a shebang script is not
// spawnable on Windows, so this fixture topology only exists on POSIX. The
// Windows lane exercises the same teardown against the real packaged build.
describe.skipIf(process.platform === 'win32')('smoke-packaged teardown', () => {
  it('passes, removes its workspace, and leaves no runtime behind', () => {
    const pidFile = path.join(fixtureRoot, 'drain.pid');
    const result = runSmoke(fakeApp, { SMOKE_FIXTURE_PID_FILE: pidFile });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Packaged desktop runtime ready');
    expect(result.created, result.stderr).toEqual([]);
    // The app's own signal never reaches the runtime's group; only the pid the
    // daemon recorded can stop it.
    expect(isProcessAlive(recordedPid(pidFile))).toBe(false);
  });

  it('stops a runtime that ignores SIGTERM instead of racing its writes', () => {
    const pidFile = path.join(fixtureRoot, 'stubborn.pid');
    const result = runSmoke(fakeApp, {
      SMOKE_FIXTURE_PID_FILE: pidFile,
      SMOKE_FIXTURE_STUBBORN: '1',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.created, result.stderr).toEqual([]);
    expect(isProcessAlive(recordedPid(pidFile))).toBe(false);
  });

  // The recorded pid stays the teardown handle after its leader exits: a group
  // whose leader is gone still runs the writer that outlives it.
  it('reaps the group of a runtime whose leader already exited', () => {
    const pidFile = path.join(fixtureRoot, 'exited-leader.pid');
    const writerPidFile = path.join(fixtureRoot, 'exited-leader-writer.pid');
    const result = runSmoke(fakeApp, {
      SMOKE_FIXTURE_PID_FILE: pidFile,
      SMOKE_FIXTURE_EXIT_AFTER_SPAWN: '1',
      SMOKE_FIXTURE_GRANDCHILD_PID_FILE: writerPidFile,
      SMOKE_FIXTURE_READY_FILE: path.join(fixtureRoot, 'exited-leader.ready'),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.created, result.stderr).toEqual([]);
    expect(isProcessAlive(Number(fs.readFileSync(writerPidFile, 'utf8')))).toBe(
      false,
    );
  });

  it('still force-kills an app that holds SIGTERM before it cleans up', () => {
    const pidFile = path.join(fixtureRoot, 'holding.pid');
    const result = runSmoke(fakeApp, {
      SMOKE_FIXTURE_PID_FILE: pidFile,
      SMOKE_FIXTURE_APP_HOLDS_SIGTERM: '1',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Packaged desktop runtime ready');
    expect(result.created, result.stderr).toEqual([]);
    expect(isProcessAlive(recordedPid(pidFile))).toBe(false);
  });

  // The locked directory only stops the removal where permission bits
  // bind: not for root with its DAC capabilities.
  it.skipIf(!arePermissionBitsEnforced())(
    'reports a workspace it cannot delete without failing a passed check',
    () => {
      const result = runSmoke(fakeApp, {
        SMOKE_FIXTURE_PID_FILE: path.join(fixtureRoot, 'locked.pid'),
        SMOKE_FIXTURE_LOCK_WORKSPACE: '1',
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('left the workspace behind');
      expect(result.created.length).toBe(1);
    },
  );

  it('keeps the workspace for debugging when the app dies before readiness', () => {
    const deadApp = writeFixture(
      'fake-dead.js',
      '#!/usr/bin/env node\nprocess.exit(3);\n',
    );
    const result = runSmoke(deadApp);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('exited before readiness');
    expect(result.created.length).toBe(1);
    expect(result.stderr).toContain(
      `Smoke workspace: ${path.join(os.tmpdir(), result.created[0])}`,
    );
  });
});

describe.skipIf(process.platform === 'win32')(
  'smoke-packaged startup failures',
  () => {
    it('reports a non-executable binary as a failed start, not a crash', () => {
      const noExec = writeFixture('fake-noexec.js', '#!/usr/bin/env node\n', {
        executable: false,
      });
      const result = runSmoke(noExec);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('failed to start');
    });
  },
);
