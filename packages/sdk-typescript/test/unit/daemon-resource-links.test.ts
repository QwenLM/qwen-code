/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { DaemonEvent } from '../../src/daemon/types.js';
import {
  createDaemonTranscriptState,
  estimateDaemonTranscriptBlockBytes,
  reduceDaemonTranscriptEvents,
} from '../../src/daemon/ui/transcript.js';
import { normalizeDaemonEvent } from '../../src/daemon/ui/normalizer.js';
import { createDaemonTranscriptStore } from '../../src/daemon/ui/store.js';
import {
  daemonUiEventToTerminalText,
  transcriptBlockToTerminalText,
} from '../../src/daemon/ui/terminal.js';
import { projectChatRecordsToDaemonTranscript } from '../../src/daemon/transcript.js';
import type {
  DaemonResourceLink,
  DaemonUiUserResourceLinkEvent,
} from '../../src/daemon/index.js';

function link(uri = 'transit://attachment-1'): DaemonResourceLink {
  return {
    type: 'resource_link',
    uri,
    name: 'report.pdf',
    mimeType: 'application/pdf',
    size: 123,
    description: 'Quarterly results',
    title: 'Quarterly report',
    annotations: {
      audience: ['user', 'assistant'],
      lastModified: '2026-09-17T00:00:00Z',
      priority: 0.5,
      _meta: { labels: ['report'] },
    },
    _meta: { owner: { label: 'attachments' } },
  };
}

function linkEvent(
  resourceLink: DaemonResourceLink = link(),
  identity: Partial<DaemonUiUserResourceLinkEvent> = {},
): DaemonUiUserResourceLinkEvent {
  return { type: 'user.resource_link.delta', resourceLink, ...identity };
}

function frame(content: unknown): DaemonEvent {
  return {
    v: 1,
    id: 10,
    type: 'session_update',
    promptId: 'prompt-1',
    originatorClientId: 'client-1',
    data: {
      update: {
        sessionUpdate: 'user_message_chunk',
        content,
        _meta: { source: 'user', routing: 'update-only' },
      },
    },
  };
}

describe('daemon user resource links', () => {
  it.each([
    'transit://attachment-1',
    'https://example.com/report.pdf',
    'file:///tmp/report.pdf',
  ])('normalizes the original URI and all ACP metadata: %s', (uri) => {
    const resourceLink = link(uri);
    const [event] = normalizeDaemonEvent(frame(resourceLink));
    expect(event).toEqual({
      type: 'user.resource_link.delta',
      eventId: 10,
      promptId: 'prompt-1',
      originatorClientId: 'client-1',
      resourceLink,
      meta: { source: 'user', routing: 'update-only' },
    });
    expect(event).not.toHaveProperty('attachmentId');
    expect(event).not.toHaveProperty('data');
    expect(daemonUiEventToTerminalText(event!)).toBe('[file: report.pdf]');
  });

  it('preserves null ACP fields and applies own-echo suppression', () => {
    const resourceLink: DaemonResourceLink = {
      type: 'resource_link',
      uri: 'transit://attachment-1',
      name: 'report.pdf',
      mimeType: null,
      size: null,
      description: null,
      title: null,
      annotations: null,
      _meta: null,
    };
    expect(normalizeDaemonEvent(frame(resourceLink))[0]).toMatchObject({
      resourceLink,
    });
    expect(
      normalizeDaemonEvent(frame(resourceLink), {
        suppressOwnUserEcho: true,
        clientId: 'client-1',
      }),
    ).toEqual([]);
  });

  it('keeps native attachment references on their existing file event path', () => {
    expect(
      normalizeDaemonEvent(
        frame({
          type: 'resource',
          attachmentId: 'native-attachment',
          mimeType: 'application/pdf',
        }),
      )[0],
    ).toMatchObject({
      type: 'user.file.delta',
      attachmentId: 'native-attachment',
      name: 'native-attachment',
    });
  });

  it('restores persisted prompt identity and preserves envelope precedence', () => {
    const event = frame(link());
    event.data = {
      update: {
        sessionUpdate: 'user_message_chunk',
        content: link(),
        _meta: {
          promptId: 'persisted-prompt',
          qwenTranscript: {
            sourceRecordIds: ['user-record'],
            segmentId: 'user-record:1',
          },
        },
      },
    };
    expect(
      normalizeDaemonEvent({ ...event, promptId: undefined })[0],
    ).toMatchObject({
      promptId: 'persisted-prompt',
      sourceRecordIds: ['user-record'],
      segmentId: 'user-record:1',
    });
    expect(normalizeDaemonEvent(event)[0]).toMatchObject({
      promptId: 'prompt-1',
    });
  });

  it('keeps two same-name, different-URI links on one text message', () => {
    const links = [link(), link('https://example.com/report.pdf')];
    const state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      [
        { type: 'user.text.delta', text: 'Compare these', promptId: 'p1' },
        ...links.map((resourceLink) =>
          linkEvent(resourceLink, { promptId: 'p1' }),
        ),
      ],
      { now: 2 },
    );
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]).toMatchObject({
      kind: 'user',
      text: 'Compare these',
      promptId: 'p1',
      resourceLinks: links,
    });
    expect(state.retainedBytes).toBe(
      estimateDaemonTranscriptBlockBytes(state.blocks[0]!),
    );
    expect(transcriptBlockToTerminalText(state.blocks[0]!)).toContain(
      '[file: report.pdf]',
    );
  });

  it('separates adjacent attachment-only prompts and repeated URIs across turns', () => {
    const state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      [
        linkEvent(link(), { promptId: 'p1' }),
        linkEvent(link(), { promptId: 'p2' }),
        { type: 'assistant.text.delta', text: 'Read', promptId: 'p2' },
        { type: 'assistant.done', promptId: 'p2' },
        linkEvent(link(), { promptId: 'p3' }),
      ],
      { now: 2 },
    );
    const users = state.blocks.filter((block) => block.kind === 'user');
    expect(users.map((block) => block.promptId)).toEqual(['p1', 'p2', 'p3']);
    expect(users.map((block) => block.text)).toEqual(['', '', '']);
    expect(users.map((block) => block.resourceLinks)).toEqual([
      [link()],
      [link()],
      [link()],
    ]);
  });

  it('deduplicates echoes by URI, fills metadata, and leaves retained snapshots unchanged', () => {
    const original: DaemonResourceLink = {
      type: 'resource_link',
      uri: link().uri,
      name: 'report.pdf',
      mimeType: null,
      annotations: { audience: ['user'], priority: null },
      _meta: { retained: 'first' },
    };
    const first = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      [linkEvent(original, { promptId: 'p1' })],
      { now: 2 },
    );
    const incoming = link();
    const second = reduceDaemonTranscriptEvents(
      first,
      [
        linkEvent(incoming, { promptId: 'p1' }),
        linkEvent(incoming, { promptId: 'p1' }),
      ],
      { now: 3 },
    );
    expect(first.blocks[0]).toMatchObject({ resourceLinks: [original] });
    expect(second.blocks[0]).toMatchObject({
      resourceLinks: [
        {
          ...incoming,
          annotations: { ...incoming.annotations, audience: ['user'] },
          _meta: { ...incoming._meta, retained: 'first' },
        },
      ],
    });
    expect(second.retainedBytes).toBe(
      estimateDaemonTranscriptBlockBytes(second.blocks[0]!),
    );
    incoming.annotations!._meta!['labels'] = ['changed'];
    incoming._meta!['owner'] = 'changed';
    expect(second.blocks[0]).toMatchObject({
      resourceLinks: [
        {
          annotations: { _meta: { labels: ['report'] } },
          _meta: { owner: { label: 'attachments' } },
        },
      ],
    });
  });

  it('separates persisted record boundaries within a prompt and clones retained link metadata', () => {
    const initial = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      [linkEvent(link(), { promptId: 'p1', sourceRecordIds: ['record-1'] })],
      { now: 2 },
    );
    const appended = reduceDaemonTranscriptEvents(
      initial,
      [
        linkEvent(link('transit://attachment-2'), {
          promptId: 'p1',
          sourceRecordIds: ['record-1'],
        }),
      ],
      { now: 3 },
    );
    const block = appended.blocks[0]!;
    if (block.kind !== 'user') throw new Error('Expected user block');
    block.resourceLinks![0]!._meta!['owner'] = 'changed in the new snapshot';
    expect(initial.blocks[0]).toMatchObject({
      resourceLinks: [{ _meta: { owner: { label: 'attachments' } } }],
    });
    const separate = reduceDaemonTranscriptEvents(
      initial,
      [linkEvent(link(), { promptId: 'p1', sourceRecordIds: ['record-2'] })],
      { now: 3 },
    );
    expect(separate.blocks.map((block) => block.sourceRecordIds)).toEqual([
      ['record-1'],
      ['record-2'],
    ]);
  });

  it('backfills prompt identity without losing retention accounting', () => {
    const state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1 }),
      [
        { type: 'user.text.delta', text: 'Read this' },
        linkEvent(link(), { promptId: 'p1' }),
        linkEvent(link(), { promptId: 'p2' }),
      ],
      { now: 2 },
    );
    expect(state.blocks).toHaveLength(2);
    expect(state.blocks[0]).toMatchObject({
      text: 'Read this',
      promptId: 'p1',
    });
    expect(state.retainedBytes).toBe(
      state.blocks.reduce(
        (bytes, block) => bytes + estimateDaemonTranscriptBlockBytes(block),
        0,
      ),
    );
  });

  it('prunes attachment-only turns on rewind and clears resource links on reset', () => {
    const store = createDaemonTranscriptStore({ now: 1 });
    store.dispatch([
      linkEvent(link(), { promptId: 'p1' }),
      { type: 'assistant.text.delta', text: 'first reply', promptId: 'p1' },
      { type: 'assistant.done' },
      linkEvent(link('transit://attachment-2'), { promptId: 'p2' }),
    ]);
    store.dispatch({
      type: 'session.rewound',
      promptId: 'p2',
      targetTurnIndex: 1,
    });
    const rewound = store.getSnapshot();
    expect(rewound.blocks).toHaveLength(2);
    expect(rewound.blocks[0]).toMatchObject({ resourceLinks: [link()] });
    expect(rewound.retainedBytes).toBe(
      rewound.blocks.reduce(
        (bytes, block) => bytes + estimateDaemonTranscriptBlockBytes(block),
        0,
      ),
    );
    store.reset();
    expect(store.getSnapshot().blocks).toEqual([]);
    expect(store.getSnapshot().retainedBytes).toBe(0);
    store.dispatch(linkEvent(link(), { promptId: 'new-prompt' }));
    expect(store.getSnapshot().blocks[0]).toMatchObject({
      resourceLinks: [link()],
    });
  });

  it('counts large link metadata against the live retention budget', () => {
    const state = reduceDaemonTranscriptEvents(
      createDaemonTranscriptState({ now: 1, maxRetainedBytes: 8_000 }),
      [
        linkEvent(
          { ...link(), description: 'x'.repeat(5_000) },
          { promptId: 'p1' },
        ),
        { type: 'assistant.text.delta', text: 'Read' },
        { type: 'assistant.done' },
        linkEvent(link(), { promptId: 'p2' }),
      ],
      { now: 2 },
    );
    expect(state.blocks.some((block) => block.promptId === 'p1')).toBe(false);
    expect(state.retainedBytes).toBe(
      state.blocks.reduce(
        (bytes, block) => bytes + estimateDaemonTranscriptBlockBytes(block),
        0,
      ),
    );
  });
});

describe('persisted user resource-link projection', () => {
  it('restores text and attachment-only prompts on the active branch with their identities', () => {
    const firstLinks = [link(), link('https://example.com/report.pdf')];
    const record = (
      uuid: string,
      parentUuid: string | null,
      overrides: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      uuid,
      parentUuid,
      sessionId: 'session-1',
      timestamp: '2026-09-17T00:00:00.000Z',
      type: 'user',
      message: { role: 'user', parts: [] },
      ...overrides,
    });
    const records = [
      record('user-1', null, {
        daemonPromptId: 'p1',
        message: { role: 'user', parts: [{ text: 'Compare these' }] },
        systemPayload: { resourceLinks: firstLinks },
      }),
      record('abandoned-answer', 'user-1', {
        type: 'assistant',
        message: { role: 'model', parts: [{ text: 'old reply' }] },
      }),
      record('abandoned-user', 'abandoned-answer', {
        systemPayload: {
          resourceLinks: [link('transit://abandoned-attachment')],
        },
      }),
      record('active-answer', 'user-1', {
        type: 'assistant',
        message: { role: 'model', parts: [{ text: 'active reply' }] },
      }),
      record('user-2', 'active-answer', {
        daemonPromptId: 'p2',
        systemPayload: { resourceLinks: [link()] },
      }),
    ];
    const projection = projectChatRecordsToDaemonTranscript(records);
    expect(projection.complete).toBe(true);
    expect(projection.blocks).toHaveLength(3);
    expect(projection.blocks[0]).toMatchObject({
      kind: 'user',
      text: 'Compare these',
      sourceRecordIds: ['user-1'],
      promptId: 'p1',
      resourceLinks: firstLinks,
    });
    expect(projection.blocks[1]).toMatchObject({
      kind: 'assistant',
      text: 'active reply',
      sourceRecordIds: ['active-answer'],
    });
    expect(projection.blocks[2]).toMatchObject({
      kind: 'user',
      text: '',
      sourceRecordIds: ['user-2'],
      promptId: 'p2',
      resourceLinks: [link()],
    });
    expect(projectChatRecordsToDaemonTranscript(records)).toEqual(projection);
    expect(records[0]!.systemPayload).toEqual({ resourceLinks: firstLinks });
  });
});
