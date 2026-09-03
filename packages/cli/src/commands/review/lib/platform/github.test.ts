/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

// githubReader.composeUrl is pure assembly — no API call — so its whole
// surface is the PR-page grammar and the host precedence: the routed gh
// host, else an operator-exported GH_HOST, else FAIL CLOSED with ''. gh's
// own third fallback is NOT github.com but hosts.yml's authenticated
// default (a single recorded host wins — go-gh's defaultHost), which this
// process cannot see, so composing a link there could point away from the
// host the write actually took.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { githubReader } from './github.js';
import { getGhHost, setGhHost } from '../gh.js';

describe('githubReader.composeUrl', () => {
  let savedEnvHost: string | undefined;
  let savedRoutedHost: string | undefined;

  beforeEach(() => {
    savedEnvHost = process.env['GH_HOST'];
    delete process.env['GH_HOST'];
    savedRoutedHost = getGhHost();
  });

  afterEach(() => {
    if (savedEnvHost === undefined) delete process.env['GH_HOST'];
    else process.env['GH_HOST'] = savedEnvHost;
    setGhHost(savedRoutedHost);
  });

  it('fails CLOSED when the routing host is not knowable — no routed host, no exported GH_HOST', () => {
    // gh's own third fallback is hosts.yml's authenticated default: a
    // hosts.yml holding a single GHE host routes the write there (probed
    // on gh 2.23.0 — no GH_HOST, single-entry hosts.yml: `gh api user`
    // resolved at that entry), and this process cannot read that default.
    // Composing github.com here would print a link that can resolve to a
    // real, unrelated PR of a same-named github.com repo while the review
    // posted to the GHE host. '' leaves the receipt linkless — submit's
    // truthy checks drop the url — instead of affirming a wrong host.
    expect(githubReader.composeUrl(6771, 'QwenLM/qwen-code')).toBe('');
  });

  it('composes the github.com page when github.com IS the knowable host', () => {
    setGhHost('github.com');
    expect(githubReader.composeUrl(6771, 'QwenLM/qwen-code')).toBe(
      'https://github.com/QwenLM/qwen-code/pull/6771',
    );
    setGhHost(undefined);
    process.env['GH_HOST'] = 'github.com';
    expect(githubReader.composeUrl(6771, 'QwenLM/qwen-code')).toBe(
      'https://github.com/QwenLM/qwen-code/pull/6771',
    );
  });

  it('binds the host to the routed gh host (an Enterprise run)', () => {
    setGhHost('ghe.example.com');
    expect(githubReader.composeUrl(7, 'o/r')).toBe(
      'https://ghe.example.com/o/r/pull/7',
    );
  });

  it('falls back to an operator-exported GH_HOST when no host is routed', () => {
    process.env['GH_HOST'] = 'ghe.internal';
    expect(githubReader.composeUrl(7, 'o/r')).toBe(
      'https://ghe.internal/o/r/pull/7',
    );
  });

  it('the routed host outranks the env export', () => {
    process.env['GH_HOST'] = 'ghe.internal';
    setGhHost('ghe.example.com');
    expect(githubReader.composeUrl(7, 'o/r')).toBe(
      'https://ghe.example.com/o/r/pull/7',
    );
  });

  it('normalizes the spelling exactly like the comment-anchor builder — one run, one textual spelling of the PR page', () => {
    // HOSTNAME_RE admits uppercase and ports; without the shared
    // normalization a `--host GHE.Corp:443` run printed
    // `https://GHE.Corp:443/…` here while compose-review anchored
    // `https://ghe.corp/…`.
    setGhHost('GHE.Corp:443');
    expect(githubReader.composeUrl(7, 'o/r')).toBe(
      'https://ghe.corp/o/r/pull/7',
    );
    setGhHost('ghe.example.com.');
    expect(githubReader.composeUrl(7, 'o/r')).toBe(
      'https://ghe.example.com/o/r/pull/7',
    );
    setGhHost(undefined);
    process.env['GH_HOST'] = 'WWW.GITHUB.COM';
    expect(githubReader.composeUrl(7, 'o/r')).toBe(
      'https://github.com/o/r/pull/7',
    );
  });

  it('keeps a NON-default port — a GHE on :8443 serves its pages there', () => {
    setGhHost('ghe.example.com:8443');
    expect(githubReader.composeUrl(7, 'o/r')).toBe(
      'https://ghe.example.com:8443/o/r/pull/7',
    );
  });

  it('refuses a malformed ownerRepo', () => {
    expect(() => githubReader.composeUrl(7, 'not-a-repo')).toThrow(TypeError);
    expect(() => githubReader.composeUrl(7, '../evil')).toThrow(TypeError);
  });
});
