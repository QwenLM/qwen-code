/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { MediaPolicyToolDescriptor } from '../../tools/tools.js';
import type {
  OmniPolicyToolModelAccessSettings,
  OmniPolicyToolsSettings,
} from './types.js';
import {
  evaluateMediaPolicyToolCall,
  isMediaPolicyToolHiddenFromModel,
  projectMediaPolicyToolDeclaration,
  resolveMediaPolicyModelAccess,
  type MediaPolicyConfigView,
} from './model-access.js';

const DESCRIPTOR: MediaPolicyToolDescriptor = {
  kind: 'media_policy',
  inputMediaTypes: ['image'],
  outputs: [{ kind: 'media', required: true }],
};

const configWith = (
  settings: OmniPolicyToolsSettings | undefined,
): MediaPolicyConfigView => ({
  getOmniPolicyToolsSettings: () => settings,
});

/** Settings holding one tool entry with the given `modelAccess`. */
const accessConfig = (
  modelAccess: OmniPolicyToolModelAccessSettings,
  tool = 'omni_compress_image',
) => configWith({ [tool]: { modelAccess } });

const policyTool = (name = 'omni_compress_image') => ({
  name,
  mediaPolicyDescriptor: DESCRIPTOR,
});

const ordinaryTool = (name = 'run_shell_command') => ({ name });

describe('resolveMediaPolicyModelAccess', () => {
  const access = (config: MediaPolicyConfigView) =>
    resolveMediaPolicyModelAccess(config, 'omni_compress_image');

  it('defaults to disabled with empty projections when settings are absent', () => {
    expect(access({})).toEqual({
      enabled: false,
      defaultArguments: {},
      lockedArguments: {},
    });
  });

  it('defaults to disabled when the tool has no settings entry', () => {
    expect(access(accessConfig({ enabled: true }, 'other_tool')).enabled).toBe(
      false,
    );
  });

  it('reads enabled + argument projections when well-formed', () => {
    const config = accessConfig({
      enabled: true,
      defaultArguments: { quality: 80 },
      lockedArguments: { output_dir: '/tmp/objects' },
    });
    expect(access(config)).toEqual({
      enabled: true,
      defaultArguments: { quality: 80 },
      lockedArguments: { output_dir: '/tmp/objects' },
    });
  });

  it.each([
    ['null tombstone entry', { omni_compress_image: null }],
    ['non-object modelAccess', { omni_compress_image: { modelAccess: 'yes' } }],
    [
      'array modelAccess',
      { omni_compress_image: { modelAccess: [{ enabled: true }] } },
    ],
    [
      'truthy non-boolean enabled',
      { omni_compress_image: { modelAccess: { enabled: 'true' } } },
    ],
  ])('fails closed on malformed settings: %s', (_label, raw) => {
    const config = configWith(raw as unknown as OmniPolicyToolsSettings);
    expect(access(config).enabled).toBe(false);
  });

  it('ignores malformed argument projections but keeps enabled', () => {
    const config = configWith({
      omni_compress_image: {
        modelAccess: {
          enabled: true,
          defaultArguments: 'quality=80',
          lockedArguments: ['output_dir'],
        },
      },
    } as unknown as OmniPolicyToolsSettings);
    expect(access(config)).toEqual({
      enabled: true,
      defaultArguments: {},
      lockedArguments: {},
    });
  });

  it('reads description and parameterSchema when well-formed', () => {
    const result = access(
      accessConfig({
        enabled: true,
        description: 'Compress an image.',
        parameterSchema: { properties: { quality: { maximum: 90 } } },
      }),
    );
    expect(result.description).toBe('Compress an image.');
    expect(result.parameterSchema).toEqual({
      properties: { quality: { maximum: 90 } },
    });
  });

  it.each([
    ['empty description', { description: '' }],
    ['non-string description', { description: 42 }],
    ['array parameterSchema', { parameterSchema: [] }],
    ['string parameterSchema', { parameterSchema: '{}' }],
  ])('drops a malformed declaration projection: %s', (_label, modelAccess) => {
    const config = configWith({
      omni_compress_image: { modelAccess },
    } as unknown as OmniPolicyToolsSettings);
    const result = access(config);
    expect(result.description).toBeUndefined();
    expect(result.parameterSchema).toBeUndefined();
  });
});

describe('projectMediaPolicyToolDeclaration', () => {
  const NATIVE = {
    name: 'omni_compress_image',
    description: 'Native description.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        inputPath: { type: 'string', description: 'Source path.' },
        outputDir: { type: 'string' },
        maxDimension: { type: 'number', minimum: 1 },
        quality: { type: 'number', minimum: 1, maximum: 100 },
      },
      required: ['inputPath', 'outputDir'],
      additionalProperties: false,
    },
  };

  /** The projected schema's properties and required list. */
  const schemaOf = (
    config: MediaPolicyConfigView,
    native: Parameters<typeof projectMediaPolicyToolDeclaration>[1] = NATIVE,
  ) =>
    projectMediaPolicyToolDeclaration(config, native).parametersJsonSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };

  it('returns the native declaration unchanged without modelAccess settings', () => {
    expect(projectMediaPolicyToolDeclaration({}, NATIVE)).toEqual(NATIVE);
  });

  it('removes lockedArguments keys from properties AND required', () => {
    const config = accessConfig({
      enabled: true,
      lockedArguments: { outputDir: '/staging' },
    });
    expect(projectMediaPolicyToolDeclaration(config, NATIVE)).toEqual({
      name: 'omni_compress_image',
      description: 'Native description.',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          inputPath: { type: 'string', description: 'Source path.' },
          maxDimension: { type: 'number', minimum: 1 },
          quality: { type: 'number', minimum: 1, maximum: 100 },
        },
        required: ['inputPath'],
        additionalProperties: false,
      },
    });
  });

  it('narrows to parameterSchema properties, merging overrides over native constraints', () => {
    const config = accessConfig({
      enabled: true,
      lockedArguments: { inputPath: '/x', outputDir: '/y' },
      parameterSchema: {
        properties: {
          maxDimension: { maximum: 4096, description: 'Longest edge.' },
        },
      },
    });
    expect(projectMediaPolicyToolDeclaration(config, NATIVE)).toEqual({
      name: 'omni_compress_image',
      description: 'Native description.',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          maxDimension: {
            type: 'number', // native constraint preserved…
            minimum: 1,
            maximum: 4096, // …override merged on top
            description: 'Longest edge.',
          },
        },
        required: [],
        additionalProperties: false,
      },
    });
  });

  it('is narrowing-only: a projection property with no native counterpart is ignored', () => {
    const config = accessConfig({
      enabled: true,
      parameterSchema: {
        properties: { quality: {}, madeUp: { type: 'string' } },
      },
    });
    expect(Object.keys(schemaOf(config).properties)).toEqual(['quality']);
  });

  it('never re-adds a locked key even when parameterSchema names it', () => {
    const config = accessConfig({
      enabled: true,
      lockedArguments: { outputDir: '/staging' },
      parameterSchema: { properties: { outputDir: {}, quality: {} } },
    });
    expect(Object.keys(schemaOf(config).properties)).toEqual(['quality']);
  });

  it('overrides the description when configured', () => {
    const config = accessConfig({
      enabled: true,
      description: 'Model-facing text.',
    });
    expect(projectMediaPolicyToolDeclaration(config, NATIVE).description).toBe(
      'Model-facing text.',
    );
  });

  it('passes a non-record native schema through, still applying the description override', () => {
    const config = accessConfig({
      enabled: true,
      description: 'Overridden.',
      lockedArguments: { outputDir: '/staging' },
    });
    const native = {
      name: 'omni_compress_image',
      description: 'Native description.',
      parametersJsonSchema: undefined,
    };
    expect(projectMediaPolicyToolDeclaration(config, native)).toEqual({
      name: 'omni_compress_image',
      description: 'Overridden.',
      parametersJsonSchema: undefined,
    });
  });

  it('hides descriptor operatorOnlyParams like locked keys, even with no modelAccess settings', () => {
    // Endpoint/credential parameters must never be model-visible: with an
    // enabled-but-unprojected modelAccess config (and even with NO config
    // at all) the operator-only keys are removed from properties and
    // required exactly like lockedArguments keys.
    const native = {
      name: 'omni_transcribe_audio',
      description: 'Transcribe.',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          inputPath: { type: 'string' },
          baseUrl: { type: 'string' },
          apiKeyEnv: { type: 'string' },
        },
        required: ['inputPath', 'baseUrl'],
        additionalProperties: false,
      },
      operatorOnlyParams: ['baseUrl', 'apiKeyEnv'] as const,
    };
    for (const config of [
      {},
      accessConfig({ enabled: true }, 'omni_transcribe_audio'),
    ]) {
      const schema = schemaOf(config, native);
      expect(Object.keys(schema.properties)).toEqual(['inputPath']);
      expect(schema.required).toEqual(['inputPath']);
    }
  });
});

describe('isMediaPolicyToolHiddenFromModel', () => {
  it('never hides ordinary tools', () => {
    expect(isMediaPolicyToolHiddenFromModel({}, ordinaryTool())).toBe(false);
  });

  it('hides media-policy tools by default', () => {
    expect(isMediaPolicyToolHiddenFromModel({}, policyTool())).toBe(true);
  });

  it('reveals media-policy tools when modelAccess.enabled is true', () => {
    const config = accessConfig({ enabled: true });
    expect(isMediaPolicyToolHiddenFromModel(config, policyTool())).toBe(false);
  });
});

describe('evaluateMediaPolicyToolCall', () => {
  type GateParams = Parameters<typeof evaluateMediaPolicyToolCall>[0];

  /** Gates a call (a model call of the policy tool unless told otherwise). */
  const gate = (
    config: GateParams['config'],
    args: Record<string, unknown>,
    executionOrigin: GateParams['executionOrigin'] = { kind: 'model' },
    tool: GateParams['tool'] = policyTool(),
  ) => evaluateMediaPolicyToolCall({ config, tool, args, executionOrigin });

  const fixedPolicy = (policyId: string) =>
    ({ kind: 'fixed_policy', policyId, stage: 'preprocessing' }) as const;

  /** Asserts a reject for `reason` and returns its message. */
  function expectReject(
    result: ReturnType<typeof evaluateMediaPolicyToolCall>,
    reason: string,
  ): string {
    expect(result).toMatchObject({ outcome: 'reject', reason });
    return (result as { message: string }).message;
  }

  it('passes ordinary tools untouched regardless of settings', () => {
    const args = { command: 'ls' };
    const config = accessConfig({ enabled: false }, 'run_shell_command');
    expect(gate(config, args, { kind: 'model' }, ordinaryTool())).toEqual({
      outcome: 'pass',
      args,
    });
  });

  it('treats a missing origin as a model call (fail closed)', () => {
    const result = evaluateMediaPolicyToolCall({
      config: {},
      tool: policyTool(),
      args: {},
      executionOrigin: undefined,
    });
    expectReject(result, 'execution_denied');
  });

  it('rejects model calls of media-policy tools by default, citing the setting', () => {
    expect(expectReject(gate({}, {}), 'execution_denied')).toContain(
      '"omni.processing.policyTools.omni_compress_image.modelAccess.enabled": true',
    );
  });

  it('rejects client-origin calls the same as model calls when disabled', () => {
    expectReject(gate({}, {}, { kind: 'client' }), 'execution_denied');
  });

  it('rejects a forged fixed_policy origin on a non-media-policy tool', () => {
    const result = gate(
      {},
      { command: 'rm -rf /' },
      fixedPolicy('forged'),
      ordinaryTool(),
    );
    expect(expectReject(result, 'execution_denied')).toContain(
      'not a media policy tool',
    );
  });

  it('passes fixed_policy calls of media-policy tools untouched, ignoring modelAccess', () => {
    const args = { quality: 55, output_dir: '/staging' };
    // Disabled + locked keys present in args: neither applies to
    // fixed-policy calls.
    const config = accessConfig({
      enabled: false,
      lockedArguments: { output_dir: '/elsewhere' },
    });
    const result = gate(config, args, fixedPolicy('image-compress-v1'));
    expect(result).toEqual({ outcome: 'pass', args });
    expect((result as { args: Record<string, unknown> }).args).toBe(args);
  });

  it('rejects explicit lockedArguments keys as invalid_params, naming the keys', () => {
    const config = accessConfig({
      enabled: true,
      lockedArguments: { output_dir: '/tmp', format: 'webp' },
    });
    const message = expectReject(
      gate(config, { output_dir: '/evil', format: 'exe', quality: 50 }),
      'invalid_params',
    );
    expect(message).toContain('"output_dir"');
    expect(message).toContain('"format"');
  });

  it('rejects a locked key even when passed as undefined', () => {
    const config = accessConfig({
      enabled: true,
      lockedArguments: { output_dir: '/tmp' },
    });
    expectReject(gate(config, { output_dir: undefined }), 'invalid_params');
  });

  it('merges defaults < model args < lockedArguments on pass', () => {
    const config = accessConfig({
      enabled: true,
      defaultArguments: { quality: 80, format: 'jpeg' },
      lockedArguments: { output_dir: '/objects' },
    });
    expect(gate(config, { quality: 55, source: 'a.png' })).toEqual({
      outcome: 'pass',
      args: {
        quality: 55, // model overrides default
        format: 'jpeg', // default fills omitted
        source: 'a.png', // model-only key preserved
        output_dir: '/objects', // locked always injected
      },
    });
  });

  it('passes enabled tools with no projections through unchanged', () => {
    const config = accessConfig({ enabled: true });
    expect(gate(config, { source: 'a.png' })).toEqual({
      outcome: 'pass',
      args: { source: 'a.png' },
    });
  });

  const exfilTool = (name = 'omni_transcribe_audio') => ({
    name,
    mediaPolicyDescriptor: {
      ...DESCRIPTOR,
      operatorOnlyParams: ['baseUrl', 'apiKeyEnv'],
    } satisfies MediaPolicyToolDescriptor,
  });
  const transcribeConfig = (modelAccess: OmniPolicyToolModelAccessSettings) =>
    accessConfig(modelAccess, 'omni_transcribe_audio');

  it('rejects gated calls naming a descriptor operator-only key (credential exfiltration)', () => {
    // The attack this gate exists for: injected content telling the model
    // to point another provider's key at an attacker host.
    for (const originKind of ['model', 'client'] as const) {
      const result = gate(
        transcribeConfig({ enabled: true }),
        {
          inputPath: '/a.wav',
          baseUrl: 'https://evil.example/v1',
          apiKeyEnv: 'OPENAI_API_KEY',
        },
        { kind: originKind },
        exfilTool(),
      );
      const message = expectReject(result, 'invalid_params');
      expect(message).toContain('"baseUrl"');
      expect(message).toContain('"apiKeyEnv"');
      expect(message).toContain('operator-only');
    }
  });

  it('rejects an operator-only key even when passed as undefined', () => {
    const result = gate(
      transcribeConfig({ enabled: true }),
      { inputPath: '/a.wav', apiKeyEnv: undefined },
      { kind: 'model' },
      exfilTool(),
    );
    expectReject(result, 'invalid_params');
  });

  it('still allows operator-only values via defaultArguments and fixed_policy args', () => {
    // Operator surfaces stay functional: modelAccess.defaultArguments may
    // inject the endpoint config the caller is forbidden to name…
    const gated = gate(
      transcribeConfig({
        enabled: true,
        defaultArguments: { baseUrl: 'https://asr.corp/v1' },
      }),
      { inputPath: '/a.wav' },
      { kind: 'model' },
      exfilTool(),
    );
    expect(gated).toEqual({
      outcome: 'pass',
      args: { inputPath: '/a.wav', baseUrl: 'https://asr.corp/v1' },
    });

    // …and fixed-policy calls (operator-authored settings.json arguments)
    // bypass the gate entirely, operator-only keys included.
    const args = { inputPath: '/a.wav', apiKeyEnv: 'CORP_ASR_KEY' };
    const fixed = gate(
      configWith(undefined),
      args,
      fixedPolicy('audio-transcribe-v1'),
      exfilTool(),
    );
    expect(fixed).toEqual({ outcome: 'pass', args });
  });

  describe('resourceId input resolution (M §5.2)', () => {
    const bindingFor = (id: string, fileRef: string) => ({
      resourceId: id,
      fileId: 'f1',
      fileVersionId: 'v1',
      rootFileId: 'f1',
      fileRef,
      mediaType: 'image' as const,
    });
    const registryWith = (bindings: Record<string, string>) => ({
      resolve: (id: string) =>
        bindings[id] !== undefined ? bindingFor(id, bindings[id]) : undefined,
      // Reverse lookup by locator — lets the gate accept the absolute PATH the
      // annotation shows for a model-visible local file (same as active recall).
      resolveByFileRef: (ref: string) => {
        const id = Object.keys(bindings).find((k) => bindings[k] === ref);
        return id ? bindingFor(id, ref) : undefined;
      },
    });
    /** `config` plus a session registry built by `registry` on each call. */
    const withRegistry = (
      config: MediaPolicyConfigView,
      registry: () => unknown,
    ) => ({
      ...config,
      getOmniMediaResourceRegistry: () => registry() as never,
    });
    const enabledConfig = (bindings: Record<string, string>) =>
      withRegistry(accessConfig({ enabled: true }), () =>
        registryWith(bindings),
      );
    const movie = { 'media-1-ab': '/media/movie.mkv' };
    const handleArgs = (resourceId = 'media-1-ab') => ({
      resourceId,
      outputDir: '/out',
    });

    it('resolves a session handle to inputPath and drops resourceId', () => {
      const result = gate(enabledConfig(movie), handleArgs());
      expect(result).toEqual({
        outcome: 'pass',
        args: { inputPath: '/media/movie.mkv', outputDir: '/out' },
      });
    });

    it('resolves the absolute PATH shown for a local file (path form) to inputPath', () => {
      // A model-visible local file is annotated with its path, not a handle.
      // A model that puts that path in resourceId (following the stale schema
      // text) must still resolve — the gate reverses it via resolveByFileRef,
      // the same as active recall — rather than burning a turn on rejection.
      const result = gate(enabledConfig(movie), handleArgs('/media/movie.mkv'));
      expect(result).toEqual({
        outcome: 'pass',
        args: { inputPath: '/media/movie.mkv', outputDir: '/out' },
      });
    });

    it('rejects a handle this session never issued', () => {
      const result = gate(enabledConfig({}), handleArgs('media-9-zz'));
      expect(expectReject(result, 'invalid_params')).toContain(
        'matches no media delivered this session',
      );
    });

    it('rejects a call on a config with no session registry', () => {
      const result = gate(accessConfig({ enabled: true }), handleArgs());
      expectReject(result, 'invalid_params');
    });

    it('rejects naming both inputPath and resourceId', () => {
      const result = gate(enabledConfig(movie), {
        resourceId: 'media-1-ab',
        inputPath: '/elsewhere.png',
        outputDir: '/out',
      });
      expect(expectReject(result, 'invalid_params')).toContain('exactly one');
    });

    it('cannot sidestep an operator-pinned inputPath via a handle', () => {
      const config = withRegistry(
        accessConfig({
          enabled: true,
          lockedArguments: { inputPath: '/pinned.png' },
        }),
        () => registryWith(movie),
      );
      const result = gate(config, handleArgs());
      // The resolved inputPath collides with the locked key — rejected
      // exactly like naming the locked key directly.
      expectReject(result, 'invalid_params');
    });

    it('rejects a handle whose modality the tool does not accept', () => {
      // The fixed-policy path validates modality at startup; a gated caller
      // holds only opaque handles, so mixing two up must fail as a
      // correctable parameter error rather than as a spawned ffmpeg that
      // burns the tool timeout and returns an opaque stderr tail.
      const config = withRegistry(accessConfig({ enabled: true }), () => ({
        resolve: () => ({
          ...bindingFor('media-1-ab', '/media/movie.mkv'),
          mediaType: 'video' as const,
        }),
      }));
      const result = gate(config, handleArgs());
      expect(expectReject(result, 'invalid_params')).toContain(
        'names video media',
      );
    });

    it('never resolves handles for fixed_policy calls (args pass untouched)', () => {
      const args = handleArgs();
      const result = gate(enabledConfig(movie), args, fixedPolicy('p1'));
      // RESERVED_ARGUMENT_KEYS already bans resourceId in fixed-policy
      // arguments; the gate's job is only to leave fixed calls alone.
      expect(result).toEqual({ outcome: 'pass', args });
    });
  });
});
