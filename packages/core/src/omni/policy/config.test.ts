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
import { STAGING_GRACE_MS } from '../recovery.js';

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
  /** Native schema, mirroring DeclarativeTool's public field — the lookup
   * contract deliberately avoids the projected `schema` getter. */
  parameterSchema?: unknown;
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
    parameterSchema: {
      type: 'object',
      properties: {
        inputPath: { type: 'string' },
        outputDir: { type: 'string' },
        maxDimension: { type: 'number' },
        quality: { type: 'number' },
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
      expect(config.fixedPolicies).toHaveLength(0);
      expect(config.transportGuardPolicies).toHaveLength(3);
    });

    it('registers no default fixed policies: zero config → zero preprocessing (D7)', () => {
      // The upstream design gives fixedPolicies pure user-experiment
      // semantics: with no configuration, NOTHING may trigger below
      // transport limits. Only the transport guard is always-on.
      const config = normalize();
      expect(config.fixedPolicies).toEqual([]);
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
    it('rejects a "__proto__" policy id instead of silently dropping it', () => {
      // JSON.parse produces "__proto__" as an ordinary own key; a plain
      // object-spread merge would route it through the prototype setter and
      // the entry would vanish without a diagnostic. The null-prototype
      // merge map keeps it as a real key so the id pattern rejects it.
      expect(() =>
        normalize({
          fixedPolicies: JSON.parse(
            '{"__proto__": {"mediaTypes": ["image"], "toolName": "omni_downsample_image"}}',
          ),
        }),
      ).toThrow(/__proto__: policy id must match/);
    });

    it('accepts a null tombstone with no matching entry (no fixed defaults exist)', () => {
      const config = normalize({
        fixedPolicies: { 'image-downsample': null },
      });
      expect(config.fixedPolicies).toEqual([]);
    });

    it('normalizes a user fixed policy with full defaults applied', () => {
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
      expect(image).toEqual({
        id: 'image-downsample',
        priority: 0,
        mediaTypes: ['image'],
        origins: ['user', 'tool'],
        when: undefined,
        onConditionUnavailable: 'skip',
        toolName: 'omni_downsample_image',
        arguments: { maxDimension: 1024 },
        maxRunsPerLineage: 1,
        onFailure: 'continue',
        output: {
          reprocessMedia: false,
          source: 'omit',
          artifacts: { '*': 'include' },
        },
        stage: 'preprocessing',
      });
    });

    it('accepts and trims an optional model-facing description', () => {
      const config = normalize({
        fixedPolicies: {
          'image-downsample': {
            mediaTypes: ['image'],
            toolName: 'omni_downsample_image',
            description: '  Downsamples large images.  ',
          },
        },
      });
      const image = config.fixedPolicies.find(
        (p) => p.id === 'image-downsample',
      );
      expect(image?.description).toBe('Downsamples large images.');
    });

    it('omits description entirely when unset or blank (no empty-string key)', () => {
      const config = normalize({
        fixedPolicies: {
          a: {
            mediaTypes: ['image'],
            toolName: 'omni_downsample_image',
          },
          b: {
            mediaTypes: ['image'],
            toolName: 'omni_downsample_image',
            description: '   ',
          },
        },
      });
      for (const id of ['a', 'b']) {
        const p = config.fixedPolicies.find((x) => x.id === id)!;
        expect('description' in p).toBe(false);
      }
    });

    it('rejects a non-string description', () => {
      expect(() =>
        normalize({
          fixedPolicies: {
            'image-downsample': {
              mediaTypes: ['image'],
              toolName: 'omni_downsample_image',
              description: 123,
            },
          },
        }),
      ).toThrow(
        'omni.processing.fixedPolicies.image-downsample.description: must be a string',
      );
    });

    it('rejects an over-long description', () => {
      expect(() =>
        normalize({
          fixedPolicies: {
            'image-downsample': {
              mediaTypes: ['image'],
              toolName: 'omni_downsample_image',
              description: 'x'.repeat(601),
            },
          },
        }),
      ).toThrow(/description: must be ≤ 600 characters \(got 601\)/);
    });

    it('replaces a default guard entry wholesale (no field-level merge)', () => {
      // Whole-entry replacement: the override does NOT inherit the
      // default's toolName, so omitting it must be a validation error —
      // a field-level merge would inherit it and pass.
      expect(() =>
        normalize({
          transportGuardPolicies: {
            'image-downsample': { mediaTypes: ['image'] },
          },
        }),
      ).toThrow(
        'omni.processing.transportGuard.policies.image-downsample.toolName: ' +
          'must be a non-empty string',
      );
      const config = normalize({
        transportGuardPolicies: {
          'image-downsample': {
            mediaTypes: ['image'],
            toolName: 'omni_downsample_image',
            arguments: { maxDimension: 1024 },
          },
        },
      });
      const image = config.transportGuardPolicies.find(
        (p) => p.id === 'image-downsample',
      );
      expect(image?.arguments).toEqual({ maxDimension: 1024 });
    });

    it('accepts user fixed policies (the only preprocessing source)', () => {
      const config = normalize({
        fixedPolicies: {
          'my-policy': {
            priority: 5,
            mediaTypes: ['image'],
            toolName: 'omni_downsample_image',
          },
        },
      });
      expect(config.fixedPolicies).toHaveLength(1);
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
            origins: ['user', 'tool', 'policy'],
            output: { source: 'keep', reprocessMedia: true },
          },
        },
      });
      const p = config.fixedPolicies.find((x) => x.id === 'p');
      expect(p?.output).toEqual({
        reprocessMedia: true,
        source: 'keep',
        artifacts: { '*': 'include' },
      });
    });

    it('rejects reprocessMedia when no policy in the set accepts origin "policy"', () => {
      // Derivatives re-enter matching with origin 'policy'; with no policy
      // accepting that origin, reprocessMedia can never take effect.
      expect(() =>
        normalize({
          fixedPolicies: {
            p: {
              mediaTypes: ['image'],
              toolName: 'omni_downsample_image',
              output: { source: 'keep', reprocessMedia: true },
            },
          },
        }),
      ).toThrow(
        'omni.processing.fixedPolicies: "p" sets output.reprocessMedia, ' +
          'but no policy in this set accepts origin "policy"',
      );
    });

    it('accepts reprocessMedia when ANOTHER policy in the set accepts origin "policy"', () => {
      expect(() =>
        normalize({
          fixedPolicies: {
            p: {
              mediaTypes: ['image'],
              toolName: 'omni_downsample_image',
              output: { source: 'keep', reprocessMedia: true },
            },
            q: {
              mediaTypes: ['image'],
              toolName: 'omni_downsample_image',
              origins: ['policy'],
            },
          },
        }),
      ).not.toThrow();
    });

    it('applies the inert-reprocessMedia check to the transport-guard set independently', () => {
      expect(() =>
        normalize({
          transportGuardPolicies: {
            g: {
              mediaTypes: ['image'],
              toolName: 'omni_downsample_image',
              output: { reprocessMedia: true },
            },
          },
        }),
      ).toThrow(
        'omni.processing.transportGuard.policies: "g" sets ' +
          'output.reprocessMedia, but no policy in this set accepts ' +
          'origin "policy"',
      );
    });

    it('rejects invalid when-conditions via the shared validator (§13 #5)', () => {
      expect(() =>
        normalize({
          fixedPolicies: {
            p: {
              mediaTypes: ['image'],
              toolName: 'omni_downsample_image',
              when: ['>', ['field', 'resource.nonexistent'], 1],
            },
          },
        }),
      ).toThrow(/omni\.processing\.fixedPolicies\.p\.when/);
    });

    it('preserves a valid when-condition verbatim through normalization (D7)', () => {
      // `when` is preprocessing's ONLY trigger mechanism: a normalization
      // regression that drops or rewrites it would silently widen every
      // user condition to ALL matching resources. Pin the round-trip.
      const when = [
        'all',
        ['>', ['field', 'resource.sizeBytes'], 10_000_000],
        ['>=', ['field', 'session.availableContextTokens'], 4096],
      ];
      const config = normalize({
        fixedPolicies: {
          p: {
            mediaTypes: ['image'],
            toolName: 'omni_downsample_image',
            when,
          },
        },
      });
      const p = config.fixedPolicies.find((x) => x.id === 'p');
      expect(p?.when).toEqual(when);
    });
  });

  describe('output.artifacts selectors (§13 #22/#24)', () => {
    /** Media tool whose descriptor declares producible mime types, so
     * `kind:` selectors have something to match. */
    const mediaToolWithMimes = () =>
      makeTool(['image'], {
        outputs: [
          {
            kind: 'media',
            role: 'preview',
            mimeTypes: ['image/jpeg'],
            required: true,
            lossy: true,
          },
          { kind: 'text', role: 'disclosure', required: true },
        ],
      });

    /** Transcript-protocol tool (§6.2): bounded UTF-8 text/plain file. */
    const transcribeLikeTool = () =>
      makeTool(['audio'], {
        outputs: [
          {
            kind: 'file',
            role: 'transcript',
            mimeTypes: ['text/plain'],
            required: true,
            lossy: true,
          },
          { kind: 'text', role: 'disclosure', required: true },
        ],
      });

    const withTool = (tool: ToolStub) => ({
      ...defaultTools(),
      tool_under_test: tool,
    });

    const policyWith = (
      artifacts: Record<string, unknown>,
      tool: ToolStub,
      mediaTypes: OmniModality[] = ['image'],
    ) =>
      normalize(
        {
          fixedPolicies: {
            p: {
              mediaTypes,
              toolName: 'tool_under_test',
              output: { artifacts },
            },
          },
        },
        withTool(tool),
      );

    it('defaults an unconfigured artifacts map to include-all', () => {
      const config = normalize({
        fixedPolicies: {
          p: { mediaTypes: ['image'], toolName: 'omni_downsample_image' },
        },
      });
      expect(config.fixedPolicies[0].output.artifacts).toEqual({
        '*': 'include',
      });
    });

    it('preserves an explicit selector map verbatim', () => {
      const config = policyWith(
        { 'role:preview': 'include', 'kind:image': 'retain', '*': 'retain' },
        mediaToolWithMimes(),
      );
      expect(config.fixedPolicies[0].output.artifacts).toEqual({
        'role:preview': 'include',
        'kind:image': 'retain',
        '*': 'retain',
      });
    });

    it('rejects actions other than include/retain', () => {
      expect(() => policyWith({ '*': 'drop' }, mediaToolWithMimes())).toThrow(
        'omni.processing.fixedPolicies.p.output.artifacts["*"]: must be "include" or "retain" (got "drop")',
      );
    });

    it('rejects unknown selector shapes', () => {
      expect(() =>
        policyWith({ preview: 'include' }, mediaToolWithMimes()),
      ).toThrow(
        'omni.processing.fixedPolicies.p.output.artifacts["preview"]: unknown selector (expected "*", "kind:<kind>", or "role:<role>")',
      );
    });

    it('rejects unknown kind targets', () => {
      expect(() =>
        policyWith({ 'kind:text': 'include' }, mediaToolWithMimes()),
      ).toThrow(/unknown artifact kind "text"/);
    });

    it('rejects malformed role tokens', () => {
      expect(() =>
        policyWith({ 'role:no spaces!': 'include' }, mediaToolWithMimes()),
      ).toThrow(/invalid role token "no spaces!"/);
    });

    it('rejects a kind selector the descriptor cannot produce (§13 #22)', () => {
      expect(() =>
        policyWith({ 'kind:video': 'retain' }, mediaToolWithMimes()),
      ).toThrow(
        'omni.processing.fixedPolicies.p.output.artifacts["kind:video"]: tool "tool_under_test" declares no output of kind "video"',
      );
    });

    it('rejects a role selector no artifact output declares (§13 #22)', () => {
      expect(() =>
        policyWith({ 'role:thumbnail': 'include' }, mediaToolWithMimes()),
      ).toThrow(
        'omni.processing.fixedPolicies.p.output.artifacts["role:thumbnail"]: tool "tool_under_test" declares no artifact output with role "thumbnail"',
      );
    });

    it('accepts role:transcript and kind:file against a transcript-protocol descriptor (§13 #24)', () => {
      const config = policyWith(
        { 'role:transcript': 'include', 'kind:file': 'include' },
        transcribeLikeTool(),
        ['audio'],
      );
      expect(config.fixedPolicies[0].output.artifacts).toEqual({
        'role:transcript': 'include',
        'kind:file': 'include',
      });
    });

    it('rejects role:transcript when the declared output is not bounded text/plain file (§13 #24)', () => {
      const wrongMime = makeTool(['audio'], {
        outputs: [
          {
            kind: 'file',
            role: 'transcript',
            mimeTypes: ['text/markdown'],
            required: true,
            lossy: true,
          },
          { kind: 'text', role: 'disclosure', required: true },
        ],
      });
      expect(() =>
        policyWith({ 'role:transcript': 'include' }, wrongMime, ['audio']),
      ).toThrow(
        'omni.processing.fixedPolicies.p.output.artifacts["role:transcript"]: a transcript selector must point at a bounded UTF-8 text/plain file output, but tool "tool_under_test" declares role "transcript" differently',
      );

      const mediaTranscript = makeTool(['audio'], {
        outputs: [
          {
            kind: 'media',
            role: 'transcript',
            mimeTypes: ['audio/wav'],
            required: true,
            lossy: true,
          },
          { kind: 'text', role: 'disclosure', required: true },
        ],
      });
      expect(() =>
        policyWith({ 'role:transcript': 'include' }, mediaTranscript, [
          'audio',
        ]),
      ).toThrow(/a transcript selector must point at a bounded UTF-8/);
    });

    it('accepts the REAL transcribe tool as a fixed-policy target with role:transcript', async () => {
      const { OmniTranscribeAudioTool } = await import(
        './tools/transcribe-audio.js'
      );
      const tools: Record<string, ToolStub> = {
        ...defaultTools(),
        omni_transcribe_audio: new OmniTranscribeAudioTool({}),
      };
      const config = normalize(
        {
          fixedPolicies: {
            'audio-transcribe': {
              mediaTypes: ['audio'],
              toolName: 'omni_transcribe_audio',
              output: {
                source: 'omit',
                artifacts: { 'role:transcript': 'include' },
              },
            },
          },
        },
        tools,
      );
      expect(config.fixedPolicies[0].output).toEqual({
        reprocessMedia: false,
        source: 'omit',
        artifacts: { 'role:transcript': 'include' },
      });
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
      tools['read_file'] = { parameterSchema: {} };
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
              when: ['>', ['field', 'resource.width'], 1],
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

    it('rejects a non-numeric or negative maxEstimatedTokens (fail-open guard)', () => {
      // guard.ts compares with `<=`/`>`: a string would make both false and
      // silently disable the token guard — must abort startup instead.
      expect(() =>
        normalize({ maxEstimatedTokens: 'abc' as unknown as number }),
      ).toThrow(
        'omni.processing.transportGuard.maxEstimatedTokens: must be a ' +
          'finite number >= 0, where 0 disables the token guard (got "abc")',
      );
      expect(() =>
        normalize({ maxEstimatedTokens: true as unknown as number }),
      ).toThrow(OmniPolicyConfigError);
      expect(() => normalize({ maxEstimatedTokens: -1 })).toThrow(
        OmniPolicyConfigError,
      );
      expect(() =>
        normalize({ maxEstimatedTokens: Number.POSITIVE_INFINITY }),
      ).toThrow(OmniPolicyConfigError);
      expect(() => normalize({ maxEstimatedTokens: 0 })).not.toThrow();
      expect(() => normalize({ maxEstimatedTokens: 262144 })).not.toThrow();
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

    it('rejects unknown keys at every level of an entry (§13 #1)', () => {
      // Typos like "settigns" would otherwise read as absent downstream
      // and the intended configuration would silently never take effect.
      expect(() =>
        normalize({
          policyTools: { omni_downsample_image: { settigns: {} } as never },
        }),
      ).toThrow(
        'omni.processing.policyTools.omni_downsample_image: unknown key "settigns"',
      );
      expect(() =>
        normalize({
          policyTools: {
            omni_downsample_image: { runtime: { timeout: 30000 } },
          },
        }),
      ).toThrow(
        'omni.processing.policyTools.omni_downsample_image.runtime: ' +
          'unknown key "timeout"',
      );
      expect(() =>
        normalize({
          policyTools: {
            omni_downsample_image: { modelAccess: { lockedArgs: {} } as never },
          },
        }),
      ).toThrow(
        'omni.processing.policyTools.omni_downsample_image.modelAccess: ' +
          'unknown key "lockedArgs"',
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

    it('caps runtime.timeoutMs below the staging sweep grace window (cross-file invariant with recovery §5)', () => {
      // A tool allowed to run for >= STAGING_GRACE_MS could have its live
      // staging directory classified as crash leftovers and deleted
      // mid-run by another process's startup sweep. Pin BOTH sides of the
      // boundary so removing, inverting (`<=`), or relocating the cap
      // fails a test instead of shipping green.
      expect(() =>
        normalize({
          policyTools: {
            omni_downsample_image: {
              runtime: { timeoutMs: STAGING_GRACE_MS },
            },
          },
        }),
      ).toThrow(
        'omni.processing.policyTools.omni_downsample_image.runtime.timeoutMs: ' +
          `must be below the staging sweep grace window (${STAGING_GRACE_MS}ms) ` +
          `so a live invocation's staging directory is never reclaimed mid-run`,
      );
      expect(() =>
        normalize({
          policyTools: {
            omni_downsample_image: {
              runtime: { timeoutMs: STAGING_GRACE_MS - 1 },
            },
          },
        }),
      ).not.toThrow();
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

    it('rejects a defaultArguments key the native schema does not declare', () => {
      expect(() =>
        normalize({
          policyTools: {
            omni_downsample_image: {
              modelAccess: {
                defaultArguments: { sharpen: 2 },
              },
            },
          },
        }),
      ).toThrow(
        /omni\.processing\.policyTools\.omni_downsample_image\.modelAccess\.defaultArguments/,
      );
    });

    it('rejects a lockedArguments value the native sub-schema refuses', () => {
      expect(() =>
        normalize({
          policyTools: {
            omni_downsample_image: {
              modelAccess: {
                lockedArguments: { quality: 'very high' },
              },
            },
          },
        }),
      ).toThrow(
        /omni\.processing\.policyTools\.omni_downsample_image\.modelAccess\.lockedArguments/,
      );
    });

    it('accepts schema-valid partial defaultArguments and lockedArguments', () => {
      expect(() =>
        normalize({
          policyTools: {
            omni_downsample_image: {
              modelAccess: {
                defaultArguments: { quality: 80 },
                lockedArguments: { maxDimension: 1024 },
              },
            },
          },
        }),
      ).not.toThrow();
    });

    it('validates locked/operator-only arguments against a REAL tool (whose `schema` getter hides them)', async () => {
      // Regression: validation must read the tool's NATIVE parameterSchema.
      // A real BaseMediaPolicyTool's `schema` getter is the model-visible
      // projection, which strips lockedArguments and operatorOnlyParams
      // keys — validated against THAT, every legitimate locked/operator
      // config would abort startup with "must NOT have additional
      // properties". The stub lookup can't catch this (its shape is
      // static), so this test wires real tool instances whose config view
      // serves the very settings under validation.
      const raw: RawOmniProcessingSettings = {
        policyTools: {
          omni_downsample_image: {
            modelAccess: {
              enabled: true,
              lockedArguments: { quality: 80 },
            },
          },
          omni_transcribe_audio: {
            modelAccess: {
              enabled: true,
              defaultArguments: { baseUrl: 'https://asr.example/v1' },
            },
          },
        },
      };
      const view = {
        getOmniPolicyToolsSettings: () => raw.policyTools,
      };
      const [image, transcribe] = await Promise.all([
        import('./tools/downsample-image.js'),
        import('./tools/transcribe-audio.js'),
      ]);
      const real: Record<string, ToolStub> = {
        ...defaultTools(),
        omni_downsample_image: new image.OmniDownsampleImageTool(view),
        omni_transcribe_audio: new transcribe.OmniTranscribeAudioTool(view),
      };
      expect(() => normalize(raw, real)).not.toThrow();
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

    describe('constraint-value narrowing (§11.2: 不能扩大类型、枚举、范围)', () => {
      /** Tool whose native schema carries real constraints to loosen. */
      const constrainedTools = (): Record<string, ToolStub> => {
        const tools = defaultTools();
        tools['omni_downsample_image'] = {
          ...makeTool(['image']),
          parameterSchema: {
            type: 'object',
            properties: {
              inputPath: { type: 'string' },
              outputDir: { type: 'string' },
              quality: { type: 'number', minimum: 1, maximum: 100 },
              format: { type: 'string', enum: ['jpeg', 'webp'] },
              tags: { type: 'array', minItems: 1, maxItems: 4 },
            },
          },
        };
        return tools;
      };
      const withProjection = (
        prop: string,
        override: Record<string, unknown>,
      ) =>
        normalize(
          {
            policyTools: {
              omni_downsample_image: {
                modelAccess: {
                  parameterSchema: { properties: { [prop]: override } },
                },
              },
            },
          },
          constrainedTools(),
        );
      const at =
        'omni.processing.policyTools.omni_downsample_image.modelAccess.' +
        'parameterSchema.properties.';

      it('rejects an override raising the native maximum (probe case)', () => {
        expect(() => withProjection('quality', { maximum: 200 })).toThrow(
          `${at}quality: the upper bound loosens the native one ` +
            '(200 vs native 100) (projection may only narrow)',
        );
      });

      it('rejects an override lowering the native minimum', () => {
        expect(() => withProjection('quality', { minimum: 0 })).toThrow(
          `${at}quality: the lower bound loosens the native one ` +
            '(0 vs native 1) (projection may only narrow)',
        );
      });

      it('rejects an enum override adding values outside the native enum', () => {
        expect(() =>
          withProjection('format', { enum: ['jpeg', 'png'] }),
        ).toThrow(
          `${at}format: "enum" adds values the native enum does not allow ` +
            '("png") (projection may only narrow)',
        );
      });

      it('rejects an override changing the native type', () => {
        expect(() => withProjection('quality', { type: 'string' })).toThrow(
          `${at}quality: "type" changes the native type ` +
            '("string" vs native "number") (projection may only narrow)',
        );
      });

      it('rejects maxItems above the native cap', () => {
        expect(() => withProjection('tags', { maxItems: 10 })).toThrow(
          `${at}tags: "maxItems" loosens the native constraint ` +
            '(10 vs native 4) (projection may only narrow)',
        );
      });

      it('accepts genuinely narrowing overrides', () => {
        expect(() =>
          withProjection('quality', {
            type: 'integer', // integer narrows number
            minimum: 10,
            maximum: 80,
          }),
        ).not.toThrow();
        expect(() =>
          withProjection('format', { enum: ['jpeg'] }),
        ).not.toThrow();
        expect(() =>
          withProjection('tags', { minItems: 2, maxItems: 3 }),
        ).not.toThrow();
        // Adding a bound where the native schema has none narrows too.
        expect(() =>
          withProjection('inputPath', { minLength: 1 }),
        ).not.toThrow();
      });
    });
  });
});
