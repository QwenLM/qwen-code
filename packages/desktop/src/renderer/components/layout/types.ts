/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DesktopConnectionStatus } from '../../api/client.js';

export type LoadState =
  | { state: 'loading' }
  | { state: 'ready'; status: DesktopConnectionStatus }
  | { state: 'error'; message: string };
