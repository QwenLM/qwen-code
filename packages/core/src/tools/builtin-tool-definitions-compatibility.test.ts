/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { getShellConfiguration } from '../utils/shell-utils.js';
import {
  getEditToolDefinition,
  getNotebookEditToolDefinition,
  getGlobToolDefinition,
  getGrepToolDefinition,
  getLSToolDefinition,
  getReadFileToolDefinition,
  getShellToolDefinition,
  getWriteFileToolDefinition,
  getZoomImageToolDefinition,
} from './builtin-tool-definitions.js';
import { ReadFileTool } from './read-file.js';
import { ZoomImageTool } from './zoom-image.js';
import { WriteFileTool } from './write-file.js';
import { NotebookEditTool } from './notebook-edit.js';
import { EditTool } from './edit.js';
import { ShellTool } from './shell.js';
import { GlobTool } from './glob.js';
import { LSTool } from './ls.js';
import { GrepTool } from './grep.js';
import { RipGrepTool } from './ripGrep.js';
import { managedToolDigest } from './managed-tool-protocol.js';
import { ManagedToolRuntime } from './managed-tool-runtime.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('builtin tool definition compatibility', () => {
  it('preserves the native Zoom declaration, deferred discovery and classifier input', () => {
    const config = {} as Config;
    const zoom = new ZoomImageTool(config);
    const runtime = new ManagedToolRuntime(
      config,
      () => [zoom],
      () => 'policy',
    );
    expect(runtime.manifest().tools).toEqual([getZoomImageToolDefinition()]);
    expect(managedToolDigest(getZoomImageToolDefinition())).toBe(
      'b314b94cffca7695f102611653da26ec9902065e669f794bc447d8aa4cd776bf',
    );
    expect(
      zoom.toAutoClassifierInput({
        file_path: '/workspace/image.png',
        x1: 0,
        y1: 0,
        x2: 500,
        y2: 500,
      }),
    ).toBe('');
  });
  it('shares the Grep schema and descriptor across both real backends', () => {
    const config = {} as Config;
    for (const tool of [new GrepTool(config), new RipGrepTool(config)]) {
      const runtime = new ManagedToolRuntime(
        config,
        () => [tool],
        () => 'policy',
      );
      expect(runtime.manifest().tools).toEqual([getGrepToolDefinition()]);
      expect(tool.toAutoClassifierInput({ pattern: 'needle' })).toBe('');
      expect(tool.schema.parametersJsonSchema).toEqual(
        expect.objectContaining({
          required: ['pattern'],
          properties: expect.objectContaining({
            limit: expect.objectContaining({ type: 'integer', minimum: 1 }),
          }),
        }),
      );
    }
  });
  it('preserves the existing Glob and LS declarations and classifier inputs', () => {
    const config = {} as Config;
    const local = [new GlobTool(config), new LSTool(config)] as const;
    const runtime = new ManagedToolRuntime(
      config,
      () => [...local],
      () => 'policy',
    );
    const definitions = [getGlobToolDefinition(), getLSToolDefinition()];
    expect(runtime.manifest().tools).toEqual(definitions);
    expect(
      definitions.map((definition) => managedToolDigest(definition)),
    ).toEqual([
      'd7fa8eae1ba88e20d8c038ca7d0e8353d18a81a2a8f3a3d79784d8ce067e6294',
      'ea0b31c92cb8ad7e4a63414bba9c9e6e579736392b3d48ba3c0b62950344d1f0',
    ]);
    expect(
      local[0].toAutoClassifierInput({ pattern: '*.txt', path: '/workspace' }),
    ).toBe('');
    expect(local[1].toAutoClassifierInput({ path: '/workspace' })).toBe('');
  });

  it.each([
    { platform: 'linux', comSpec: undefined, threshold: undefined },
    { platform: 'win32', comSpec: 'cmd.exe', threshold: 0 },
    {
      platform: 'win32',
      comSpec: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      threshold: 40_000,
    },
    {
      platform: 'win32',
      comSpec: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      threshold: undefined,
    },
  ] as const)(
    'matches the real Runtime manifest for $platform / $comSpec / $threshold',
    ({ platform, comSpec, threshold }) => {
      vi.spyOn(os, 'platform').mockReturnValue(platform);
      vi.stubEnv('ComSpec', comSpec);
      vi.stubEnv('MSYSTEM', undefined);
      vi.stubEnv('TERM', undefined);
      const config = {
        isTruncateToolOutputThresholdExplicit: () => threshold !== undefined,
        getTruncateToolOutputThreshold: () => threshold,
      } as unknown as Config;
      const tools = [
        new ReadFileTool(config),
        new WriteFileTool(config),
        new EditTool(config),
        new NotebookEditTool(config),
        new ShellTool(config),
      ];
      const runtime = new ManagedToolRuntime(
        config,
        () => tools,
        () => 'policy',
      );
      expect(runtime.manifest().tools).toEqual([
        getReadFileToolDefinition(),
        getWriteFileToolDefinition(),
        getEditToolDefinition(),
        getNotebookEditToolDefinition(),
        getShellToolDefinition({
          shellConfiguration: getShellConfiguration(),
          platform,
          outputThreshold: threshold,
        }),
      ]);
    },
  );
});
