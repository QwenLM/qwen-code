/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { MediaPolicyToolDescriptor } from '../../tools/tools.js';
import type { OmniPolicyToolsSettings } from './types.js';
import {
  evaluateMediaPolicyToolCall,
  isMediaPolicyToolHiddenFromModel,
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

const policyTool = (name = 'omni_compress_image') => ({
  name,
  mediaPolicyDescriptor: DESCRIPTOR,
});

const ordinaryTool = (name = 'run_shell_command') => ({ name });

describe('resolveMediaPolicyModelAccess', () => {
  it('defaults to disabled with empty projections when settings are absent', () => {
    expect(resolveMediaPolicyModelAccess({}, 'omni_compress_image')).toEqual({
      enabled: false,
      defaultArguments: {},
      lockedArguments: {},
    });
  });

  it('defaults to disabled when the tool has no settings entry', () => {
    const config = configWith({
      other_tool: { modelAccess: { enabled: true } },
    });
    expect(
      resolveMediaPolicyModelAccess(config, 'omni_compress_image').enabled,
    ).toBe(false);
  });

  it('reads enabled + argument projections when well-formed', () => {
    const config = configWith({
      omni_compress_image: {
        modelAccess: {
          enabled: true,
          defaultArguments: { quality: 80 },
          lockedArguments: { output_dir: '/tmp/objects' },
        },
      },
    });
    expect(
      resolveMediaPolicyModelAccess(config, 'omni_compress_image'),
    ).toEqual({
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
    expect(
      resolveMediaPolicyModelAccess(config, 'omni_compress_image').enabled,
    ).toBe(false);
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
    expect(
      resolveMediaPolicyModelAccess(config, 'omni_compress_image'),
    ).toEqual({ enabled: true, defaultArguments: {}, lockedArguments: {} });
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
    const config = configWith({
      omni_compress_image: { modelAccess: { enabled: true } },
    });
    expect(isMediaPolicyToolHiddenFromModel(config, policyTool())).toBe(false);
  });
});

describe('evaluateMediaPolicyToolCall', () => {
  it('passes ordinary tools untouched regardless of settings', () => {
    const args = { command: 'ls' };
    const result = evaluateMediaPolicyToolCall({
      config: configWith({
        run_shell_command: { modelAccess: { enabled: false } },
      }),
      tool: ordinaryTool(),
      args,
      executionOrigin: { kind: 'model' },
    });
    expect(result).toEqual({ outcome: 'pass', args });
  });

  it('treats a missing origin as a model call (fail closed)', () => {
    const result = evaluateMediaPolicyToolCall({
      config: {},
      tool: policyTool(),
      args: {},
      executionOrigin: undefined,
    });
    expect(result).toMatchObject({
      outcome: 'reject',
      reason: 'execution_denied',
    });
  });

  it('rejects model calls of media-policy tools by default, citing the setting', () => {
    const result = evaluateMediaPolicyToolCall({
      config: {},
      tool: policyTool(),
      args: {},
      executionOrigin: { kind: 'model' },
    });
    expect(result).toMatchObject({
      outcome: 'reject',
      reason: 'execution_denied',
    });
    expect((result as { message: string }).message).toContain(
      '"omni.processing.policyTools.omni_compress_image.modelAccess.enabled": true',
    );
  });

  it('rejects client-origin calls the same as model calls when disabled', () => {
    const result = evaluateMediaPolicyToolCall({
      config: {},
      tool: policyTool(),
      args: {},
      executionOrigin: { kind: 'client' },
    });
    expect(result).toMatchObject({
      outcome: 'reject',
      reason: 'execution_denied',
    });
  });

  it('rejects a forged fixed_policy origin on a non-media-policy tool', () => {
    const result = evaluateMediaPolicyToolCall({
      config: {},
      tool: ordinaryTool(),
      args: { command: 'rm -rf /' },
      executionOrigin: {
        kind: 'fixed_policy',
        policyId: 'forged',
        stage: 'preprocessing',
      },
    });
    expect(result).toMatchObject({
      outcome: 'reject',
      reason: 'execution_denied',
    });
    expect((result as { message: string }).message).toContain(
      'not a media policy tool',
    );
  });

  it('passes fixed_policy calls of media-policy tools untouched, ignoring modelAccess', () => {
    const args = { quality: 55, output_dir: '/staging' };
    const result = evaluateMediaPolicyToolCall({
      // Disabled + locked keys present in args: neither applies to
      // fixed-policy calls.
      config: configWith({
        omni_compress_image: {
          modelAccess: {
            enabled: false,
            lockedArguments: { output_dir: '/elsewhere' },
          },
        },
      }),
      tool: policyTool(),
      args,
      executionOrigin: {
        kind: 'fixed_policy',
        policyId: 'image-compress-v1',
        stage: 'preprocessing',
      },
    });
    expect(result).toEqual({ outcome: 'pass', args });
    expect((result as { args: Record<string, unknown> }).args).toBe(args);
  });

  it('rejects explicit lockedArguments keys as invalid_params, naming the keys', () => {
    const result = evaluateMediaPolicyToolCall({
      config: configWith({
        omni_compress_image: {
          modelAccess: {
            enabled: true,
            lockedArguments: { output_dir: '/tmp', format: 'webp' },
          },
        },
      }),
      tool: policyTool(),
      args: { output_dir: '/evil', format: 'exe', quality: 50 },
      executionOrigin: { kind: 'model' },
    });
    expect(result).toMatchObject({
      outcome: 'reject',
      reason: 'invalid_params',
    });
    const message = (result as { message: string }).message;
    expect(message).toContain('"output_dir"');
    expect(message).toContain('"format"');
  });

  it('rejects a locked key even when passed as undefined', () => {
    const result = evaluateMediaPolicyToolCall({
      config: configWith({
        omni_compress_image: {
          modelAccess: {
            enabled: true,
            lockedArguments: { output_dir: '/tmp' },
          },
        },
      }),
      tool: policyTool(),
      args: { output_dir: undefined },
      executionOrigin: { kind: 'model' },
    });
    expect(result).toMatchObject({
      outcome: 'reject',
      reason: 'invalid_params',
    });
  });

  it('merges defaults < model args < lockedArguments on pass', () => {
    const result = evaluateMediaPolicyToolCall({
      config: configWith({
        omni_compress_image: {
          modelAccess: {
            enabled: true,
            defaultArguments: { quality: 80, format: 'jpeg' },
            lockedArguments: { output_dir: '/objects' },
          },
        },
      }),
      tool: policyTool(),
      args: { quality: 55, source: 'a.png' },
      executionOrigin: { kind: 'model' },
    });
    expect(result).toEqual({
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
    const result = evaluateMediaPolicyToolCall({
      config: configWith({
        omni_compress_image: { modelAccess: { enabled: true } },
      }),
      tool: policyTool(),
      args: { source: 'a.png' },
      executionOrigin: { kind: 'model' },
    });
    expect(result).toEqual({ outcome: 'pass', args: { source: 'a.png' } });
  });
});
