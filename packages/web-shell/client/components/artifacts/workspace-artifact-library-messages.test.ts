/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { getTranslator } from '../../i18n';
import {
  WORKSPACE_ARTIFACT_LIBRARY_MESSAGES_EN,
  WORKSPACE_ARTIFACT_LIBRARY_MESSAGES_RU,
  WORKSPACE_ARTIFACT_LIBRARY_MESSAGES_ZH,
} from './workspace-artifact-library-messages';
import * as transcriptStub from './workspace-artifact-library-messages.transcript-stub';

describe('workspace artifact library messages', () => {
  it('reach the app through the main dictionary, in every language', () => {
    expect(getTranslator('en')('workspaceArtifactLibrary.title')).toBe(
      'Artifacts',
    );
    expect(getTranslator('zh-CN')('workspaceArtifactLibrary.title')).toBe(
      '产物',
    );
    expect(getTranslator('ru')('workspaceArtifactLibrary.title')).toBe(
      'Артефакты',
    );
  });

  it('hold only workspace-artifact-library keys, translated one for one', () => {
    const en = Object.keys(WORKSPACE_ARTIFACT_LIBRARY_MESSAGES_EN);
    expect(en.length).toBeGreaterThan(0);
    expect(en.every((key) => key.startsWith('workspaceArtifactLibrary.'))).toBe(
      true,
    );
    expect(Object.keys(WORKSPACE_ARTIFACT_LIBRARY_MESSAGES_ZH).sort()).toEqual(
      [...en].sort(),
    );
    expect(Object.keys(WORKSPACE_ARTIFACT_LIBRARY_MESSAGES_RU).sort()).toEqual(
      [...en].sort(),
    );
  });

  it('are replaced by a stub of the same shape in the transcript build', () => {
    expect(Object.keys(transcriptStub).sort()).toEqual([
      'WORKSPACE_ARTIFACT_LIBRARY_MESSAGES_EN',
      'WORKSPACE_ARTIFACT_LIBRARY_MESSAGES_RU',
      'WORKSPACE_ARTIFACT_LIBRARY_MESSAGES_ZH',
    ]);
    expect(transcriptStub.WORKSPACE_ARTIFACT_LIBRARY_MESSAGES_EN).toEqual({});
    expect(transcriptStub.WORKSPACE_ARTIFACT_LIBRARY_MESSAGES_ZH).toEqual({});
    expect(transcriptStub.WORKSPACE_ARTIFACT_LIBRARY_MESSAGES_RU).toEqual({});
  });
});
