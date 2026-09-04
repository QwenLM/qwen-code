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
import type { OmniUploadConfig } from './upload-config.js';
import {
  OMNI_DISCLOSURE_TEXT_PREFIX,
  OMNI_RESOURCE_HANDLE_TEXT_PREFIX,
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
  recallMode?: 'active' | 'sideQuery';
  upload?: OmniUploadConfig;
  fixedPolicies?: unknown[];
}): Config {
  return {
    isOmniEnabled: vi.fn().mockReturnValue(overrides?.omniEnabled ?? true),
    isTrustedFolder: vi.fn().mockReturnValue(true),
    getContentGeneratorConfig: vi
      .fn()
      .mockReturnValue(overrides?.cgc ?? DASHSCOPE_CGC),
    getModel: vi.fn().mockReturnValue('qwen3.5-omni-plus'),
    getOmniUploadConfig: vi.fn().mockReturnValue(overrides?.upload),
    getOmniPolicyToolsSettings: vi.fn().mockReturnValue(overrides?.policyTools),
    getOmniProcessingConfig: vi
      .fn()
      .mockReturnValue(
        overrides?.fixedPolicies
          ? { fixedPolicies: overrides.fixedPolicies }
          : undefined,
      ),
    getOmniMemoryConfig: vi
      .fn()
      .mockReturnValue(
        overrides?.recallMode
          ? { recall: { mode: overrides.recallMode } }
          : undefined,
      ),
  } as unknown as Config;
}

/** A normalized-policy stub carrying the fields the guidance collector
 * reads: id + priority for ordering, description for the prompt bullet. */
function policy(
  id: string,
  priority: number,
  description?: string,
): Record<string, unknown> {
  return { id, priority, mediaTypes: ['video'], output: {}, description };
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

  it('includes guidance for custom inference with a dedicated upload channel', () => {
    const section = buildOmniMediaGuidanceSection(
      stubConfig({
        cgc: {
          authType: AuthType.USE_OPENAI,
          apiKey: 'inference-key',
          baseUrl: 'http://127.0.0.1:22002/v1',
        },
        upload: {
          apiKey: 'upload-key',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          model: 'qwen3.5-omni-plus',
        },
      }),
    );

    expect(section).toContain('Media Delivery');
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

describe('buildOmniMediaGuidanceSection — policy descriptions', () => {
  it('injects a described policy verbatim into the prompt', () => {
    const desc =
      'Keyframe degradation triggers only when estimated tokens > 10000; ' +
      'at or below that a clip is delivered at native resolution.';
    const section = buildOmniMediaGuidanceSection(
      stubConfig({ fixedPolicies: [policy('movie-keyframes', 60, desc)] }),
    )!;
    expect(section).toContain('automatic preprocessing policies');
    expect(section).toContain(desc);
  });

  it('omits the block entirely when no policy carries a description', () => {
    const section = buildOmniMediaGuidanceSection(
      stubConfig({
        fixedPolicies: [
          policy('movie-keyframes', 60),
          policy('movie-extract-audio', 100),
        ],
      }),
    )!;
    expect(section).not.toContain('automatic preprocessing policies');
  });

  it('orders descriptions by priority desc then id, and skips undescribed policies', () => {
    const section = buildOmniMediaGuidanceSection(
      stubConfig({
        fixedPolicies: [
          policy('movie-keyframes', 60, 'LOW-PRIORITY-DESC'),
          policy('undescribed', 200), // no description → contributes nothing
          policy('movie-extract-audio', 100, 'HIGH-PRIORITY-DESC'),
        ],
      }),
    )!;
    expect(section).toContain('HIGH-PRIORITY-DESC');
    expect(section).toContain('LOW-PRIORITY-DESC');
    // Higher priority (100) must precede lower (60).
    expect(section.indexOf('HIGH-PRIORITY-DESC')).toBeLessThan(
      section.indexOf('LOW-PRIORITY-DESC'),
    );
  });
});

describe('buildOmniMediaGuidanceSection — recall guidance', () => {
  it('explains the resource marker and the recall-before-reprocessing contract in active mode', () => {
    const section = buildOmniMediaGuidanceSection(
      stubConfig({ recallMode: 'active' }),
    )!;
    // The annotation ships with every memory-known delivery, but the tool
    // that consumes it is deferred — so without this the model sees the
    // marker with no explanation and reprocesses what memory already holds.
    expect(section).toContain(OMNI_RESOURCE_HANDLE_TEXT_PREFIX);
    expect(section).toContain('omni_recall_media_memory');
    expect(section).toMatch(/BEFORE reprocessing/);
    // It must describe BOTH annotation forms: the absolute path for a local
    // file the model read, and the opaque handle for path-less media.
    expect(section).toMatch(/absolute path/);
    expect(section).toMatch(/opaque session handle/);
  });

  it('says nothing about the recall tool in sideQuery mode', () => {
    // D10: in sideQuery mode the harness injects recalled memory itself and
    // the tool is not even registered — telling the model to call it would
    // invite a guaranteed unknown-tool error.
    const section = buildOmniMediaGuidanceSection(
      stubConfig({ recallMode: 'sideQuery' }),
    )!;
    expect(section).not.toContain('omni_recall_media_memory');
  });

  it('says nothing about recall when memory is not configured', () => {
    const section = buildOmniMediaGuidanceSection(stubConfig())!;
    expect(section).not.toContain('omni_recall_media_memory');
  });
});
