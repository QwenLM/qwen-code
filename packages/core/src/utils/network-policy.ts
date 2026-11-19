/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LookupFunction } from 'node:net';

import type { ExtensionNetworkPolicy } from '../config/config.js';

export interface ResolvedNetworkTarget {
  url: URL;
  lookup?: LookupFunction;
  curlResolve?: string;
}

export async function resolveNetworkTarget(
  value: string | URL,
  policy?: ExtensionNetworkPolicy,
  signal?: AbortSignal,
): Promise<ResolvedNetworkTarget> {
  signal?.throwIfAborted();
  const url = value instanceof URL ? value : new URL(value);
  if (policy !== 'public') return { url };
  const { resolveNetworkTarget: resolveCheckedTarget } = await import(
    '@qwen-code/network-policy'
  );
  const { lookup, curlResolve } = await resolveCheckedTarget(
    url,
    'public',
    signal,
  );
  return { url, lookup, curlResolve };
}
