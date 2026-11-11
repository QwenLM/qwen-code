/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  vi,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  type Mock,
} from 'vitest';
import { InstallationManager } from './installationManager.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  CONFIG_DIR,
  homedir as pathsHomedir,
  setConfigHomeDirOverride,
} from './paths.js';
import { runLogger } from './runLogger.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    existsSync: vi.fn(actual.existsSync),
  } as typeof actual;
});

vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof import('node:os')>();
  return {
    ...os,
    homedir: vi.fn(),
  };
});

vi.mock('node:crypto', async (importOriginal) => {
  const crypto = await importOriginal<typeof import('node:crypto')>();
  return {
    ...crypto,
    randomUUID: vi.fn(),
  };
});

vi.mock('./paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./paths.js')>();
  return {
    ...actual,
    homedir: vi.fn(),
  };
});

describe('InstallationManager', () => {
  let tempHomeDir: string;
  let installationManager: InstallationManager;
  const installationIdFile = () =>
    path.join(tempHomeDir, CONFIG_DIR, 'installation_id');

  beforeEach(() => {
    tempHomeDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gemini-cli-test-home-'),
    );
    (pathsHomedir as Mock).mockReturnValue(tempHomeDir);
    (os.homedir as Mock).mockReturnValue(tempHomeDir);
    setConfigHomeDirOverride(path.join(tempHomeDir, CONFIG_DIR));
    installationManager = new InstallationManager();
  });

  afterEach(() => {
    fs.rmSync(tempHomeDir, { recursive: true, force: true });
    setConfigHomeDirOverride(undefined);
    vi.clearAllMocks();
  });

  describe('getInstallationId', () => {
    it('should create and write a new installation ID if one does not exist', () => {
      const newId = 'new-uuid-123';
      (randomUUID as Mock).mockReturnValue(newId);

      const installationId = installationManager.getInstallationId();
      const repeatedId = installationManager.getInstallationId();

      expect(installationId).toBe(newId);
      expect(repeatedId).toBe(newId);
      expect(randomUUID).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(installationIdFile())).toBe(true);
      expect(fs.readFileSync(installationIdFile(), 'utf-8')).toBe(newId);
    });

    it('should read an existing installation ID from a file', () => {
      const existingId = 'existing-uuid-123';
      fs.mkdirSync(path.dirname(installationIdFile()), { recursive: true });
      fs.writeFileSync(installationIdFile(), existingId);

      const installationId = installationManager.getInstallationId();

      expect(installationId).toBe(existingId);
    });

    it('should cache an existing ID after the first file read', () => {
      const existingId = 'existing-uuid-123';
      fs.mkdirSync(path.dirname(installationIdFile()), { recursive: true });
      fs.writeFileSync(installationIdFile(), existingId);

      const firstId = installationManager.getInstallationId();
      const secondId = installationManager.getInstallationId();

      expect(firstId).toBe(existingId);
      expect(secondId).toBe(firstId);
      expect(fs.existsSync).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync).toHaveBeenCalledTimes(1);
    });

    it('should cache the fallback ID after a read error', () => {
      vi.mocked(fs.existsSync).mockReturnValueOnce(true);
      const readSpy = vi.mocked(fs.readFileSync);
      readSpy.mockImplementationOnce(() => {
        throw new Error('Read error');
      });
      const consoleWarnSpy = vi
        .spyOn(runLogger, 'warn')
        .mockImplementation(() => {});

      const id = installationManager.getInstallationId();
      const repeatedId = installationManager.getInstallationId();

      expect(id).toBe('123456789');
      expect(repeatedId).toBe(id);
      expect(readSpy).toHaveBeenCalledTimes(1);
      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    });
  });
});
