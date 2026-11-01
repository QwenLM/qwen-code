/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yargs from 'yargs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { batchCommand } from './batch.js';
import { BatchTaskStore } from './batch-task.js';
import {
  resetEnvironmentTrackingForTesting,
  resetHomeEnvBootstrapForTesting,
} from '../config/settings.js';
import { resetTrustedFoldersForTesting } from '../config/trustedFolders.js';

const isolated = vi.hoisted(() => ({ home: '' }));

vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:os')>();
  return {
    ...original,
    homedir: () => isolated.home,
    default: { ...original.default, homedir: () => isolated.home },
  };
});

describe('local batch commands with real settings loading', () => {
  let root: string;
  let workspace: string;
  let userSettings: string;
  let configured: string;
  let previousEnvironment: NodeJS.ProcessEnv;
  let previousExitCode: typeof process.exitCode;
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    previousEnvironment = { ...process.env };
    previousExitCode = process.exitCode;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-batch-local-env-'));
    workspace = path.join(root, 'workspace');
    isolated.home = path.join(root, 'home');
    const qwenHome = path.join(isolated.home, '.qwen');
    configured = path.join(root, 'configured');
    for (const dir of [workspace, qwenHome, configured]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    process.env = {
      ...previousEnvironment,
      QWEN_HOME: qwenHome,
      QWEN_RUNTIME_DIR: path.join(root, 'runtime'),
      QWEN_CODE_SYSTEM_SETTINGS_PATH: path.join(root, 'system.json'),
      QWEN_CODE_SYSTEM_DEFAULTS_PATH: path.join(root, 'defaults.json'),
      QWEN_CODE_TRUSTED_FOLDERS_PATH: path.join(root, 'trust.json'),
    };
    delete process.env['QWEN_BATCH_HOME'];
    userSettings = path.join(qwenHome, 'settings.json');
    fs.writeFileSync(userSettings, '{}');
    fs.writeFileSync(
      path.join(qwenHome, '.env'),
      `QWEN_BATCH_HOME=${configured.replaceAll('\\', '/')}\n`,
    );
    fs.writeFileSync(
      path.join(root, 'trust.json'),
      JSON.stringify({ [workspace]: 'TRUST_FOLDER' }),
    );
    resetEnvironmentTrackingForTesting();
    resetHomeEnvBootstrapForTesting();
    resetTrustedFoldersForTesting();
    vi.spyOn(process, 'cwd').mockReturnValue(workspace);
    stdout = [];
    stderr = [];
    const capture = (target: string[]) =>
      ((
        chunk: unknown,
        encodingOrCallback?: unknown,
        callback?: () => void,
      ) => {
        target.push(String(chunk));
        const done =
          typeof encodingOrCallback === 'function'
            ? encodingOrCallback
            : callback;
        if (typeof done === 'function') done();
        return true;
      }) as typeof process.stdout.write;
    vi.spyOn(process.stdout, 'write').mockImplementation(capture(stdout));
    vi.spyOn(process.stderr, 'write').mockImplementation(capture(stderr));
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('Local batch commands must not access the network'),
    );
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = previousEnvironment;
    process.exitCode = previousExitCode;
    resetEnvironmentTrackingForTesting();
    resetHomeEnvBootstrapForTesting();
    resetTrustedFoldersForTesting();
    const resolvedRoot = path.resolve(root);
    if (
      path.dirname(resolvedRoot) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolvedRoot).startsWith('qwen-batch-local-env-')
    ) {
      throw new Error('Unexpected fixture root');
    }
    fs.rmSync(resolvedRoot, { recursive: true, force: true });
  });

  const createTask = (directory: string, name: string) => {
    const store = new BatchTaskStore(directory);
    const task = store.create(
      {
        schemaVersion: 1,
        name,
        kind: 'text',
        shared: { instructions: 'Translate' },
        items: [{ id: 'a', source: 'a.md', target: 'b.md' }],
      },
      workspace,
      'qwen-plus',
    );
    return { store, task };
  };

  it.each(
    (['user-env', 'invalid-workspace', 'invalid-user'] as const).flatMap(
      (source) =>
        (['list', 'clean'] as const).map((command) => ({ source, command })),
    ),
  )(
    '$source: $command uses the available local task home',
    async ({ source, command }) => {
      const invalidBytes = '{\n  "theme": "dark",\n}\n';
      const workspaceSettings = path.join(workspace, '.qwen', 'settings.json');
      if (source === 'invalid-workspace') {
        fs.mkdirSync(path.dirname(workspaceSettings), { recursive: true });
        fs.writeFileSync(workspaceSettings, invalidBytes);
      } else if (source === 'invalid-user') {
        fs.writeFileSync(userSettings, invalidBytes);
      }
      const configuredTask = createTask(configured, 'configured');
      const fallbackTask = createTask(
        path.join(isolated.home, '.qwen', 'batch'),
        'fallback',
      );
      // Invalid user settings can throw before env files load. Local commands
      // must still operate on the fallback store, without pretending env loaded.
      const expected =
        source === 'invalid-user' ? fallbackTask : configuredTask;
      const other = source === 'invalid-user' ? configuredTask : fallbackTask;
      await yargs(
        command === 'list'
          ? ['batch', 'list']
          : ['batch', 'clean', expected.task.id],
      )
        .command(batchCommand)
        .exitProcess(false)
        .fail(false)
        .parseAsync();

      expect(process.exitCode).toBeUndefined();
      expect(globalThis.fetch).not.toHaveBeenCalled();
      if (command === 'list') {
        expect(stdout.join('')).toContain(expected.task.id);
        expect(stdout.join('')).not.toContain(other.task.id);
        expect(fs.existsSync(expected.store.fileOf(expected.task.id))).toBe(
          true,
        );
      } else {
        expect(fs.existsSync(expected.store.fileOf(expected.task.id))).toBe(
          false,
        );
      }
      expect(fs.existsSync(other.store.fileOf(other.task.id))).toBe(true);
      if (source === 'invalid-user') {
        expect(process.env['QWEN_BATCH_HOME']).toBeUndefined();
        expect(fs.readFileSync(userSettings, 'utf8')).toBe(invalidBytes);
      } else {
        expect(path.resolve(process.env['QWEN_BATCH_HOME']!)).toBe(configured);
      }
      if (source === 'invalid-workspace') {
        expect(fs.readFileSync(workspaceSettings, 'utf8')).toBe(invalidBytes);
        expect(fs.existsSync(`${workspaceSettings}.corrupted`)).toBe(false);
      }
      if (source !== 'user-env') {
        expect(stderr.join('')).toContain(
          'warning: Could not load batch settings',
        );
      }
    },
  );
});
