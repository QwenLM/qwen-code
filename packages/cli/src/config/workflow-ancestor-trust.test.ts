/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ideContextStore } from '@qwen-code/qwen-code-core/ide/ideContext.js';
import {
  createLocalWorkflowAncestorTrustProvider,
  loadTrustedFolders,
  loadTrustedFoldersFresh,
  resetTrustedFoldersForTesting,
  TrustLevel,
} from './trustedFolders.js';
import type { Settings } from './settings.js';

describe('local workflow ancestor trust', () => {
  let directory: string;
  let rulesPath: string;
  let repo: string;
  let packages: string;
  let target: string;

  const enabled: Settings = { security: { folderTrust: { enabled: true } } };

  function writeRules(rules: Record<string, unknown>): void {
    writeFileSync(rulesPath, JSON.stringify(rules));
  }

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'qwen-workflow-trust-'));
    rulesPath = path.join(directory, 'trustedFolders.json');
    repo = path.join(directory, 'repo');
    packages = path.join(repo, 'packages');
    target = path.join(packages, 'app');
    vi.stubEnv('QWEN_CODE_TRUSTED_FOLDERS_PATH', rulesPath);
    vi.spyOn(ideContextStore, 'get').mockReturnValue(undefined);
    resetTrustedFoldersForTesting();
  });

  afterEach(() => {
    resetTrustedFoldersForTesting();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  it('H02 does not turn a trusted child into an ancestor grant', async () => {
    writeRules({ [target]: TrustLevel.TRUST_FOLDER });
    const provider = createLocalWorkflowAncestorTrustProvider(enabled);
    await expect(provider([packages, repo])).resolves.toEqual([false, false]);
  });

  it('H02 follows existing trust precedence and TRUST_PARENT semantics', async () => {
    writeRules({
      [target]: TrustLevel.TRUST_PARENT,
      [repo]: TrustLevel.TRUST_FOLDER,
      [packages]: TrustLevel.DO_NOT_TRUST,
    });
    const provider = createLocalWorkflowAncestorTrustProvider(enabled);
    await expect(provider([packages, repo])).resolves.toEqual([false, true]);
    writeRules({ [target]: TrustLevel.TRUST_PARENT });
    await expect(provider([packages, repo])).resolves.toEqual([true, false]);
  });

  it('H03 permits local ancestors when folder trust is disabled', async () => {
    const provider = createLocalWorkflowAncestorTrustProvider({});
    await expect(provider([packages, repo])).resolves.toEqual([true, true]);
  });

  it('H02 re-reads external revocation and restoration without resetting the cached API', async () => {
    writeRules({ [repo]: TrustLevel.TRUST_FOLDER });
    const cached = loadTrustedFolders();
    const provider = createLocalWorkflowAncestorTrustProvider(enabled);
    await expect(provider([packages, repo])).resolves.toEqual([true, true]);
    writeRules({ [repo]: TrustLevel.DO_NOT_TRUST });
    await expect(provider([packages, repo])).resolves.toEqual([false, false]);
    expect(loadTrustedFolders()).toBe(cached);
    expect(cached.isPathTrusted(repo)).toBe(true);
    writeRules({ [repo]: TrustLevel.TRUST_FOLDER });
    await expect(provider([packages, repo])).resolves.toEqual([true, true]);
  });

  it('H02 accepts the existing JSONC rule format', async () => {
    writeFileSync(
      rulesPath,
      `{// persisted comment\n${JSON.stringify(repo)}: "TRUST_FOLDER",\n}`,
    );
    const fresh = loadTrustedFoldersFresh();
    expect(fresh.errors).toEqual([]);
    expect(fresh.isPathTrusted(repo)).toBe(true);
  });

  it.each(['missing', 'malformed', 'non-object', 'invalid-enum'])(
    'H02 denies the entire snapshot when rules are %s',
    async (state) => {
      if (state === 'malformed') writeFileSync(rulesPath, '{ broken');
      if (state === 'non-object') writeFileSync(rulesPath, '[]');
      if (state === 'invalid-enum') {
        writeRules({
          [repo]: TrustLevel.TRUST_FOLDER,
          [packages]: 'UNKNOWN_VALUE',
        });
      }
      const provider = createLocalWorkflowAncestorTrustProvider(enabled);
      await expect(provider([packages, repo])).resolves.toEqual([false, false]);
    },
  );

  it('H02 denies a read failure instead of using an older snapshot', async () => {
    writeRules({ [repo]: TrustLevel.TRUST_FOLDER });
    const provider = createLocalWorkflowAncestorTrustProvider(enabled);
    await expect(provider([packages, repo])).resolves.toEqual([true, true]);
    rmSync(rulesPath);
    vi.stubEnv('QWEN_CODE_TRUSTED_FOLDERS_PATH', directory);
    await expect(provider([packages, repo])).resolves.toEqual([false, false]);
  });

  it('H02 treats IDE trust as deny-only while folder trust is enabled', async () => {
    writeRules({ [repo]: TrustLevel.TRUST_FOLDER });
    const provider = createLocalWorkflowAncestorTrustProvider(enabled);
    vi.mocked(ideContextStore.get).mockReturnValue({
      workspaceState: { isTrusted: false },
    });
    await expect(provider([packages, repo])).resolves.toEqual([false, false]);
    vi.mocked(ideContextStore.get).mockReturnValue({
      workspaceState: { isTrusted: true },
    });
    writeRules({ [target]: TrustLevel.TRUST_FOLDER });
    await expect(provider([packages, repo])).resolves.toEqual([false, false]);
    await expect(
      createLocalWorkflowAncestorTrustProvider({})([packages, repo]),
    ).resolves.toEqual([true, true]);
  });
});
