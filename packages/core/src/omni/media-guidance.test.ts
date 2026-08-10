/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { AuthType } from '../core/contentGenerator.js';
import { ToolNames } from '../tools/tool-names.js';
import { buildOmniMediaGuidanceSection } from './media-guidance.js';
import {
  OMNI_DISCLOSURE_TEXT_PREFIX,
  OMNI_OMISSION_TEXT_PREFIX,
  OMNI_TRANSCRIPT_TEXT_PREFIX,
} from './disclosure.js';

const DASHSCOPE_CGC = {
  authType: AuthType.USE_OPENAI,
  apiKey: 'sk-real-key',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
};

function stubConfig(overrides?: {
  omniEnabled?: boolean;
  cgc?: Record<string, unknown>;
  policyTools?: Record<string, unknown>;
}): Config {
  return {
    isOmniEnabled: vi.fn().mockReturnValue(overrides?.omniEnabled ?? true),
    isTrustedFolder: vi.fn().mockReturnValue(true),
    getContentGeneratorConfig: vi
      .fn()
      .mockReturnValue(overrides?.cgc ?? DASHSCOPE_CGC),
    getOmniPolicyToolsSettings: vi.fn().mockReturnValue(overrides?.policyTools),
  } as unknown as Config;
}

describe('buildOmniMediaGuidanceSection', () => {
  it('returns null when omni is disabled', () => {
    expect(
      buildOmniMediaGuidanceSection(stubConfig({ omniEnabled: false })),
    ).toBeNull();
  });

  it('returns null when the delivery gate rejects the provider', () => {
    expect(
      buildOmniMediaGuidanceSection(
        stubConfig({
          cgc: { ...DASHSCOPE_CGC, baseUrl: 'https://api.openai.com/v1' },
        }),
      ),
    ).toBeNull();
  });

  it('explains all three disclosure markers and the progressive contract', () => {
    const section = buildOmniMediaGuidanceSection(stubConfig());
    expect(section).toContain(OMNI_DISCLOSURE_TEXT_PREFIX);
    expect(section).toContain(OMNI_OMISSION_TEXT_PREFIX);
    expect(section).toContain(OMNI_TRANSCRIPT_TEXT_PREFIX);
    expect(section).toContain('progressive-understanding');
    // The two behavioral pillars: overview-not-complete + no extrapolation.
    expect(section).toContain('not the complete content');
    expect(section).toContain('Never conclude');
  });

  it('with no tools enabled, instructs stating missing evidence instead of listing tools', () => {
    const section = buildOmniMediaGuidanceSection(stubConfig())!;
    expect(section).toContain('No media tools are enabled');
    expect(section).not.toContain('Available media tools');
    expect(section).not.toContain(ToolNames.OMNI_CLIP_VIDEO);
  });

  it('lists exactly the modelAccess-enabled tools', () => {
    const section = buildOmniMediaGuidanceSection(
      stubConfig({
        policyTools: {
          [ToolNames.OMNI_CLIP_VIDEO]: { modelAccess: { enabled: true } },
          [ToolNames.OMNI_EXTRACT_KEYFRAMES]: {
            modelAccess: { enabled: true },
          },
          // Present but not enabled — must not be listed.
          [ToolNames.OMNI_TRANSCRIBE_AUDIO]: {
            modelAccess: { enabled: false },
          },
        },
      }),
    )!;
    expect(section).toContain('Available media tools');
    expect(section).toContain(ToolNames.OMNI_CLIP_VIDEO);
    expect(section).toContain(ToolNames.OMNI_EXTRACT_KEYFRAMES);
    expect(section).not.toContain(ToolNames.OMNI_TRANSCRIBE_AUDIO);
    expect(section).not.toContain('No media tools are enabled');
    // Tool-usage direction present when tools are available.
    expect(section).toContain('fetch the evidence yourself');
  });

  it('tolerates malformed policyTools settings (fail-closed per tool)', () => {
    const section = buildOmniMediaGuidanceSection(
      stubConfig({
        policyTools: {
          [ToolNames.OMNI_CLIP_VIDEO]: 'not-an-object',
          [ToolNames.OMNI_EXTRACT_KEYFRAMES]: { modelAccess: 'nope' },
        },
      }),
    )!;
    expect(section).toContain('No media tools are enabled');
  });
});
