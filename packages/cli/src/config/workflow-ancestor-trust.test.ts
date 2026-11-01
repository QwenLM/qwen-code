/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ideContextStore } from '@qwen-code/qwen-code-core/ide/ideContext.js';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import {
  listSavedWorkflows,
  resolveSavedWorkflowScript,
} from '@qwen-code/qwen-code-core/agents/runtime/workflow-saved.js';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import {
  createLocalWorkflowAncestorTrustProvider,
  loadTrustedFolders,
  loadTrustedFoldersFresh,
  resetTrustedFoldersForTesting,
  TrustLevel,
} from './trustedFolders.js';
import {
  getOperatorTrustSettings,
  LoadedSettings,
  type Settings,
} from './settings.js';

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
    directory = realpathSync(
      mkdtempSync(path.join(tmpdir(), 'qwen-workflow-trust-')),
    );
    rulesPath = path.join(directory, 'trustedFolders.json');
    repo = path.join(directory, 'repo');
    packages = path.join(repo, 'packages');
    target = path.join(packages, 'app');
    mkdirSync(target, { recursive: true });
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
    await expect(provider([packages, repo], target)).resolves.toEqual([
      false,
      false,
    ]);
  });

  it('H02 follows existing trust precedence and TRUST_PARENT semantics', async () => {
    writeRules({
      [target]: TrustLevel.TRUST_FOLDER,
      [repo]: TrustLevel.TRUST_FOLDER,
      [packages]: TrustLevel.DO_NOT_TRUST,
    });
    const provider = createLocalWorkflowAncestorTrustProvider(enabled);
    await expect(provider([packages, repo], target)).resolves.toEqual([
      false,
      true,
    ]);
    writeRules({ [target]: TrustLevel.TRUST_PARENT });
    await expect(provider([packages, repo], target)).resolves.toEqual([
      true,
      false,
    ]);
  });

  it('H03 permits local ancestors when folder trust is disabled', async () => {
    const provider = createLocalWorkflowAncestorTrustProvider({});
    await expect(provider([packages, repo], target)).resolves.toEqual([
      true,
      true,
    ]);
  });

  it
    .skipIf(process.platform === 'win32')
    .each(['ancestor', 'qwen', 'workflows'] as const)(
    'R1-30 rejects a forged Git boundary with world-writable %s',
    async (component) => {
      const workflowDirectory = path.join(repo, '.qwen', 'workflows');
      mkdirSync(workflowDirectory, { recursive: true });
      writeFileSync(path.join(repo, '.git'), 'gitdir: /attacker/forged');
      writeFileSync(
        path.join(workflowDirectory, 'evil.js'),
        "return 'ATTACKER_SCRIPT_BODY';",
      );
      const unsafe =
        component === 'ancestor'
          ? repo
          : component === 'qwen'
            ? path.dirname(workflowDirectory)
            : workflowDirectory;
      chmodSync(unsafe, 0o1777);
      const userWorkflows = vi
        .spyOn(Storage, 'getUserWorkflowsDir')
        .mockReturnValue(path.join(directory, 'user'));
      const provider = createLocalWorkflowAncestorTrustProvider({});
      const config = {
        getTargetDir: () => target,
        getWorkflowAncestorTrustProvider: () => provider,
        storage: {
          getGeneratedWorkflowsDir: () => path.join(directory, 'generated'),
        },
      } as unknown as Config;
      try {
        await expect(listSavedWorkflows(config)).resolves.toEqual([]);
        await expect(
          resolveSavedWorkflowScript('evil', config),
        ).rejects.toThrow();
        chmodSync(unsafe, 0o775);
        await expect(
          resolveSavedWorkflowScript('evil', config),
        ).resolves.toMatchObject({ script: "return 'ATTACKER_SCRIPT_BODY';" });
      } finally {
        userWorkflows.mockRestore();
        chmodSync(unsafe, 0o755);
      }
    },
  );

  it('R1-24 denies ancestors when the current target has an explicit distrust rule', async () => {
    writeRules({
      [repo]: TrustLevel.TRUST_FOLDER,
      [target]: TrustLevel.DO_NOT_TRUST,
    });
    const provider = createLocalWorkflowAncestorTrustProvider(enabled);
    await expect(provider([packages, repo], target)).resolves.toEqual([
      false,
      false,
    ]);
  });

  it.each([false, true])(
    'R1-22 uses operator trust when workspace overrides enabled=%s',
    async (workspaceEnabled) => {
      const file = (settings: Settings) => ({
        settings,
        originalSettings: settings,
        path: 'fixture',
      });
      const loaded = new LoadedSettings(
        file({}),
        file({}),
        file({ security: { folderTrust: { enabled: !workspaceEnabled } } }),
        file({ security: { folderTrust: { enabled: workspaceEnabled } } }),
        true,
        new Set(),
      );
      expect(loaded.merged.security?.folderTrust?.enabled).toBe(
        workspaceEnabled,
      );
      writeRules({
        [repo]: TrustLevel.TRUST_FOLDER,
        [target]: TrustLevel.DO_NOT_TRUST,
      });
      const provider = createLocalWorkflowAncestorTrustProvider(
        getOperatorTrustSettings(loaded),
      );
      await expect(provider([packages, repo], target)).resolves.toEqual([
        workspaceEnabled,
        workspaceEnabled,
      ]);
    },
  );

  it('R1-25 discards valid grants when a fresh snapshot has an invalid rule', () => {
    writeRules({
      [repo]: TrustLevel.TRUST_FOLDER,
      [packages]: 'UNKNOWN_VALUE',
    });
    const fresh = loadTrustedFoldersFresh();
    expect(fresh.errors).not.toHaveLength(0);
    expect(fresh.user.config).toEqual({});
    expect(fresh.isPathTrusted(repo)).not.toBe(true);
  });

  it('H02 re-reads external revocation and restoration without resetting the cached API', async () => {
    writeRules({ [repo]: TrustLevel.TRUST_FOLDER });
    const cached = loadTrustedFolders();
    const provider = createLocalWorkflowAncestorTrustProvider(enabled);
    await expect(provider([packages, repo], target)).resolves.toEqual([
      true,
      true,
    ]);
    writeRules({ [repo]: TrustLevel.DO_NOT_TRUST });
    await expect(provider([packages, repo], target)).resolves.toEqual([
      false,
      false,
    ]);
    expect(loadTrustedFolders()).toBe(cached);
    expect(cached.isPathTrusted(repo)).toBe(true);
    writeRules({ [repo]: TrustLevel.TRUST_FOLDER });
    await expect(provider([packages, repo], target)).resolves.toEqual([
      true,
      true,
    ]);
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
      await expect(provider([packages, repo], target)).resolves.toEqual([
        false,
        false,
      ]);
    },
  );

  it('H02 denies a read failure instead of using an older snapshot', async () => {
    writeRules({ [repo]: TrustLevel.TRUST_FOLDER });
    const provider = createLocalWorkflowAncestorTrustProvider(enabled);
    await expect(provider([packages, repo], target)).resolves.toEqual([
      true,
      true,
    ]);
    rmSync(rulesPath);
    vi.stubEnv('QWEN_CODE_TRUSTED_FOLDERS_PATH', directory);
    await expect(provider([packages, repo], target)).resolves.toEqual([
      false,
      false,
    ]);
  });

  it('H02 treats IDE trust as deny-only while folder trust is enabled', async () => {
    writeRules({ [repo]: TrustLevel.TRUST_FOLDER });
    const provider = createLocalWorkflowAncestorTrustProvider(enabled);
    vi.mocked(ideContextStore.get).mockReturnValue({
      workspaceState: { isTrusted: false },
    });
    await expect(provider([packages, repo], target)).resolves.toEqual([
      false,
      false,
    ]);
    vi.mocked(ideContextStore.get).mockReturnValue({
      workspaceState: { isTrusted: true },
    });
    writeRules({ [target]: TrustLevel.TRUST_FOLDER });
    await expect(provider([packages, repo], target)).resolves.toEqual([
      false,
      false,
    ]);
    await expect(
      createLocalWorkflowAncestorTrustProvider({})([packages, repo], target),
    ).resolves.toEqual([true, true]);
  });
});
