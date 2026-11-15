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
import type {
  OmniPolicyToolModelAccessSettings,
  OmniPolicyToolSettings,
} from './types.js';
import type {
  MediaPolicyToolDescriptor,
  MediaPolicyToolOutputSpec,
} from '../../tools/tools.js';
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

/** A tool whose only outputs are one required lossy `kind` output (with
 * `role` and a single mime type) plus the disclosure text. */
const toolEmitting = (
  mediaType: OmniModality,
  kind: MediaPolicyToolOutputSpec['kind'],
  role: string,
  mimeType: string,
) =>
  makeTool([mediaType], {
    outputs: [
      { kind, role, mimeTypes: [mimeType], required: true, lossy: true },
      { kind: 'text', role: 'disclosure', required: true },
    ],
  });

function defaultTools(): Record<string, ToolStub> {
  return {
    omni_downsample_image: makeTool(['image']),
    omni_downscale_video: makeTool(['video']),
    omni_downsample_audio: makeTool(['audio']),
  };
}

/** The default tools plus `tool` registered under `name`. */
const toolsWith = (name: string, tool: ToolStub) => ({
  ...defaultTools(),
  [name]: tool,
});

function lookup(tools: Record<string, ToolStub>): OmniPolicyToolLookup {
  return { getTool: (name) => tools[name] };
}

function normalize(
  raw: RawOmniProcessingSettings = {},
  tools: Record<string, ToolStub> = defaultTools(),
) {
  return normalizeOmniProcessingConfig(raw, lookup(tools));
}

/** Error-path prefixes of fixed policy `p`, the guard set and the image
 * tool's policyTools entry. */
const AT_P = 'omni.processing.fixedPolicies.p';
const AT_GUARD = 'omni.processing.transportGuard.policies';
const AT_TOOL = 'omni.processing.policyTools.omni_downsample_image';

/** A minimal image-downsample policy entry plus `extra` fields. */
const imagePolicy = (extra: Record<string, unknown> = {}) => ({
  mediaTypes: ['image'],
  toolName: 'omni_downsample_image',
  ...extra,
});

const fixed = (policies: unknown, tools?: Record<string, ToolStub>) =>
  normalize({ fixedPolicies: policies }, tools);
const guard = (policies: unknown) =>
  normalize({ transportGuardPolicies: policies });
const policyTool = (
  entry: OmniPolicyToolSettings,
  tools?: Record<string, ToolStub>,
) => normalize({ policyTools: { omni_downsample_image: entry } }, tools);
const modelAccess = (access: OmniPolicyToolModelAccessSettings) =>
  policyTool({ modelAccess: access });

/** Normalizes imagePolicy(extra) under `id` and returns that policy. */
const fixedPolicy = (extra: Record<string, unknown>, id = 'p') =>
  fixed({ [id]: imagePolicy(extra) }).fixedPolicies.find((p) => p.id === id);

/** Asserts that policy `p` = imagePolicy(extra) fails with `error`. */
function expectFixedError(
  extra: Record<string, unknown>,
  error: string | RegExp,
  tools?: Record<string, ToolStub>,
) {
  expect(() => fixed({ p: imagePolicy(extra) }, tools)).toThrow(error);
}

describe('normalizeOmniProcessingConfig', () => {
  describe('system defaults', () => {
    it('normalizes against the REAL degradation tools, not just stubs', async () => {
      // The stub lookup can drift from the shipped descriptors; this is the
      // startup path of every real CLI run, so a descriptor failing §13 (e.g.
      // lossy output without a disclosure) must fail HERE, not at launch.
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
      // Upstream design: fixedPolicies are pure user experiments. No config →
      // NOTHING triggers below transport limits; the guard alone is always-on.
      expect(normalize().fixedPolicies).toEqual([]);
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
      // JSON.parse makes "__proto__" an ordinary own key; an object-spread
      // merge would route it through the prototype setter and drop it
      // silently. The null-prototype merge map keeps it for the id check.
      expect(() =>
        fixed(
          JSON.parse(
            '{"__proto__": {"mediaTypes": ["image"], "toolName": "omni_downsample_image"}}',
          ),
        ),
      ).toThrow(/__proto__: policy id must match/);
    });

    it('accepts a null tombstone with no matching entry (no fixed defaults exist)', () => {
      expect(fixed({ 'image-downsample': null }).fixedPolicies).toEqual([]);
    });

    it('normalizes a user fixed policy with full defaults applied', () => {
      const image = fixedPolicy(
        { arguments: { maxDimension: 1024 } },
        'image-downsample',
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
      const image = fixedPolicy(
        { description: '  Downsamples large images.  ' },
        'image-downsample',
      );
      expect(image?.description).toBe('Downsamples large images.');
    });

    it('omits description entirely when unset or blank (no empty-string key)', () => {
      const config = fixed({
        a: imagePolicy(),
        b: imagePolicy({ description: '   ' }),
      });
      for (const id of ['a', 'b']) {
        const p = config.fixedPolicies.find((x) => x.id === id)!;
        expect('description' in p).toBe(false);
      }
    });

    it('rejects a non-string description', () => {
      expect(() =>
        fixed({ 'image-downsample': imagePolicy({ description: 123 }) }),
      ).toThrow(
        'omni.processing.fixedPolicies.image-downsample.description: must be a string',
      );
    });

    it('rejects an over-long description', () => {
      expect(() =>
        fixed({
          'image-downsample': imagePolicy({ description: 'x'.repeat(601) }),
        }),
      ).toThrow(/description: must be ≤ 600 characters \(got 601\)/);
    });

    it('replaces a default guard entry wholesale (no field-level merge)', () => {
      // The override does NOT inherit the default's toolName, so omitting
      // it must fail — a field-level merge would inherit it and pass.
      expect(() =>
        guard({ 'image-downsample': { mediaTypes: ['image'] } }),
      ).toThrow(
        `${AT_GUARD}.image-downsample.toolName: must be a non-empty string`,
      );
      const config = guard({
        'image-downsample': imagePolicy({ arguments: { maxDimension: 1024 } }),
      });
      const image = config.transportGuardPolicies.find(
        (p) => p.id === 'image-downsample',
      );
      expect(image?.arguments).toEqual({ maxDimension: 1024 });
    });

    it('accepts user fixed policies (the only preprocessing source)', () => {
      const config = fixed({ 'my-policy': imagePolicy({ priority: 5 }) });
      expect(config.fixedPolicies).toHaveLength(1);
      const mine = config.fixedPolicies.find((p) => p.id === 'my-policy');
      expect(mine?.priority).toBe(5);
      expect(mine?.stage).toBe('preprocessing');
    });

    it('rejects transport-guard tombstones (the guard is mandatory)', () => {
      expect(() => guard({ 'image-downsample': null })).toThrow(
        `${AT_GUARD}.image-downsample: transport guard policies cannot be ` +
          'removed (the guard is mandatory); override the entry instead',
      );
    });

    it('rejects non-object policy maps', () => {
      expect(() => fixed(['nope'])).toThrow(
        'omni.processing.fixedPolicies: must be an object map of policy id → policy',
      );
      expect(() => fixed({ bad: 'string' })).toThrow(
        'omni.processing.fixedPolicies.bad: must be an object (or null to remove a default)',
      );
    });
  });

  describe('policy entry validation', () => {
    it('rejects unknown keys (§13 #1)', () => {
      expectFixedError({ retries: 3 }, `${AT_P}: unknown key "retries"`);
    });

    it('rejects malformed policy ids', () => {
      expect(() => fixed({ 'has space': imagePolicy() })).toThrow(
        OmniPolicyConfigError,
      );
    });

    it('rejects empty or unknown mediaTypes (§13 #3)', () => {
      expectFixedError(
        { mediaTypes: [] },
        `${AT_P}.mediaTypes: must be a non-empty array`,
      );
      expectFixedError(
        { mediaTypes: ['text'] },
        `${AT_P}.mediaTypes: unknown modality "text" (expected image, video, audio)`,
      );
    });

    it.each([
      [
        'rejects unknown origins (§13 #4)',
        { origins: ['model'] },
        `${AT_P}.origins: unknown origin "model" (expected user, tool, policy)`,
      ],
      [
        'rejects onConditionUnavailable "abortTurn" with an explicit not-yet-supported error',
        { onConditionUnavailable: 'abortTurn' },
        /"abortTurn" is not yet supported/,
      ],
      [
        'rejects invalid onFailure',
        { onFailure: 'retry' },
        `${AT_P}.onFailure: must be "continue" or "abort" (got "retry")`,
      ],
      [
        'rejects non-positive maxRunsPerLineage',
        { maxRunsPerLineage: 0 },
        `${AT_P}.maxRunsPerLineage: must be a positive integer (got 0)`,
      ],
      // Derivatives re-enter matching with origin 'policy'; with no policy
      // accepting that origin, reprocessMedia can never take effect.
      [
        'rejects reprocessMedia when no policy in the set accepts origin "policy"',
        { output: { source: 'keep', reprocessMedia: true } },
        'omni.processing.fixedPolicies: "p" sets output.reprocessMedia, ' +
          'but no policy in this set accepts origin "policy"',
      ],
      [
        'rejects invalid when-conditions via the shared validator (§13 #5)',
        { when: ['>', ['field', 'resource.nonexistent'], 1] },
        /omni\.processing\.fixedPolicies\.p\.when/,
      ],
    ])('%s', (_title, extra, error) => {
      expectFixedError(extra, error);
    });

    it('rejects unknown output keys and illegal output.source (§13 #23)', () => {
      expectFixedError(
        { output: { keepBoth: true } },
        `${AT_P}.output: unknown key "keepBoth"`,
      );
      expectFixedError(
        { output: { source: 'drop' } },
        `${AT_P}.output.source: must be "keep" or "omit" (got "drop")`,
      );
    });

    it('allows output.source "keep" for preprocessing policies', () => {
      const p = fixedPolicy({
        origins: ['user', 'tool', 'policy'],
        output: { source: 'keep', reprocessMedia: true },
      });
      expect(p?.output).toEqual({
        reprocessMedia: true,
        source: 'keep',
        artifacts: { '*': 'include' },
      });
    });

    it('accepts reprocessMedia when ANOTHER policy in the set accepts origin "policy"', () => {
      expect(() =>
        fixed({
          p: imagePolicy({ output: { source: 'keep', reprocessMedia: true } }),
          q: imagePolicy({ origins: ['policy'] }),
        }),
      ).not.toThrow();
    });

    it('applies the inert-reprocessMedia check to the transport-guard set independently', () => {
      expect(() =>
        guard({ g: imagePolicy({ output: { reprocessMedia: true } }) }),
      ).toThrow(
        `${AT_GUARD}: "g" sets output.reprocessMedia, but no policy in ` +
          'this set accepts origin "policy"',
      );
    });

    it('preserves a valid when-condition verbatim through normalization (D7)', () => {
      // `when` is preprocessing's ONLY trigger: a normalization regression
      // that drops or rewrites it would silently widen every user condition
      // to ALL matching resources. Pin the round-trip.
      const when = [
        'all',
        ['>', ['field', 'resource.sizeBytes'], 10_000_000],
        ['>=', ['field', 'session.availableContextTokens'], 4096],
      ];
      expect(fixedPolicy({ when })?.when).toEqual(when);
    });
  });

  describe('output.artifacts selectors (§13 #22/#24)', () => {
    /** Media tool whose descriptor declares producible mime types, so
     * `kind:` selectors have something to match. */
    const mediaToolWithMimes = () =>
      toolEmitting('image', 'media', 'preview', 'image/jpeg');

    /** Audio tool declaring its `transcript` role on a `kind` output. */
    const transcriptTool = (
      kind: MediaPolicyToolOutputSpec['kind'],
      mimeType: string,
    ) => toolEmitting('audio', kind, 'transcript', mimeType);

    const policyWith = (
      artifacts: Record<string, unknown>,
      tool: ToolStub,
      mediaTypes: OmniModality[] = ['image'],
    ) =>
      fixed(
        {
          p: { mediaTypes, toolName: 'tool_under_test', output: { artifacts } },
        },
        toolsWith('tool_under_test', tool),
      );
    const AT_ARTIFACTS = `${AT_P}.output.artifacts`;

    it('defaults an unconfigured artifacts map to include-all', () => {
      const config = fixed({ p: imagePolicy() });
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

    it.each([
      [
        'rejects actions other than include/retain',
        { '*': 'drop' },
        `${AT_ARTIFACTS}["*"]: must be "include" or "retain" (got "drop")`,
      ],
      [
        'rejects unknown selector shapes',
        { preview: 'include' },
        `${AT_ARTIFACTS}["preview"]: unknown selector (expected "*", "kind:<kind>", or "role:<role>")`,
      ],
      [
        'rejects unknown kind targets',
        { 'kind:text': 'include' },
        /unknown artifact kind "text"/,
      ],
      [
        'rejects malformed role tokens',
        { 'role:no spaces!': 'include' },
        /invalid role token "no spaces!"/,
      ],
      [
        'rejects a kind selector the descriptor cannot produce (§13 #22)',
        { 'kind:video': 'retain' },
        `${AT_ARTIFACTS}["kind:video"]: tool "tool_under_test" declares no output of kind "video"`,
      ],
      [
        'rejects a role selector no artifact output declares (§13 #22)',
        { 'role:thumbnail': 'include' },
        `${AT_ARTIFACTS}["role:thumbnail"]: tool "tool_under_test" declares no artifact output with role "thumbnail"`,
      ],
    ])('%s', (_title, artifacts, error) => {
      expect(() => policyWith(artifacts, mediaToolWithMimes())).toThrow(error);
    });

    it('accepts role:transcript and kind:file against a transcript-protocol descriptor (§13 #24)', () => {
      const config = policyWith(
        { 'role:transcript': 'include', 'kind:file': 'include' },
        transcriptTool('file', 'text/plain'), // §6.2 transcript protocol
        ['audio'],
      );
      expect(config.fixedPolicies[0].output.artifacts).toEqual({
        'role:transcript': 'include',
        'kind:file': 'include',
      });
    });

    it('rejects role:transcript when the declared output is not bounded text/plain file (§13 #24)', () => {
      const selector = { 'role:transcript': 'include' };
      const wrongMime = transcriptTool('file', 'text/markdown');
      expect(() => policyWith(selector, wrongMime, ['audio'])).toThrow(
        `${AT_ARTIFACTS}["role:transcript"]: a transcript selector must point at a bounded UTF-8 text/plain file output, but tool "tool_under_test" declares role "transcript" differently`,
      );
      const mediaTranscript = transcriptTool('media', 'audio/wav');
      expect(() => policyWith(selector, mediaTranscript, ['audio'])).toThrow(
        /a transcript selector must point at a bounded UTF-8/,
      );
    });

    it('accepts the REAL transcribe tool as a fixed-policy target with role:transcript', async () => {
      const { OmniTranscribeAudioTool } = await import(
        './tools/transcribe-audio.js'
      );
      const config = fixed(
        {
          'audio-transcribe': {
            mediaTypes: ['audio'],
            toolName: 'omni_transcribe_audio',
            output: {
              source: 'omit',
              artifacts: { 'role:transcript': 'include' },
            },
          },
        },
        toolsWith('omni_transcribe_audio', new OmniTranscribeAudioTool({})),
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
      expect(() => fixed({ p: { mediaTypes: ['image'] } })).toThrow(
        `${AT_P}.toolName: must be a non-empty string`,
      );
    });

    it('rejects an unregistered tool (covers excluded tools too)', () => {
      expectFixedError(
        { toolName: 'no_such_tool' },
        `${AT_P}.toolName: tool "no_such_tool" is not registered ` +
          '(unknown name, or excluded by tool filtering)',
      );
    });

    it('rejects a registered tool without a media_policy descriptor', () => {
      expectFixedError(
        { toolName: 'read_file' },
        `${AT_P}.toolName: tool "read_file" is not a media policy tool ` +
          '(no media_policy descriptor)',
        toolsWith('read_file', { parameterSchema: {} }),
      );
    });

    it('rejects a tool declaring no required output', () => {
      const weakTool = makeTool(['image'], {
        outputs: [{ kind: 'media', required: false, lossy: false }],
      });
      expectFixedError(
        { toolName: 'weak_tool' },
        /declares no required output/,
        toolsWith('weak_tool', weakTool),
      );
    });

    it('rejects a lossy tool without a disclosure output (§13 #8)', () => {
      const sneakyTool = makeTool(['image'], {
        outputs: [{ kind: 'media', required: true, lossy: true }],
      });
      expectFixedError(
        { toolName: 'sneaky_tool' },
        `${AT_P}.toolName: tool "sneaky_tool" declares a lossy media output ` +
          'but no disclosure text output',
        toolsWith('sneaky_tool', sneakyTool),
      );
    });

    it('rejects mediaTypes the tool does not accept', () => {
      expectFixedError(
        { mediaTypes: ['image', 'video'] },
        `${AT_P}.mediaTypes: tool "omni_downsample_image" does not accept ` +
          '"video" input (accepts image)',
      );
    });
  });

  describe('fixed arguments validation (§13 #11)', () => {
    it('rejects reserved io keys in arguments', () => {
      expectFixedError(
        { arguments: { inputPath: '/tmp/x.png' } },
        `${AT_P}.arguments: "inputPath" is injected by the orchestrator ` +
          'per invocation and must not be configured',
      );
    });

    it('validates arguments against the settingsSchema (io-stripped)', () => {
      expectFixedError(
        { arguments: { bogus: true } },
        /omni\.processing\.fixedPolicies\.p\.arguments/,
      );
      // Valid tunables pass through untouched.
      const p = fixedPolicy({ arguments: { maxDimension: 800, quality: 70 } });
      expect(p?.arguments).toEqual({ maxDimension: 800, quality: 70 });
    });
  });

  describe('transport guard rules (§13 #15-#17)', () => {
    it('rejects guard policies declaring when', () => {
      expect(() =>
        guard({
          'image-downsample': imagePolicy({
            when: ['>', ['field', 'resource.width'], 1],
          }),
        }),
      ).toThrow(
        `${AT_GUARD}.image-downsample.when: transport guard policies must ` +
          'not declare "when" (they run exactly when transport limits are ' +
          'exceeded)',
      );
    });

    it('rejects guard policies with output.source "keep"', () => {
      expect(() =>
        guard({
          'image-downsample': imagePolicy({ output: { source: 'keep' } }),
        }),
      ).toThrow(
        `${AT_GUARD}.image-downsample.output.source: transport guard ` +
          'policies must use "omit" (the over-limit source cannot stay in ' +
          'the delivery set)',
      );
    });

    it('rejects a merged guard set that does not cover all three modalities', () => {
      // Point every guard entry at image only → video+audio uncovered.
      expect(() =>
        guard({
          'video-downscale': imagePolicy(),
          'audio-downsample': imagePolicy(),
        }),
      ).toThrow(
        `${AT_GUARD}: no guard policy covers video, audio — the merged set ` +
          'must cover image, video, and audio',
      );
    });
  });

  describe('limits (§12.2)', () => {
    it('merges overrides over defaults', () => {
      expect(normalize({ limits: { maxLineageDepth: 3 } }).limits).toEqual({
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
      const withTokens = (value: unknown) =>
        normalize({ maxEstimatedTokens: value as number });
      expect(() => withTokens('abc')).toThrow(
        'omni.processing.transportGuard.maxEstimatedTokens: must be a ' +
          'finite number >= 0, where 0 disables the token guard (got "abc")',
      );
      expect(() => withTokens(true)).toThrow(OmniPolicyConfigError);
      expect(() => withTokens(-1)).toThrow(OmniPolicyConfigError);
      expect(() => withTokens(Number.POSITIVE_INFINITY)).toThrow(
        OmniPolicyConfigError,
      );
      expect(() => withTokens(0)).not.toThrow();
      expect(() => withTokens(262144)).not.toThrow();
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
      // A typo like "settigns" would otherwise read as absent downstream and
      // the intended configuration would silently never take effect.
      expect(() => policyTool({ settigns: {} } as never)).toThrow(
        `${AT_TOOL}: unknown key "settigns"`,
      );
      expect(() => policyTool({ runtime: { timeout: 30000 } })).toThrow(
        `${AT_TOOL}.runtime: unknown key "timeout"`,
      );
      expect(() => modelAccess({ lockedArgs: {} } as never)).toThrow(
        `${AT_TOOL}.modelAccess: unknown key "lockedArgs"`,
      );
    });

    it('validates settings against the settingsSchema (§13 #7)', () => {
      expect(() => policyTool({ settings: { bogus: 1 } })).toThrow(
        /omni\.processing\.policyTools\.omni_downsample_image\.settings/,
      );
    });

    it('rejects non-positive runtime.timeoutMs', () => {
      expect(() => policyTool({ runtime: { timeoutMs: -5 } })).toThrow(
        `${AT_TOOL}.runtime.timeoutMs: must be a positive integer (got -5)`,
      );
    });

    it('caps runtime.timeoutMs below the staging sweep grace window (cross-file invariant with recovery §5)', () => {
      // A tool running >= STAGING_GRACE_MS could have its live staging dir
      // swept as crash leftovers by another process's startup. Pin BOTH
      // sides so removing, inverting (`<=`) or relocating the cap fails.
      expect(() =>
        policyTool({ runtime: { timeoutMs: STAGING_GRACE_MS } }),
      ).toThrow(
        `${AT_TOOL}.runtime.timeoutMs: ` +
          `must be below the staging sweep grace window (${STAGING_GRACE_MS}ms) ` +
          `so a live invocation's staging directory is never reclaimed mid-run`,
      );
      expect(() =>
        policyTool({ runtime: { timeoutMs: STAGING_GRACE_MS - 1 } }),
      ).not.toThrow();
    });

    it('rejects overlapping defaultArguments and lockedArguments (§13 #21)', () => {
      expect(() =>
        modelAccess({
          defaultArguments: { quality: 80 },
          lockedArguments: { quality: 60 },
        }),
      ).toThrow(
        `${AT_TOOL}.modelAccess: "quality" present in both defaultArguments ` +
          'and lockedArguments',
      );
    });

    it('rejects a defaultArguments key the native schema does not declare', () => {
      expect(() => modelAccess({ defaultArguments: { sharpen: 2 } })).toThrow(
        /omni\.processing\.policyTools\.omni_downsample_image\.modelAccess\.defaultArguments/,
      );
    });

    it('rejects a lockedArguments value the native sub-schema refuses', () => {
      expect(() =>
        modelAccess({ lockedArguments: { quality: 'very high' } }),
      ).toThrow(
        /omni\.processing\.policyTools\.omni_downsample_image\.modelAccess\.lockedArguments/,
      );
    });

    it('accepts schema-valid partial defaultArguments and lockedArguments', () => {
      expect(() =>
        modelAccess({
          defaultArguments: { quality: 80 },
          lockedArguments: { maxDimension: 1024 },
        }),
      ).not.toThrow();
    });

    it('validates locked/operator-only arguments against a REAL tool (whose `schema` getter hides them)', async () => {
      // Regression: validation must read the NATIVE parameterSchema. A real
      // tool's `schema` getter is the model projection, which strips locked
      // and operator-only keys, so every legitimate locked/operator config
      // would abort startup ("must NOT have additional properties"). Static
      // stubs can't catch this: wire real tools whose config view serves
      // the very settings under validation.
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
        modelAccess({
          parameterSchema: { properties: { quality: {}, sharpen: {} } },
        }),
      ).toThrow(
        `${AT_TOOL}.modelAccess.parameterSchema: ` +
          '"sharpen" not present in the tool\'s native schema (projection may only narrow)',
      );
    });

    it('accepts a narrowing-only parameterSchema', () => {
      expect(() =>
        modelAccess({ parameterSchema: { properties: { quality: {} } } }),
      ).not.toThrow();
    });

    describe('constraint-value narrowing (§11.2: 不能扩大类型、枚举、范围)', () => {
      /** Tool whose native schema carries real constraints to loosen. */
      const constrainedTool = (): ToolStub => ({
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
      });
      const withProjection = (
        prop: string,
        override: Record<string, unknown>,
      ) =>
        policyTool(
          {
            modelAccess: {
              parameterSchema: { properties: { [prop]: override } },
            },
          },
          toolsWith('omni_downsample_image', constrainedTool()),
        );
      const at = `${AT_TOOL}.modelAccess.parameterSchema.properties.`;

      it.each([
        [
          'rejects an override raising the native maximum (probe case)',
          'quality',
          { maximum: 200 },
          'quality: the upper bound loosens the native one (200 vs native 100)',
        ],
        [
          'rejects an override lowering the native minimum',
          'quality',
          { minimum: 0 },
          'quality: the lower bound loosens the native one (0 vs native 1)',
        ],
        [
          'rejects an enum override adding values outside the native enum',
          'format',
          { enum: ['jpeg', 'png'] },
          'format: "enum" adds values the native enum does not allow ("png")',
        ],
        [
          'rejects an override changing the native type',
          'quality',
          { type: 'string' },
          'quality: "type" changes the native type ("string" vs native "number")',
        ],
        [
          'rejects maxItems above the native cap',
          'tags',
          { maxItems: 10 },
          'tags: "maxItems" loosens the native constraint (10 vs native 4)',
        ],
      ])('%s', (_title, prop, override, reason) => {
        expect(() => withProjection(prop, override)).toThrow(
          `${at}${reason} (projection may only narrow)`,
        );
      });

      it('accepts genuinely narrowing overrides', () => {
        const narrows = (prop: string, override: Record<string, unknown>) =>
          expect(() => withProjection(prop, override)).not.toThrow();
        // integer narrows number
        narrows('quality', { type: 'integer', minimum: 10, maximum: 80 });
        narrows('format', { enum: ['jpeg'] });
        narrows('tags', { minItems: 2, maxItems: 3 });
        // Adding a bound where the native schema has none narrows too.
        narrows('inputPath', { minLength: 1 });
      });
    });
  });
});
