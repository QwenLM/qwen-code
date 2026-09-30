/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { GenerateContentResponse } from '@google/genai';
import { describe, expect, it } from 'vitest';
import {
  getToolCallPreparations,
  setToolCallPreparations,
} from './tool-call-preparation.js';

describe('tool-call preparation metadata', () => {
  it('attaches metadata without adding enumerable response fields', () => {
    const response = new GenerateContentResponse();
    const preparations = [{ callId: 'call-1', toolName: 'read_file' }];

    setToolCallPreparations(response, preparations);

    expect(getToolCallPreparations(response)).toEqual(preparations);
    expect(JSON.stringify(response)).not.toContain('toolCallPreparations');
  });

  it('returns an empty list when no metadata is attached', () => {
    expect(getToolCallPreparations(new GenerateContentResponse())).toEqual([]);
  });

  it('clears attached metadata when set to an empty list', () => {
    const response = new GenerateContentResponse();
    setToolCallPreparations(response, [
      { callId: 'call-1', toolName: 'read_file' },
    ]);

    setToolCallPreparations(response, []);

    expect(getToolCallPreparations(response)).toEqual([]);
  });
});
