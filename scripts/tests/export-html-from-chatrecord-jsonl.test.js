/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  looksLikeChatRecord,
  looksLikeExportJsonl,
  readJsonlObjects,
  renderHtmlFromObjects,
  selectChatRecords,
} from '../../integration-tests/concurrent-runner/export-html-from-chatrecord-jsonl.js';

const LEGACY_REJECTION =
  'Legacy exported JSONL cannot be rendered safely; provide source ChatRecord JSONL.';

function chatRecord(overrides = {}) {
  return {
    uuid: 'rec-1',
    parentUuid: null,
    sessionId: 'sess-1',
    timestamp: '2026-01-02T03:04:05.000Z',
    type: 'user',
    cwd: '/work',
    version: '0.1.0',
    ...overrides,
  };
}

function legacyMetadata(overrides = {}) {
  return {
    type: 'session_metadata',
    sessionId: 'sess-1',
    startTime: '2026-01-02T03:04:05.000Z',
    ...overrides,
  };
}

/** Stand-in for `@qwen-code/qwen-code/export`, which needs built CLI output. */
function stubExportApi() {
  return {
    collectSessionMetadata: vi.fn(async (conversation) => ({
      sessionId: conversation.sessionId,
      messageCount: conversation.messages.length,
    })),
    toHtml: vi.fn(() => '<html>rendered</html>'),
  };
}

const tempDirs = [];
function writeJsonl(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'chatrecord-jsonl-'));
  tempDirs.push(dir);
  const file = join(dir, 'input.jsonl');
  writeFileSync(file, lines.join('\n'), 'utf8');
  return file;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('selectChatRecords', () => {
  it('rejects legacy exported JSONL with the exact message', () => {
    // The behaviour this pins is a deliberate flip: legacy exports used to be
    // rendered through a separate path. Dropping the throw, or letting
    // looksLikeExportJsonl stop matching the legacy shape, must not pass
    // silently — that would put already-rendered markup back on the page
    // without the export API's document allowlist ever seeing it.
    expect(() => selectChatRecords([legacyMetadata()])).toThrow(
      LEGACY_REJECTION,
    );
  });

  it('rejects on the first line alone, even with real records behind it', () => {
    expect(() => selectChatRecords([legacyMetadata(), chatRecord()])).toThrow(
      LEGACY_REJECTION,
    );
  });

  it('accepts ChatRecords and drops entries that are not one', () => {
    const keep = chatRecord({ uuid: 'rec-keep' });
    const records = selectChatRecords([keep, { note: 'not a record' }]);

    expect(records).toEqual([keep]);
  });

  it('reports an empty input distinctly from an unrecognized one', () => {
    expect(() => selectChatRecords([])).toThrow('Input JSONL is empty.');
    expect(() => selectChatRecords([{ note: 'nope' }])).toThrow(
      'Unrecognized JSONL format (expected ChatRecord-per-line).',
    );
  });
});

describe('renderHtmlFromObjects', () => {
  it('renders the ChatRecord happy path through the export API', async () => {
    const api = stubExportApi();
    const records = [
      chatRecord({ uuid: 'rec-1', timestamp: '2026-01-02T03:04:05.000Z' }),
      chatRecord({ uuid: 'rec-2', timestamp: '2026-01-02T02:00:00.000Z' }),
    ];

    const html = await renderHtmlFromObjects(records, api);

    expect(html).toBe('<html>rendered</html>');
    // startTime is the earliest record, not the first one in file order.
    expect(api.collectSessionMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-1',
        startTime: '2026-01-02T02:00:00.000Z',
        messages: records,
      }),
      expect.anything(),
    );
    const [sessionData, passedRecords] = api.toHtml.mock.calls[0];
    expect(passedRecords).toEqual(records);
    expect(sessionData).toEqual(
      expect.objectContaining({
        sessionId: 'sess-1',
        messages: [],
        metadata: { sessionId: 'sess-1', messageCount: 2 },
      }),
    );
  });

  it('never reaches the renderer for legacy exported JSONL', async () => {
    const api = stubExportApi();

    await expect(
      renderHtmlFromObjects([legacyMetadata()], api),
    ).rejects.toThrow(LEGACY_REJECTION);
    expect(api.collectSessionMetadata).not.toHaveBeenCalled();
    expect(api.toHtml).not.toHaveBeenCalled();
  });
});

describe('looksLikeExportJsonl', () => {
  it('matches only the legacy metadata header shape', () => {
    expect(looksLikeExportJsonl([legacyMetadata()])).toBe(true);
    expect(looksLikeExportJsonl([chatRecord()])).toBe(false);
    expect(looksLikeExportJsonl([legacyMetadata({ type: 'user' })])).toBe(
      false,
    );
    expect(
      looksLikeExportJsonl([legacyMetadata({ startTime: undefined })]),
    ).toBe(false);
  });
});

describe('looksLikeChatRecord', () => {
  it('requires every field the renderer reads', () => {
    expect(looksLikeChatRecord(chatRecord())).toBe(true);
    expect(looksLikeChatRecord(null)).toBe(false);
    // parentUuid may be null, but the key has to be present.
    const { parentUuid: _dropped, ...withoutParent } = chatRecord();
    expect(looksLikeChatRecord(withoutParent)).toBe(false);
    expect(looksLikeChatRecord(chatRecord({ sessionId: 7 }))).toBe(false);
  });
});

describe('readJsonlObjects', () => {
  it('parses one object per line and skips blank lines', async () => {
    const file = writeJsonl([
      JSON.stringify(chatRecord({ uuid: 'rec-1' })),
      '',
      JSON.stringify(chatRecord({ uuid: 'rec-2' })),
      '',
    ]);

    const objects = await readJsonlObjects(file);

    expect(objects.map((o) => o.uuid)).toEqual(['rec-1', 'rec-2']);
  });

  it('names the offending line when JSON is invalid', async () => {
    const file = writeJsonl([JSON.stringify(chatRecord()), '{ not json']);

    await expect(readJsonlObjects(file)).rejects.toThrow(
      /Invalid JSONL line[\s\S]*\{ not json/,
    );
  });
});
