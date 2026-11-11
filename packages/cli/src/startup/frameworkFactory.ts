/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  FrameworkInitInput,
  FrameworkMode,
} from '../framework/appFramework.js';
import type { SettingsService } from '@qwen-code/resource';
import type { EntryFramework } from '../framework/entryFramework.js';

/** Creates an entry Framework only when its command needs runtime resources. */
export type CliFrameworkFactory = (
  signal: AbortSignal,
  settings: SettingsService,
  mode: FrameworkMode,
  input: FrameworkInitInput,
) => EntryFramework | Promise<EntryFramework>;

/** Callback owned by main; commands select an entry without owning its lifetime. */
export type StartFramework = (
  mode: FrameworkMode,
  input: FrameworkInitInput,
) => Promise<EntryFramework>;

export async function createFramework(
  signal: AbortSignal,
  settings: SettingsService,
  mode: FrameworkMode,
  input: FrameworkInitInput,
): Promise<EntryFramework> {
  switch (mode) {
    case 'tui': {
      const { TuiAppFramework } = await import(
        '../framework/tuiAppFramework.js'
      );
      return new TuiAppFramework(signal, settings, input);
    }
    case 'acp': {
      const { AcpAppFramework } = await import(
        '../framework/acpAppFramework.js'
      );
      return new AcpAppFramework(signal, settings, input);
    }
    case 'sdk': {
      const { SdkAppFramework } = await import(
        '../framework/sdkAppFramework.js'
      );
      return new SdkAppFramework(signal, settings, input);
    }
    case 'headless': {
      const { HeadlessAppFramework } = await import(
        '../framework/headlessAppFramework.js'
      );
      return new HeadlessAppFramework(signal, settings, input);
    }
    case 'daemon': {
      const { DaemonAppFramework } = await import(
        '../framework/daemonAppFramework.js'
      );
      return new DaemonAppFramework(signal, settings, input);
    }
    case 'remoteWorker': {
      const { RemoteWorkerAppFramework } = await import(
        '../framework/remoteWorkerAppFramework.js'
      );
      return new RemoteWorkerAppFramework(signal, settings, input);
    }
    case 'command': {
      const { CommandAppFramework } = await import(
        '../framework/commandAppFramework.js'
      );
      return new CommandAppFramework(signal, settings, input);
    }
    default:
      throw new Error(`Unsupported framework entry: ${mode}`);
  }
}
