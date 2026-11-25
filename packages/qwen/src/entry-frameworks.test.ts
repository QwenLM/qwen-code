/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  FrameworkInitInput,
  FrameworkMode,
} from '@qwen-code/cli/framework';
import type { SettingsService } from '@qwen-code/resource';

const frameworks = vi.hoisted(() => {
  const make = (name: string) =>
    class {
      readonly kind = name;
      constructor(
        readonly signal: AbortSignal,
        readonly settings: unknown,
        readonly input: unknown,
      ) {}
    };
  return {
    QwenTuiAppFramework: make('QwenTuiAppFramework'),
    AcpAppFramework: make('AcpAppFramework'),
    SdkAppFramework: make('SdkAppFramework'),
    HeadlessAppFramework: make('HeadlessAppFramework'),
    DaemonAppFramework: make('DaemonAppFramework'),
    RemoteWorkerAppFramework: make('RemoteWorkerAppFramework'),
    CommandAppFramework: make('CommandAppFramework'),
  };
});
vi.mock('./qwen-tui-app-framework.js', () => ({
  QwenTuiAppFramework: frameworks.QwenTuiAppFramework,
}));
vi.mock('@qwen-code/cli/framework', () => frameworks);

import { createCliFramework } from './entry-frameworks.js';

// Keep in step with FrameworkMode: a mode missing here fails to compile.
const expected = {
  tui: 'QwenTuiAppFramework',
  acp: 'AcpAppFramework',
  sdk: 'SdkAppFramework',
  headless: 'HeadlessAppFramework',
  daemon: 'DaemonAppFramework',
  remoteWorker: 'RemoteWorkerAppFramework',
  command: 'CommandAppFramework',
} satisfies Record<FrameworkMode, string>;

describe('createCliFramework', () => {
  const signal = new AbortController().signal;
  const settings = {} as SettingsService;
  const input = {} as FrameworkInitInput;

  it.each(Object.entries(expected))(
    'creates the %s entry with the caller inputs',
    async (mode, kind) => {
      const framework = (await createCliFramework(
        signal,
        settings,
        mode as FrameworkMode,
        input,
      )) as unknown as InstanceType<typeof frameworks.AcpAppFramework>;

      expect(framework.kind).toBe(kind);
      expect(framework.signal).toBe(signal);
      expect(framework.settings).toBe(settings);
      expect(framework.input).toBe(input);
    },
  );

  it('rejects an unknown mode', async () => {
    await expect(
      createCliFramework(signal, settings, 'unknown' as FrameworkMode, input),
    ).rejects.toThrow('Unsupported framework entry: unknown');
  });
});
