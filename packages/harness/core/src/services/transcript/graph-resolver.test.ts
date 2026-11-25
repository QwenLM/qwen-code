/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { runTranscriptSteps } from './cooperative.js';
import { beginResumeRead } from './resume-read-budget.js';
import { describe, expect, it, vi } from 'vitest';
import type { TranscriptMessage } from '../../protocol/transcript/entry.js';
import {
  computeLeafUuids,
  resolveTranscriptChain,
  resolveTranscriptChainSteps,
  type TranscriptGraphView,
} from './graph-resolver.js';

function user(
  uuid: string,
  parentUuid: string | null,
  timestamp = `2026-08-04T00:00:0${uuid === 'old-user' ? '0' : '1'}.000Z`,
  isSidechain = false,
): TranscriptMessage {
  return {
    type: 'user',
    uuid,
    parentUuid,
    isSidechain,
    timestamp,
    cwd: '/workspace',
    sessionId: 'session-1',
    userType: 'external',
    version: '1.0.0',
    message: { role: 'user', content: uuid },
  };
}

function system(
  uuid: string,
  parentUuid: string | null,
  timestamp: string,
): TranscriptMessage {
  return {
    type: 'system',
    subtype: 'informational',
    content: uuid,
    level: 'info',
    isMeta: false,
    uuid,
    parentUuid,
    isSidechain: false,
    timestamp,
    cwd: '/workspace',
    sessionId: 'session-1',
    userType: 'external',
    version: '1.0.0',
  };
}

function incompleteAssistant(
  uuid: string,
  parentUuid: string | null,
  timestamp: string,
): TranscriptMessage {
  return {
    type: 'assistant',
    uuid,
    parentUuid,
    isSidechain: false,
    timestamp,
    cwd: '/workspace',
    sessionId: 'session-1',
    userType: 'external',
    version: '1.0.0',
    message: {
      type: 'message',
      role: 'assistant',
      stop_sequence: null,
      container: null,
      context_management: null,
      id: `${uuid}-message`,

      model: 'test-model',
      stop_reason: null,

      content: [],
    },
  };
}

function graphOf(...messages: TranscriptMessage[]): TranscriptGraphView {
  return {
    messagesByUuid: new Map(messages.map((message) => [message.uuid, message])),
    orderByUuid: new Map(
      messages.map((message, order) => [message.uuid, order]),
    ),
  };
}

describe('resolveTranscriptChain', () => {
  it('uses the default leaf only when no explicit leaf is provided', () => {
    const oldUser = user('old-user', null);
    const latestUser = user('latest-user', oldUser.uuid);
    const graph = graphOf(oldUser, latestUser);

    expect(resolveTranscriptChain(graph).leafUuid).toBe(latestUser.uuid);
    expect(resolveTranscriptChain(graph, oldUser.uuid).leafUuid).toBe(
      oldUser.uuid,
    );
  });

  it('treats an explicit null leaf as an empty active conversation', () => {
    const graph = graphOf(user('latest-user', null));

    expect(resolveTranscriptChain(graph, null)).toEqual({
      messages: [],
      diagnostics: [],
    });
  });

  it('rejects an explicit leaf UUID that is absent from a non-empty graph', () => {
    const graph = graphOf(user('latest-user', null));

    expect(() => resolveTranscriptChain(graph, 'missing')).toThrowError(
      expect.objectContaining({
        code: 'TRANSCRIPT_ACTIVE_LEAF_INVALID',
        leafUuid: 'missing',
      }),
    );
  });

  it('rejects an explicit leaf UUID when the graph is empty', () => {
    const graph = graphOf();

    expect(() => resolveTranscriptChain(graph, 'missing')).toThrowError(
      expect.objectContaining({ code: 'TRANSCRIPT_ACTIVE_LEAF_INVALID' }),
    );
    expect(resolveTranscriptChain(graph, null)).toEqual({
      messages: [],
      diagnostics: [],
    });
  });

  it('normalizes a system leaf to its user ancestor and retains its system descendants', () => {
    const root = user('root-user', null, '2026-08-04T00:00:00.000Z');
    const warning = system('warning', root.uuid, '2026-08-04T00:00:01.000Z');
    const duration = system(
      'duration',
      warning.uuid,
      '2026-08-04T00:00:02.000Z',
    );
    const graph = graphOf(root, warning, duration);

    expect(computeLeafUuids(graph)).toEqual(new Set([root.uuid]));
    expect(resolveTranscriptChain(graph, duration.uuid)).toMatchObject({
      leafUuid: root.uuid,
      messages: [root, warning, duration],
      diagnostics: [],
    });
  });

  it('falls back to a healthy conversation leaf when a system leaf has no user or assistant ancestor', () => {
    const healthy = user('healthy-user', null, '2026-08-04T00:00:00.000Z');
    const warning = system(
      'dangling-warning',
      'missing-parent',
      '2026-08-04T00:00:10.000Z',
    );
    const graph = graphOf(healthy, warning);

    expect(resolveTranscriptChain(graph, warning.uuid)).toMatchObject({
      leafUuid: healthy.uuid,
      messages: [healthy],
      diagnostics: [],
    });
  });

  it('does not expose a conversation parent through a terminal system branch', () => {
    const root = user('root-user', null, '2026-08-04T00:00:00.000Z');
    const incomplete = incompleteAssistant(
      'incomplete-assistant',
      root.uuid,
      '2026-08-04T00:00:01.000Z',
    );
    const warning = system('warning', root.uuid, '2026-08-04T00:00:02.000Z');
    const graph = graphOf(root, incomplete, warning);

    expect(computeLeafUuids(graph)).toEqual(new Set([incomplete.uuid]));
    expect(resolveTranscriptChain(graph)).toMatchObject({
      leafUuid: incomplete.uuid,
      messages: [root, incomplete],
      diagnostics: [],
    });
  });

  it('recovers a missing parent from the nearest earlier message within five seconds', () => {
    const root = user('root-user', null, '2026-08-04T00:00:00.000Z');
    const orphan = user(
      'orphan-user',
      'missing-parent',
      '2026-08-04T00:00:04.000Z',
    );
    const graph = graphOf(root, orphan);

    expect(resolveTranscriptChain(graph, orphan.uuid)).toMatchObject({
      leafUuid: orphan.uuid,
      messages: [root, orphan],
      diagnostics: [],
    });
  });

  it('does not recover a missing parent outside the five-second window', () => {
    const root = user('root-user', null, '2026-08-04T00:00:00.000Z');
    const orphan = user(
      'orphan-user',
      'missing-parent',
      '2026-08-04T00:00:06.000Z',
    );
    const graph = graphOf(root, orphan);

    expect(resolveTranscriptChain(graph, orphan.uuid)).toMatchObject({
      leafUuid: orphan.uuid,
      messages: [orphan],
      diagnostics: [
        {
          kind: 'broken-chain',
          uuid: orphan.uuid,
          parentUuid: 'missing-parent',
        },
      ],
    });
  });

  it('does not cross the sidechain boundary during timestamp recovery', () => {
    const sidechainMessage = user(
      'sidechain-user',
      null,
      '2026-08-04T00:00:03.000Z',
      true,
    );
    const orphan = user(
      'orphan-user',
      'missing-parent',
      '2026-08-04T00:00:04.000Z',
    );
    const graph = graphOf(sidechainMessage, orphan);

    expect(resolveTranscriptChain(graph, orphan.uuid)).toMatchObject({
      messages: [orphan],
      diagnostics: [expect.objectContaining({ kind: 'broken-chain' })],
    });
  });
});

describe('shared non-conversation ancestry', () => {
  function sharedGraph(size: number) {
    const entries = [user('root', null)];
    for (let i = 0; i < size; i++)
      entries.push(
        system(
          `chain-${i}`,
          i ? `chain-${i - 1}` : 'root',
          '2026-08-04T00:00:01.000Z',
        ),
      );
    for (let i = 0; i < size; i++)
      entries.push(
        system(
          `terminal-${i}`,
          `chain-${size - 1}`,
          '2026-08-04T00:00:01.000Z',
        ),
      );
    return graphOf(...entries);
  }

  it('allows cancellation during graph derivation without publishing a chain', async () => {
    const graph = sharedGraph(1000);
    const controller = new AbortController();
    const get = graph.messagesByUuid.get.bind(graph.messagesByUuid);
    vi.spyOn(graph.messagesByUuid, 'get').mockImplementationOnce((uuid) => {
      setImmediate(() => controller.abort());
      return get(uuid);
    });
    const attempt = await beginResumeRead({ signal: controller.signal });
    try {
      await expect(
        runTranscriptSteps(resolveTranscriptChainSteps(graph), attempt),
      ).rejects.toMatchObject({ reason: 'cancelled' });
    } finally {
      attempt.finish();
      vi.restoreAllMocks();
    }
    const next = await beginResumeRead({ limits: { timeoutMs: 100 } });
    next.finish();
  });

  it('visits shared ancestors only once during leaf selection', () => {
    const graph = sharedGraph(200);
    const get = vi.spyOn(graph.messagesByUuid, 'get');
    expect([...computeLeafUuids(graph)]).toEqual(['root']);
    expect(get.mock.calls.length).toBeLessThan(1000);
  });
});
