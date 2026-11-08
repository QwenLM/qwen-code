/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeFakeConfig } from '../test-utils/config.js';
import type { MonitorRegistry } from '../services/monitorRegistry.js';
import type { ShellConfiguration } from '../utils/shell-utils.js';
import { MonitorTool } from './monitor.js';

const mockGetShellConfiguration = vi.hoisted(() =>
  vi.fn<() => ShellConfiguration>(),
);
vi.mock('../utils/shell-utils.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/shell-utils.js')>();
  return { ...actual, getShellConfiguration: mockGetShellConfiguration };
});

let directory: string | undefined;
let registry: MonitorRegistry | undefined;

afterEach(() => {
  registry?.reset();
  registry = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
  mockGetShellConfiguration.mockReset();
});

it('reports a real asynchronous spawn error through the registry after the initial acknowledgement', async () => {
  directory = mkdtempSync(path.join(os.tmpdir(), 'qwen-monitor-runtime-'));
  mockGetShellConfiguration.mockReturnValue({
    executable: path.join(directory, 'missing-executable'),
    argsPrefix: [],
    shell: 'bash',
  });
  const config = makeFakeConfig({ targetDir: directory, cwd: directory });
  registry = config.getMonitorRegistry();
  const notifications = vi.fn();
  registry.setNotificationCallback(notifications);

  const pendingResult = new MonitorTool(config)
    .build({ command: 'controlled command' })
    .execute(new AbortController().signal);
  expect(registry.getAll()).toHaveLength(1);
  expect(registry.getAll()[0].status).toBe('running');
  expect(registry.getAll()[0].pid).toBeUndefined();

  const result = await pendingResult;
  expect(result.llmContent).toContain('Monitor started.');
  expect(result.error).toBeUndefined();
  await vi.waitFor(() => {
    expect(registry?.getAll()[0]?.status).toBe('failed');
    expect(notifications).toHaveBeenCalledOnce();
  });
  expect(notifications.mock.calls[0][1]).toContain('<status>failed</status>');
  expect(notifications.mock.calls[0][1]).toContain('ENOENT');
  expect(registry.getRunning()).toHaveLength(0);
});
