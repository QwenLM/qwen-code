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
  verdict: Verdict;
  // The refusal under a URL parser that applies UTS #46's newer xn-- checks,
  // such as Node 24's, which refuses a label whose Punycode decodes to plain
  // ASCII. Node 22's keeps that label, so the reader refuses the URL for
  // another reason.
  strictIdnaVerdict?: Exclude<Verdict, 'accepted'>;
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

// Asks the running parser rather than the Node version.
const STRICT_IDNA = !URL.canParse('http://xn--localhost-/');

const REFUSALS: Record<Exclude<Verdict, 'accepted'>, string> = {
  invalid: 'Managed Runtime Broker URL is invalid.',
  'not-origin': 'Managed Runtime Broker URL must be an HTTP(S) origin.',
  'plain-outside-loopback':
    'Managed Runtime Broker URL must use HTTPS outside the loopback interface.',
};

describe('resolveManagedRuntimeBrokerBaseUrl', () => {
  it.each(cases)(
    'reads $url as $verdict',
    ({ url, verdict, strictIdnaVerdict, hostname, port }) => {
      // The fixture holds this reader's verdicts only; an unknown one would
      // leave toThrow() checking just that something threw.
      expect(['accepted', ...Object.keys(REFUSALS)]).toContain(verdict);
      if (strictIdnaVerdict !== undefined) {
        expect(Object.keys(REFUSALS)).toContain(strictIdnaVerdict);
        expect(verdict).not.toBe('accepted');
      }
      if (verdict !== 'accepted') {
        const refusal =
          STRICT_IDNA && strictIdnaVerdict ? strictIdnaVerdict : verdict;
        expect(() => resolveManagedRuntimeBrokerBaseUrl(url)).toThrow(
          REFUSALS[refusal],
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
