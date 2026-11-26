/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveManagedRuntimeBrokerBaseUrl } from './managed-runtime-broker-url.js';

type Verdict = 'accepted' | 'invalid' | 'not-origin' | 'plain-outside-loopback';
interface Fixture {
  url: string;
  // The verdict where the URL parser keeps the host.
  verdict: Verdict;
  // The host of a URL with an xn-- label. Node's URL parsers disagree on
  // some of them: ada 2.9 (Node 22) keeps xn--localhost- and refuses xn--a,
  // ada 3 (Node 24.0 to 24.19, and 25) refuses both, and ada 4 (Node 24.20
  // and later, and 26) keeps both. A parser that refuses the host makes the
  // URL invalid before the Harness's own rules apply.
  idnaHost?: string;
  hostname?: string;
  port?: number;
}
// The control plane's preflight (HarnessBrokerUrlTest) reads the same cases,
// so the two readers of the Harness Broker URL cannot drift apart.
const { cases } = JSON.parse(
  readFileSync(
    new URL('./managed-runtime-broker-url.fixtures.json', import.meta.url),
    'utf8',
  ),
) as { cases: Fixture[] };

const REFUSALS: Record<Exclude<Verdict, 'accepted'>, string> = {
  invalid: 'Managed Runtime Broker URL is invalid.',
  'not-origin': 'Managed Runtime Broker URL must be an HTTP(S) origin.',
  'plain-outside-loopback':
    'Managed Runtime Broker URL must use HTTPS outside the loopback interface.',
};

// Asks the running parser about the host itself, not the Node version.
const readings = cases.map((fixture) => ({
  ...fixture,
  expected:
    fixture.idnaHost !== undefined &&
    !URL.canParse(`http://${fixture.idnaHost}/`)
      ? 'invalid'
      : fixture.verdict,
}));

describe('resolveManagedRuntimeBrokerBaseUrl', () => {
  it('requires an explicit false from untyped callers to permit remote HTTP', () => {
    expect(() =>
      // @ts-expect-error A JavaScript caller may supply a null option.
      resolveManagedRuntimeBrokerBaseUrl('http://runtime-broker:4182', null),
    ).toThrow('must use HTTPS');
  });

  it.each([
    'ftp://runtime-broker:4182',
    'http://user:secret@runtime-broker:4182',
    'http://runtime-broker:4182/api/..',
    'http://runtime-broker:4182?query',
    'http://runtime-broker:4182#fragment',
    'http://runtime-broker:65536',
    'http://127.1:4182',
  ])(
    'still requires a canonical HTTP(S) origin for %s when TLS is optional',
    (url) => {
      expect(() => resolveManagedRuntimeBrokerBaseUrl(url, false)).toThrow(
        'Managed Runtime Broker URL',
      );
    },
  );

  it.each(readings)(
    'reads $url as $expected',
    ({ url, verdict, idnaHost, expected, hostname, port }) => {
      // The fixture holds this reader's verdicts only; an unknown one would
      // leave toThrow() checking just that something threw.
      expect(['accepted', ...Object.keys(REFUSALS)]).toContain(verdict);
      // Every xn-- host is named, so no case rests on one parser's IDNA.
      if (/xn--/i.test(url)) {
        expect(url.toLowerCase().split('/')[2]?.split(':')[0]).toBe(idnaHost);
      } else {
        expect(idnaHost).toBeUndefined();
      }
      if (expected !== 'accepted') {
        expect(() => resolveManagedRuntimeBrokerBaseUrl(url)).toThrow(
          REFUSALS[expected],
        );
        return;
      }
      const resolved = resolveManagedRuntimeBrokerBaseUrl(url);
      const defaultPort = resolved.protocol === 'https:' ? 443 : 80;
      expect({
        hostname: resolved.hostname,
        port: Number(resolved.port) || defaultPort,
      }).toEqual({ hostname, port });
    },
  );
});

// Non-ASCII hosts cannot be fixture rows: the Java reader returns UNCLASSIFIED
// for them and declaredApproximation only excuses that against an accepted
// verdict. Pin the U-label refusal here instead.
describe('canonical host spelling (direct cases)', () => {
  it.each([
    'https://例子.example:8443',
    'https://exämple.example:8443',
    // An unrelated punycode label must not smuggle a U-label elsewhere through.
    'https://exämple.xn--foo:8443',
  ])('refuses non-canonical U-label host %s', (url) => {
    expect(() => resolveManagedRuntimeBrokerBaseUrl(url)).toThrow(
      'Managed Runtime Broker URL is invalid.',
    );
  });
});
