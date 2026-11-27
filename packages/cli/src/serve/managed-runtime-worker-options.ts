/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { parseArgs } from 'node:util';

export const DEFAULT_MANAGED_WORKER_CONTAINER_PORT = 43190;

export function parseManagedRuntimeWorkerOptions(
  args: string[],
): { bootPath?: string; containerPort?: number } | undefined {
  if (args.length === 0) return {};
  try {
    const { values } = parseArgs({
      args,
      options: {
        'container-boot': { type: 'string', multiple: true },
        port: { type: 'string', multiple: true },
      },
    });
    const paths = values['container-boot'];
    if (paths?.length !== 1 || !paths[0] || (values.port?.length ?? 0) > 1) {
      return undefined;
    }
    const value = values.port?.[0];
    if (value === undefined) {
      return { bootPath: paths[0] };
    }
    if (!/^[1-9]\d{0,4}$/.test(value) || Number(value) > 65535)
      return undefined;
    return { bootPath: paths[0], containerPort: Number(value) };
  } catch {
    return undefined;
  }
}
