/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// githubReader.composeUrl is pure assembly — no API call — so its whole
// surface is the PR-page grammar and the host precedence: the routed gh
// host, else an operator-exported GH_HOST, else github.com. The same
// precedence gh itself applies, so the composed link lands where the
// review ran.

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

  it('composes the github.com PR page by default', () => {
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
