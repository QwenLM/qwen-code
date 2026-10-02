/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import {
  buildHarnessWiring,
  buildKillPlan,
  buildManagedWebShellPath,
  buildServeStages,
  buildWebShellLaunch,
  buildWebShellUrl,
  findAvailablePort,
  generateHarnessSecrets,
  healthFailureAction,
  parseLauncherArgs,
  renderSpringEnv,
  renderSpringPs1Env,
  springEnvFilePath,
  springEnvReuseWarning,
  waitForHttpOk,
} from '../managed-agent-dev.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const script = path.join(__dirname, '..', 'managed-agent-dev.js');

const VALID_DIGEST = `sha256:${'a'.repeat(64)}`;

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

  it('walks past a port Vite already holds on the localhost family', async () => {
    // Vite binds 'localhost'; on IPv6-first hosts that is ::1 only, so a
    // 127.0.0.1 probe would call the held port free and Vite would silently
    // bump past the probed value (observed in a two-launcher dry run).
    const viteStandIn = net.createServer();
    await new Promise((resolveListen) =>
      viteStandIn.listen(0, 'localhost', resolveListen),
    );
    const held = viteStandIn.address().port;
    try {
      const found = await findAvailablePort(held, new Set(), 'localhost');
      expect(found).not.toBe(held);
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
      `$env:QWEN_MANAGED_AGENT_HARNESS_BASE_URL='http://127.0.0.1:4270'`,
    );
    expect(content).toContain(
      `$env:QWEN_MANAGED_AGENT_HARNESS_TOKEN='harness-token'`,
    );
    expect(content).toContain(
      `$env:QWEN_MANAGED_AGENT_CAPABILITY_DIGEST='${VALID_DIGEST}'`,
    );
    expect(content.endsWith('\n')).toBe(true);
  });
});

describe('springEnvFilePath', () => {
  it('never resolves inside the served workspace', () => {
    expect(springEnvFilePath().startsWith(root + path.sep)).toBe(false);
  });
});

describe('springEnvReuseWarning', () => {
  it('warns only when the file pre-existed', () => {
    expect(springEnvReuseWarning(false)).toBeNull();
    expect(springEnvReuseWarning(true)).toContain('old harness token');
  });
});

describe('generateHarnessSecrets', () => {
  it('mints a 32-hex token and a sha256 digest the harness profile accepts', () => {
    const secrets = generateHarnessSecrets();
    expect(secrets.harnessToken).toMatch(/^[0-9a-f]{32}$/);
    expect(secrets.capabilityDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
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
    // The pairing cannot drift to two sources: mutating one consumer away
    // from the shared input turns this red (R1-13).
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
});

describe('buildServeStages', () => {
  const wiring = buildHarnessWiring({
    harnessPort: 4270,
    workspace: '/ws',
    harnessToken: 'harness-token',
    capabilityDigest: VALID_DIGEST,
  });
  const stages = buildServeStages({
    workspace: '/ws',
    daemonPort: 4170,
    daemonToken: 'daemon-token',
    serveEnv: { MARKER: '1' },
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

describe('healthFailureAction', () => {
  it('continues past a Spring timeout but aborts on owned children', () => {
    expect(healthFailureAction('java')).toBe('continue');
    expect(healthFailureAction('daemon')).toBe('abort');
    expect(healthFailureAction('harness')).toBe('abort');
    expect(healthFailureAction('anything-else')).toBe('abort');
  });
});

describe('waitForHttpOk', () => {
  function serve(statusCode, body = '{}') {
    const server = http.createServer((_req, res) => {
      res.writeHead(statusCode, { 'content-type': 'application/json' });
      res.end(body);
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

  it('reports the last connection error when nothing answers', async () => {
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
    ).rejects.toThrow(/last error: /);
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
      ).rejects.toThrow(/digest mismatch/);
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
  it('composes the full Managed URL for the printed banner', () => {
    expect(
      buildWebShellUrl({
        host: '127.0.0.1',
        port: 5174,
        webShellPath:
          '/?managed=1&managedProvider=java&tenant=local-java-demo&token=t',
      }),
    ).toBe(
      'http://127.0.0.1:5174/?managed=1&managedProvider=java&tenant=local-java-demo&token=t',
    );
  });
});

describe('buildWebShellLaunch', () => {
  it('carries the token-bearing open path by environment, never by argv', () => {
    const launch = buildWebShellLaunch({
      webShellPath: '/?managed=1&token=TOPSECRET',
      webPort: 5174,
      daemonUrl: 'http://127.0.0.1:4170',
      javaUrl: 'http://127.0.0.1:8080',
    });
    expect(launch.command).toBe('npm');
    expect(launch.args).toContain('--port');
    expect(JSON.stringify(launch.args)).not.toContain('TOPSECRET');
    expect(launch.env.QWEN_WEB_SHELL_OPEN_PATH).toContain('TOPSECRET');
    expect(launch.env.QWEN_DAEMON_URL).toBe('http://127.0.0.1:4170');
    expect(launch.env.QWEN_MANAGED_AGENT_JAVA_URL).toBe(
      'http://127.0.0.1:8080',
    );
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
  (process.platform === 'win32' ? it.skip : it)(
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

  (process.platform === 'win32' ? it.skip : it)(
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
