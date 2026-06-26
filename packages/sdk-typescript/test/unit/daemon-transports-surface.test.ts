/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, expectTypeOf } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as Transports from '../../src/daemon/transports.js';
import type {
  NegotiateTransportOptions,
  TransportFactory,
} from '../../src/daemon/transports.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(here, '..', '..', 'package.json');

describe('@qwen-code/sdk/daemon/transports — opt-in transport surface', () => {
  it('exports the concrete ACP transports + negotiateTransport at runtime', () => {
    // Locks the consumer-facing contract that lets agent-web (and any
    // external SDK consumer) get resumable ACP-over-HTTP without forking
    // or reaching into source paths. These deliberately live OFF the
    // default `./daemon` barrel to keep its browser bundle under budget;
    // if a future barrel reshuffle drops them here, this fails loudly.
    expect(typeof Transports.AcpHttpTransport).toBe('function');
    expect(typeof Transports.AcpWsTransport).toBe('function');
    expect(typeof Transports.AutoReconnectTransport).toBe('function');
    expect(typeof Transports.RestSseTransport).toBe('function');
    expect(typeof Transports.negotiateTransport).toBe('function');
  });

  it('AcpHttpTransport advertises native replay (supportsReplay)', () => {
    // The whole reason to expose this transport: it natively sends
    // Last-Event-ID on reconnect, which is what closes the §1.8
    // mid-turn content-loss gap against the resumable daemon stream.
    const t = new Transports.AcpHttpTransport(
      'http://localhost:0',
      undefined,
      globalThis.fetch.bind(globalThis),
    );
    expect(t.type).toBe('acp-http');
    expect(t.supportsReplay).toBe(true);
  });

  it('exposes the transport option types at the subpath (compile-time)', () => {
    expectTypeOf<NegotiateTransportOptions>().not.toBeNever();
    expectTypeOf<TransportFactory>().not.toBeNever();
    // The fetchFn injection point must stay on the negotiate options.
    expectTypeOf<
      NonNullable<NegotiateTransportOptions['fetchFn']>
    >().toEqualTypeOf<typeof globalThis.fetch>();
  });

  it('declares the ./daemon/transports subpath in package.json exports', () => {
    // The runtime imports above resolve via the bundler's source mapping;
    // this pins the *published* contract so the subpath actually ships.
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      exports: Record<string, Record<string, string>>;
    };
    const entry = pkg.exports['./daemon/transports'];
    expect(entry).toBeDefined();
    expect(entry.types).toBe('./dist/daemon/transports.d.ts');
    expect(entry.import).toBe('./dist/daemon/transports.js');
    expect(entry.require).toBe('./dist/daemon/transports.cjs');
  });
});
