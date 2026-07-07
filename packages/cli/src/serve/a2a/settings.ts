/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { A2aPeerConfig, A2aSettings } from './types.js';

function disabledA2aSettings(): A2aSettings {
  return {
    enabled: false,
    explicitPeers: [],
    trustedPeers: new Map(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizePeer(value: unknown): A2aPeerConfig | undefined {
  if (!isRecord(value)) return undefined;
  if (!nonEmptyString(value['id']) || !nonEmptyString(value['url'])) {
    return undefined;
  }

  const peer: A2aPeerConfig = {
    id: value['id'],
    url: value['url'],
  };
  if (nonEmptyString(value['alias'])) {
    peer.alias = value['alias'];
  }
  if (nonEmptyString(value['tokenRef'])) {
    peer.tokenRef = value['tokenRef'];
  }
  return peer;
}

export function normalizeA2aSettings(value: unknown): A2aSettings {
  if (!isRecord(value) || value['enabled'] !== true) {
    return disabledA2aSettings();
  }

  const explicitPeers = Array.isArray(value['explicitPeers'])
    ? value['explicitPeers'].flatMap((peer) => {
        const normalized = normalizePeer(peer);
        return normalized === undefined ? [] : [normalized];
      })
    : [];
  const trustedPeers = new Map<string, A2aPeerConfig>();
  if (isRecord(value['trustedPeers'])) {
    for (const [id, rawPeer] of Object.entries(value['trustedPeers'])) {
      if (!isRecord(rawPeer)) continue;
      const normalized = normalizePeer({ id, ...rawPeer });
      if (normalized !== undefined) {
        trustedPeers.set(normalized.id, normalized);
      }
    }
  }

  return {
    enabled: true,
    explicitPeers,
    trustedPeers,
  };
}

export function resolveA2aTokenRef(
  tokenRef: string | undefined,
): string | undefined {
  if (tokenRef === undefined) return undefined;
  if (!tokenRef.startsWith('env:')) {
    throw new Error(`Unsupported A2A tokenRef '${tokenRef}'`);
  }

  const envName = tokenRef.slice('env:'.length);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
    throw new Error(`Invalid A2A env tokenRef '${tokenRef}'`);
  }
  return process.env[envName];
}
