/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { SessionAttachmentStore } from './sessionAttachments.js';
import { makeBridge, makeChannel, WS_A } from './internal/testUtils.js';

const link = {
  title: 'Requirements',
  locator: { type: 'url' as const, url: 'https://example.com/spec#part' },
};

describe('session source bridge', () => {
  it('never sends an attachment mutation to a replaced owner after the existence check', async () => {
    const handles: Array<ReturnType<typeof makeChannel>> = [];
    const bridge = makeBridge({
      channelFactory: async () => {
        const handle = makeChannel();
        handles.push(handle);
        return handle.channel;
      },
    });
    const original = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    let release!: (
      value: Awaited<ReturnType<SessionAttachmentStore['list']>>,
    ) => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const list = vi
      .spyOn(SessionAttachmentStore.prototype, 'list')
      .mockImplementationOnce(() => {
        started();
        return new Promise((resolve) => {
          release = resolve;
        });
      });
    try {
      const mutation = bridge.upsertSessionSource(
        original.sessionId,
        {
          title: 'Old attachment',
          locator: { type: 'attachment', attachmentId: 'original.txt' },
        },
        { clientId: original.clientId },
      );
      const rejected = mutation.catch((error: unknown) => error);
      await waiting;
      await bridge.closeSession(original.sessionId, {
        clientId: original.clientId,
      });
      const replacement = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(replacement.sessionId).toBe(original.sessionId);
      release([
        {
          type: 'resource',
          attachmentId: 'original.txt',
          mimeType: 'text/plain',
          size: 1,
        },
      ]);
      expect(await rejected).toMatchObject({ name: 'SessionNotFoundError' });
      expect(
        handles.some((handle) =>
          handle.agent.extMethodCalls.some(
            (call) => call.method === 'qwen/session/sources/upsert',
          ),
        ),
      ).toBe(false);
    } finally {
      list.mockRestore();
      await bridge.shutdown();
    }
  });

  it('maps private source errors without requiring raw-payload RPC errors', async () => {
    const handle = makeChannel({
      extMethodImpl: () => ({
        sourceError: {
          code: 'source_persistence_unavailable',
          message: 'Source metadata could not be persisted',
        },
      }),
    });
    const bridge = makeBridge({ channelFactory: async () => handle.channel });
    const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    try {
      await expect(
        bridge.upsertSessionSource(session.sessionId, link, {
          clientId: session.clientId,
        }),
      ).rejects.toMatchObject({
        code: 'source_persistence_unavailable',
        message: 'Source metadata could not be persisted',
      });
    } finally {
      await bridge.shutdown();
    }
  });

  it('forwards to the bound child and validates clients and attachment ownership first', async () => {
    const handle = makeChannel({
      extMethodImpl: (_method, params) => ({
        revision: 3,
        sources: [],
        input: params['input'],
      }),
    });
    const bridge = makeBridge({ channelFactory: async () => handle.channel });
    const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const context = { clientId: session.clientId };
    try {
      await expect(
        bridge.getSessionSources(session.sessionId, context),
      ).resolves.toMatchObject({ revision: 3 });
      await expect(
        bridge.upsertSessionSource(session.sessionId, link, context),
      ).resolves.toMatchObject({ input: link });
      await expect(
        bridge.removeSessionSource(session.sessionId, 'source-1', context),
      ).resolves.toMatchObject({ revision: 3 });
      const methods = handle.agent.extMethodCalls.filter((call) =>
        call.method.startsWith('qwen/session/sources/'),
      );
      expect(methods.map((call) => call.method)).toEqual([
        'qwen/session/sources/list',
        'qwen/session/sources/upsert',
        'qwen/session/sources/remove',
      ]);
      expect(
        methods.every((call) => call.params['sessionId'] === session.sessionId),
      ).toBe(true);
      await expect(
        bridge.upsertSessionSource(session.sessionId, link, {
          clientId: 'foreign',
        }),
      ).rejects.toMatchObject({ name: 'InvalidClientIdError' });
      await expect(
        bridge.upsertSessionSource(session.sessionId, link, {}),
      ).rejects.toMatchObject({ data: { errorKind: 'client_id_required' } });
      await expect(
        bridge.upsertSessionSource(
          session.sessionId,
          {
            title: 'Unknown',
            locator: { type: 'attachment', attachmentId: 'unknown.txt' },
          },
          context,
        ),
      ).rejects.toMatchObject({
        data: { errorKind: 'source_attachment_not_found' },
      });
      await expect(
        bridge.upsertSessionSource(
          session.sessionId,
          { ...link, extra: true } as typeof link,
          context,
        ),
      ).rejects.toMatchObject({ code: 'invalid_source' });
      expect(
        handle.agent.extMethodCalls.filter((call) =>
          call.method.startsWith('qwen/session/sources/'),
        ),
      ).toHaveLength(3);
    } finally {
      await bridge.shutdown();
    }
  });

  it('forwards accepted same-session attachment metadata without reading its contents', async () => {
    const handle = makeChannel({
      extMethodImpl: (_method, params) => ({
        revision: 1,
        input: params['input'],
      }),
    });
    const bridge = makeBridge({ channelFactory: async () => handle.channel });
    const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const context = { clientId: session.clientId };
    try {
      const attachment = await bridge.storeSessionAttachment(
        session.sessionId,
        Buffer.from('reference'),
        'text/plain',
        context,
        'reference.txt',
      );
      const input = {
        title: 'Reference',
        locator: {
          type: 'attachment' as const,
          attachmentId: attachment.attachmentId,
        },
      };
      await expect(
        bridge.upsertSessionSource(session.sessionId, input, context),
      ).resolves.toMatchObject({ input });
      expect(
        (await bridge.getSessionArtifacts(session.sessionId)).artifacts,
      ).toEqual([]);
    } finally {
      await bridge.shutdown();
    }
  });

  it('drops foreign and malformed child notifications and publishes a metadata invalidation', async () => {
    const handle = makeChannel();
    const bridge = makeBridge({ channelFactory: async () => handle.channel });
    const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    try {
      await handle.agentConnection.extNotification(
        'qwen/notify/session/sources-changed',
        { sessionId: 'foreign', revision: 1 },
      );
      await handle.agentConnection.extNotification(
        'qwen/notify/session/sources-changed',
        { sessionId: session.sessionId, revision: -1 },
      );
      await handle.agentConnection.extNotification(
        'qwen/notify/session/sources-changed',
        { sessionId: session.sessionId, revision: 2 },
      );
      // The following RPC waits behind the notifications on the same transport.
      await bridge.getSessionSources(session.sessionId);
      const sources = bridge
        .getSessionReplaySnapshot(session.sessionId)
        ?.liveJournal.filter((event) => event.type === 'source_changed');
      expect(sources).toHaveLength(1);
      expect(sources?.[0]?.data).toEqual({
        sessionId: session.sessionId,
        revision: 2,
      });
    } finally {
      await bridge.shutdown();
    }
  });
});
