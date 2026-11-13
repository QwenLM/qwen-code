/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getUserStartupWarnings } from './userStartupWarnings.js';
import * as os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';

describe('getUserStartupWarnings', () => {
  let testRootDir: string;
  let startupOptions: {
    workspaceRoot: string;
    useRipgrep: boolean;
    useBuiltinRipgrep: boolean;
  };

  beforeEach(async () => {
    testRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'warnings-test-'));
    // Keeps the ~/.qwen check below off the real home directory.
    vi.stubEnv('QWEN_HOME', path.join(testRootDir, 'qwen-home'));
    startupOptions = {
      workspaceRoot: testRootDir,
      useRipgrep: true,
      useBuiltinRipgrep: true,
    };
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(testRootDir, { recursive: true, force: true });
  });

  describe('root directory check', () => {
    it('should return a warning when running in a root directory', async () => {
      const rootDir = path.parse(testRootDir).root;
      const warnings = await getUserStartupWarnings({
        ...startupOptions,
        workspaceRoot: rootDir,
      });
      expect(warnings).toContainEqual(
        expect.stringContaining('root directory'),
      );
      expect(warnings).toContainEqual(
        expect.stringContaining('folder structure will be used'),
      );
    });

    it('should not return a warning when running in a non-root directory', async () => {
      const projectDir = path.join(testRootDir, 'project');
      await fs.mkdir(projectDir);
      const warnings = await getUserStartupWarnings({
        ...startupOptions,
        workspaceRoot: projectDir,
      });
      expect(warnings).not.toContainEqual(
        expect.stringContaining('root directory'),
      );
    });
  });

  describe('sign-in files left in ~/.qwen on an XDG install', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    let home: string;
    const legacyDir = () => path.join(home, '.qwen');
    const xdgDir = () => path.join(home, '.config', 'qwen');
    const write = async (file: string, content = '{}') => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content);
    };
    const notices = async () =>
      (await getUserStartupWarnings(startupOptions)).filter((warning) =>
        warning.includes('from another Qwen Code install'),
      );

    beforeEach(async () => {
      home = path.join(testRootDir, 'home');
      vi.stubEnv('HOME', home);
      vi.stubEnv('USERPROFILE', home);
      vi.stubEnv('QWEN_HOME', undefined);
      vi.stubEnv('XDG_CONFIG_HOME', undefined);
      Object.defineProperty(process, 'platform', { value: 'linux' });
      // An XDG install, next to a ~/.qwen another install signed in from.
      await write(path.join(xdgDir(), '.qwen-global-dir'), '');
      await write(path.join(legacyDir(), 'settings.json'), '{"legacy":1}');
      await write(path.join(legacyDir(), 'oauth_creds.json'), '{"legacy":2}');
    });

    afterEach(() => {
      Object.defineProperty(process, 'platform', platform);
    });

    it('says where they are and reads, copies or moves nothing', async () => {
      const tilde = (...segments: string[]) => path.join('~', ...segments);
      expect(await notices()).toEqual([
        `${tilde('.qwen')} has settings.json and oauth_creds.json from another Qwen Code install, ` +
          `but this install uses ${tilde('.config', 'qwen')} and does not read them. ` +
          `Run /auth to sign in here, or delete ` +
          `${tilde('.config', 'qwen', '.qwen-global-dir')} to use ${tilde('.qwen')} instead.`,
      ]);
      expect((await fs.readdir(legacyDir())).sort()).toEqual([
        'oauth_creds.json',
        'settings.json',
      ]);
      expect(
        await fs.readFile(path.join(legacyDir(), 'oauth_creds.json'), 'utf8'),
      ).toBe('{"legacy":2}');
      expect(await fs.readdir(xdgDir())).toEqual(['.qwen-global-dir']);
    });

    it('names only the files the XDG directory lacks', async () => {
      await write(path.join(xdgDir(), 'settings.json'));
      const [notice] = await notices();
      expect(notice).toContain(' has oauth_creds.json from another');
      expect(notice).toContain(' does not read it. ');

      await write(path.join(xdgDir(), 'oauth_creds.json'));
      expect(await notices()).toEqual([]);
    });

    it('says nothing while ~/.qwen is the global dir', async () => {
      await fs.rm(path.join(xdgDir(), '.qwen-global-dir'));
      expect(await notices()).toEqual([]);
    });

    it('says nothing under QWEN_HOME, even pointed at the XDG directory', async () => {
      vi.stubEnv('QWEN_HOME', xdgDir());
      expect(await notices()).toEqual([]);
    });

    it.each(['darwin', 'win32'])('says nothing on %s', async (value) => {
      Object.defineProperty(process, 'platform', { value });
      expect(await notices()).toEqual([]);
    });
  });

  describe('error handling', () => {
    it('should handle errors when checking directory', async () => {
      const nonExistentPath = path.join(testRootDir, 'non-existent');
      const warnings = await getUserStartupWarnings({
        ...startupOptions,
        workspaceRoot: nonExistentPath,
      });
      const expectedWarning =
        'Could not verify the current directory due to a file system error.';
      expect(warnings).toEqual([expectedWarning]);
    });
  });
});
