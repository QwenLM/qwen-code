/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as Peer from '../../src/peer/index.js';
import type {
  PeerEndpointOptions,
  PeerReceipt,
  PeerSendResult,
} from '../../src/peer/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..', '..');

describe('@qwen-code/sdk/peer — opt-in peer surface', () => {
  it('exports the endpoint and the pieces it is built from', () => {
    expect(typeof Peer.PeerEndpoint.start).toBe('function');
    for (const name of [
      'PeerEndpointError',
      'PeerSendError',
      'parsePeerFrame',
      'encodePeerFrame',
      'buildAuthLine',
      'parsePeerAuthLine',
      'buildUserFrame',
      'buildDeliveryStatusFrame',
      'sendPeerFrame',
      'probePeerSocket',
      'startPeerInbox',
      'readLiveSessionRecords',
      'resolveQwenHome',
      'resolvePeerTarget',
      'peerRef',
      'flattenPeerLabel',
    ] as const) {
      expect(typeof Peer[name]).toBe('function');
    }
  });

  it('names every outcome of a send in its type', () => {
    expectTypeOf<PeerSendResult['kind']>().toEqualTypeOf<
      'sent' | 'self' | 'not-found' | 'ambiguous' | 'failed'
    >();
    expectTypeOf<PeerReceipt['previous']>().toEqualTypeOf<
      Peer.PeerDeliveryStatus | 'pending'
    >();
    expectTypeOf<PeerEndpointOptions['name']>().toEqualTypeOf<string>();
  });

  it('stays out of the default and daemon entries, which ship to browsers', () => {
    for (const entry of ['src/index.ts', 'src/daemon/index.ts']) {
      expect(readFileSync(join(packageRoot, entry), 'utf8')).not.toContain(
        'peer/',
      );
    }
  });

  it('declares the ./peer subpath in package.json exports', () => {
    const pkg = JSON.parse(
      readFileSync(join(packageRoot, 'package.json'), 'utf8'),
    ) as { exports: Record<string, Record<string, string>> };
    const entry = pkg.exports['./peer'];
    expect(entry).toBeDefined();
    expect(entry['types']).toBe('./dist/peer/index.d.ts');
    expect(entry['import']).toBe('./dist/peer/index.js');
    expect(entry['require']).toBe('./dist/peer/index.cjs');
  });
});
