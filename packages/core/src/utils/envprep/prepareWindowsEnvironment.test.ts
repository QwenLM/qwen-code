/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, expect, it, vi } from 'vitest';

const installer = vi.hoisted(() => ({
  loaded: vi.fn(),
  stop: vi.fn(async () => {}),
  schedule: vi.fn(),
}));
vi.mock('./backgroundPreparation.js', () => {
  installer.loaded();
  return { scheduleBackgroundPreparation: installer.schedule };
});

import { prepareWindowsEnvironment } from '../../../index.js';
import type { WindowsEnvironmentUrls } from './types.js';

afterEach(() => vi.restoreAllMocks());

it('keeps the Core entry lazy and loads the installer only for Windows preparation', async () => {
  expect(installer.loaded).not.toHaveBeenCalled();
  const platform = vi.spyOn(process, 'platform', 'get');
  for (const name of ['darwin', 'linux'] as const) {
    platform.mockReturnValue(name);
    const stop = await prepareWindowsEnvironment(new AbortController().signal);
    await stop();
    expect(installer.loaded).not.toHaveBeenCalled();
  }

  platform.mockReturnValue('win32');
  const aborted = new AbortController();
  aborted.abort();
  await expect(prepareWindowsEnvironment(aborted.signal)).rejects.toBe(
    aborted.signal.reason,
  );
  expect(installer.loaded).not.toHaveBeenCalled();

  const sources: WindowsEnvironmentUrls = {
    gitBashPrimaryUrl: 'https://example.com/PortableGit.7z.exe',
    gitBashFallbackUrl: 'https://example.com/fallback/PortableGit.7z.exe',
    sevenZrPrimaryUrl: 'https://example.com/7zr.exe',
    sevenZrFallbackUrl: 'https://example.com/fallback/7zr.exe',
  };
  const signal = new AbortController().signal;
  installer.schedule.mockReturnValue(installer.stop);
  await expect(prepareWindowsEnvironment(signal, sources)).resolves.toBe(
    installer.stop,
  );
  expect(installer.loaded).toHaveBeenCalledOnce();
  expect(installer.schedule).toHaveBeenCalledExactlyOnceWith(sources, signal);
});

it('does not schedule installation if startup aborts while loading the installer', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  installer.schedule.mockClear();
  const controller = new AbortController();
  const preparing = prepareWindowsEnvironment(controller.signal);
  controller.abort();
  await expect(preparing).rejects.toBe(controller.signal.reason);
  expect(installer.schedule).not.toHaveBeenCalled();
});
