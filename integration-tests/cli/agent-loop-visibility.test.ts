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
  IS_CONTAINER_SANDBOX,
  readDebugLogs,
  TestRig,
} from '../test-helper.js';
import {
  startFakeOpenAIServer,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';

// The debug logger may insert a `[trace_id=… span_id=…]` context between the
// tag and the message when telemetry is active, so allow it optionally and
// capture only the path.
const LOOP_ENTRY =
  /\[LOOP\] (?:\[trace_id=[^\]]*\] )?headless (legacy|shared|kernel)/g;

const headlessPaths = (log: string): string[] =>
  [...log.matchAll(LOOP_ENTRY)].map((match) => match[1]);

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

  async function runHeadless(
    shared: boolean,
    kernel: boolean,
  ): Promise<{ exitCode: number | null; log: string }> {
    await server?.close();
    rig = new TestRig();
    await rig.setup('agent-loop-visibility', {
      settings: {
        experimental: { unifiedAgentLoop: shared, eventBusAgentLoop: kernel },
      },
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
          QWEN_DEBUG_LOG_FILE: '1',
          QWEN_HOME: runtimeDir,
          QWEN_RUNTIME_DIR: runtimeDir,
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
    return { exitCode, log: readDebugLogs(runtimeDir) };
  }

  it('logs the legacy path when both switches are off', async () => {
    const { log } = await runHeadless(false, false);
    expect(headlessPaths(log)).toEqual(['legacy']);
  });

  it('logs the shared path when only the unified switch is on', async () => {
    const { log } = await runHeadless(true, false);
    expect(headlessPaths(log)).toEqual(['shared']);
  });

  it('logs the kernel path when both switches are on', async () => {
    const { log } = await runHeadless(true, true);
    expect(headlessPaths(log)).toEqual(['kernel']);
  });

  it('does not reuse the parity suites counted marker wording', async () => {
    const { log } = await runHeadless(true, false);
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
