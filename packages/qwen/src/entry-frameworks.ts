/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  EntryFramework,
  FrameworkInitInput,
  FrameworkMode,
} from '@qwen-code/cli/framework';
import type { SettingsService } from '@qwen-code/resource';

// Mirrors the Harness default factory, which is not exported; only the TUI
// entry differs.
export async function createCliFramework(
  signal: AbortSignal,
  settings: SettingsService,
  mode: FrameworkMode,
  input: FrameworkInitInput,
): Promise<EntryFramework> {
  if (mode === 'tui') {
    const { QwenTuiAppFramework } = await import('./qwen-tui-app-framework.js');
    return new QwenTuiAppFramework(signal, settings, input);
  }
  const framework = await import('@qwen-code/cli/framework');
  switch (mode) {
    case 'acp':
      return new framework.AcpAppFramework(signal, settings, input);
    case 'sdk':
      return new framework.SdkAppFramework(signal, settings, input);
    case 'headless':
      return new framework.HeadlessAppFramework(signal, settings, input);
    case 'daemon':
      return new framework.DaemonAppFramework(signal, settings, input);
    case 'remoteWorker':
      return new framework.RemoteWorkerAppFramework(signal, settings, input);
    case 'command':
      return new framework.CommandAppFramework(signal, settings, input);
    default:
      throw new Error(`Unsupported framework entry: ${mode}`);
  }
}
