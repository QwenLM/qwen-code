/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import {
  buildManagedWebShellPath,
  findAvailablePort,
  parseLauncherArgs,
  renderSpringEnv,
} from '../managed-agent-dev.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(__dirname, '..', 'managed-agent-dev.js');

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
});

describe('renderSpringEnv', () => {
  it('exports the four harness wiring values Spring needs', () => {
    const content = renderSpringEnv({
      harnessPort: 4270,
      harnessToken: 'harness-token',
      capabilityDigest: `sha256:${'a'.repeat(64)}`,
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
      `export QWEN_MANAGED_AGENT_CAPABILITY_DIGEST='sha256:${'a'.repeat(64)}'`,
    );
    expect(content.startsWith('#')).toBe(true);
    expect(content.endsWith('\n')).toBe(true);
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
});
