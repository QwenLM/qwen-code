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
      'probePeerSocketVerdict',
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

  // An import of the peer module, in any of the forms a module specifier
  // can take: `../peer`, `./peer/frames.js`, `@qwen-code/sdk/peer`. Prose
  // that merely mentions the word does not count.
  const isPeerImport = (source: string) =>
    /from\s+['"][^'"]*\/peer(?:\/[^'"]*)?['"]/.test(source);

  it('recognises every form a peer import can take', () => {
    expect(isPeerImport("export * from '../peer';")).toBe(true);
    expect(isPeerImport("import { x } from './peer/frames.js';")).toBe(true);
    expect(isPeerImport("import { x } from '@qwen-code/sdk/peer';")).toBe(true);
    expect(isPeerImport("import { x } from './session.js';")).toBe(false);
    expect(isPeerImport('// talks to a peer/relay')).toBe(false);
  });

  it('stays out of the default and daemon entries', () => {
    // The daemon entries are bundled for browsers, where the endpoint's
    // sockets cannot exist; the default entry is what every query() user
    // loads. The endpoint is opt-in for both.
    for (const entry of ['src/index.ts', 'src/daemon/index.ts']) {
      expect(isPeerImport(readFileSync(join(packageRoot, entry), 'utf8'))).toBe(
        false,
      );
    }
  });

  it('declares the ./peer subpath in package.json exports', () => {
    const pkg = JSON.parse(
      readFileSync(join(packageRoot, 'package.json'), 'utf8'),
    ) as { exports: Record<string, Record<string, string>> };
    expect(pkg.exports['./peer']).toEqual({
      types: './dist/peer/index.d.ts',
      import: './dist/peer/index.js',
      require: './dist/peer/index.cjs',
    });
  });
});
