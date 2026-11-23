/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Block B slice 3 (#17045): every surface's resolved loop path must be
 * provable from the debug log. The headless surface logs a uniform
 * `[LOOP] headless <path>` entry marker for legacy, shared, and kernel. The
 * wording is deliberately distinct from the parity suites' counted markers so
 * it cannot inflate their arm-identity counts.
 */

import { spawn } from 'node:child_process';
import { cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONTAINER_SANDBOX_NO_PROXY,
  fakeServerHostOptions,
  headlessLoopPaths,
  IS_CONTAINER_SANDBOX,
  readDebugLogs,
  TestRig,
} from '../test-helper.js';
import {
  startFakeOpenAIServer,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';

describe('agent loop visibility (headless entry marker)', () => {
  let rig: TestRig;
  let server: FakeOpenAIServer | undefined;

  beforeEach(() => {
    const noProxy = IS_CONTAINER_SANDBOX
      ? CONTAINER_SANDBOX_NO_PROXY
      : '127.0.0.1,localhost';
    vi.stubEnv('NO_PROXY', noProxy);
    vi.stubEnv('no_proxy', noProxy);
    vi.stubEnv('QWEN_CODE_ENABLE_UNIFIED_AGENT_LOOP', undefined);
    vi.stubEnv('QWEN_CODE_ENABLE_EVENT_BUS_AGENT_LOOP', undefined);
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    vi.unstubAllEnvs();
    await rig?.cleanup();
  });

  async function runHeadless(experimental?: {
    unifiedAgentLoop: boolean;
    eventBusAgentLoop: boolean;
  }): Promise<string> {
    await server?.close();
    rig = new TestRig();
    await rig.setup('agent-loop-visibility', {
      settings: experimental ? { experimental } : {},
    });
    const dir = rig.testDir!;
    server = await startFakeOpenAIServer(({ body }) => {
      if (body['stream'] !== true)
        return { content: '{"selected_memories":[]}' };
      return { content: 'Hello!' };
    }, fakeServerHostOptions());
    const runtimeDir = `${dir}-runtime`;
    rmSync(runtimeDir, { recursive: true, force: true });
    cpSync(join(dir, '.qwen-home'), runtimeDir, { recursive: true });
    const child = spawn(
      'node',
      [
        rig.bundlePath,
        '--no-chat-recording',
        '--yolo',
        '--prompt',
        'Say hello',
        '--output-format',
        'json',
        '--auth-type',
        'openai',
        '--model',
        'fake-model',
        '--openai-base-url',
        server.baseUrl,
        '--openai-api-key',
        'fake-key',
      ],
      {
        cwd: dir,
        stdio: 'pipe',
        env: {
          ...process.env,
          HOME: runtimeDir,
          USERPROFILE: runtimeDir,
          QWEN_DEBUG_LOG_FILE: '1',
          QWEN_HOME: runtimeDir,
          QWEN_RUNTIME_DIR: runtimeDir,
          QWEN_CODE_SYSTEM_SETTINGS_PATH: join(dir, 'system-settings.json'),
          QWEN_CODE_SYSTEM_DEFAULTS_PATH: join(dir, 'system-defaults.json'),
        },
      },
    );
    child.stdin.end();
    let stderr = '';
    child.stderr.on('data', (data: Buffer) => (stderr += data));
    child.stdout.resume();
    const exitCode = await new Promise<number | null>((resolve) =>
      child.on('close', resolve),
    );
    expect(exitCode, `headless run failed: ${stderr}`).toBe(0);
    return readDebugLogs(runtimeDir);
  }

  it('runs headless on the kernel when both switches are unset', async () => {
    const log = await runHeadless();
    expect(headlessLoopPaths(log)).toEqual(['kernel']);
    expect(log).toContain('runAgentLoopOnBus started');
  });

  it('logs the legacy path when both switches are off', async () => {
    const log = await runHeadless({
      unifiedAgentLoop: false,
      eventBusAgentLoop: false,
    });
    expect(headlessLoopPaths(log)).toEqual(['legacy']);
  });

  it('logs the shared path when only the unified switch is on', async () => {
    const log = await runHeadless({
      unifiedAgentLoop: true,
      eventBusAgentLoop: false,
    });
    expect(headlessLoopPaths(log)).toEqual(['shared']);
  });

  it('logs the kernel path when both switches are on', async () => {
    const log = await runHeadless({
      unifiedAgentLoop: true,
      eventBusAgentLoop: true,
    });
    expect(headlessLoopPaths(log)).toEqual(['kernel']);
  });

  it('does not reuse the parity suites counted marker wording', async () => {
    const log = await runHeadless({
      unifiedAgentLoop: true,
      eventBusAgentLoop: false,
    });
    // The entry marker must not contain the substrings the parity suites
    // count for arm identity, or it would inflate those counts.
    const entryLines = log
      .split('\n')
      .filter((line) => line.includes('[LOOP]') && line.includes('headless'));
    expect(entryLines.length).toBeGreaterThan(0);
    for (const line of entryLines) {
      expect(line).not.toContain('on the shared agent loop');
      expect(line).not.toContain('runAgentLoopOnBus started');
    }
  });
});
