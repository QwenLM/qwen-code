/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ideContextStore } from '@qwen-code/qwen-code-core';
import {
  createWorkflowAncestorTrustProvider,
  loadTrustedFolders,
  resetTrustedFoldersForTesting,
  TrustLevel,
} from './trustedFolders.js';
import {
  evaluateDaemonWorkflowAncestorTrust,
  type DaemonTrustPolicySnapshot,
} from './daemon-trust-policy.js';
import type { Settings } from './settings.js';

const enabled = { security: { folderTrust: { enabled: true } } } as Settings;
const disabled = { security: { folderTrust: { enabled: false } } } as Settings;

describe('createWorkflowAncestorTrustProvider (local sessions)', () => {
  let dir: string;
  let repo: string;
  let packages: string;
  let prevPath: string | undefined;

  // Writes the rules file only, as another process or an editor would: the
  // process cache is deliberately left alone.
  const writeRules = (rules: Record<string, TrustLevel> | string) => {
    fs.writeFileSync(
      path.join(dir, 'trustedFolders.json'),
      typeof rules === 'string' ? rules : JSON.stringify(rules),
    );
  };

  beforeEach(() => {
    dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'wf-ancestor-trust-')),
    );
    repo = path.join(dir, 'repo');
    packages = path.join(repo, 'packages');
    prevPath = process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'];
    process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'] = path.join(
      dir,
      'trustedFolders.json',
    );
    resetTrustedFoldersForTesting();
    ideContextStore.clear();
  });

  afterEach(() => {
    if (prevPath === undefined) {
      delete process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'];
    } else {
      process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'] = prevPath;
    }
    resetTrustedFoldersForTesting();
    ideContextStore.clear();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('trusts only ancestors a rule trusts', async () => {
    writeRules({
      [path.join(packages, 'a')]: TrustLevel.TRUST_FOLDER,
      [repo]: TrustLevel.TRUST_FOLDER,
    });
    const provider = createWorkflowAncestorTrustProvider(enabled);
    // `packages` inherits the root's rule; nothing above the root is trusted.
    await expect(provider([packages, repo, dir])).resolves.toEqual([
      true,
      true,
      false,
    ]);
  });

  it('does not let a trusted target imply its parents', async () => {
    writeRules({ [path.join(packages, 'a')]: TrustLevel.TRUST_FOLDER });
    const provider = createWorkflowAncestorTrustProvider(enabled);
    await expect(provider([packages, repo])).resolves.toEqual([false, false]);
  });

  it('honors TRUST_PARENT and a nearer DO_NOT_TRUST', async () => {
    writeRules({
      [path.join(packages, 'a')]: TrustLevel.TRUST_PARENT,
      [repo]: TrustLevel.DO_NOT_TRUST,
    });
    const provider = createWorkflowAncestorTrustProvider(enabled);
    await expect(provider([packages, repo])).resolves.toEqual([true, false]);
  });

  it('reads the rules on every lookup', async () => {
    writeRules({});
    const provider = createWorkflowAncestorTrustProvider(enabled);
    await expect(provider([repo])).resolves.toEqual([false]);
    writeRules({ [repo]: TrustLevel.TRUST_FOLDER });
    await expect(provider([repo])).resolves.toEqual([true]);
  });

  it('applies a rule changed outside the process to the next lookup, past the process cache', async () => {
    const target = path.join(packages, 'a');
    writeRules({
      [target]: TrustLevel.TRUST_FOLDER,
      [repo]: TrustLevel.TRUST_FOLDER,
    });
    // Prime the process cache the way a running session does.
    expect(loadTrustedFolders().isPathTrusted(repo)).toBe(true);
    const provider = createWorkflowAncestorTrustProvider(enabled);
    await expect(provider([packages, repo])).resolves.toEqual([true, true]);
    // Revoked by another process; the target stays trusted.
    writeRules({
      [target]: TrustLevel.TRUST_FOLDER,
      [repo]: TrustLevel.DO_NOT_TRUST,
    });
    await expect(provider([packages, repo])).resolves.toEqual([false, false]);
    // Unreadable rules never keep an earlier grant.
    writeRules({ [repo]: TrustLevel.TRUST_FOLDER });
    await expect(provider([repo])).resolves.toEqual([true]);
    writeRules('{ not json');
    await expect(provider([repo])).resolves.toEqual([false]);
    fs.rmSync(path.join(dir, 'trustedFolders.json'));
    await expect(provider([repo])).resolves.toEqual([false]);
    // Restored.
    writeRules({ [repo]: TrustLevel.TRUST_FOLDER });
    await expect(provider([repo])).resolves.toEqual([true]);
  });

  it('denies every ancestor when the rules cannot be read', async () => {
    writeRules('[not an object]');
    const provider = createWorkflowAncestorTrustProvider(enabled);
    await expect(provider([packages, repo])).resolves.toEqual([false, false]);
  });

  it('answers trusted when folder trust is disabled', async () => {
    const provider = createWorkflowAncestorTrustProvider(disabled);
    await expect(provider([packages, repo])).resolves.toEqual([true, true]);
  });

  it('never lets IDE trust grant an ancestor, but lets IDE distrust deny one', async () => {
    writeRules({});
    ideContextStore.set({ workspaceState: { isTrusted: true } });
    const provider = createWorkflowAncestorTrustProvider(enabled);
    await expect(provider([process.cwd()])).resolves.toEqual([false]);
    writeRules({ [process.cwd()]: TrustLevel.TRUST_FOLDER });
    ideContextStore.set({ workspaceState: { isTrusted: false } });
    await expect(provider([process.cwd()])).resolves.toEqual([false]);
  });
});

describe('evaluateDaemonWorkflowAncestorTrust (daemon snapshots)', () => {
  const repo = path.resolve('/srv/repo');
  const snapshot = (
    overrides: Partial<DaemonTrustPolicySnapshot> = {},
  ): DaemonTrustPolicySnapshot => ({
    revision: 'r1',
    folderTrustEnabled: true,
    ideTrust: undefined,
    trustedFolders: {},
    ...overrides,
  });

  it('follows the snapshot rules, including an ancestor-only revoke', () => {
    const target = path.join(repo, 'packages', 'a');
    const before = snapshot({
      trustedFolders: {
        [target]: TrustLevel.TRUST_FOLDER,
        [repo]: TrustLevel.TRUST_FOLDER,
      },
    });
    const after = snapshot({
      revision: 'r2',
      trustedFolders: { [target]: TrustLevel.TRUST_FOLDER },
    });
    expect(evaluateDaemonWorkflowAncestorTrust(before, repo, '/')).toBe(true);
    expect(evaluateDaemonWorkflowAncestorTrust(after, repo, '/')).toBe(false);
  });

  it('denies on settings or rule errors and allows with folder trust off', () => {
    const error = {
      code: 'trust_policy_invalid',
      path: '/x',
      message: 'bad',
    } as const;
    expect(
      evaluateDaemonWorkflowAncestorTrust(
        snapshot({ settingsError: error }),
        repo,
        '/',
      ),
    ).toBe(false);
    expect(
      evaluateDaemonWorkflowAncestorTrust(
        snapshot({
          trustedFoldersError: error,
          trustedFolders: { [repo]: TrustLevel.TRUST_FOLDER },
        }),
        repo,
        '/',
      ),
    ).toBe(false);
    expect(
      evaluateDaemonWorkflowAncestorTrust(
        snapshot({ folderTrustEnabled: false }),
        repo,
        '/',
      ),
    ).toBe(true);
  });

  it('never treats the daemon cwd IDE trust as an ancestor grant', () => {
    expect(
      evaluateDaemonWorkflowAncestorTrust(
        snapshot({ ideTrust: true }),
        repo,
        repo,
      ),
    ).toBe(false);
    expect(
      evaluateDaemonWorkflowAncestorTrust(
        snapshot({
          ideTrust: false,
          trustedFolders: { [repo]: TrustLevel.TRUST_FOLDER },
        }),
        repo,
        repo,
      ),
    ).toBe(false);
  });
});
