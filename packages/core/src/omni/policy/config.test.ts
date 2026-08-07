/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OMNI_PROCESSING_LIMITS,
  OmniPolicyConfigError,
  normalizeOmniProcessingConfig,
} from './config.js';
import type {
  OmniPolicyToolLookup,
  RawOmniProcessingSettings,
} from './config.js';
import type { MediaPolicyToolDescriptor } from '../../tools/tools.js';
import type { OmniModality } from '../recognition.js';

const TUNABLE_SCHEMA = {
  type: 'object',
  properties: {
    maxDimension: { type: 'number', minimum: 1 },
    quality: { type: 'number', minimum: 1, maximum: 100 },
  },
  additionalProperties: false,
};

interface ToolStub {
  mediaPolicyDescriptor?: MediaPolicyToolDescriptor;
  schema?: { parametersJsonSchema?: unknown };
}

function makeTool(
  inputMediaTypes: OmniModality[],
  overrides: Partial<MediaPolicyToolDescriptor> = {},
): ToolStub {
  return {
    mediaPolicyDescriptor: {
      kind: 'media_policy',
      inputMediaTypes,
      outputs: [
        { kind: 'media', required: true, lossy: true },
        { kind: 'text', role: 'disclosure', required: true },
      ],
      settingsSchema: TUNABLE_SCHEMA,
      ...overrides,
    },
    schema: {
      parametersJsonSchema: {
        type: 'object',
        properties: {
          inputPath: { type: 'string' },
          outputDir: { type: 'string' },
          maxDimension: { type: 'number' },
          quality: { type: 'number' },
        },
      },
    },
  };
}

function defaultTools(): Record<string, ToolStub> {
  return {
    omni_downsample_image: makeTool(['image']),
    omni_downscale_video: makeTool(['video']),
    omni_downsample_audio: makeTool(['audio']),
  };
}

function lookup(tools: Record<string, ToolStub>): OmniPolicyToolLookup {
  return { getTool: (name) => tools[name] };
}

function normalize(
  raw: RawOmniProcessingSettings = {},
  tools: Record<string, ToolStub> = defaultTools(),
) {
  return normalizeOmniProcessingConfig(raw, lookup(tools));
}

describe('normalizeOmniProcessingConfig', () => {
  describe('system defaults', () => {
    it('normalizes against the REAL degradation tools, not just stubs', async () => {
      // The stub lookup above can drift from the shipped tool descriptors;
      // this is the startup path every real CLI run takes, so a descriptor
      // that fails §13 validation (e.g. a lossy output without a declared
      // disclosure) must fail HERE, not at first launch.
      const [image, video, audio] = await Promise.all([
        import('./tools/downsample-image.js'),
        import('./tools/downscale-video.js'),
        import('./tools/downsample-audio.js'),
      ]);
      const real: Record<string, ToolStub> = {
        omni_downsample_image: new image.OmniDownsampleImageTool({}),
        omni_downscale_video: new video.OmniDownscaleVideoTool({}),
        omni_downsample_audio: new audio.OmniDownsampleAudioTool({}),
      };
      const config = normalize({}, real);
      expect(config.fixedPolicies).toHaveLength(3);
      expect(config.transportGuardPolicies).toHaveLength(3);
    });

    it('produces the three default fixed policies with when-thresholds', () => {
      const config = normalize();
      expect(config.fixedPolicies.map((p) => p.id).sort()).toEqual([
        'audio-downsample',
        'image-downsample',
        'video-downscale',
      ]);
      const image = config.fixedPolicies.find(
        (p) => p.id === 'image-downsample',
      );
      expect(image).toEqual({
        id: 'image-downsample',
        priority: 0,
        mediaTypes: ['image'],
        origins: ['user', 'tool'],
        when: {
          any: [
            {
              left: { field: 'resource.width' },
              operator: 'gt',
              right: { value: 1568 },
            },
            {
              left: { field: 'resource.height' },
              operator: 'gt',
              right: { value: 1568 },
            },
          ],
        },
        onConditionUnavailable: 'skip',
        toolName: 'omni_downsample_image',
        arguments: {},
        maxRunsPerLineage: 1,
        onFailure: 'continue',
        output: { reprocessMedia: false, source: 'omit' },
        stage: 'preprocessing',
      });
      const video = config.fixedPolicies.find(
        (p) => p.id === 'video-downscale',
      );
      expect(video?.toolName).toBe('omni_downscale_video');
      expect(video?.when).toEqual({
        any: [
          {
            left: { field: 'resource.height' },
            operator: 'gt',
            right: { value: 480 },
          },
          {
            left: { field: 'resource.sizeBytes' },
            operator: 'gt',
            right: { value: 209715200 },
          },
        ],
      });
      const audio = config.fixedPolicies.find(
        (p) => p.id === 'audio-downsample',
      );
      expect(audio?.toolName).toBe('omni_downsample_audio');
      expect(audio?.when).toEqual({
        any: [
          {
            left: { field: 'resource.bitRate' },
            operator: 'gt',
            right: { value: 96000 },
          },
          {
            left: { field: 'resource.sampleRateHz' },
            operator: 'gt',
            right: { value: 24000 },
          },
        ],
      });
    });

    it('produces the three default guard policies without when, stage transport_guard', () => {
      const config = normalize();
      expect(config.transportGuardPolicies.map((p) => p.id).sort()).toEqual([
        'audio-downsample',
        'image-downsample',
        'video-downscale',
      ]);
      for (const policy of config.transportGuardPolicies) {
        expect(policy.when).toBeUndefined();
        expect(policy.stage).toBe('transport_guard');
        expect(policy.output.source).toBe('omit');
      }
    });

    it('defaults limits per policy design §12.2', () => {
      expect(normalize().limits).toEqual({
        maxConcurrentResources: 1,
        reservedOutputTokens: 8192,
        maxLineageDepth: 8,
        maxPolicyRunsPerRoot: 64,
        maxArtifactsPerRoot: 256,
        maxDerivedBytesPerRoot: 1073741824,
        maxTransportPasses: 3,
      });
      expect(normalize().limits).toEqual(DEFAULT_OMNI_PROCESSING_LIMITS);
    });
  });

  describe('id-merge semantics', () => {
    it('removes a default fixed policy on null tombstone', () => {
      const config = normalize({
        fixedPolicies: { 'image-downsample': null },
      });
      expect(config.fixedPolicies.map((p) => p.id).sort()).toEqual([
        'audio-downsample',
        'video-downscale',
      ]);
    });

    it('replaces a default entry wholesale (no field-level merge)', () => {
      const config = normalize({
        fixedPolicies: {
          'image-downsample': {
            mediaTypes: ['image'],
            toolName: 'omni_downsample_image',
            arguments: { maxDimension: 1024 },
          },
        },
      });
      const image = config.fixedPolicies.find(
        (p) => p.id === 'image-downsample',
      );
      // The default's `when` does NOT survive: whole-entry replacement.
      expect(image?.when).toBeUndefined();
      expect(image?.arguments).toEqual({ maxDimension: 1024 });
    });

    it('accepts additional user policies alongside defaults', () => {
      const config = normalize({
        fixedPolicies: {
          'my-policy': {
            priority: 5,
            mediaTypes: ['image'],
            toolName: 'omni_downsample_image',
          },
        },
      });
      expect(config.fixedPolicies).toHaveLength(4);
      const mine = config.fixedPolicies.find((p) => p.id === 'my-policy');
      expect(mine?.priority).toBe(5);
      expect(mine?.stage).toBe('preprocessing');
    });

    it('rejects transport-guard tombstones (the guard is mandatory)', () => {
      expect(() =>
        normalize({ transportGuardPolicies: { 'image-downsample': null } }),
      ).toThrow(
        'omni.processing.transportGuard.policies.image-downsample: ' +
          'transport guard policies cannot be removed (the guard is ' +
          'mandatory); override the entry instead',
      );
    });

    it('rejects non-object policy maps', () => {
      expect(() => normalize({ fixedPolicies: ['nope'] })).toThrow(
        'omni.processing.fixedPolicies: must be an object map of policy id → policy',
      );
      expect(() =>
        normalize({ fixedPolicies: { bad: 'string' as never } }),
      ).toThrow(
        'omni.processing.fixedPolicies.bad: must be an object (or null to remove a default)',
      );
    });
  });

  describe('policy entry validation', () => {
    it('rejects unknown keys (§13 #1)', () => {
      expect(() =>
        normalize({
          fixedPolicies: {
            p: {
              mediaTypes: ['image'],
              toolName: 'omni_downsample_image',
              retries: 3,
            },
          },
        }),
      ).toThrow('omni.processing.fixedPolicies.p: unknown key "retries"');
    });

    it('rejects malformed policy ids', () => {
      expect(() =>
        normalize({
          fixedPolicies: {
            'has space': {
              mediaTypes: ['image'],
              toolName: 'omni_downsample_image',
            },
          },
        }),
      ).toThrow(OmniPolicyConfigError);
    });

    it('rejects empty or unknown mediaTypes (§13 #3)', () => {
      expect(() =>
        normalize({
          fixedPolicies: {
            p: { mediaTypes: [], toolName: 'omni_downsample_image' },
          },
        }),
      ).toThrow(
        'omni.processing.fixedPolicies.p.mediaTypes: must be a non-empty array',
      );
      expect(() =>
        normalize({
          fixedPolicies: {
            p: { mediaTypes: ['text'], toolName: 'omni_downsample_image' },
          },
        }),
      ).toThrow(
        'omni.processing.fixedPolicies.p.mediaTypes: unknown modality "text" ' +
          '(expected image, video, audio)',
      );
    });

    it('rejects unknown origins (§13 #4)', () => {
      expect(() =>
        normalize({
          fixedPolicies: {
            p: {
              mediaTypes: ['image'],
              origins: ['model'],
              toolName: 'omni_downsample_image',
            },
          },
        }),
      ).toThrow(
        'omni.processing.fixedPolicies.p.origins: unknown origin "model" ' +
          '(expected user, tool, policy)',
      );
    });

    it('rejects onConditionUnavailable "abortTurn" with an explicit not-yet-supported error', () => {
      expect(() =>
        normalize({
          fixedPolicies: {
            p: {
              mediaTypes: ['image'],
              toolName: 'omni_downsample_image',
              onConditionUnavailable: 'abortTurn',
            },
          },
        }),
      ).toThrow(/"abortTurn" is not yet supported/);
    });

    it('rejects invalid onFailure', () => {
      expect(() =>
        normalize({
          fixedPolicies: {
            p: {
              mediaTypes: ['image'],
              toolName: 'omni_downsample_image',
              onFailure: 'retry',
            },
          },
        }),
      ).toThrow(
        'omni.processing.fixedPolicies.p.onFailure: must be "continue" or "abort" (got "retry")',
      );
    });

    it('rejects non-positive maxRunsPerLineage', () => {
      expect(() =>
        normalize({
          fixedPolicies: {
            p: {
              mediaTypes: ['image'],
              toolName: 'omni_downsample_image',
              maxRunsPerLineage: 0,
            },
          },
        }),
      ).toThrow(
        'omni.processing.fixedPolicies.p.maxRunsPerLineage: must be a positive integer (got 0)',
      );
    });

    it('rejects unknown output keys and illegal output.source (§13 #23)', () => {
      expect(() =>
        normalize({
          fixedPolicies: {
            p: {
              mediaTypes: ['image'],
              toolName: 'omni_downsample_image',
              output: { keepBoth: true },
            },
          },
        }),
      ).toThrow(
        'omni.processing.fixedPolicies.p.output: unknown key "keepBoth"',
      );
      expect(() =>
        normalize({
          fixedPolicies: {
            p: {
              mediaTypes: ['image'],
              toolName: 'omni_downsample_image',
              output: { source: 'drop' },
            },
          },
        }),
      ).toThrow(
        'omni.processing.fixedPolicies.p.output.source: must be "keep" or "omit" (got "drop")',
      );
    });

    it('allows output.source "keep" for preprocessing policies', () => {
      const config = normalize({
        fixedPolicies: {
          p: {
            mediaTypes: ['image'],
            toolName: 'omni_downsample_image',
            output: { source: 'keep', reprocessMedia: true },
          },
        },
      });
      const p = config.fixedPolicies.find((x) => x.id === 'p');
      expect(p?.output).toEqual({ reprocessMedia: true, source: 'keep' });
    });

    it('rejects invalid when-conditions via the shared validator (§13 #5)', () => {
      expect(() =>
        normalize({
          fixedPolicies: {
            p: {
              mediaTypes: ['image'],
              toolName: 'omni_downsample_image',
              when: {
                left: { field: 'resource.nonexistent' },
                operator: 'gt',
                right: { value: 1 },
              },
            },
          },
        }),
      ).toThrow(/omni\.processing\.fixedPolicies\.p\.when/);
    });
  });

  describe('tool reference validation (§13 #6/#8/#14)', () => {
    it('rejects a missing toolName', () => {
      expect(() =>
        normalize({ fixedPolicies: { p: { mediaTypes: ['image'] } } }),
      ).toThrow(
        'omni.processing.fixedPolicies.p.toolName: must be a non-empty string',
      );
    });

    it('rejects an unregistered tool (covers excluded tools too)', () => {
      expect(() =>
        normalize({
          fixedPolicies: {
            p: { mediaTypes: ['image'], toolName: 'no_such_tool' },
          },
        }),
      ).toThrow(
        'omni.processing.fixedPolicies.p.toolName: tool "no_such_tool" is ' +
          'not registered (unknown name, or excluded by tool filtering)',
      );
    });

    it('rejects a registered tool without a media_policy descriptor', () => {
      const tools = defaultTools();
      tools['read_file'] = { schema: { parametersJsonSchema: {} } };
      expect(() =>
        normalize(
          {
            fixedPolicies: {
              p: { mediaTypes: ['image'], toolName: 'read_file' },
            },
          },
          tools,
        ),
      ).toThrow(
        'omni.processing.fixedPolicies.p.toolName: tool "read_file" is not ' +
          'a media policy tool (no media_policy descriptor)',
      );
    });

    it('rejects a tool declaring no required output', () => {
      const tools = defaultTools();
      tools['weak_tool'] = makeTool(['image'], {
        outputs: [{ kind: 'media', required: false, lossy: false }],
      });
      expect(() =>
        normalize(
          {
            fixedPolicies: {
              p: { mediaTypes: ['image'], toolName: 'weak_tool' },
            },
          },
          tools,
        ),
      ).toThrow(/declares no required output/);
    });

    it('rejects a lossy tool without a disclosure output (§13 #8)', () => {
      const tools = defaultTools();
      tools['sneaky_tool'] = makeTool(['image'], {
        outputs: [{ kind: 'media', required: true, lossy: true }],
      });
      expect(() =>
        normalize(
          {
            fixedPolicies: {
              p: { mediaTypes: ['image'], toolName: 'sneaky_tool' },
            },
          },
          tools,
        ),
      ).toThrow(
        'omni.processing.fixedPolicies.p.toolName: tool "sneaky_tool" ' +
          'declares a lossy media output but no disclosure text output',
      );
    });

    it('rejects mediaTypes the tool does not accept', () => {
      expect(() =>
        normalize({
          fixedPolicies: {
            p: {
              mediaTypes: ['image', 'video'],
              toolName: 'omni_downsample_image',
            },
          },
        }),
      ).toThrow(
        'omni.processing.fixedPolicies.p.mediaTypes: tool ' +
          '"omni_downsample_image" does not accept "video" input (accepts image)',
      );
    });
  });

  describe('fixed arguments validation (§13 #11)', () => {
    it('rejects reserved io keys in arguments', () => {
      expect(() =>
        normalize({
          fixedPolicies: {
            p: {
              mediaTypes: ['image'],
              toolName: 'omni_downsample_image',
              arguments: { inputPath: '/tmp/x.png' },
            },
          },
        }),
      ).toThrow(
        'omni.processing.fixedPolicies.p.arguments: "inputPath" is injected ' +
          'by the orchestrator per invocation and must not be configured',
      );
    });

    it('validates arguments against the settingsSchema (io-stripped)', () => {
      expect(() =>
        normalize({
          fixedPolicies: {
            p: {
              mediaTypes: ['image'],
              toolName: 'omni_downsample_image',
              arguments: { bogus: true },
            },
          },
        }),
      ).toThrow(/omni\.processing\.fixedPolicies\.p\.arguments/);
      // Valid tunables pass through untouched.
      const config = normalize({
        fixedPolicies: {
          p: {
            mediaTypes: ['image'],
            toolName: 'omni_downsample_image',
            arguments: { maxDimension: 800, quality: 70 },
          },
        },
      });
      expect(config.fixedPolicies.find((x) => x.id === 'p')?.arguments).toEqual(
        { maxDimension: 800, quality: 70 },
      );
    });
  });

  describe('transport guard rules (§13 #15-#17)', () => {
    it('rejects guard policies declaring when', () => {
      expect(() =>
        normalize({
          transportGuardPolicies: {
            'image-downsample': {
              mediaTypes: ['image'],
              toolName: 'omni_downsample_image',
              when: {
                left: { field: 'resource.width' },
                operator: 'gt',
                right: { value: 1 },
              },
            },
          },
        }),
      ).toThrow(
        'omni.processing.transportGuard.policies.image-downsample.when: ' +
          'transport guard policies must not declare "when" (they run ' +
          'exactly when transport limits are exceeded)',
      );
    });

    it('rejects guard policies with output.source "keep"', () => {
      expect(() =>
        normalize({
          transportGuardPolicies: {
            'image-downsample': {
              mediaTypes: ['image'],
              toolName: 'omni_downsample_image',
              output: { source: 'keep' },
            },
          },
        }),
      ).toThrow(
        'omni.processing.transportGuard.policies.image-downsample.output.source: ' +
          'transport guard policies must use "omit" (the over-limit source ' +
          'cannot stay in the delivery set)',
      );
    });

    it('rejects a merged guard set that does not cover all three modalities', () => {
      const tools = defaultTools();
      // Point every guard entry at image only → video+audio uncovered.
      expect(() =>
        normalize(
          {
            transportGuardPolicies: {
              'video-downscale': {
                mediaTypes: ['image'],
                toolName: 'omni_downsample_image',
              },
              'audio-downsample': {
                mediaTypes: ['image'],
                toolName: 'omni_downsample_image',
              },
            },
          },
          tools,
        ),
      ).toThrow(
        'omni.processing.transportGuard.policies: no guard policy covers ' +
          'video, audio — the merged set must cover image, video, and audio',
      );
    });
  });

  describe('limits (§12.2)', () => {
    it('merges overrides over defaults', () => {
      const config = normalize({ limits: { maxLineageDepth: 3 } });
      expect(config.limits).toEqual({
        ...DEFAULT_OMNI_PROCESSING_LIMITS,
        maxLineageDepth: 3,
      });
    });

    it('rejects unknown limit keys', () => {
      expect(() => normalize({ limits: { maxFoo: 1 } })).toThrow(
        'omni.processing.limits: unknown key "maxFoo"',
      );
    });

    it('rejects non-positive-integer values', () => {
      expect(() => normalize({ limits: { maxLineageDepth: 0 } })).toThrow(
        'omni.processing.limits.maxLineageDepth: must be a positive integer (got 0)',
      );
      expect(() => normalize({ limits: { maxLineageDepth: 2.5 } })).toThrow(
        'omni.processing.limits.maxLineageDepth: must be a positive integer (got 2.5)',
      );
    });

    it('allows reservedOutputTokens of zero', () => {
      const config = normalize({ limits: { reservedOutputTokens: 0 } });
      expect(config.limits.reservedOutputTokens).toBe(0);
    });
  });

  describe('channel caps (§13 #18/#19)', () => {
    it('rejects maxUploadFileBytes above the 1 GiB channel cap', () => {
      expect(() => normalize({ maxUploadFileBytes: 1073741824 + 1 })).toThrow(
        'omni.processing.transportGuard.maxUploadFileBytes: 1073741825 ' +
          'exceeds the DashScope per-file upload cap (1073741824)',
      );
      expect(() => normalize({ maxUploadFileBytes: 1073741824 })).not.toThrow();
    });

    it('rejects urlTtlHours outside 0..48', () => {
      expect(() => normalize({ urlTtlHours: 49 })).toThrow(
        'omni.delivery.upload.urlTtlHours: must be a number between 0 and 48 (got 49)',
      );
      expect(() => normalize({ urlTtlHours: -1 })).toThrow(
        OmniPolicyConfigError,
      );
      expect(() => normalize({ urlTtlHours: 48 })).not.toThrow();
      expect(() => normalize({ urlTtlHours: 0 })).not.toThrow();
    });
  });

  describe('policyTools validation (§13 #7/#20/#21)', () => {
    it('accepts null tombstones and valid entries', () => {
      expect(() =>
        normalize({
          policyTools: {
            omni_downsample_image: null,
            omni_downscale_video: {
              settings: { maxDimension: 640 },
              runtime: { timeoutMs: 30000 },
            },
          },
        }),
      ).not.toThrow();
    });

    it('rejects entries naming a non-media-policy tool', () => {
      expect(() =>
        normalize({ policyTools: { no_such_tool: { settings: {} } } }),
      ).toThrow(
        'omni.processing.policyTools.no_such_tool: "no_such_tool" is not a ' +
          'registered media policy tool',
      );
    });

    it('validates settings against the settingsSchema (§13 #7)', () => {
      expect(() =>
        normalize({
          policyTools: {
            omni_downsample_image: { settings: { bogus: 1 } },
          },
        }),
      ).toThrow(
        /omni\.processing\.policyTools\.omni_downsample_image\.settings/,
      );
    });

    it('rejects non-positive runtime.timeoutMs', () => {
      expect(() =>
        normalize({
          policyTools: {
            omni_downsample_image: { runtime: { timeoutMs: -5 } },
          },
        }),
      ).toThrow(
        'omni.processing.policyTools.omni_downsample_image.runtime.timeoutMs: ' +
          'must be a positive integer (got -5)',
      );
    });

    it('rejects overlapping defaultArguments and lockedArguments (§13 #21)', () => {
      expect(() =>
        normalize({
          policyTools: {
            omni_downsample_image: {
              modelAccess: {
                defaultArguments: { quality: 80 },
                lockedArguments: { quality: 60 },
              },
            },
          },
        }),
      ).toThrow(
        'omni.processing.policyTools.omni_downsample_image.modelAccess: ' +
          '"quality" present in both defaultArguments and lockedArguments',
      );
    });

    it('rejects parameterSchema properties absent from the native schema (§13 #20)', () => {
      expect(() =>
        normalize({
          policyTools: {
            omni_downsample_image: {
              modelAccess: {
                parameterSchema: {
                  properties: { quality: {}, sharpen: {} },
                },
              },
            },
          },
        }),
      ).toThrow(
        'omni.processing.policyTools.omni_downsample_image.modelAccess.parameterSchema: ' +
          '"sharpen" not present in the tool\'s native schema (projection may only narrow)',
      );
    });

    it('accepts a narrowing-only parameterSchema', () => {
      expect(() =>
        normalize({
          policyTools: {
            omni_downsample_image: {
              modelAccess: {
                parameterSchema: { properties: { quality: {} } },
              },
            },
          },
        }),
      ).not.toThrow();
    });
  });
});
