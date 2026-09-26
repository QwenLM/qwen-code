/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Part } from '@google/genai';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Config } from '../config/config.js';
import { ReadFileTool } from './read-file.js';
import { ZoomImageTool } from './zoom-image.js';
import { NotebookEditTool } from './notebook-edit.js';
import { ToolRegistry } from './tool-registry.js';
import {
  createBuiltinManagedToolRuntime,
  type ManagedToolRuntime,
  type ManagedToolExecutionResult,
} from './managed-tool-runtime.js';
import {
  parseManagedToolInvocationReference,
  type ManagedToolPrepareResponse,
} from './managed-tool-protocol.js';

function reference(prepared: ManagedToolPrepareResponse) {
  const {
    params: _params,
    description: _description,
    locations: _locations,
    defaultPermission: _permission,
    requiresUserInteraction: _interaction,
    toolUseId: _toolUseId,
    ...ref
  } = prepared;
  return parseManagedToolInvocationReference(ref);
}

function images(result: ManagedToolExecutionResult) {
  expect(result.executionStatus).toBe('success');
  const content = result.result?.llmContent;
  return Array.isArray(content)
    ? (content as Part[]).flatMap((part) =>
        part.inlineData ? [part.inlineData] : [],
      )
    : [];
}

describe('managed native media invocation views', () => {
  let root: string;
  let config: Config;
  let registry: ToolRegistry;
  let runtime: ManagedToolRuntime;
  let imagePath: string;
  let identity: {
    sessionId: string;
    promptId: string;
    callId: string;
    capabilityDigest: string;
    policyRevision: string;
  };
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'managed-media-')));
    vi.stubEnv('QWEN_HOME', join(root, 'home'));
    vi.stubEnv('QWEN_RUNTIME_DIR', join(root, 'runtime'));
    config = new Config({
      targetDir: root,
      cwd: root,
      model: 'text-only',
      debugMode: false,
      telemetry: { enabled: false },
      usageStatisticsEnabled: false,
      disableAllHooks: true,
    });
    registry = new ToolRegistry(config);
    vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
    registry.registerTool(new ReadFileTool(config));
    registry.registerTool(new ZoomImageTool(config));
    registry.registerTool(new NotebookEditTool(config));
    imagePath = join(root, 'green.png');
    await sharp({
      create: { width: 40, height: 40, channels: 3, background: '#00ff00' },
    })
      .png()
      .toFile(imagePath);
    runtime = await createBuiltinManagedToolRuntime(config);
    const manifest = runtime.manifest();
    identity = {
      sessionId: config.getSessionId(),
      promptId: 'media-turn',
      callId: 'read',
      capabilityDigest: manifest.capabilityDigest,
      policyRevision: manifest.policyRevision,
    };
    await runtime.beginTurn(identity);
  });
  afterEach(async () => {
    await runtime?.dispose();
    await registry?.stop();
    await config?.shutdown({ shutdownTelemetry: false });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });
  async function execute(prepared: ManagedToolPrepareResponse) {
    const ref = reference(prepared);
    await runtime.preflight(ref);
    return runtime.execute(ref);
  }
  const media = (image: boolean) => ({ inputModalities: { image } });
  const crop = () => ({ file_path: imagePath, x1: 0, y1: 0, x2: 500, y2: 500 });

  it('returns the real native image through an explicit capability without a model generator', async () => {
    expect(config.getContentGeneratorConfig()).toBeUndefined();
    const result = await execute(
      await runtime.prepare(
        identity,
        ReadFileTool.Name,
        { file_path: imagePath },
        undefined,
        media(true),
      ),
    );
    const [part] = images(result);
    expect(part?.mimeType).toBe('image/jpeg');
    const { data, info } = await sharp(Buffer.from(part!.data!, 'base64'))
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(info.width).toBeGreaterThan(0);
    expect(data[1]).toBeGreaterThan(230);
    expect(data[0]).toBeLessThan(20);
    expect(config.getContentGeneratorConfig()).toBeUndefined();
    expect(config.getEffectiveInputModalities()).toEqual({});
  });

  it('keeps prepared Zoom capability stable while the next call in the same prompt changes', async () => {
    const context = media(true);
    const first = await runtime.prepare(
      identity,
      ZoomImageTool.Name,
      crop(),
      undefined,
      context,
    );
    context.inputModalities.image = false;
    await expect(
      runtime.prepare(identity, ZoomImageTool.Name, crop(), undefined, context),
    ).rejects.toThrow();
    const retry = await runtime.prepare(
      identity,
      ZoomImageTool.Name,
      crop(),
      undefined,
      media(true),
    );
    expect(retry).toEqual(first);
    const second = await runtime.prepare(
      { ...identity, callId: 'second' },
      ZoomImageTool.Name,
      crop(),
      undefined,
      media(false),
    );
    expect(images(await execute(first))).toHaveLength(1);
    const rejected = await execute(second);
    expect(rejected.executionStatus).toBe('error');
    expect(rejected.result?.llmContent).toContain(
      'requires a model that accepts image',
    );
    expect(config.getEffectiveInputModalities()).toEqual({});
  });

  it('keeps concurrent Read capabilities isolated on the same tool Config', async () => {
    const yes = await runtime.prepare(
      identity,
      ReadFileTool.Name,
      { file_path: imagePath },
      undefined,
      media(true),
    );
    const no = await runtime.prepare(
      { ...identity, callId: 'no-image' },
      ReadFileTool.Name,
      { file_path: imagePath },
      undefined,
      media(false),
    );
    const [supported, unsupported] = await Promise.all([
      execute(yes),
      execute(no),
    ]);
    expect(images(supported)).toHaveLength(1);
    expect(images(unsupported)).toHaveLength(0);
    expect(config.getEffectiveInputModalities()).toEqual({});
  });

  it('retains the owning read cache when the media Config view reads a notebook', async () => {
    const notebook = join(root, 'cache.ipynb');
    await writeFile(
      notebook,
      JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {},
        cells: [
          {
            id: 'a',
            cell_type: 'code',
            source: ['x = 1'],
            metadata: {},
            outputs: [],
            execution_count: null,
          },
        ],
      }),
    );
    expect(
      (
        await execute(
          await runtime.prepare(
            identity,
            ReadFileTool.Name,
            { file_path: notebook },
            undefined,
            media(true),
          ),
        )
      ).executionStatus,
    ).toBe('success');
    const edit = await runtime.prepare(
      { ...identity, callId: 'edit' },
      NotebookEditTool.Name,
      { notebook_path: notebook, cell_id: 'a', new_source: 'x = 2' },
    );
    await expect(runtime.confirmation(reference(edit))).resolves.toMatchObject({
      type: 'edit',
    });
  });

  it('does not grant implicit image capability when media context is omitted', async () => {
    const result = await execute(
      await runtime.prepare(identity, ReadFileTool.Name, {
        file_path: imagePath,
      }),
    );
    expect(images(result)).toHaveLength(0);
  });

  it('rejects media metadata for tools that do not consume it', async () => {
    await expect(
      runtime.prepare(
        identity,
        NotebookEditTool.Name,
        {},
        undefined,
        media(true),
      ),
    ).rejects.toThrow('does not support media context');
  });

  it('retains the native zero-byte audio read result using resolved audio capability', async () => {
    const path = join(root, 'empty.wav');
    await writeFile(path, '');
    const result = await execute(
      await runtime.prepare(
        identity,
        ReadFileTool.Name,
        { file_path: path },
        undefined,
        { inputModalities: { audio: true } },
      ),
    );
    expect(result.executionStatus).toBe('success');
    expect(result.result?.llmContent).toEqual({
      inlineData: { data: '', mimeType: 'audio/wav', displayName: 'empty.wav' },
    });
    expect(config.getEffectiveInputModalities()).toEqual({});
  });

  it.each([true, false])(
    'loads Zoom only when a native factory was registered (%s)',
    async (registered) => {
      await runtime.dispose();
      await registry.stop();
      registry = new ToolRegistry(config);
      vi.mocked(config.getToolRegistry).mockReturnValue(registry);
      if (registered)
        registry.registerFactory(
          ZoomImageTool.Name,
          async () => new ZoomImageTool(config),
        );
      runtime = await createBuiltinManagedToolRuntime(config);
      const manifest = runtime.manifest();
      const { capabilityDigest, policyRevision } = manifest;
      identity = { ...identity, capabilityDigest, policyRevision };
      await runtime.beginTurn(identity);
      if (registered) {
        expect(manifest.tools).toEqual([
          expect.objectContaining({
            name: ZoomImageTool.Name,
            shouldDefer: true,
          }),
        ]);
        expect(
          images(
            await execute(
              await runtime.prepare(
                identity,
                ZoomImageTool.Name,
                crop(),
                undefined,
                media(true),
              ),
            ),
          ),
        ).toHaveLength(1);
      } else {
        expect(manifest.tools).toEqual([]);
        await expect(
          runtime.prepare(
            identity,
            ZoomImageTool.Name,
            crop(),
            undefined,
            media(true),
          ),
        ).rejects.toThrow('unavailable');
      }
    },
  );
});
