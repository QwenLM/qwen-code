/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaPolicyToolDescriptor } from '../../../tools/tools.js';
import { Kind, type ToolResult } from '../../../tools/tools.js';
import {
  assertMediaPolicyIo,
  BaseMediaPolicyTool,
  createPolicyToolTimeoutBudget,
  DEFAULT_POLICY_TOOL_TIMEOUT_MS,
  formatBytesShort,
  MEDIA_POLICY_IO_SCHEMA_PROPERTIES,
  resolvePolicyToolTimeoutMs,
  policyOutputFileName,
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

describe('createPolicyToolTimeoutBudget', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives the first pass the full budget and later passes only the remainder', () => {
    const remaining = createPolicyToolTimeoutBudget(10_000);
    expect(remaining()).toBe(10_000);
    vi.advanceTimersByTime(4_000);
    expect(remaining()).toBe(6_000);
  });

  it('starts the clock at the first call, not at creation', () => {
    const remaining = createPolicyToolTimeoutBudget(10_000);
    vi.advanceTimersByTime(5_000); // setup time before the first pass
    expect(remaining()).toBe(10_000);
  });

  it('floors an exhausted budget at 1ms so a follow-up pass fails fast', () => {
    const remaining = createPolicyToolTimeoutBudget(10_000);
    expect(remaining()).toBe(10_000);
    vi.advanceTimersByTime(60_000);
    expect(remaining()).toBe(1);
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

  it('asks for inputPath or resourceId when neither was supplied', () => {
    // Schema-level `required` deliberately omits inputPath (the gated
    // model surface passes resourceId, resolved before validation) — so
    // the neither-provided case must fail HERE with an actionable hint.
    expect(
      validateMediaPolicyIoParams({
        outputDir: '/b/staging',
      } as unknown as Parameters<typeof validateMediaPolicyIoParams>[0]),
    ).toMatch(/inputPath.*or resourceId/);
  });
});

describe('policyOutputFileName', () => {
  it('keeps two spans of one source from colliding', () => {
    const a = policyOutputFileName({
      inputPath: '/films/robot-dreams.mkv',
      operation: 'clip',
      variant: '90s+75s',
      extension: '.mp4',
    });
    const b = policyOutputFileName({
      inputPath: '/films/robot-dreams.mkv',
      operation: 'clip',
      variant: '2458s+75s',
      extension: '.mp4',
    });
    expect(a).toBe('robot-dreams-clip-90s+75s.mp4');
    expect(b).toBe('robot-dreams-clip-2458s+75s.mp4');
    expect(a).not.toBe(b);
  });

  it('keeps two sources from colliding on the same operation', () => {
    const opts = { operation: 'audio', extension: '.wav' } as const;
    expect(
      policyOutputFileName({ inputPath: '/a/movie.mkv', ...opts }),
    ).not.toBe(policyOutputFileName({ inputPath: '/b/other.mkv', ...opts }));
  });

  it('re-running one operation resolves to the same name (idempotent)', () => {
    const opts = {
      inputPath: '/a/movie.mkv',
      operation: 'clip',
      variant: '0s+30s',
      extension: '.mp4',
    } as const;
    expect(policyOutputFileName(opts)).toBe(policyOutputFileName(opts));
  });

  it('sanitizes a hostile or non-ASCII stem into a portable component', () => {
    const name = policyOutputFileName({
      inputPath: '/tmp/《机器人之梦》 v2; rm -rf.mkv',
      operation: 'keyframe',
      variant: '0001',
      extension: '.jpg',
    });
    expect(name).toMatch(/^[A-Za-z0-9._+-]+$/);
    expect(name.endsWith('-keyframe-0001.jpg')).toBe(true);
    expect(name).not.toContain('/');
    expect(name).not.toContain(';');
  });

  it('falls back to a placeholder when nothing portable survives', () => {
    expect(
      policyOutputFileName({
        inputPath: '/tmp/《》.mkv',
        operation: 'audio',
        extension: '.wav',
      }),
    ).toBe('media-audio.wav');
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
    const error = await assertMediaPolicyIo({
      inputPath: path.join(root, 'nope'),
      outputDir,
    }).catch((err: Error) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/input file not found/);
    // Basename only: this message reaches the model, and a resourceId-
    // resolved call must never leak the locator the handle stands in for
    // (M §5.2). A full-path message satisfies the matcher above too.
    expect((error as Error).message).not.toContain(root);
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

  it('rejects a missing output directory and never creates it', async () => {
    const inputPath = path.join(root, 'in.bin');
    await fs.writeFile(inputPath, 'x');
    const outputDir = path.join(root, 'nope');
    await expect(assertMediaPolicyIo({ inputPath, outputDir })).rejects.toThrow(
      /output directory not found/,
    );
    // The schema tells the model the directory must already exist and is
    // not created automatically; enforce that contract — the rejection must
    // leave nothing behind.
    await expect(fs.access(outputDir)).rejects.toThrow();
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

describe('MEDIA_POLICY_IO_SCHEMA_PROPERTIES', () => {
  it('documents that outputDir must already exist and is not auto-created', () => {
    // Model-facing schema text: the tool rejects (never creates) a
    // nonexistent outputDir (see assertMediaPolicyIo). Pin the wording so a
    // future edit cannot silently tell the model a different contract than
    // the tool honors.
    const description = MEDIA_POLICY_IO_SCHEMA_PROPERTIES.outputDir.description;
    expect(description).toMatch(/existing directory/);
    expect(description).toMatch(/not created automatically/);
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
