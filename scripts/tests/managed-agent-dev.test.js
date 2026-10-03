/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import {
  buildHarnessWiring,
  buildKillPlan,
  buildManagedWebShellPath,
  buildServeStages,
  buildSpringRecipeLines,
  buildWebShellLaunch,
  buildWebShellUrl,
  ensurePortFree,
  executeKillPlan,
  findAvailablePort,
  generateDaemonToken,
  generateHarnessSecrets,
  healthFailureAction,
  parseLauncherArgs,
  renderSpringEnv,
  renderSpringPs1Env,
  runServeStages,
  springEnvDir,
  springEnvFilePath,
  springEnvReuseWarning,
  springHealthExpectBody,
  TEARDOWN_SIGNALS,
  waitForHttpOk,
  writeSpringEnvFiles,
} from '../managed-agent-dev.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const script = path.join(__dirname, '..', 'managed-agent-dev.js');

const VALID_DIGEST = `sha256:${'a'.repeat(64)}`;
const onWindows = process.platform === 'win32';

describe('parseLauncherArgs', () => {
  it('returns defaults with no arguments', () => {
    expect(parseLauncherArgs([])).toEqual({
      daemonPort: undefined,
      harnessPort: undefined,
      javaUrl: 'http://127.0.0.1:8080',
      tenant: 'local-java-demo',
      workspace: undefined,
      skipJavaWait: false,
    });
  });

  it('accepts separate and joined option forms', () => {
    expect(
      parseLauncherArgs([
        '--daemon-port',
        '4200',
        '--harness-port=4300',
        '--tenant',
        'team-a',
        '--workspace=/tmp/ws',
        '--skip-java-wait',
      ]),
    ).toEqual({
      daemonPort: 4200,
      harnessPort: 4300,
      javaUrl: 'http://127.0.0.1:8080',
      tenant: 'team-a',
      workspace: '/tmp/ws',
      skipJavaWait: true,
    });
  });

  it('rejects an unsupported option', () => {
    expect(() => parseLauncherArgs(['--port', '4170'])).toThrow(
      'Unsupported managed-agent-dev option: --port',
    );
  });

  it('rejects a missing value, including a following flag', () => {
    expect(() => parseLauncherArgs(['--tenant'])).toThrow(
      '--tenant requires a value.',
    );
    expect(() => parseLauncherArgs(['--tenant', '--skip-java-wait'])).toThrow(
      '--tenant requires a value.',
    );
    expect(() => parseLauncherArgs(['--tenant='])).toThrow(
      '--tenant requires a value.',
    );
  });

  it('rejects a value for the boolean flag', () => {
    expect(() => parseLauncherArgs(['--skip-java-wait=yes'])).toThrow(
      '--skip-java-wait does not take a value.',
    );
  });

  it('rejects ports outside a fixed pollable range', () => {
    expect(() => parseLauncherArgs(['--daemon-port=abc'])).toThrow(
      '--daemon-port must be an integer 1–65535',
    );
    expect(() => parseLauncherArgs(['--daemon-port=0'])).toThrow(
      '--daemon-port must be an integer 1–65535',
    );
    expect(() => parseLauncherArgs(['--harness-port', '65536'])).toThrow(
      '--harness-port must be an integer 1–65535',
    );
  });

  it('rejects two explicitly equal ports', () => {
    expect(() =>
      parseLauncherArgs(['--daemon-port', '4170', '--harness-port=4170']),
    ).toThrow('--daemon-port and --harness-port must differ.');
    expect(
      parseLauncherArgs(['--daemon-port=4170', '--harness-port=4270']),
    ).toMatchObject({ daemonPort: 4170, harnessPort: 4270 });
    expect(parseLauncherArgs(['--daemon-port=4270'])).toMatchObject({
      daemonPort: 4270,
      harnessPort: undefined,
    });
  });

  it('rejects a non-http java url', () => {
    expect(() => parseLauncherArgs(['--java-url=not-a-url'])).toThrow(
      '--java-url must be a valid URL',
    );
    expect(() => parseLauncherArgs(['--java-url=ftp://127.0.0.1'])).toThrow(
      '--java-url must be an http(s) URL',
    );
  });

  it('strips trailing slashes from the java url', () => {
    expect(
      parseLauncherArgs(['--java-url=http://127.0.0.1:8080/']).javaUrl,
    ).toBe('http://127.0.0.1:8080');
  });

  it('preserves values that contain an equals sign', () => {
    expect(parseLauncherArgs(['--workspace=/tmp/with=equals']).workspace).toBe(
      '/tmp/with=equals',
    );
  });

  it('rejects tenants Spring would refuse with invalid_tenant', () => {
    expect(() => parseLauncherArgs(['--tenant', 'team a'])).toThrow(
      '--tenant must match',
    );
    expect(() => parseLauncherArgs(['--tenant=team a/b?c'])).toThrow(
      '--tenant must match',
    );
    expect(() => parseLauncherArgs(['--tenant', 'x'.repeat(129)])).toThrow(
      '--tenant must match',
    );
    expect(parseLauncherArgs(['--tenant', 'a:b.c-d_e']).tenant).toBe(
      'a:b.c-d_e',
    );
    expect(parseLauncherArgs(['--tenant', 'x'.repeat(128)])?.tenant).toBe(
      'x'.repeat(128),
    );
    expect(parseLauncherArgs([]).tenant).toBe('local-java-demo');
  });
});

describe('ensurePortFree', () => {
  it('rejects a busy pinned port before any health wait', async () => {
    const blocker = net.createServer();
    await new Promise((resolveListen) =>
      blocker.listen(0, '127.0.0.1', resolveListen),
    );
    const occupied = blocker.address().port;
    try {
      await expect(ensurePortFree(occupied, '--daemon-port')).rejects.toThrow(
        `--daemon-port ${occupied} is already in use`,
      );
    } finally {
      await new Promise((resolveClose) => blocker.close(resolveClose));
    }
  });

  it('resolves on a free pinned port', async () => {
    const blocker = net.createServer();
    await new Promise((resolveListen) =>
      blocker.listen(0, '127.0.0.1', resolveListen),
    );
    const free = blocker.address().port;
    await new Promise((resolveClose) => blocker.close(resolveClose));
    await expect(
      ensurePortFree(free, '--harness-port'),
    ).resolves.toBeUndefined();
  });
});

describe('findAvailablePort', () => {
  it('skips an excluded port without probing it', async () => {
    const blocker = net.createServer();
    await new Promise((resolveListen) =>
      blocker.listen(0, '127.0.0.1', resolveListen),
    );
    const occupied = blocker.address().port;
    const logs = [];
    const spy = vi
      .spyOn(console, 'log')
      .mockImplementation((msg) => logs.push(String(msg)));
    try {
      // The bound port would fail the probe with EADDRINUSE; the exclusion
      // must skip it before any probe, so no "in use" line may be logged.
      const found = await findAvailablePort(occupied, new Set([occupied]));
      expect(found).not.toBe(occupied);
      expect(logs.some((line) => line.includes(`${occupied}`))).toBe(false);
    } finally {
      spy.mockRestore();
      await new Promise((resolveClose) => blocker.close(resolveClose));
    }
  });

  it('walks by family: the probe sees only what its own bind family can collide with', async () => {
    // On IPv6-first hosts Vite binds ::1 only, which a 127.0.0.1 probe
    // cannot see — the web probe's host must match the server's bind family.
    // The fixture binds ::1 literally so the parameter stays observable even
    // where 'localhost' resolves IPv4-only; skipped when ::1 cannot listen.
    const viteStandIn = net.createServer();
    const bound = await new Promise((resolveListen) => {
      viteStandIn.once('error', () => resolveListen(false));
      viteStandIn.listen(0, '::1', () => resolveListen(true));
    });
    if (!bound) {
      return;
    }
    const held = viteStandIn.address().port;
    try {
      expect(await findAvailablePort(held, new Set(), '::1')).not.toBe(held);
      expect(await findAvailablePort(held, new Set(), '127.0.0.1')).toBe(held);
    } finally {
      await new Promise((resolveClose) => viteStandIn.close(resolveClose));
    }
  });
});

describe('buildKillPlan', () => {
  it('uses a tree kill on Windows, a process group on POSIX', () => {
    expect(buildKillPlan(true, true)).toEqual({ kind: 'taskkill' });
    expect(buildKillPlan(false, true)).toEqual({ kind: 'process-group' });
    expect(buildKillPlan(true, false)).toEqual({ kind: 'direct' });
    expect(buildKillPlan(false, false)).toEqual({ kind: 'direct' });
  });
});

describe('executeKillPlan', () => {
  it('runs taskkill /T on the Windows plan', () => {
    const taskkill = vi.fn();
    executeKillPlan(
      { kind: 'taskkill' },
      1234,
      { kill: vi.fn() },
      { taskkill, killProcess: vi.fn() },
    );
    expect(taskkill).toHaveBeenCalledWith(['/pid', '1234', '/T', '/F']);
  });

  it('signals the process group on the POSIX plan', () => {
    const killProcess = vi.fn();
    executeKillPlan(
      { kind: 'process-group' },
      1234,
      { kill: vi.fn() },
      { taskkill: vi.fn(), killProcess },
    );
    expect(killProcess).toHaveBeenCalledWith(-1234, 'SIGTERM');
  });

  it('falls back to a direct kill when there is no pid', () => {
    const directChild = { kill: vi.fn() };
    executeKillPlan({ kind: 'direct' }, undefined, directChild, {
      taskkill: vi.fn(),
      killProcess: vi.fn(),
    });
    expect(directChild.kill).toHaveBeenCalled();
  });
});

describe('TEARDOWN_SIGNALS', () => {
  it('covers SIGINT, SIGTERM and (on POSIX) SIGHUP', () => {
    expect(TEARDOWN_SIGNALS).toContain('SIGINT');
    expect(TEARDOWN_SIGNALS).toContain('SIGTERM');
    if (process.platform === 'win32') {
      expect(TEARDOWN_SIGNALS).not.toContain('SIGHUP');
    } else {
      expect(TEARDOWN_SIGNALS).toContain('SIGHUP');
    }
  });
});

describe('renderSpringEnv', () => {
  it('exports the four harness wiring values Spring needs', () => {
    const content = renderSpringEnv({
      harnessPort: 4270,
      harnessToken: 'harness-token',
      capabilityDigest: VALID_DIGEST,
    });
    expect(content).toContain(
      `export QWEN_MANAGED_AGENT_HARNESS_ENABLED='true'`,
    );
    expect(content).toContain(
      `export QWEN_MANAGED_AGENT_HARNESS_BASE_URL='http://127.0.0.1:4270'`,
    );
    expect(content).toContain(
      `export QWEN_MANAGED_AGENT_HARNESS_TOKEN='harness-token'`,
    );
    expect(content).toContain(
      `export QWEN_MANAGED_AGENT_CAPABILITY_DIGEST='${VALID_DIGEST}'`,
    );
    expect(content.startsWith('#')).toBe(true);
    expect(content.endsWith('\n')).toBe(true);
  });
});

describe('renderSpringPs1Env', () => {
  it('emits the same four values in PowerShell syntax', () => {
    const content = renderSpringPs1Env({
      harnessPort: 4270,
      harnessToken: 'harness-token',
      capabilityDigest: VALID_DIGEST,
    });
    expect(content).toContain(`$env:QWEN_MANAGED_AGENT_HARNESS_ENABLED='true'`);
    expect(content).toContain(
      `$env:QWEN_MANAGED_AGENT_HARNESS_TOKEN='harness-token'`,
    );
    expect(content.endsWith('\n')).toBe(true);
  });
});

describe('springEnvDir', () => {
  it('never resolves inside the served workspace', () => {
    expect(springEnvFilePath(root).startsWith(root + path.sep)).toBe(false);
  });

  it('differs per checkout so two worktrees cannot truncate each other', () => {
    expect(springEnvDir('/checkout/a')).not.toBe(springEnvDir('/checkout/b'));
    expect(springEnvDir('/checkout/a')).toBe(springEnvDir('/checkout/a'));
  });
});

describe('writeSpringEnvFiles', () => {
  const envContent = "export TOKEN='t'\n";
  const ps1Content = "$env:TOKEN='t'\n";
  const guardedIt = onWindows ? it.skip : it;

  function freshDir() {
    const dir = mkdtempSync(path.join(tmpdir(), 'spring-env-writer-'));
    return {
      dir,
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  guardedIt('writes 0600 files and a ps1 sibling only on Windows', () => {
    const { dir, cleanup } = freshDir();
    try {
      writeSpringEnvFiles({
        directory: dir,
        springEnv: envContent,
        springPs1Env: ps1Content,
        isWinPlatform: false,
      });
      expect(readFileSync(path.join(dir, 'spring.env'), 'utf8')).toBe(
        envContent,
      );
      expect(statSync(path.join(dir, 'spring.env')).mode & 0o777).toBe(0o600);
      expect(existsSync(path.join(dir, 'spring.env.ps1'))).toBe(false);

      writeSpringEnvFiles({
        directory: dir,
        springEnv: envContent,
        springPs1Env: ps1Content,
        isWinPlatform: true,
      });
      expect(statSync(path.join(dir, 'spring.env.ps1')).mode & 0o777).toBe(
        0o600,
      );
      expect(readFileSync(path.join(dir, 'spring.env.ps1'), 'utf8')).toBe(
        ps1Content,
      );
    } finally {
      cleanup();
    }
  });

  guardedIt('refuses a planted symlink and leaves its target untouched', () => {
    const { dir, cleanup } = freshDir();
    const victimDir = mkdtempSync(path.join(tmpdir(), 'spring-env-victim-'));
    try {
      const victim = path.join(victimDir, 'victim.txt');
      writeFileSync(victim, 'precious');
      symlinkSync(victim, path.join(dir, 'spring.env'));
      expect(() =>
        writeSpringEnvFiles({
          directory: dir,
          springEnv: envContent,
          springPs1Env: ps1Content,
          isWinPlatform: false,
        }),
      ).toThrow(/not a regular file/);
      expect(readFileSync(victim, 'utf8')).toBe('precious');
    } finally {
      cleanup();
      rmSync(victimDir, { recursive: true, force: true });
    }
  });

  guardedIt(
    'forces 0600 on the overwrite path where writeFileSync mode is a no-op',
    () => {
      const { dir, cleanup } = freshDir();
      try {
        const target = path.join(dir, 'spring.env');
        writeFileSync(target, 'stale');
        chmodSync(target, 0o666);
        writeSpringEnvFiles({
          directory: dir,
          springEnv: envContent,
          springPs1Env: ps1Content,
          isWinPlatform: false,
        });
        expect(statSync(target).mode & 0o777).toBe(0o600);
        expect(readFileSync(target, 'utf8')).toBe(envContent);
      } finally {
        cleanup();
      }
    },
  );

  guardedIt('refuses a directory that is not 0700', () => {
    const { dir, cleanup } = freshDir();
    try {
      chmodSync(dir, 0o755);
      expect(() =>
        writeSpringEnvFiles({
          directory: dir,
          springEnv: envContent,
          springPs1Env: ps1Content,
          isWinPlatform: false,
        }),
      ).toThrow(/must be 0700/);
    } finally {
      cleanup();
    }
  });

  guardedIt(
    'skips the 0700 gate on the Windows arm, where NTFS ACLs own the boundary',
    () => {
      const { dir, cleanup } = freshDir();
      try {
        chmodSync(dir, 0o755);
        writeSpringEnvFiles({
          directory: dir,
          springEnv: envContent,
          springPs1Env: ps1Content,
          isWinPlatform: true,
        });
        expect(existsSync(path.join(dir, 'spring.env.ps1'))).toBe(true);
      } finally {
        cleanup();
      }
    },
  );
});

describe('springEnvReuseWarning', () => {
  it('warns only when the file pre-existed', () => {
    expect(springEnvReuseWarning(false)).toBeNull();
    expect(springEnvReuseWarning(true)).toContain('old harness token');
  });
});

describe('generateDaemonToken / generateHarnessSecrets', () => {
  it('mints accepted formats', () => {
    const secrets = generateHarnessSecrets();
    expect(secrets.harnessToken).toMatch(/^[0-9a-f]{32}$/);
    expect(secrets.capabilityDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('rotates: two mints never agree', () => {
    const a = generateHarnessSecrets();
    const b = generateHarnessSecrets();
    expect(a.harnessToken).not.toBe(b.harnessToken);
    expect(a.capabilityDigest).not.toBe(b.capabilityDigest);
    expect(generateDaemonToken()).not.toBe(generateDaemonToken());
  });
});

describe('buildHarnessWiring', () => {
  it('produces the five-condition hosted-harness contract', () => {
    const wiring = buildHarnessWiring({
      harnessPort: 4270,
      workspace: '/ws',
      harnessToken: 'harness-token',
      capabilityDigest: VALID_DIGEST,
    });
    expect(wiring.serveArgs).toEqual([
      'scripts/dev.js',
      'serve',
      '--profile',
      'hosted-harness',
      '--hostname',
      '127.0.0.1',
      '--port',
      '4270',
      '--require-auth',
      '--no-web',
      '--workspace',
      '/ws',
    ]);
    expect(wiring.extraEnv).toEqual({
      QWEN_SERVER_TOKEN: 'harness-token',
      QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST: VALID_DIGEST,
    });
  });

  it('feeds the Spring side and the harness side from one input', () => {
    const wiring = buildHarnessWiring({
      harnessPort: 4270,
      workspace: '/ws',
      harnessToken: 'the-one-token',
      capabilityDigest: VALID_DIGEST,
    });
    expect(wiring.springEnv).toContain(
      `export QWEN_MANAGED_AGENT_HARNESS_TOKEN='${wiring.extraEnv.QWEN_SERVER_TOKEN}'`,
    );
    expect(wiring.springEnv).toContain(
      `export QWEN_MANAGED_AGENT_CAPABILITY_DIGEST='${wiring.extraEnv.QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST}'`,
    );
    expect(wiring.springPs1Env).toContain(
      `$env:QWEN_MANAGED_AGENT_HARNESS_TOKEN='${wiring.extraEnv.QWEN_SERVER_TOKEN}'`,
    );
  });

  it('renders the same harness port into argv and both base URLs', () => {
    const wiring = buildHarnessWiring({
      harnessPort: 4321,
      workspace: '/ws',
      harnessToken: 't',
      capabilityDigest: VALID_DIGEST,
    });
    expect(wiring.serveArgs).toContain('4321');
    expect(wiring.springEnv).toContain(
      `HARNESS_BASE_URL='http://127.0.0.1:4321'`,
    );
    expect(wiring.springPs1Env).toContain(
      `HARNESS_BASE_URL='http://127.0.0.1:4321'`,
    );
  });
});

describe('buildServeStages', () => {
  const wiring = buildHarnessWiring({
    harnessPort: 4270,
    workspace: '/ws',
    harnessToken: 'harness-token',
    capabilityDigest: VALID_DIGEST,
  });
  // Ambient credentials must always lose to this run's freshly minted ones.
  const stages = buildServeStages({
    workspace: '/ws',
    daemonPort: 4170,
    daemonToken: 'daemon-token',
    serveEnv: {
      MARKER: '1',
      QWEN_SERVER_TOKEN: 'ambient-must-lose',
      QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST: `sha256:${'f'.repeat(64)}`,
    },
    harnessWiring: wiring,
  });

  it('boots the daemon before the harness', () => {
    expect(stages.map((stage) => stage.label)).toEqual(['daemon', 'harness']);
  });

  it('wires each stage with its own credentials', () => {
    expect(stages[0].env).toMatchObject({
      MARKER: '1',
      QWEN_SERVER_TOKEN: 'daemon-token',
    });
    expect(stages[1].env).toMatchObject({
      MARKER: '1',
      QWEN_SERVER_TOKEN: 'harness-token',
      QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST: VALID_DIGEST,
    });
    expect(stages[0].health).toMatchObject({
      url: 'http://127.0.0.1:4170/capabilities',
      token: 'daemon-token',
    });
    expect(stages[1].health).toMatchObject({
      url: 'http://127.0.0.1:4270/capabilities',
      token: 'harness-token',
    });
  });

  it('pins the daemon argv and moves it with the daemon port', () => {
    expect(stages[0].args).toEqual([
      'scripts/dev.js',
      'serve',
      '--hostname',
      '127.0.0.1',
      '--port',
      '4170',
      '--workspace',
      '/ws',
    ]);
    const moved = buildServeStages({
      workspace: '/ws',
      daemonPort: 4199,
      daemonToken: 'daemon-token',
      serveEnv: {},
      harnessWiring: wiring,
    });
    expect(moved[0].args).toContain('4199');
    expect(moved[0].health.url).toBe('http://127.0.0.1:4199/capabilities');
  });

  it('rejects a harness answering the daemon health check', () => {
    const daemonExpect = stages[0].health.expectBody;
    expect(daemonExpect({ v: 1 })).toBe(true);
    expect(
      daemonExpect({ v: 1, hostedHarness: { capabilityDigest: 'x' } }),
    ).not.toBe(true);
    expect(daemonExpect(null)).not.toBe(true);
  });

  it('accepts only the harness instance holding this run’s digest', () => {
    const harnessExpect = stages[1].health.expectBody;
    expect(
      harnessExpect({
        v: 1,
        hostedHarness: { capabilityDigest: VALID_DIGEST },
      }),
    ).toBe(true);
    expect(
      harnessExpect({
        v: 1,
        hostedHarness: { capabilityDigest: `sha256:${'b'.repeat(64)}` },
      }),
    ).not.toBe(true);
    expect(harnessExpect({ v: 1 })).toBe('not a hosted-harness responder');
    expect(harnessExpect(undefined)).not.toBe(true);
  });
});

describe('runServeStages', () => {
  it('spawns and gates strictly in turn; a failed gate stops the next spawn', async () => {
    const calls = [];
    const stages = [{ label: 'daemon' }, { label: 'harness' }];
    await runServeStages(stages, {
      spawnStage: (stage) => {
        calls.push(`spawn:${stage.label}`);
      },
      waitStage: async (stage) => {
        calls.push(`wait:${stage.label}`);
      },
    });
    expect(calls).toEqual([
      'spawn:daemon',
      'wait:daemon',
      'spawn:harness',
      'wait:harness',
    ]);

    const failingCalls = [];
    await expect(
      runServeStages(stages, {
        spawnStage: (stage) => {
          failingCalls.push(`spawn:${stage.label}`);
        },
        waitStage: async (stage) => {
          failingCalls.push(`wait:${stage.label}`);
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');
    expect(failingCalls).toEqual(['spawn:daemon', 'wait:daemon']);
  });
});

describe('healthFailureAction', () => {
  it('continues past a Spring timeout but aborts on owned children', () => {
    expect(healthFailureAction('java')).toBe('continue');
    expect(healthFailureAction('daemon')).toBe('abort');
    expect(healthFailureAction('harness')).toBe('abort');
    expect(healthFailureAction('anything-else')).toBe('abort');
  });
});

describe('springHealthExpectBody', () => {
  it('accepts only a Spring Boot actuator health shape', () => {
    expect(springHealthExpectBody({ status: 'UP' })).toBe(true);
    expect(springHealthExpectBody({ status: 'OUT_OF_SERVICE' })).toBe(true);
    expect(springHealthExpectBody(null)).toBe(
      'not a Spring Boot actuator health response',
    );
    expect(springHealthExpectBody({})).toBe(
      'not a Spring Boot actuator health response',
    );
    expect(springHealthExpectBody('<html>ok</html>')).toBe(
      'not a Spring Boot actuator health response',
    );
  });
});

describe('waitForHttpOk', () => {
  function serve(alwaysStatus, alwaysBody = '{}') {
    const server = http.createServer((_req, res) => {
      res.writeHead(alwaysStatus, { 'content-type': 'application/json' });
      res.end(alwaysBody);
    });
    return new Promise((resolveListen) => {
      server.listen(0, '127.0.0.1', () => resolveListen(server));
    });
  }

  it('resolves on a 2xx responder', async () => {
    const server = await serve(200);
    try {
      const { port } = server.address();
      await expect(
        waitForHttpOk(`http://127.0.0.1:${port}/health`, {
          timeoutMs: 1_000,
          intervalMs: 25,
        }),
      ).resolves.toBeUndefined();
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  });

  it('sends the bearer token when one is given and none otherwise', async () => {
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push(req.headers.authorization);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise((resolveListen) =>
      server.listen(0, '127.0.0.1', resolveListen),
    );
    try {
      const { port } = server.address();
      await waitForHttpOk(`http://127.0.0.1:${port}/capabilities`, {
        token: 'abc',
        timeoutMs: 1_000,
        intervalMs: 25,
      });
      await waitForHttpOk(`http://127.0.0.1:${port}/capabilities`, {
        timeoutMs: 1_000,
        intervalMs: 25,
      });
      expect(seen[0]).toBe('Bearer abc');
      expect(seen[1]).toBeUndefined();
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  });

  it('reports the last HTTP status on timeout instead of implying no responder', async () => {
    const server = await serve(404);
    try {
      const { port } = server.address();
      await expect(
        waitForHttpOk(`http://127.0.0.1:${port}/actuator/health`, {
          timeoutMs: 300,
          intervalMs: 50,
        }),
      ).rejects.toThrow(/last response: HTTP 404/);
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  });

  it('carries the connection error cause through the generic fetch failure', async () => {
    const blocker = net.createServer();
    await new Promise((resolveListen) =>
      blocker.listen(0, '127.0.0.1', resolveListen),
    );
    const deadPort = blocker.address().port;
    await new Promise((resolveClose) => blocker.close(resolveClose));
    await expect(
      waitForHttpOk(`http://127.0.0.1:${deadPort}/actuator/health`, {
        timeoutMs: 300,
        intervalMs: 50,
      }),
    ).rejects.toThrow(/last error: .*ECONNREFUSED/);
  });

  it('lets a fresh error supersede an older response status', async () => {
    let hits = 0;
    const server = http.createServer((_req, res) => {
      hits += 1;
      // `connection: close` keeps undici from pooling a keep-alive socket,
      // so after the listener stops the next attempt really is a refusal.
      res.writeHead(503, {
        'content-type': 'application/json',
        connection: 'close',
      });
      res.end('{}');
      // The responder dies mid-wait: the next attempts are refusals, and the
      // stale 503 must not outlive them.
      if (hits >= 4) server.close();
    });
    await new Promise((resolveListen) =>
      server.listen(0, '127.0.0.1', resolveListen),
    );
    const { port } = server.address();
    const err = await waitForHttpOk(`http://127.0.0.1:${port}/capabilities`, {
      timeoutMs: 900,
      intervalMs: 50,
    }).then(
      () => new Error('unexpected resolve'),
      (caught) => caught,
    );
    expect(String(err)).toMatch(/ECONNREFUSED/);
    expect(String(err)).not.toContain('503');
  });

  it('keeps waiting until the identity predicate accepts the body', async () => {
    const server = await serve(200, JSON.stringify({ digest: 'wrong' }));
    try {
      const { port } = server.address();
      await expect(
        waitForHttpOk(`http://127.0.0.1:${port}/capabilities`, {
          timeoutMs: 300,
          intervalMs: 50,
          expectBody: (body) =>
            body?.digest === 'right' ? true : 'digest mismatch',
        }),
      ).rejects.toThrow(/last response: HTTP 200, digest mismatch/);
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  });

  it('resolves when a later attempt finally satisfies the predicate', async () => {
    let hits = 0;
    const server = http.createServer((_req, res) => {
      hits += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ digest: hits < 3 ? 'wrong' : 'right' }));
    });
    await new Promise((resolveListen) =>
      server.listen(0, '127.0.0.1', resolveListen),
    );
    try {
      const { port } = server.address();
      await expect(
        waitForHttpOk(`http://127.0.0.1:${port}/capabilities`, {
          timeoutMs: 2_000,
          intervalMs: 25,
          expectBody: (body) =>
            body?.digest === 'right' ? true : 'digest mismatch',
        }),
      ).resolves.toBeUndefined();
      expect(hits).toBeGreaterThanOrEqual(3);
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  });
});

describe('buildManagedWebShellPath', () => {
  it('selects the Managed panel with the Java provider and daemon token', () => {
    const openPath = buildManagedWebShellPath({
      tenant: 'local-java-demo',
      daemonToken: 'daemon-token',
    });
    const params = new URLSearchParams(openPath.split('?', 2)[1]);
    expect(openPath.startsWith('/?')).toBe(true);
    expect(params.get('managed')).toBe('1');
    expect(params.get('managedProvider')).toBe('java');
    expect(params.get('tenant')).toBe('local-java-demo');
    expect(params.get('token')).toBe('daemon-token');
  });

  it('url-encodes tenant ids that are not query-safe', () => {
    const openPath = buildManagedWebShellPath({
      tenant: 'team a/b?c',
      daemonToken: 't',
    });
    const params = new URLSearchParams(openPath.split('?', 2)[1]);
    expect(params.get('tenant')).toBe('team a/b?c');
    expect(openPath).not.toContain('team a/b?c');
  });
});

describe('buildWebShellUrl', () => {
  it('always spells localhost, matching Vite’s bind host', () => {
    expect(
      buildWebShellUrl({
        port: 5174,
        webShellPath:
          '/?managed=1&managedProvider=java&tenant=local-java-demo&token=t',
      }),
    ).toBe(
      'http://localhost:5174/?managed=1&managedProvider=java&tenant=local-java-demo&token=t',
    );
  });
});

describe('buildWebShellLaunch', () => {
  it('carries the token-bearing open path by environment, never by argv', () => {
    const launch = buildWebShellLaunch({
      webShellPath: '/?managed=1&token=TOPSECRET',
      webPort: 5199,
      daemonUrl: 'http://127.0.0.1:4170',
      javaUrl: 'http://127.0.0.1:8080',
    });
    expect(launch.command).toBe('npm');
    expect(launch.args).toEqual([
      'run',
      'dev',
      '--workspace=packages/web-shell',
      '--',
      '--port',
      '5199',
      '--host',
      'localhost',
      '--strictPort',
    ]);
    expect(JSON.stringify(launch.args)).not.toContain('TOPSECRET');
    expect(launch.env.QWEN_WEB_SHELL_OPEN_PATH).toContain('TOPSECRET');
    expect(launch.env.QWEN_DAEMON_URL).toBe('http://127.0.0.1:4170');
    expect(launch.env.QWEN_MANAGED_AGENT_JAVA_URL).toBe(
      'http://127.0.0.1:8080',
    );
    expect(launch.env.PATH).toBe(process.env.PATH);
  });
});

describe('buildSpringRecipeLines', () => {
  const envPath = '/tmp/x/spring.env';
  const ps1Path = '/tmp/x/spring.env.ps1';

  it('prints a POSIX source line and no PowerShell bypass on POSIX', () => {
    const lines = buildSpringRecipeLines({
      isWinPlatform: false,
      springEnvPath: envPath,
      springPs1Path: ps1Path,
    });
    const joined = lines.join('\n');
    expect(joined).toContain(`source "${envPath}"`);
    expect(joined).toContain('export SPRING_DATASOURCE_URL=');
    expect(joined).not.toContain('Set-ExecutionPolicy');
  });

  it('prints an uncommented self-enabling line on Windows, never a bare source', () => {
    const lines = buildSpringRecipeLines({
      isWinPlatform: true,
      springEnvPath: envPath,
      springPs1Path: ps1Path,
    });
    const joined = lines.join('\n');
    expect(joined).toContain('Set-ExecutionPolicy -Scope Process');
    expect(joined).toContain(ps1Path);
    expect(joined).toContain('$env:SPRING_DATASOURCE_URL=');
    expect(joined).not.toContain(`  source "${envPath}"`);
  });

  it('creates the database and user exactly as the reference e2e does', () => {
    const e2eSource = readFileSync(
      path.join(root, 'scripts', 'run-managed-agent-server-e2e.ts'),
      'utf8',
    );
    const clause = e2eSource.match(
      /CREATE DATABASE qwen_managed_agent[^']+unicode_ci/,
    )?.[0];
    expect(clause).toBeTruthy();
    const posix = buildSpringRecipeLines({
      isWinPlatform: false,
      springEnvPath: envPath,
      springPs1Path: ps1Path,
    }).join('\n');
    expect(posix).toContain(clause);
    const readme = readFileSync(
      path.join(
        root,
        'packages',
        'sdk-java',
        'managed-agent-server',
        'README.md',
      ),
      'utf8',
    );
    expect(readme).toContain(clause);
  });
});

describe('script entry', () => {
  it('exits 1 with a clear message on an unsupported option', () => {
    const result = spawnSync(process.execPath, [script, '--bogus'], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Unsupported managed-agent-dev option: --bogus',
    );
  });

  // File symlinks on Windows need a privilege the runner may not grant;
  // the guard logic this pins is platform-agnostic.
  (onWindows ? it.skip : it)(
    'still runs main when invoked through a symlink',
    () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'managed-agent-dev-link-'));
      try {
        const link = path.join(dir, 'managed-agent-dev.js');
        symlinkSync(script, link);
        const result = spawnSync(process.execPath, [link, '--bogus'], {
          encoding: 'utf8',
        });
        // Before realpathSync joined the guard, this invocation exited 0 in
        // silence — resolve() never unwraps the symlink.
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          'Unsupported managed-agent-dev option: --bogus',
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  (onWindows ? it.skip : it)(
    'leaves an importer’s signal semantics untouched',
    () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'managed-agent-dev-probe-'));
      try {
        const probe = path.join(dir, 'probe.mjs');
        writeFileSync(
          probe,
          `await import(${JSON.stringify(pathToFileURL(script).href)});\n` +
            `process.kill(process.pid, 'SIGTERM');\n`,
        );
        const result = spawnSync(process.execPath, [probe], {
          encoding: 'utf8',
        });
        // With top-level handler registration, shutdown(0) ran and the probe
        // exited 0 instead of dying by the signal.
        expect(result.status).not.toBe(0);
        expect(result.signal).toBe('SIGTERM');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
