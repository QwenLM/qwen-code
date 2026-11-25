/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createTestI18nService } from '../../test-utils/i18n.js';

import { describe, expect, it } from 'vitest';
import {
  getModelProgressLabel,
  isModelProgressLabel,
  MODEL_PROGRESS_LABEL,
} from './modelProgress.js';

describe('modelProgress', () => {
  it('uses Generating while waiting for reasoning or text', () => {
    expect(getModelProgressLabel(null, createTestI18nService().get)).toBe(
      MODEL_PROGRESS_LABEL.generating,
    );
    expect(
      getModelProgressLabel(
        { subject: '', description: '  ' },
        createTestI18nService().get,
      ),
    ).toBe(MODEL_PROGRESS_LABEL.generating);
  });

  it('uses Thinking for non-empty reasoning without displaying its contents', () => {
    expect(
      getModelProgressLabel(
        { subject: '', description: 'Inspecting files' },
        createTestI18nService().get,
      ),
    ).toBe(MODEL_PROGRESS_LABEL.thinking);
    expect(
      getModelProgressLabel(
        { subject: 'Inspecting files', description: '' },
        createTestI18nService().get,
      ),
    ).toBe(MODEL_PROGRESS_LABEL.thinking);
  });

  it('recognizes both fixed model progress labels', () => {
    expect(
      isModelProgressLabel(
        MODEL_PROGRESS_LABEL.generating,
        createTestI18nService().get,
      ),
    ).toBe(true);
    expect(
      isModelProgressLabel(
        MODEL_PROGRESS_LABEL.thinking,
        createTestI18nService().get,
      ),
    ).toBe(true);
    expect(
      isModelProgressLabel('Loading commands...', createTestI18nService().get),
    ).toBe(false);
  });

  it('localizes fixed model progress labels without exposing thought text', () => {
    expect(
      getModelProgressLabel(null, createTestI18nService('zh-CN').get),
    ).toBe('正在生成...');
    expect(
      getModelProgressLabel(
        { subject: 'Internal subject', description: 'Internal detail' },
        createTestI18nService('zh-CN').get,
      ),
    ).toBe('正在思考...');
    expect(
      isModelProgressLabel('正在生成...', createTestI18nService('zh-CN').get),
    ).toBe(true);
    expect(
      isModelProgressLabel('正在思考...', createTestI18nService('zh-CN').get),
    ).toBe(true);
  });
});
