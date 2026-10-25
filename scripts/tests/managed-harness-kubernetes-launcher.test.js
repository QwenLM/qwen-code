/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const kubernetes = path.join(
  root,
  'packages/managed-agent-server/distribution/kubernetes',
);
const launcher = path.join(kubernetes, 'harness-launcher.mjs');
const brokerUrl = 'https://runtime-broker.example.internal';

// The launcher runs on import; these stand in for the Pod it expects.
const state = vi.hoisted(() => ({
  process: undefined,
  errors: [],
  spawned: [],
}));
vi.mock('node:process', () => ({
  default: new Proxy(
    {},
    {
      get: (_target, key) => state.process[key],
      set: (_target, key, value) => {
        state.process[key] = value;
        return true;
      },
    },
  ),
}));
vi.mock('node:console', () => ({
  default: { error: (message) => state.errors.push(message) },
}));
vi.mock('node:child_process', () => ({
  spawn: (command, args, options) => {
    state.spawned.push({ command, args, env: options.env });
    return { once() {}, kill() {} };
  },
}));
vi.mock('node:fs/promises', () => ({
  mkdir: async () => undefined,
  readFile: async (file) =>
    ({
      'harness-token': 'harness-secret\n',
      'broker-token': 'broker-secret\n',
      'model-api-key': 'model-secret\n',
    })[path.posix.basename(file)],
}));

beforeEach(() => {
  state.errors = [];
  state.spawned = [];
  state.process = {
    env: {
      PATH: '/usr/bin',
      QWEN_HOSTED_HARNESS_INSTANCE_ID: 'pod-uid-1',
      QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST: `sha256:${'a'.repeat(64)}`,
      QWEN_MANAGED_RUNTIME_BROKER_URL: brokerUrl,
    },
    exitCode: undefined,
    on() {},
  };
});

async function launch() {
  vi.resetModules();
  await import(launcher);
}

it('hands qwen serve only Broker variables that serve removes from its environment', async () => {
  await launch();

  expect(state.errors).toEqual([]);
  expect(state.process.exitCode).toBeUndefined();
  expect(state.spawned).toHaveLength(1);
  const [{ command, args, env }] = state.spawned;
  // serve.ts deletes both unconditionally; the profile is what makes
  // validateHostedHarnessProfile accept them, and a launch without it exits
  // instead of starting a default daemon.
  expect(command).toBe('/usr/local/bin/qwen');
  expect(args).toEqual([
    'serve',
    '--profile',
    'hosted-harness',
    '--http-bridge',
    '--no-web',
    '--hostname',
    '127.0.0.1',
    '--port',
    '4170',
    '--workspace',
    '/var/run/qwen/workspace',
  ]);
  expect(env.QWEN_MANAGED_RUNTIME_BROKER_URL).toBe(brokerUrl);
  expect(env.QWEN_MANAGED_RUNTIME_BROKER_TOKEN).toBe('broker-secret');
  expect(args.join(' ')).not.toContain('broker-secret');
  // Anything left in the serve process environment reaches every process it starts.
  const removed = [
    ...readFileSync(
      path.join(root, 'packages/cli/src/commands/serve.ts'),
      'utf8',
    ).matchAll(/delete process\.env\['([A-Z0-9_]+)'\]/g),
  ].map((match) => match[1]);
  const brokerKeys = Object.keys(env).filter((key) => key.includes('BROKER'));
  expect(brokerKeys.length).toBeGreaterThan(0);
  for (const key of brokerKeys) expect(removed).toContain(key);
});

it('names a missing Broker URL', async () => {
  delete state.process.env.QWEN_MANAGED_RUNTIME_BROKER_URL;
  await launch();

  expect(state.process.exitCode).toBe(1);
  expect(state.spawned).toHaveLength(0);
  expect(state.errors).toEqual([
    'The pool requires a Broker URL in QWEN_MANAGED_RUNTIME_BROKER_URL.',
  ]);
});

// The v0.26.1 manifest sets the old name, which nothing reads any more.
it('names the rename for a manifest that sets the old Broker URL name', async () => {
  delete state.process.env.QWEN_MANAGED_RUNTIME_BROKER_URL;
  state.process.env.QWEN_HOSTED_HARNESS_BROKER_URL = brokerUrl;
  await launch();

  expect(state.process.exitCode).toBe(1);
  expect(state.spawned).toHaveLength(0);
  expect(state.errors).toEqual([
    'The pool requires a Broker URL in QWEN_MANAGED_RUNTIME_BROKER_URL; rename QWEN_HOSTED_HARNESS_BROKER_URL in the Deployment.',
  ]);
});

it('names a Broker URL that does not parse', async () => {
  state.process.env.QWEN_MANAGED_RUNTIME_BROKER_URL =
    'runtime-broker.example.internal';
  await launch();

  expect(state.process.exitCode).toBe(1);
  expect(state.spawned).toHaveLength(0);
  expect(state.errors).toEqual([
    'The pool requires a valid Broker URL in QWEN_MANAGED_RUNTIME_BROKER_URL.',
  ]);
});

it.each([
  'http://runtime-broker.example.internal',
  'https://user@runtime-broker.example.internal',
  'https://user:secret@runtime-broker.example.internal',
  'https://runtime-broker.example.internal/?token=x',
  'https://runtime-broker.example.internal/#x',
])('refuses %s as a Broker URL', async (url) => {
  state.process.env.QWEN_MANAGED_RUNTIME_BROKER_URL = url;
  await launch();

  expect(state.process.exitCode).toBe(1);
  expect(state.spawned).toHaveLength(0);
  expect(state.errors).toEqual([
    'The pool requires an HTTPS Broker URL in QWEN_MANAGED_RUNTIME_BROKER_URL.',
  ]);
});

it('refuses a Broker URL with a path, which qwen serve refuses at boot', async () => {
  state.process.env.QWEN_MANAGED_RUNTIME_BROKER_URL = `${brokerUrl}/broker`;
  await launch();

  expect(state.process.exitCode).toBe(1);
  expect(state.spawned).toHaveLength(0);
  expect(state.errors).toEqual([
    'The pool requires an origin-only Broker URL in QWEN_MANAGED_RUNTIME_BROKER_URL.',
  ]);
});

it('sets every variable the launcher reads in the Harness container', () => {
  const read = new Set(
    [
      ...readFileSync(launcher, 'utf8').matchAll(/process\.env\.([A-Z0-9_]+)/g),
    ].map((match) => match[1]),
  );
  const pool = parse(
    readFileSync(path.join(kubernetes, 'harness-pool.yaml'), 'utf8'),
  );
  const harness = pool.spec.template.spec.containers.find(
    (container) => container.name === 'harness',
  );
  const set = harness.env.map((variable) => variable.name);
  expect(read).toContain('QWEN_MANAGED_RUNTIME_BROKER_URL');
  // Read only to name the rename for an older manifest.
  const retired = ['QWEN_HOSTED_HARNESS_BROKER_URL'];
  for (const name of retired) {
    expect(read).toContain(name);
    expect(set).not.toContain(name);
  }
  for (const name of read) {
    if (!retired.includes(name)) expect(set).toContain(name);
  }
});
