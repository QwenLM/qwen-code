/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for child-process environment scrubbing.
 *
 * Unlike the unit tests in child-env-scrub.test.ts (which verify the pure
 * scrubChildEnv() helper in isolation), these tests spawn REAL child
 * processes through production code paths and inspect the child's actual
 * environment output.
 *
 * This proves that the spawn/PTY boundary - not just the helper function -
 * uses the sanitized environment.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import os from 'node:os';
import {
  collectSensitiveShellEnvKeys,
  scrubChildEnv,
} from './child-env-scrub.js';
import { ShellExecutionService } from '../services/shellExecutionService.js';

// ---------------------------------------------------------------------------
// Env seeding helpers
// ---------------------------------------------------------------------------

const SEED_TOKEN_SCRUBBED = 'qwen-integration-scrubbed-token-do-not-leak';
const SEED_TOKEN_PRESERVED = 'gh-integration-allowed-token-must-survive';

const seededKeys: string[] = [];

function seedEnv() {
  setSeedVar('QWEN_SERVER_TOKEN', SEED_TOKEN_SCRUBBED);
  setSeedVar('GH_TOKEN', SEED_TOKEN_PRESERVED);
}

function setSeedVar(key: string, value: string) {
  if (!seededKeys.includes(key)) seededKeys.push(key);
  process.env[key] = value;
}

afterEach(() => {
  for (const key of seededKeys) {
    delete process.env[key];
  }
  seededKeys.length = 0;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spawn a real `node -e` child that dumps its env as JSON to stdout.
 * Returns the parsed env object.
 */
function spawnEnvDump(
  childEnv: NodeJS.ProcessEnv,
): Promise<Record<string, string | undefined>> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
      { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr!.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Child exited with code ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(
          new Error(`Failed to parse child env JSON: ${(e as Error).message}`),
        );
      }
    });
  });
}

/**
 * Build the command string for ShellExecutionService.execute() that dumps
 * the child env as JSON. Uses plain `node` (always on PATH) rather than
 * `process.execPath` because the Windows-style absolute path is not
 * understood by bash/Git Bash on Windows.
 */
function envDumpShellCommand(): string {
  return `node -e "process.stdout.write(JSON.stringify(process.env))"`;
}

// ---------------------------------------------------------------------------
// Tests: direct child_process.spawn (covers tool-registry, monitor, mcp
// patterns - all use scrubChildEnv -> spawn with array args)
// ---------------------------------------------------------------------------

describe('integration: child_process.spawn with scrubbed env', () => {
  it('shell-tool denylist: strips QWEN_SERVER_TOKEN, preserves GH_TOKEN', async () => {
    seedEnv();

    const childEnv = scrubChildEnv(
      process.env,
      collectSensitiveShellEnvKeys(process.env),
    );

    const env = await spawnEnvDump(childEnv);

    expect(env['QWEN_SERVER_TOKEN']).toBeUndefined();
    expect(env['GH_TOKEN']).toBe(SEED_TOKEN_PRESERVED);
  });

  it('ACP policy strips daemon secrets and preserves provider keys', async () => {
    seedEnv();
    // Simulate a provider API key that the ACP child MUST inherit.
    setSeedVar('OPENAI_API_KEY', 'sk-test-provider-key');

    // Mirror the ACP spawnChannel daemon-secret denylist.
    const ACP_SCRUBBED_KEYS = new Set([
      'QWEN_SERVER_TOKEN',
      'QWEN_DAEMON_TOKEN',
      'QWEN_CODE_SIMPLE',
    ]);

    const childEnv = scrubChildEnv(process.env, ACP_SCRUBBED_KEYS);
    const env = await spawnEnvDump(childEnv);

    expect(env['QWEN_SERVER_TOKEN']).toBeUndefined();
    expect(env['GH_TOKEN']).toBe(SEED_TOKEN_PRESERVED);
    expect(env['OPENAI_API_KEY']).toBe('sk-test-provider-key');
  });

  it('overrides cannot re-introduce scrubbed keys via real spawn', async () => {
    seedEnv();

    const childEnv = scrubChildEnv(
      process.env,
      collectSensitiveShellEnvKeys(process.env),
      {
        QWEN_SERVER_TOKEN: 'smuggled-via-override',
        EXTRA_INJECTED: 'should-exist',
      },
    );

    const env = await spawnEnvDump(childEnv);

    expect(env['QWEN_SERVER_TOKEN']).toBeUndefined();
    expect(env['EXTRA_INJECTED']).toBe('should-exist');
    expect(env['GH_TOKEN']).toBe(SEED_TOKEN_PRESERVED);
  });

  it('collectSensitiveShellEnvKeys + scrubChildEnv strips QWEN_CUSTOM_API_KEY_* variants', async () => {
    seedEnv();
    setSeedVar('QWEN_CUSTOM_API_KEY_EXAMPLE_COM', 'custom-provider-secret');

    const childEnv = scrubChildEnv(
      process.env,
      collectSensitiveShellEnvKeys(process.env),
    );

    const env = await spawnEnvDump(childEnv);

    expect(env['QWEN_SERVER_TOKEN']).toBeUndefined();
    expect(env['QWEN_CUSTOM_API_KEY_EXAMPLE_COM']).toBeUndefined();
    expect(env['GH_TOKEN']).toBe(SEED_TOKEN_PRESERVED);
  });
});

// ---------------------------------------------------------------------------
// Tests: ShellExecutionService.execute() - child_process fallback path
// ---------------------------------------------------------------------------

describe('integration: ShellExecutionService child_process path', () => {
  it('strips QWEN_SERVER_TOKEN from the spawned child environment', async () => {
    seedEnv();

    const ac = new AbortController();
    const command = envDumpShellCommand();

    const handle = await ShellExecutionService.execute(
      command,
      os.tmpdir(),
      () => {},
      ac.signal,
      false, // shouldUseNodePty: false -> child_process fallback
      {},
    );

    const result = await handle.result;
    expect(result.error).toBeNull();
    expect(result.executionMethod).toBe('child_process');

    // Parse the JSON env dump from the child's stdout.
    const childEnv = JSON.parse(result.output);
    expect(childEnv['QWEN_SERVER_TOKEN']).toBeUndefined();
    expect(childEnv['GH_TOKEN']).toBe(SEED_TOKEN_PRESERVED);
    // Verify the shell override QWEN_CODE=1 is injected.
    expect(childEnv['QWEN_CODE']).toBe('1');
  });

  it('does not leak the scrubbed token value anywhere in the output', async () => {
    seedEnv();

    const ac = new AbortController();
    const command = envDumpShellCommand();

    const handle = await ShellExecutionService.execute(
      command,
      os.tmpdir(),
      () => {},
      ac.signal,
      false,
      {},
    );

    const result = await handle.result;
    expect(result.output).not.toContain(SEED_TOKEN_SCRUBBED);
    expect(result.output).toContain(SEED_TOKEN_PRESERVED);
  });
});

// ---------------------------------------------------------------------------
// Tests: ShellExecutionService.execute() - PTY path
// ---------------------------------------------------------------------------

describe('integration: ShellExecutionService PTY path', () => {
  it('strips QWEN_SERVER_TOKEN from the PTY child environment', async () => {
    seedEnv();

    const ac = new AbortController();
    const command = envDumpShellCommand();

    const handle = await ShellExecutionService.execute(
      command,
      os.tmpdir(),
      () => {},
      ac.signal,
      true, // shouldUseNodePty: true -> PTY path
      {},
    );

    const result = await handle.result;

    // If PTY is not available, the service falls back to child_process.
    // That path is already covered by the child_process tests above.
    if (result.executionMethod === 'child_process') {
      // PTY not available - verify the fallback still scrubs correctly.
      const childEnv = JSON.parse(result.output);
      expect(childEnv['QWEN_SERVER_TOKEN']).toBeUndefined();
      expect(childEnv['GH_TOKEN']).toBe(SEED_TOKEN_PRESERVED);
      return;
    }

    // PTY output may include ANSI escape codes, shell prompts, and \r\n.
    // The JSON env dump might not parse cleanly, so use string assertions.
    expect(result.output).not.toContain(SEED_TOKEN_SCRUBBED);
    expect(result.output).toContain(SEED_TOKEN_PRESERVED);
  });
});
