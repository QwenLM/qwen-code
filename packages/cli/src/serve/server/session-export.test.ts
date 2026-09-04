/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SESSION_TRANSCRIPT_MAX_INDEX_BYTES,
  SessionService,
  type ResumedSessionData,
} from '@qwen-code/qwen-code-core';
import {
  collectSessionData,
  generateExportFilename,
  normalizeSessionData,
  toHtml,
  toJson,
  toJsonl,
  toMarkdown,
} from '../../ui/utils/export/index.js';
import { exportSessionTranscript } from './session-export.js';

vi.mock('../../ui/utils/export/index.js', () => ({
  collectSessionData: vi.fn(),
  generateExportFilename: vi.fn(),
  normalizeSessionData: vi.fn(),
  toHtml: vi.fn(),
  toJson: vi.fn(),
  toJsonl: vi.fn(),
  toMarkdown: vi.fn(),
}));

const sessionId = '550e8400-e29b-41d4-a716-446655440000';
const sessionData: ResumedSessionData = {
  conversation: {
    sessionId,
    projectHash: 'project-hash',
    startTime: '2025-01-01T00:00:00.000Z',
    lastUpdated: '2025-01-01T00:00:00.000Z',
    messages: [],
  },
  filePath: '/workspace/session.jsonl',
  lastCompletedUuid: null,
};

describe('exportSessionTranscript', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(collectSessionData).mockResolvedValue({
      sessionId,
      startTime: sessionData.conversation.startTime,
      messages: [],
    });
    vi.mocked(normalizeSessionData).mockImplementation((data) => data);
    vi.mocked(generateExportFilename).mockReturnValue('session.json');
    vi.mocked(toHtml).mockReturnValue('');
    vi.mocked(toJson).mockReturnValue('{}');
    vi.mocked(toJsonl).mockReturnValue('');
    vi.mocked(toMarkdown).mockReturnValue('');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads archived storage when archiveState is archived', async () => {
    const loadArchivedSession = vi
      .spyOn(SessionService.prototype, 'loadArchivedSession')
      .mockResolvedValue(sessionData);
    const loadSession = vi.spyOn(SessionService.prototype, 'loadSession');

    await exportSessionTranscript({
      workspaceCwd: '/workspace',
      sessionId,
      format: 'json',
      archiveState: 'archived',
    });

    expect(loadArchivedSession).toHaveBeenCalledWith(sessionId, {
      maxBytes: SESSION_TRANSCRIPT_MAX_INDEX_BYTES,
    });
    expect(loadSession).not.toHaveBeenCalled();
  });

  it('loads active storage when archiveState is omitted', async () => {
    const loadArchivedSession = vi.spyOn(
      SessionService.prototype,
      'loadArchivedSession',
    );
    const loadSession = vi
      .spyOn(SessionService.prototype, 'loadSession')
      .mockResolvedValue(sessionData);

    await exportSessionTranscript({
      workspaceCwd: '/workspace',
      sessionId,
      format: 'json',
    });

    expect(loadSession).toHaveBeenCalledWith(sessionId);
    expect(loadArchivedSession).not.toHaveBeenCalled();
  });
});
