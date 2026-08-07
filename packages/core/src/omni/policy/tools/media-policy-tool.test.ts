/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MediaPolicyToolDescriptor } from '../../../tools/tools.js';
import { Kind, type ToolResult } from '../../../tools/tools.js';
import {
  assertMediaPolicyIo,
  BaseMediaPolicyTool,
  DEFAULT_POLICY_TOOL_TIMEOUT_MS,
  formatBytesShort,
  resolvePolicyToolTimeoutMs,
  validateMediaPolicyIoParams,
  type MediaPolicyToolConfigView,
} from './media-policy-tool.js';
import { BaseToolInvocation } from '../../../tools/tools.js';

describe('formatBytesShort', () => {
  it.each([
    [512, '512B'],
    [8_200_000, '7.8MB'],
    [943_718, '921.6KB'],
    [2 * 1024 ** 3, '2GB'],
    [180 * 1024 ** 2, '180MB'],
    [1024, '1KB'],
  ])('%d → %s', (bytes, expected) => {
    expect(formatBytesShort(bytes)).toBe(expected);
  });
});

describe('resolvePolicyToolTimeoutMs', () => {
  it('defaults to 600s when unset', () => {
    expect(resolvePolicyToolTimeoutMs({}, 'omni_downscale_video')).toBe(
      DEFAULT_POLICY_TOOL_TIMEOUT_MS,
    );
    expect(DEFAULT_POLICY_TOOL_TIMEOUT_MS).toBe(600_000);
  });

  it('reads policyTools.<tool>.runtime.timeoutMs', () => {
    const config = {
      getOmniPolicyToolsSettings: () => ({
        omni_downscale_video: { runtime: { timeoutMs: 120_000 } },
      }),
    };
    expect(resolvePolicyToolTimeoutMs(config, 'omni_downscale_video')).toBe(
      120_000,
    );
  });

  it.each([
    ['tombstone entry', null],
    ['malformed runtime', { runtime: 'fast' }],
    ['non-numeric timeout', { runtime: { timeoutMs: 'soon' } }],
    ['non-positive timeout', { runtime: { timeoutMs: 0 } }],
    ['non-finite timeout', { runtime: { timeoutMs: Infinity } }],
  ])('falls back to the default on %s', (_label, entry) => {
    const config = {
      getOmniPolicyToolsSettings: () => ({
        omni_downscale_video: entry as never,
      }),
    };
    expect(resolvePolicyToolTimeoutMs(config, 'omni_downscale_video')).toBe(
      DEFAULT_POLICY_TOOL_TIMEOUT_MS,
    );
  });
});

describe('validateMediaPolicyIoParams', () => {
  it('accepts absolute paths', () => {
    expect(
      validateMediaPolicyIoParams({
        inputPath: '/a/in.mp4',
        outputDir: '/b/staging',
      }),
    ).toBeNull();
  });

  it.each([
    ['relative inputPath', 'in.mp4', '/b', /inputPath must be an absolute/],
    ['relative outputDir', '/a/in.mp4', 'out', /outputDir must be an absolute/],
  ])('rejects %s', (_label, inputPath, outputDir, pattern) => {
    expect(validateMediaPolicyIoParams({ inputPath, outputDir })).toMatch(
      pattern,
    );
  });
});

describe('assertMediaPolicyIo', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-mp-io-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('returns the input size for a valid pair', async () => {
    const inputPath = path.join(root, 'in.bin');
    await fs.writeFile(inputPath, Buffer.alloc(1234));
    const outputDir = path.join(root, 'staging');
    await fs.mkdir(outputDir);
    await expect(
      assertMediaPolicyIo({ inputPath, outputDir }),
    ).resolves.toEqual({ inputSizeBytes: 1234 });
  });

  it('rejects a missing input file', async () => {
    const outputDir = path.join(root, 'staging');
    await fs.mkdir(outputDir);
    await expect(
      assertMediaPolicyIo({ inputPath: path.join(root, 'nope'), outputDir }),
    ).rejects.toThrow(/input file not found/);
  });

  it('rejects a symlinked input (never reads through a link)', async () => {
    const real = path.join(root, 'real.bin');
    await fs.writeFile(real, 'x');
    const link = path.join(root, 'link.bin');
    await fs.symlink(real, link);
    const outputDir = path.join(root, 'staging');
    await fs.mkdir(outputDir);
    await expect(
      assertMediaPolicyIo({ inputPath: link, outputDir }),
    ).rejects.toThrow(/not a regular file/);
  });

  it('rejects a missing output directory', async () => {
    const inputPath = path.join(root, 'in.bin');
    await fs.writeFile(inputPath, 'x');
    await expect(
      assertMediaPolicyIo({ inputPath, outputDir: path.join(root, 'nope') }),
    ).rejects.toThrow(/output directory not found/);
  });

  it('rejects a symlinked output directory', async () => {
    const inputPath = path.join(root, 'in.bin');
    await fs.writeFile(inputPath, 'x');
    const realDir = path.join(root, 'real-dir');
    await fs.mkdir(realDir);
    const linkDir = path.join(root, 'link-dir');
    await fs.symlink(realDir, linkDir);
    await expect(
      assertMediaPolicyIo({ inputPath, outputDir: linkDir }),
    ).rejects.toThrow(/not a real directory/);
  });
});

describe('BaseMediaPolicyTool validation', () => {
  interface TestParams {
    inputPath: string;
    outputDir: string;
    level?: number;
  }

  class NoopInvocation extends BaseToolInvocation<TestParams, ToolResult> {
    getDescription(): string {
      return 'noop';
    }
    async execute(): Promise<ToolResult> {
      return { llmContent: 'ok', returnDisplay: 'ok' };
    }
  }

  class TestPolicyTool extends BaseMediaPolicyTool<TestParams> {
    constructor(view: MediaPolicyToolConfigView = {}) {
      super(
        'test_policy_tool',
        'TestPolicyTool',
        'test',
        Kind.Other,
        {
          type: 'object',
          properties: {
            inputPath: { type: 'string' },
            outputDir: { type: 'string' },
            level: { type: 'number', minimum: 1 },
          },
          required: ['inputPath', 'outputDir'],
          additionalProperties: false,
        },
        view,
      );
    }
    override get mediaPolicyDescriptor(): MediaPolicyToolDescriptor {
      return {
        kind: 'media_policy',
        inputMediaTypes: ['image'],
        outputs: [{ kind: 'media', required: true, lossy: true }],
      };
    }
    protected override validateToolParamValues(
      params: TestParams,
    ): string | null {
      return validateMediaPolicyIoParams(params);
    }
    protected createInvocation(params: TestParams): NoopInvocation {
      return new NoopInvocation(params);
    }
  }

  const tool = new TestPolicyTool();

  it('validates against the NATIVE parameter schema', () => {
    expect(
      tool.validateToolParams({
        inputPath: '/a/in.png',
        outputDir: '/b/staging',
        level: 3,
      }),
    ).toBeNull();
  });

  it('rejects schema violations (unknown property, missing required)', () => {
    expect(
      tool.validateToolParams({
        inputPath: '/a/in.png',
        outputDir: '/b/staging',
        extra: true,
      } as never),
    ).not.toBeNull();
    expect(
      tool.validateToolParams({ inputPath: '/a/in.png' } as never),
    ).not.toBeNull();
  });

  it('runs value validation after schema validation', () => {
    expect(
      tool.validateToolParams({ inputPath: 'rel.png', outputDir: '/b' }),
    ).toMatch(/absolute/);
  });

  it('build throws on invalid params', () => {
    expect(() => tool.build({ inputPath: 'rel.png', outputDir: '/b' })).toThrow(
      /absolute/,
    );
  });

  describe('model-visible schema projection (decision D6)', () => {
    it('declares the native schema unchanged without modelAccess settings', () => {
      expect(tool.schema).toEqual({
        name: 'test_policy_tool',
        description: 'test',
        parametersJsonSchema: {
          type: 'object',
          properties: {
            inputPath: { type: 'string' },
            outputDir: { type: 'string' },
            level: { type: 'number', minimum: 1 },
          },
          required: ['inputPath', 'outputDir'],
          additionalProperties: false,
        },
      });
    });

    it('projects the declaration while validation keeps the native schema', () => {
      const configured = new TestPolicyTool({
        getOmniPolicyToolsSettings: () => ({
          test_policy_tool: {
            modelAccess: {
              enabled: true,
              description: 'Model-facing description.',
              lockedArguments: { inputPath: '/x', outputDir: '/y' },
              parameterSchema: { properties: { level: { maximum: 9 } } },
            },
          },
        }),
      });
      // The model sees ONLY the tunable, with the override merged in.
      expect(configured.schema).toEqual({
        name: 'test_policy_tool',
        description: 'Model-facing description.',
        parametersJsonSchema: {
          type: 'object',
          properties: { level: { type: 'number', minimum: 1, maximum: 9 } },
          required: [],
          additionalProperties: false,
        },
      });
      // …but the harness-injected io arguments the projection hides must
      // remain valid: validation runs on the NATIVE schema (§9.4).
      expect(
        configured.validateToolParams({
          inputPath: '/a/in.png',
          outputDir: '/b/staging',
          level: 3,
        }),
      ).toBeNull();
    });
  });
});
