/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import { createMockWorkspaceContext } from '../test-utils/mockWorkspaceContext.js';
import { LSTool } from './ls.js';
import { ReadFileTool } from './read-file.js';
import { FileReadCache } from '../services/fileReadCache.js';
import { StandardFileSystemService } from '../services/fileSystemService.js';
import { ZoomImageTool } from './zoom-image.js';
import { ToolErrorType } from './tool-error.js';

vi.mock('../telemetry/loggers.js', () => ({ logFileOperation: vi.fn() }));

const FULL = { x1: 0, y1: 0, x2: 1000, y2: 1000 };
const signal = new AbortController().signal;

describe.skipIf(process.platform === 'win32')(
  'managed read path consistency',
  () => {
    let fixture: string;
    let managed: string;
    let workspace: string;
    let outside: string;
    let rawDir: string;
    let config: Config;

    beforeEach(async () => {
      fixture = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), 'managed-path-tools-')),
      );
      managed = path.join(fixture, 'managed');
      workspace = path.join(fixture, 'workspace');
      outside = path.join(fixture, 'outside');
      await Promise.all([managed, workspace, outside].map((p) => fs.mkdir(p)));
      await fs.symlink(outside, path.join(managed, 'link'), 'dir');
      await fs.writeFile(
        path.join(outside, 'SECRET-MARKER.txt'),
        'outside fixture',
      );
      await sharp({
        create: { width: 12, height: 12, channels: 3, background: '#ff0000' },
      })
        .png()
        .toFile(path.join(outside, 'secret.png'));
      rawDir = `${managed}/link/../outside`;
      const fileService = new FileDiscoveryService(workspace);
      config = {
        getTargetDir: () => workspace,
        getWorkspaceContext: () => createMockWorkspaceContext(workspace),
        getFileService: () => fileService,
        getFileFilteringOptions: () => ({
          respectGitIgnore: true,
          respectQwenIgnore: true,
        }),
        getTruncateToolOutputLines: () => 1000,
        getTruncateToolOutputThreshold: () => 2500,
        getFileReadCache: () => new FileReadCache(),
        getFileReadCacheDisabled: () => true,
        getFileSystemService: () => new StandardFileSystemService(),
        getManagedExtensionsDir: () => managed,
        getEffectiveInputModalities: () => ({ image: true }),
        getPlansDir: () => path.join(workspace, '.plans'),
        storage: {
          getUserSkillsDirs: () => [path.join(workspace, '.skills')],
          getProjectTempDir: () => path.join(workspace, '.temp'),
          getProjectDir: () => path.join(workspace, '.project'),
          getWorkflowRunsDir: () => path.join(workspace, '.workflow-runs'),
        },
      } as unknown as Config;
    });

    afterEach(async () => {
      await fs.rm(fixture, { recursive: true, force: true });
    });

    it('does not list the outside directory through a symlink plus dot-dot', async () => {
      const invocation = new LSTool(config).build({ path: rawDir });
      const permission = await invocation.getDefaultPermission();
      const outsideEntries = await fs.readdir(rawDir);
      const result = await invocation.execute(signal);
      expect(outsideEntries).toContain('SECRET-MARKER.txt');
      expect(permission).toBe('allow');
      expect(result.error?.type).toBe(ToolErrorType.LS_EXECUTION_ERROR);
      expect(result.llmContent).toContain('ENOENT');
      expect(result.llmContent).not.toContain('SECRET-MARKER.txt');
    });

    it('does not return an outside image through a symlink plus dot-dot', async () => {
      const invocation = new ZoomImageTool(config).build({
        file_path: `${rawDir}/secret.png`,
        ...FULL,
      });
      const permission = await invocation.getDefaultPermission();
      const result = await invocation.execute(signal);
      const parts = Array.isArray(result.llmContent) ? result.llmContent : [];
      const image = parts.find(
        (part) => typeof part !== 'string' && part.inlineData !== undefined,
      );
      expect(permission).toBe('allow');
      expect(result.error?.type).toBe(ToolErrorType.FILE_NOT_FOUND);
      expect(image).toBeUndefined();
    });

    it.each([false, true])(
      'does not return outside text through read_file with cacheDisabled=%s',
      async (cacheDisabled) => {
        const fileReadCache = new FileReadCache();
        const readConfig = {
          ...config,
          getFileReadCacheDisabled: () => cacheDisabled,
          getFileReadCache: () => fileReadCache,
        } as Config;
        const invocation = new ReadFileTool(readConfig).build({
          file_path: `${rawDir}/SECRET-MARKER.txt`,
        });
        const permission = await invocation.getDefaultPermission();
        const result = await invocation.execute(signal);
        expect(permission).toBe('allow');
        expect(result.error?.type).toBe(ToolErrorType.FILE_NOT_FOUND);
        expect(result.llmContent).not.toContain('outside fixture');
      },
    );

    it('asks for all raw paths when the managed root is not configured', async () => {
      const ordinary = {
        ...config,
        getManagedExtensionsDir: () => undefined,
      } as Config;
      expect(
        await new LSTool(ordinary)
          .build({ path: rawDir })
          .getDefaultPermission(),
      ).toBe('ask');
      expect(
        await new ZoomImageTool(ordinary)
          .build({ file_path: `${rawDir}/secret.png`, ...FULL })
          .getDefaultPermission(),
      ).toBe('ask');
      expect(
        await new ReadFileTool(ordinary)
          .build({ file_path: `${rawDir}/SECRET-MARKER.txt` })
          .getDefaultPermission(),
      ).toBe('ask');
    });

    it('reports an ENOENT error for normalized twins without outside data', async () => {
      expect(
        (
          await new LSTool(config)
            .build({ path: path.resolve(rawDir) })
            .execute(signal)
        ).error?.type,
      ).toBe(ToolErrorType.LS_EXECUTION_ERROR);
      expect(
        (
          await new ZoomImageTool(config)
            .build({ file_path: path.resolve(rawDir, 'secret.png'), ...FULL })
            .execute(signal)
        ).error?.type,
      ).toBe(ToolErrorType.FILE_NOT_FOUND);
      expect(
        (
          await new ReadFileTool(config)
            .build({ file_path: path.resolve(rawDir, 'SECRET-MARKER.txt') })
            .execute(signal)
        ).error?.type,
      ).toBe(ToolErrorType.FILE_NOT_FOUND);
    });

    it('still lists, reads and zooms regular content inside the managed root', async () => {
      await fs.writeFile(path.join(managed, 'safe.txt'), 'safe fixture');
      await fs.copyFile(
        path.join(outside, 'secret.png'),
        path.join(managed, 'safe.png'),
      );
      const listing = new LSTool(config).build({ path: managed });
      expect(await listing.getDefaultPermission()).toBe('allow');
      const listingResult = await listing.execute(signal);
      expect(listingResult.error).toBeUndefined();
      expect(listingResult.llmContent).toContain('safe.txt');
      const zoom = new ZoomImageTool(config).build({
        file_path: path.join(managed, 'safe.png'),
        ...FULL,
      });
      expect(await zoom.getDefaultPermission()).toBe('allow');
      const imageResult = await zoom.execute(signal);
      expect(imageResult.error).toBeUndefined();
      expect(imageResult.llmContent).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ inlineData: expect.any(Object) }),
        ]),
      );
      const read = new ReadFileTool(config).build({
        file_path: path.join(managed, 'safe.txt'),
      });
      expect(await read.getDefaultPermission()).toBe('allow');
      expect((await read.execute(signal)).llmContent).toBe('safe fixture');
    });

    it('asks when a leaf symlink target traverses another link and dot-dot', async () => {
      await fs.symlink('link/../outside', path.join(managed, 'alias'), 'dir');
      await fs.symlink(
        'link/../outside/SECRET-MARKER.txt',
        path.join(managed, 'alias.txt'),
      );
      await fs.symlink(
        'link/../outside/secret.png',
        path.join(managed, 'alias.png'),
      );
      expect(await fs.realpath(path.join(managed, 'alias'))).toBe(outside);
      const invocations = [
        new LSTool(config).build({ path: path.join(managed, 'alias') }),
        new ReadFileTool(config).build({
          file_path: path.join(managed, 'alias.txt'),
        }),
        new ZoomImageTool(config).build({
          file_path: path.join(managed, 'alias.png'),
          ...FULL,
        }),
      ];
      for (const invocation of invocations) {
        expect(await invocation.getDefaultPermission()).toBe('ask');
      }
    });

    it('still asks for a direct symlink to outside content', async () => {
      expect(
        await new LSTool(config)
          .build({ path: path.join(managed, 'link') })
          .getDefaultPermission(),
      ).toBe('ask');
      expect(
        await new ZoomImageTool(config)
          .build({
            file_path: path.join(managed, 'link', 'secret.png'),
            ...FULL,
          })
          .getDefaultPermission(),
      ).toBe('ask');
      expect(
        await new ReadFileTool(config)
          .build({ file_path: path.join(managed, 'link', 'SECRET-MARKER.txt') })
          .getDefaultPermission(),
      ).toBe('ask');
    });
  },
);
