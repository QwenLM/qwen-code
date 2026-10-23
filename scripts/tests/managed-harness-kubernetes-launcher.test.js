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
  const [{ args, env }] = state.spawned;
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

it('refuses a plaintext Broker URL', async () => {
  state.process.env.QWEN_MANAGED_RUNTIME_BROKER_URL =
    'http://runtime-broker.example.internal';
  await launch();

  expect(state.process.exitCode).toBe(1);
  expect(state.spawned).toHaveLength(0);
  expect(state.errors).toEqual(['The pool requires an HTTPS Broker URL.']);
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
  for (const name of read) expect(set).toContain(name);
});
