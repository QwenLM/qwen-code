/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('./start-server.sh', import.meta.url));

test(
  'combined launcher accepts explicitly disabled Runtime and rejects partial configuration',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'qwen-runtime-disabled-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const launched = join(root, 'launched');
    await mkdir(join(root, 'bin'));
    await writeFile(
      join(root, 'bin', 'java'),
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$QWEN_TEST_LAUNCHED"\n',
      { mode: 0o755 },
    );
    const environment = {
      ...process.env,
      JAVA_HOME: root,
      QWEN_TEST_LAUNCHED: launched,
    };
    delete environment.QWEN_MANAGED_AGENT_RUNTIME_BROKER_ENABLED;
    delete environment.QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY;
    delete environment.QWEN_HOME;
    await execute('/bin/sh', [script, '--spring.profiles.active=test'], {
      env: {
        ...environment,
        QWEN_MANAGED_AGENT_RUNTIME_BROKER_ENABLED: 'false',
      },
    });
    assert.equal(
      await readFile(launched, 'utf8'),
      '-jar\n/app/qwen-managed-agent-server.jar\n--spring.profiles.active=test\n',
    );
    await rm(launched);
    for (const overrides of [
      {},
      { QWEN_MANAGED_AGENT_RUNTIME_BROKER_ENABLED: 'true' },
      { QWEN_MANAGED_AGENT_RUNTIME_BROKER_ENABLED: 'invalid' },
      {
        QWEN_MANAGED_AGENT_RUNTIME_BROKER_ENABLED: 'false',
        QWEN_HOME: join(root, 'home'),
      },
      {
        QWEN_MANAGED_AGENT_RUNTIME_BROKER_ENABLED: 'false',
        QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY: join(root, 'state'),
      },
    ]) {
      await assert.rejects(
        execute('/bin/sh', [script], {
          env: { ...environment, ...overrides },
        }),
      );
      await assert.rejects(stat(launched), { code: 'ENOENT' });
    }
  },
);

test(
  'LOCAL launcher restores private modes and rejects symlinks or unowned entries',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'qwen-runtime-launcher-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const state = join(root, 'state');
    const home = join(root, 'home');
    const bin = join(root, 'bin');
    const launched = join(root, 'launched');
    await mkdir(state);
    await mkdir(bin);
    const record = join(state, 'record.json');
    await writeFile(record, '{}');
    await chmod(state, 0o750);
    await chmod(record, 0o640);
    await writeFile(
      join(bin, 'java'),
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$QWEN_TEST_LAUNCHED"\n',
      { mode: 0o755 },
    );
    const environment = {
      ...process.env,
      JAVA_HOME: root,
      QWEN_HOME: home,
      QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY: state,
      QWEN_TEST_LAUNCHED: launched,
    };
    await execute('/bin/sh', [script], { env: environment });
    assert.equal((await stat(state)).mode & 0o777, 0o700);
    assert.equal((await stat(record)).mode & 0o777, 0o600);
    assert.equal((await stat(home)).mode & 0o777, 0o700);
    assert.equal(
      await readFile(launched, 'utf8'),
      '-jar\n/app/qwen-managed-agent-server.jar\n',
    );

    await rm(launched);
    const link = join(state, 'link');
    await symlink(record, link);
    await assert.rejects(
      execute('/bin/sh', [script], { env: environment }),
      /unsupported entry/,
    );
    await assert.rejects(stat(launched), { code: 'ENOENT' });
    await rm(link);
    await chmod(record, 0o640);
    await writeFile(join(bin, 'id'), '#!/bin/sh\necho 4294967294\n', {
      mode: 0o755,
    });
    await assert.rejects(
      execute('/bin/sh', [script], {
        env: { ...environment, PATH: `${bin}:${process.env.PATH}` },
      }),
      /unowned/,
    );
    assert.equal((await stat(record)).mode & 0o777, 0o640);
  },
);
