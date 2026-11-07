/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { invalidateModelCatalog } from '../models/model-catalog.js';
import {
  defaultModalities,
  isQwenFamilyWireModel,
  isTieredEffortWireModel,
} from './modalityDefaults.js';
import type { InputModalities } from './contentGenerator.js';

type Check = (model: string) => void;

/** The model's modalities equal `expected` exactly (one assertion). */
const equals =
  (expected: InputModalities): Check =>
  (model) =>
    expect(defaultModalities(model)).toEqual(expected);

/** One assertion per listed modality; `undefined` means absent. */
const has =
  (spec: { [K in keyof InputModalities]: true | undefined }): Check =>
  (model) => {
    const m = defaultModalities(model);
    for (const [key, value] of Object.entries(spec)) {
      expect(m[key as keyof InputModalities]).toBe(value);
    }
  };

const FULL = equals({ image: true, pdf: true, audio: true, video: true });
const TEXT_ONLY = equals({});
const IMAGE_VIDEO = equals({ image: true, video: true });
const IMAGE = has({ image: true });
const IMAGE_NO_PDF = has({ image: true, pdf: undefined });
const IMAGE_PDF = has({ image: true, pdf: true });
const ONLY_IMAGE_VIDEO = has({
  image: true,
  video: true,
  pdf: undefined,
  audio: undefined,
});

type Case = [label: string, check: Check, model?: string];

/** One case per row, titled `${prefix} ${label}`; the model id defaults to
 * the label. */
const casesFor = (prefix: string, rows: Case[]) =>
  it.each(rows)(`${prefix} %s`, (label, check, model) => check(model ?? label));

// Run against the real bundled catalog (the production default). QWEN_HOME is
// pinned to an empty dir so a host's refreshed cache cannot replace the
// bundle, and deleting the kill-switch opts back out of the test-setup's
// regex-only default.
let tempDir: string;
let previousHome: string | undefined;
let previousSwitch: string | undefined;

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modality-defaults-'));
  previousHome = process.env['QWEN_HOME'];
  previousSwitch = process.env['QWEN_CODE_MODELS_DEV'];
  process.env['QWEN_HOME'] = path.join(tempDir, '.qwen');
  delete process.env['QWEN_CODE_MODELS_DEV'];
  invalidateModelCatalog();
});

afterAll(() => {
  if (previousHome === undefined) {
    delete process.env['QWEN_HOME'];
  } else {
    process.env['QWEN_HOME'] = previousHome;
  }
  if (previousSwitch === undefined) {
    delete process.env['QWEN_CODE_MODELS_DEV'];
  } else {
    process.env['QWEN_CODE_MODELS_DEV'] = previousSwitch;
  }
  invalidateModelCatalog();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('defaultModalities', () => {
  it('does not infer modalities for an unrecognized batch route', () => {
    expect(defaultModalities('google/gemini-2.5-flash:batch')).toEqual({});
  });

  describe('Google Gemini', () => {
    casesFor('returns full multimodal for', [
      ['gemini-3-pro', FULL, 'gemini-3-pro-preview'],
      ['gemini-3-flash', FULL, 'gemini-3-flash-preview'],
      ['gemini-3.1-pro', FULL, 'gemini-3.1-pro-preview'],
      ['gemini-2.5-pro', FULL],
      ['gemini-1.5-flash', FULL],
    ]);
  });

  describe('OpenAI', () => {
    casesFor('returns image for', [
      [
        'gpt-5.2',
        has({
          image: true,
          audio: undefined,
          pdf: undefined,
          video: undefined,
        }),
      ],
      ['gpt-5-mini', IMAGE],
      ['gpt-4o', IMAGE],
      ['o3', IMAGE],
    ]);
  });

  describe('Anthropic Claude', () => {
    casesFor('returns image + pdf for', [
      [
        'claude-opus-4-6',
        has({ image: true, pdf: true, audio: undefined, video: undefined }),
      ],
      ['claude-sonnet-4-6', IMAGE_PDF],
      ['claude-sonnet-4', IMAGE_PDF],
      ['claude-3.5-sonnet', IMAGE_PDF],
    ]);
  });

  describe('Qwen', () => {
    casesFor('returns image + video for', [
      ['qwen-vl-max', ONLY_IMAGE_VIDEO],
      ['qwen3-vl-plus', has({ image: true, video: true })],
      ['qwen2.5-vl-32b-instruct', ONLY_IMAGE_VIDEO],
      ['Ollama qwen3-vl tags', ONLY_IMAGE_VIDEO, 'qwen3-vl:8b'],
      ['Ollama qwen2.5vl tags', ONLY_IMAGE_VIDEO, 'qwen2.5vl:7b'],
      ['qwen2.5-vl without a size', ONLY_IMAGE_VIDEO, 'qwen2.5-vl'],
      [
        'quantized Qwen2.5-VL builds',
        ONLY_IMAGE_VIDEO,
        'Qwen/Qwen2.5-VL-3B-Instruct-AWQ',
      ],
      ['qwen2-vl-7b-instruct', ONLY_IMAGE_VIDEO],
      ['coder-model (same as qwen3.5-plus)', IMAGE_VIDEO, 'coder-model'],
      ['qwen3.5-plus', ONLY_IMAGE_VIDEO],
      ['qwen3.7-plus', ONLY_IMAGE_VIDEO],
      // [Regression] issue-10194 — qwen3.8-flash/plus were classified as text-only
      ['qwen3.8-flash', IMAGE_VIDEO],
      ['qwen3.8-plus', IMAGE_VIDEO],
      ['qwen3.6-35b variants', ONLY_IMAGE_VIDEO, 'qwen3.6-35b-a3b-nvfp4'],
      // The bundled catalog adds video; its pdf stays endpoint-gated by the
      // lookupModelCatalog correction.
      ['qwen3.8-max', IMAGE_VIDEO],
    ]);

    casesFor('returns text-only for', [
      ['qwen3-coder-plus', TEXT_ONLY],
      ['qwen3.7-max', TEXT_ONLY],
      ['qwen-turbo', TEXT_ONLY],
    ]);

    casesFor('returns image for', [
      ['qvq-72b-preview', IMAGE],
      [
        'qwen3.8-max-preview (provider-prefixed)',
        IMAGE,
        'bailian-token-plan/qwen3.8-max-preview',
      ],
    ]);

    it('returns full multimodal for qwen omni models', () => {
      for (const model of [
        'qwen3.5-omni-plus',
        'qwen3-omni-flash',
        'qwen-omni-turbo',
      ]) {
        FULL(model);
      }
    });
  });

  describe('DeepSeek', () => {
    casesFor('returns text-only for', [
      ['deepseek-chat', TEXT_ONLY],
      ['deepseek-reasoner', TEXT_ONLY],
      // (QwenLM/qwen-code#10270)
      ['non-vision deepseek-v4-flash', TEXT_ONLY, 'deepseek-v4-flash'],
      ['deepseek-v4.1-flash', TEXT_ONLY],
      ['deepseek-v4-pro', TEXT_ONLY],
    ]);

    it('returns image for deepseek-v4-flash-vision-exp', () => {
      IMAGE_NO_PDF('deepseek-v4-flash-vision-exp');
    });

    it('returns image for the official deepseek-flash', () => {
      IMAGE_NO_PDF('deepseek-flash');
    });

    casesFor('returns image for', [
      ['DeepSeek-VL2', IMAGE_NO_PDF, 'deepseek-ai/deepseek-vl2'],
      ['DeepSeek-VL2-Small', IMAGE_NO_PDF, 'deepseek-ai/deepseek-vl2-small'],
    ]);
  });

  describe('Zhipu GLM', () => {
    casesFor('returns image for', [
      ['glm-4.5v', IMAGE_NO_PDF],
      // (QwenLM/qwen-code#10270)
      ['glm-4.6v', IMAGE_NO_PDF],
      ['glm-5v-turbo', IMAGE_NO_PDF],
      ['glm-5.3-flash', IMAGE_NO_PDF],
    ]);

    casesFor('returns text-only for', [
      ['glm-5', TEXT_ONLY],
      ['glm-4.7', TEXT_ONLY],
      ['glm-4.6 (no v suffix)', TEXT_ONLY, 'glm-4.6'],
    ]);
  });

  describe('MiniMax', () => {
    it('returns image + video for MiniMax-M3', () => {
      ONLY_IMAGE_VIDEO('MiniMax-M3');
    });

    it('returns text-only for MiniMax-M2.5', () => {
      TEXT_ONLY('MiniMax-M2.5');
    });

    it('returns image for MiniMax-VL-01', () => {
      IMAGE_NO_PDF('MiniMaxAI/MiniMax-VL-01');
    });
  });

  describe('Kimi', () => {
    casesFor('returns image + video for', [
      ['kimi-k3', ONLY_IMAGE_VIDEO],
      ['kimi-k3.1-pro', ONLY_IMAGE_VIDEO],
      ['k3.1-pro', ONLY_IMAGE_VIDEO],
      ['k3.1-pro-highspeed', ONLY_IMAGE_VIDEO],
      ['kimi-k2.5', ONLY_IMAGE_VIDEO],
    ]);

    it('returns image only for the K3 256K variant', () => {
      expect(defaultModalities('k3-256k')).toEqual({ image: true });
      expect(defaultModalities('kimi-k3-256k')).toEqual({ image: true });
    });

    it('returns text-only for kimi-k2', () => {
      TEXT_ONLY('kimi-k2');
    });

    casesFor('returns image for', [
      ['Kimi-VL-A3B-Instruct', IMAGE_NO_PDF, 'moonshotai/Kimi-VL-A3B-Instruct'],
      ['Kimi-VL-A3B-Thinking', IMAGE_NO_PDF, 'moonshotai/Kimi-VL-A3B-Thinking'],
    ]);
  });

  describe('ByteDance Doubao', () => {
    casesFor('returns image for', [
      [
        // #4876 wanted image support here; since #13209 the dotted spelling
        // also reaches the catalog entry volcengine publishes for
        // `doubao-seed-2-0-pro`, so it carries that entry's video too instead
        // of the family row's image-only answer.
        'doubao-seed-2.0-pro (issue #4876)',
        IMAGE_VIDEO,
        'doubao-seed-2.0-pro',
      ],
      ['doubao-seed-1.6', IMAGE],
      ['doubao-1.5-vision-pro', IMAGE],
      ['doubao-vision', IMAGE],
    ]);

    casesFor('returns text-only for', [
      [
        'doubao-seedance (text→video generation model)',
        TEXT_ONLY,
        'doubao-seedance-1.0-pro',
      ],
      [
        'doubao-seedream (text→image generation model)',
        TEXT_ONLY,
        'doubao-seedream-3.0',
      ],
      ['doubao-pro-32k', TEXT_ONLY],
      ['doubao-lite-4k', TEXT_ONLY],
    ]);
  });

  describe('other open-weight vision models', () => {
    casesFor('returns image for', [
      ['llama3.2-vision (Ollama)', IMAGE, 'llama3.2-vision:11b'],
      [
        'Llama-3.2-11B-Vision-Instruct',
        IMAGE,
        'meta-llama/Llama-3.2-11B-Vision-Instruct',
      ],
      [
        'Llama-4-Scout-17B-16E-Instruct',
        IMAGE,
        'meta-llama/Llama-4-Scout-17B-16E-Instruct',
      ],
      ['llama4 (Ollama)', IMAGE, 'llama4:16x17b'],
      ['llava', IMAGE, 'llava:13b'],
      ['pixtral-12b', IMAGE],
      ['pixtral-large-latest', IMAGE],
      [
        'Mistral-Small-3.1-24B-Instruct',
        IMAGE,
        'mistralai/Mistral-Small-3.1-24B-Instruct-2503',
      ],
      ['mistral-small3.2 (Ollama)', IMAGE, 'mistral-small3.2:24b'],
    ]);

    casesFor('returns text-only for', [
      ['llama3.2 (text model)', TEXT_ONLY, 'llama3.2:3b'],
      ['llama3.1', TEXT_ONLY, 'llama3.1:8b'],
      [
        'Mistral Small 3 (text model)',
        TEXT_ONLY,
        'mistralai/Mistral-Small-24B-Instruct-2501',
      ],
    ]);
  });

  describe('unknown models', () => {
    it('returns text-only for unrecognized models', () => {
      expect(defaultModalities('some-random-model-xyz')).toEqual({});
    });
  });

  describe('normalization', () => {
    it('normalizes provider prefixes', () => {
      expect(defaultModalities('openai/gpt-4o')).toEqual(
        defaultModalities('gpt-4o'),
      );
    });

    it('returns a fresh copy each time', () => {
      const a = defaultModalities('gemini-2.5-pro');
      const b = defaultModalities('gemini-2.5-pro');
      expect(a).toEqual(b);
      expect(a).not.toBe(b);
    });
  });
});

describe('isQwenFamilyWireModel', () => {
  it('matches qwen* ids case-insensitively', () => {
    expect(isQwenFamilyWireModel('qwen3.8-max')).toBe(true);
    expect(isQwenFamilyWireModel('Qwen3.7-Max')).toBe(true);
    expect(isQwenFamilyWireModel('qwen-vl-max')).toBe(true);
  });

  it('matches the coder-model QWEN_OAUTH default', () => {
    expect(isQwenFamilyWireModel('coder-model')).toBe(true);
  });

  it('rejects non-qwen ids and empty input', () => {
    expect(isQwenFamilyWireModel('glm-5.2')).toBe(false);
    expect(isQwenFamilyWireModel('kimi-k2.6')).toBe(false);
    expect(isQwenFamilyWireModel('')).toBe(false);
    expect(isQwenFamilyWireModel(undefined)).toBe(false);
  });
});

describe('isTieredEffortWireModel', () => {
  it('matches the qwen3.8-max family including snapshots and aliases', () => {
    expect(isTieredEffortWireModel('qwen3.8-max')).toBe(true);
    expect(isTieredEffortWireModel('qwen3.8-max-preview')).toBe(true);
    expect(isTieredEffortWireModel('qwen3.8-max-2026-01-15')).toBe(true);
    expect(isTieredEffortWireModel('qwen3.8-max-latest')).toBe(true);
    expect(isTieredEffortWireModel('Qwen3.8-Max')).toBe(true);
  });

  it('matches the invite-series and qwen4 prefixes case-insensitively', () => {
    expect(isTieredEffortWireModel('qwen-latest-series-invite-202610-m6')).toBe(
      true,
    );
    expect(isTieredEffortWireModel('QWEN-LATEST-SERIES-INVITE-x')).toBe(true);
    expect(isTieredEffortWireModel('qwen4')).toBe(true);
    expect(isTieredEffortWireModel('qwen4-plus')).toBe(true);
    expect(isTieredEffortWireModel('Qwen4-Max-2026-10-01')).toBe(true);
  });

  it('rejects other qwen models and non-qwen ids', () => {
    expect(isTieredEffortWireModel('qwen3.7-max')).toBe(false);
    expect(isTieredEffortWireModel('qwen3.9-max')).toBe(false);
    expect(isTieredEffortWireModel('qwen-latest-series-other')).toBe(false);
    expect(isTieredEffortWireModel('company-qwen4')).toBe(false);
    expect(isTieredEffortWireModel('coder-model')).toBe(false);
    expect(isTieredEffortWireModel('glm-5.2')).toBe(false);
    expect(isTieredEffortWireModel(undefined)).toBe(false);
  });

  it('keeps a configured toggle-only protocol ahead of the new prefixes', () => {
    expect(
      isTieredEffortWireModel('qwen-latest-series-invite-202610-m6', {
        thinking: true,
        toggleOnly: true,
        disableField: 'enable_thinking',
      }),
    ).toBe(false);
    expect(
      isTieredEffortWireModel('qwen4-plus', {
        thinking: true,
        efforts: ['low', 'high'],
        defaultEffort: 'high',
        disableField: 'reasoning_effort',
      }),
    ).toBe(true);
  });
});
