/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Settings } from './settings.js';
import {
  getProviderStartupEnvironment,
  loadEnvironment,
  restoreLoadedEnvironment,
} from './settings.js';
import {
  isWorkspaceTrusted,
  isWorkspaceTrustedForProviders,
} from './trustedFolders.js';

const WORKSPACE_TRUST_VAR = 'QWEN_R9_WS_TRUST_DIR';
const SHELL_TRUST_VAR = 'QWEN_R9_SHELL_TRUST_DIR';

describe('isWorkspaceTrustedForProviders', () => {
  let workspaceDir: string;
  let trustedParent: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'qwen-trust-r9-'));
    trustedParent = dirname(workspaceDir);
    delete process.env[WORKSPACE_TRUST_VAR];
    delete process.env[SHELL_TRUST_VAR];
  });

  afterEach(() => {
    restoreLoadedEnvironment();
    vi.unstubAllEnvs();
    delete process.env[WORKSPACE_TRUST_VAR];
    delete process.env[SHELL_TRUST_VAR];
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('keeps a literal user rule trusted without any environment', () => {
    const userSettings = {
      permissions: { trustDirectories: [trustedParent] },
    } as Settings;

    const result = isWorkspaceTrustedForProviders(
      userSettings,
      workspaceDir,
      () => undefined,
    );

    expect(result.isTrusted).toBe(true);
    expect(result.source).toBe('file');
  });

  it('reports no trust for a literal rule outside the workspace', () => {
    const userSettings = {
      permissions: { trustDirectories: [`${trustedParent}-elsewhere`] },
    } as Settings;

    const result = isWorkspaceTrustedForProviders(
      userSettings,
      workspaceDir,
      () => undefined,
    );

    expect(result.isTrusted).toBeUndefined();
  });

  it('resolves a referenced user rule through the view', () => {
    const userSettings = {
      permissions: { trustDirectories: ['${' + SHELL_TRUST_VAR + '}'] },
    } as Settings;

    const result = isWorkspaceTrustedForProviders(
      userSettings,
      workspaceDir,
      (name) => (name === SHELL_TRUST_VAR ? trustedParent : undefined),
    );

    expect(result.isTrusted).toBe(true);
  });

  it('keeps an unresolved reference untrusted when the view excludes it', () => {
    const userSettings = {
      permissions: { trustDirectories: ['${' + WORKSPACE_TRUST_VAR + '}'] },
    } as Settings;

    const result = isWorkspaceTrustedForProviders(
      userSettings,
      workspaceDir,
      () => undefined,
    );

    expect(result.isTrusted).toBeUndefined();
  });

  it('applies the reference default when the view excludes the value', () => {
    const userSettings = {
      permissions: {
        trustDirectories: ['${' + WORKSPACE_TRUST_VAR + ':-/nonexistent}'],
      },
    } as Settings;

    const result = isWorkspaceTrustedForProviders(
      userSettings,
      workspaceDir,
      () => undefined,
    );

    expect(result.isTrusted).toBeUndefined();
  });

  it('consults additionalDirectories rules through the view', () => {
    const userSettings = {
      permissions: {
        trustDirectories: [],
        additionalDirectories: ['${' + SHELL_TRUST_VAR + '}'],
      },
    } as Settings;

    const result = isWorkspaceTrustedForProviders(
      userSettings,
      workspaceDir,
      (name) => (name === SHELL_TRUST_VAR ? trustedParent : undefined),
    );

    expect(result.isTrusted).toBe(true);
  });

  it('honors the folder-trust toggle without rules', () => {
    const userSettings = {
      security: { folderTrust: { enabled: false } },
      permissions: { trustDirectories: [] },
    } as Settings;

    const result = isWorkspaceTrustedForProviders(
      userSettings,
      workspaceDir,
      () => undefined,
    );

    expect(result.isTrusted).toBe(true);
    expect(result.source).toBeUndefined();
  });

  it('reports no trust without trust rules', () => {
    const result = isWorkspaceTrustedForProviders(
      {} as Settings,
      workspaceDir,
      () => undefined,
    );

    expect(result.isTrusted).toBeUndefined();
  });

  it('treats a malformed rule container as ineligible instead of throwing', () => {
    const userSettings = {
      permissions: { trustDirectories: 'not-an-array' },
    } as unknown as Settings;

    expect(() =>
      isWorkspaceTrustedForProviders(
        userSettings,
        workspaceDir,
        () => undefined,
      ),
    ).not.toThrow();
    expect(
      isWorkspaceTrustedForProviders(
        userSettings,
        workspaceDir,
        () => undefined,
      ).isTrusted,
    ).toBeUndefined();
  });

  it('treats a non-string rule container value as ineligible', () => {
    const userSettings = {
      permissions: { trustDirectories: 42 },
    } as unknown as Settings;

    expect(() =>
      isWorkspaceTrustedForProviders(
        userSettings,
        workspaceDir,
        () => undefined,
      ),
    ).not.toThrow();
    expect(
      isWorkspaceTrustedForProviders(
        userSettings,
        workspaceDir,
        () => undefined,
      ).isTrusted,
    ).toBeUndefined();
  });

  it('ignores non-string rule entries while keeping valid literal rules', () => {
    const userSettings = {
      permissions: { trustDirectories: [trustedParent, 42, null] },
    } as unknown as Settings;

    const result = isWorkspaceTrustedForProviders(
      userSettings,
      workspaceDir,
      () => undefined,
    );

    expect(result.isTrusted).toBe(true);
  });

  it('tolerates a malformed permissions container', () => {
    const userSettings = {
      permissions: 'garbage',
    } as unknown as Settings;

    expect(() =>
      isWorkspaceTrustedForProviders(
        userSettings,
        workspaceDir,
        () => undefined,
      ),
    ).not.toThrow();
    expect(
      isWorkspaceTrustedForProviders(
        userSettings,
        workspaceDir,
        () => undefined,
      ).isTrusted,
    ).toBeUndefined();
  });

  it('tolerates a malformed additionalDirectories container', () => {
    const userSettings = {
      permissions: { trustDirectories: [], additionalDirectories: 42 },
    } as unknown as Settings;

    expect(() =>
      isWorkspaceTrustedForProviders(
        userSettings,
        workspaceDir,
        () => undefined,
      ),
    ).not.toThrow();
  });

  describe('with a loaded workspace .env', () => {
    function writeWorkspaceEnv(content: string) {
      const configDir = join(workspaceDir, '.qwen');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, '.env'), content);
    }

    it('excludes the workspace-origin value the projection would expand', () => {
      writeWorkspaceEnv(`${WORKSPACE_TRUST_VAR}=${trustedParent}\n`);
      loadEnvironment({} as Settings, workspaceDir, () => ({
        isTrusted: false,
        source: undefined,
      }));

      // The injection is visible to the loaded projection's expansion...
      expect(process.env[WORKSPACE_TRUST_VAR]).toBe(trustedParent);
      // ...but the provider startup view excludes it.
      const readEnvironment = getProviderStartupEnvironment();
      expect(readEnvironment(WORKSPACE_TRUST_VAR)).toBeUndefined();

      const rawUserSettings = {
        permissions: { trustDirectories: ['${' + WORKSPACE_TRUST_VAR + '}'] },
      } as Settings;
      const providerResult = isWorkspaceTrustedForProviders(
        rawUserSettings,
        workspaceDir,
        readEnvironment,
      );
      expect(providerResult.isTrusted).toBeUndefined();

      // The expanded projection the loaded trust was built from still
      // matches, which is why the provider gate recomputes from raw rules.
      const expandedUserSettings = {
        permissions: { trustDirectories: [trustedParent] },
      } as Settings;
      expect(
        isWorkspaceTrusted(
          expandedUserSettings,
          workspaceDir,
          undefined,
          undefined,
          false,
        ).isTrusted,
      ).toBe(true);
    });

    it('keeps a shell-exported value resolving the same rule', () => {
      writeWorkspaceEnv(`${SHELL_TRUST_VAR}=${workspaceDir}\n`);
      vi.stubEnv(SHELL_TRUST_VAR, trustedParent);
      loadEnvironment({} as Settings, workspaceDir, () => ({
        isTrusted: false,
        source: undefined,
      }));

      // Shell values are never injected, so the view still resolves them.
      const readEnvironment = getProviderStartupEnvironment();
      expect(readEnvironment(SHELL_TRUST_VAR)).toBe(trustedParent);

      const rawUserSettings = {
        permissions: { trustDirectories: ['${' + SHELL_TRUST_VAR + '}'] },
      } as Settings;
      const result = isWorkspaceTrustedForProviders(
        rawUserSettings,
        workspaceDir,
        readEnvironment,
      );
      expect(result.isTrusted).toBe(true);
    });
  });
});
