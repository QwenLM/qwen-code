/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManagedGithubAdapter } from '@qwen-code/channel-github';
import type { ManagedGithubAdapterDeps } from '@qwen-code/channel-github';
import type { ManagedChannelControlPlane } from '@qwen-code/channel-base';
import { parseChannelConfig } from './config-utils.js';

// The production policy path, end to end: the REAL parseChannelConfig output
// (which always injects privatePolicy/senderPolicy/groupPolicy defaults) plus
// the pre-parse entry handed to the REAL adapter. The round-3 config-only
// groupPolicy guard was dead here because the injected defaults made its
// `=== undefined` conditions never true; these cases pin the raw-entry fix.

const tempDirs: string[] = [];
function tempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), 'managed-github-policy-'));
  tempDirs.push(dir);
  return dir;
}
beforeEach(() => {
  vi.stubEnv('QWEN_HOME', tempCwd());
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function adapterFor(
  parsed: Record<string, unknown>,
  raw: Record<string, unknown>,
): ManagedGithubAdapter {
  // The policy is computed in the constructor; connect (and thus the client /
  // control plane) is never reached, so empty collaborators suffice.
  return new ManagedGithubAdapter({
    name: 'gh',
    cwd: tempCwd(),
    config: parsed,
    rawConfig: raw,
    controlPlane: {} as ManagedChannelControlPlane,
    deps: {} as ManagedGithubAdapterDeps,
    pollLoop: false,
  });
}

describe('managed GitHub policy through the real parse layer', () => {
  it('honors groupPolicy open from a parseChannelConfig result', async () => {
    const raw = { type: 'github', token: 'ghp_x', groupPolicy: 'open' };
    const parsed = (await parseChannelConfig('gh', raw)) as Record<
      string,
      unknown
    >;
    // The parse layer really does inject the managed policy defaults.
    expect(parsed['privatePolicy']).toBeDefined();
    expect(parsed['senderPolicy']).toBeDefined();
    expect(adapterFor(parsed, raw).policy.senderPolicy).toBe('open');
  });

  it('keeps an allowedUsers-only config admitting its senders', async () => {
    const raw = { type: 'github', token: 'ghp_x', allowedUsers: ['alice'] };
    const parsed = (await parseChannelConfig('gh', raw)) as Record<
      string,
      unknown
    >;
    const policy = adapterFor(parsed, raw).policy;
    expect(policy.senderPolicy).toBe('allowlist');
    expect(policy.allowedSenders).toEqual(['alice']);
  });

  it('refuses an unknown groupPolicy from a parseChannelConfig result', async () => {
    const raw = { type: 'github', token: 'ghp_x', groupPolicy: 'bogus' };
    const parsed = (await parseChannelConfig('gh', raw)) as Record<
      string,
      unknown
    >;
    expect(() => adapterFor(parsed, raw)).toThrow(/groupPolicy must be one of/);
  });

  it('starts a Web Shell off-mode repoFilter config without refusal', async () => {
    // The editor seeds repoFilterMode 'off' on save; it must not be refused.
    const raw = { type: 'github', token: 'ghp_x', repoFilterMode: 'off' };
    const parsed = (await parseChannelConfig('gh', raw)) as Record<
      string,
      unknown
    >;
    expect(() => adapterFor(parsed, raw)).not.toThrow();
  });
});
