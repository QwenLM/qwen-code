/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import type { TuiAppFramework } from './tuiAppFramework.js';
import type { AcpAppFramework } from './acpAppFramework.js';
import type { DaemonAppFramework } from './daemonAppFramework.js';
import type { SdkAppFramework } from './sdkAppFramework.js';
import type { HeadlessAppFramework } from './headlessAppFramework.js';
import type { RemoteWorkerAppFramework } from './remoteWorkerAppFramework.js';
import type { CommandAppFramework } from './commandAppFramework.js';
export type EntryFramework =
  | TuiAppFramework
  | AcpAppFramework
  | DaemonAppFramework
  | SdkAppFramework
  | HeadlessAppFramework
  | RemoteWorkerAppFramework
  | CommandAppFramework;
