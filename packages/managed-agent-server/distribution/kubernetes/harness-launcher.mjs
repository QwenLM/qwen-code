/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import console from 'node:console';
import { mkdir, readFile } from 'node:fs/promises';
import process from 'node:process';
import { URL } from 'node:url';

const secrets = '/etc/qwen/secrets';
const runtime = '/var/run/qwen';

async function secret(name) {
  const value = (await readFile(`${secrets}/${name}`, 'utf8')).trim();
  if (!value || /[\r\n\0]/u.test(value))
    throw new Error(`Invalid ${name} secret file.`);
  return value;
}

try {
  if (
    !/^[A-Za-z0-9._:-]{1,128}$/u.test(
      process.env.QWEN_HOSTED_HARNESS_INSTANCE_ID ?? '',
    )
  )
    throw new Error('A Pod instance identity is required.');
  if (
    !/^sha256:[0-9a-f]{64}$/u.test(
      process.env.QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST ?? '',
    )
  )
    throw new Error('A verified capability digest is required.');
  // Name the variable, never its value: the name changed, and the v0.26.1
  // manifest still sets QWEN_HOSTED_HARNESS_BROKER_URL.
  const brokerUrlText = process.env.QWEN_MANAGED_RUNTIME_BROKER_URL;
  if (!brokerUrlText)
    throw new Error(
      process.env.QWEN_HOSTED_HARNESS_BROKER_URL
        ? 'The pool requires a Broker URL in QWEN_MANAGED_RUNTIME_BROKER_URL; rename QWEN_HOSTED_HARNESS_BROKER_URL in the Deployment.'
        : 'The pool requires a Broker URL in QWEN_MANAGED_RUNTIME_BROKER_URL.',
    );
  let brokerUrl;
  try {
    brokerUrl = new URL(brokerUrlText);
  } catch {
    throw new Error(
      'The pool requires a valid Broker URL in QWEN_MANAGED_RUNTIME_BROKER_URL.',
    );
  }
  if (
    brokerUrl.protocol !== 'https:' ||
    brokerUrl.username ||
    brokerUrl.password ||
    brokerUrl.search ||
    brokerUrl.hash
  )
    throw new Error(
      'The pool requires an HTTPS Broker URL in QWEN_MANAGED_RUNTIME_BROKER_URL.',
    );
  // qwen serve takes an origin only, and would stop at boot without naming
  // the variable.
  if (brokerUrl.pathname !== '/' && brokerUrl.pathname !== '')
    throw new Error(
      'The pool requires an origin-only Broker URL in QWEN_MANAGED_RUNTIME_BROKER_URL.',
    );
  await Promise.all(
    ['home', 'state', 'workspace'].map((name) =>
      mkdir(`${runtime}/${name}`, { recursive: true, mode: 0o700 }),
    ),
  );
  const child = spawn(
    '/usr/local/bin/qwen',
    [
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
      `${runtime}/workspace`,
    ],
    {
      cwd: `${runtime}/workspace`,
      stdio: 'inherit',
      env: {
        ...process.env,
        HOME: `${runtime}/home`,
        QWEN_HOME: `${runtime}/state`,
        QWEN_CODE_SYSTEM_SETTINGS_PATH: '/etc/qwen/config/settings.json',
        QWEN_SERVER_TOKEN: await secret('harness-token'),
        QWEN_MANAGED_RUNTIME_BROKER_TOKEN: await secret('broker-token'),
        OPENAI_API_KEY: await secret('model-api-key'),
      },
    },
  );
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.on(signal, () => child.kill(signal));
  child.once('error', () => {
    console.error('Hosted Harness child could not start.');
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
} catch (error) {
  // Never print child environment or secret file contents.
  console.error(
    error instanceof Error && error.message.startsWith('The pool')
      ? error.message
      : 'Hosted Harness configuration or secret files are invalid.',
  );
  process.exitCode = 1;
}
