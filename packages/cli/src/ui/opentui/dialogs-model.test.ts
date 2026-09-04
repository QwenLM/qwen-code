/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Verifies the OpenTUI model dialog reproduces the original ink ModelDialog
 * display logic: modality formatting, API-key masking, context-window
 * formatting, the authType::modelId[\0baseUrl] selection keys, the dialog
 * title per mode/persist-scope, and the row label markers.
 */

import { describe, it, expect, vi } from 'vitest';

// theme.ts builds a SyntaxStyle at module scope, which needs the OpenTUI
// native FFI — unavailable in the test runtime. Stub the graphics surface.
vi.mock('@opentui/core', () => ({
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
}));

import {
  buildModelSelectionKey,
  computeModelDialogMaxItems,
  formatContextWindow,
  formatModalities,
  formatModelOptionLabel,
  maskApiKey,
  modelDialogTitle,
  parseModelSelectionKey,
  MAX_MODEL_ITEMS_TO_SHOW,
  type OpenTuiModelEntry,
} from './dialogs-model.js';

describe('formatModalities', () => {
  it('reports text-only when nothing is declared', () => {
    expect(formatModalities(undefined)).toBe('text-only');
    expect(formatModalities({})).toBe('text-only');
  });

  it('lists enabled input modalities after text', () => {
    expect(
      formatModalities({ image: true, pdf: true, audio: true, video: true }),
    ).toBe('text · image · pdf · audio · video');
    expect(formatModalities({ image: true })).toBe('text · image');
  });
});

describe('maskApiKey', () => {
  it('shows (not set) for missing/blank keys', () => {
    expect(maskApiKey(undefined)).toBe('(not set)');
    expect(maskApiKey('   ')).toBe('(not set)');
  });

  it('masks short keys completely', () => {
    expect(maskApiKey('abc123')).toBe('***');
  });

  it('keeps 3 head + 4 tail characters for long keys', () => {
    expect(maskApiKey('sk-abcdef123456')).toBe('sk-…3456');
  });
});

describe('formatContextWindow', () => {
  it('formats unknown and known sizes like the original', () => {
    expect(formatContextWindow(undefined)).toBe('(unknown)');
    expect(formatContextWindow(1048576)).toBe('1,048,576 tokens');
  });
});

describe('model selection keys', () => {
  it('round-trips authType and modelId', () => {
    const key = buildModelSelectionKey('use-openai', 'gpt-x');
    expect(parseModelSelectionKey(key)).toEqual({
      authType: 'use-openai',
      modelId: 'gpt-x',
    });
  });

  it('preserves baseUrl through the \\0 separator', () => {
    const key = buildModelSelectionKey('use-openai', 'gpt-x', 'https://a');
    expect(parseModelSelectionKey(key)).toEqual({
      authType: 'use-openai',
      modelId: 'gpt-x',
      baseUrl: 'https://a',
    });
  });

  it('falls back to a bare id when no separator exists', () => {
    expect(parseModelSelectionKey('plain-id')).toEqual({
      authType: '',
      modelId: 'plain-id',
    });
  });
});

describe('modelDialogTitle', () => {
  it('uses the mode-specific title', () => {
    expect(modelDialogTitle('primary')).toBe('Select Model');
    expect(modelDialogTitle('fast')).toBe('Select Fast Model');
    expect(modelDialogTitle('voice')).toBe('Select Voice Model');
    expect(modelDialogTitle('vision')).toBe('Select Vision Model');
    expect(modelDialogTitle('compaction')).toBe('Select Compaction Model');
    expect(modelDialogTitle('image')).toBe('Select Image Model');
  });

  it('appends the persist-scope suffix', () => {
    expect(modelDialogTitle('primary', 'workspace')).toBe(
      'Select Model (this project)',
    );
    expect(modelDialogTitle('primary', 'user')).toBe('Select Model (global)');
  });
});

describe('formatModelOptionLabel', () => {
  const base: OpenTuiModelEntry = {
    key: 'k',
    value: 'use-openai::gpt-x',
    authType: 'use-openai',
    label: 'GPT X',
    modelId: 'gpt-x',
  };

  it('shows the authType tag, label, and model id suffix', () => {
    expect(formatModelOptionLabel(base)).toBe('[use-openai] GPT X (gpt-x)');
  });

  it('omits the id suffix when id equals the label', () => {
    expect(formatModelOptionLabel({ ...base, label: 'gpt-x' })).toBe(
      '[use-openai] gpt-x',
    );
  });

  it('marks runtime and discontinued rows', () => {
    expect(formatModelOptionLabel({ ...base, isRuntime: true })).toBe(
      '[use-openai] GPT X (gpt-x) (Runtime)',
    );
    expect(formatModelOptionLabel({ ...base, isQwenOAuth: true })).toBe(
      '[use-openai] GPT X (gpt-x) (Discontinued)',
    );
    // Runtime wins over the discontinued marker (original behavior).
    expect(
      formatModelOptionLabel({ ...base, isRuntime: true, isQwenOAuth: true }),
    ).toBe('[use-openai] GPT X (gpt-x) (Runtime)');
  });
});

describe('computeModelDialogMaxItems (availableTerminalHeight parity)', () => {
  it('uses the full window when no height is provided', () => {
    expect(computeModelDialogMaxItems(undefined, false, 0)).toBe(
      MAX_MODEL_ITEMS_TO_SHOW,
    );
  });

  it('caps the list so the detail panel and footer stay visible', () => {
    // 24-row terminal, no descriptions: (24 - 14 fixed) / 1 row = 10, but
    // never more than MAX_MODEL_ITEMS_TO_SHOW.
    expect(computeModelDialogMaxItems(24, false, 0)).toBeLessThanOrEqual(
      MAX_MODEL_ITEMS_TO_SHOW,
    );
    // Short terminal shrinks the window below the default.
    expect(computeModelDialogMaxItems(18, false, 0)).toBe(4);
  });

  it('counts two rows for entries with descriptions', () => {
    expect(computeModelDialogMaxItems(24, true, 0)).toBe(
      Math.floor((24 - 14) / 2),
    );
  });

  it('reserves rows for a visible error box', () => {
    expect(computeModelDialogMaxItems(24, false, 4)).toBe(
      Math.floor((24 - 14 - 4) / 1),
    );
  });

  it('never shows fewer than one row', () => {
    expect(computeModelDialogMaxItems(5, false, 0)).toBe(1);
    expect(computeModelDialogMaxItems(0, true, 10)).toBe(1);
  });
});
