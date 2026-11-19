/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { getTranslator } from '../../i18n';
import {
  ARTIFACT_LIBRARY_MESSAGES_EN,
  ARTIFACT_LIBRARY_MESSAGES_RU,
  ARTIFACT_LIBRARY_MESSAGES_ZH,
} from './managed-artifact-library-messages';
import * as transcriptStub from './managed-artifact-library-messages.transcript-stub';

describe('artifact library messages', () => {
  it('reach the app through the main dictionary, in every language', () => {
    expect(getTranslator('en')('managed.artifactLibrary.title')).toBe(
      'Artifact library',
    );
    expect(getTranslator('zh-CN')('managed.artifactLibrary.title')).toBe(
      '产物库',
    );
    expect(getTranslator('ru')('managed.artifactLibrary.title')).toBe(
      'Библиотека артефактов',
    );
  });

  it('hold only artifact-library keys, translated one for one', () => {
    const en = Object.keys(ARTIFACT_LIBRARY_MESSAGES_EN);
    expect(en.length).toBeGreaterThan(0);
    expect(en.every((key) => key.startsWith('managed.artifactLibrary.'))).toBe(
      true,
    );
    expect(Object.keys(ARTIFACT_LIBRARY_MESSAGES_ZH).sort()).toEqual(
      [...en].sort(),
    );
    expect(Object.keys(ARTIFACT_LIBRARY_MESSAGES_RU).sort()).toEqual(
      [...en].sort(),
    );
  });

  it('are replaced by a stub of the same shape in the transcript build', () => {
    expect(Object.keys(transcriptStub).sort()).toEqual([
      'ARTIFACT_LIBRARY_MESSAGES_EN',
      'ARTIFACT_LIBRARY_MESSAGES_RU',
      'ARTIFACT_LIBRARY_MESSAGES_ZH',
    ]);
    expect(transcriptStub.ARTIFACT_LIBRARY_MESSAGES_EN).toEqual({});
    expect(transcriptStub.ARTIFACT_LIBRARY_MESSAGES_ZH).toEqual({});
    expect(transcriptStub.ARTIFACT_LIBRARY_MESSAGES_RU).toEqual({});
  });
});
