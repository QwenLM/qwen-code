/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  SessionSourceService,
  restoreSessionSources,
  validateSessionSourceInput,
  type SessionSourcesSnapshot,
} from './session-sources.js';

const file = (workspacePath = 'docs/requirements.md') => ({
  title: 'Requirements',
  locator: { type: 'workspace_file', workspacePath },
});
const link = (url = 'https://example.com/doc#one') => ({
  title: 'Reference',
  locator: { type: 'url', url },
});

function fixture(sessionId = 'session', workspaceCwd = '/workspace') {
  let stored: SessionSourcesSnapshot | undefined;
  const persist = vi.fn(async (snapshot: SessionSourcesSnapshot) => {
    stored = structuredClone(snapshot);
  });
  const notify = vi.fn(async () => undefined);
  const load = vi.fn(async () => ({ sourcesSnapshot: stored }));
  const service = new SessionSourceService({
    sessionId,
    workspaceCwd: () => workspaceCwd,
    persist,
    notify,
    load,
  });
  const restart = () =>
    new SessionSourceService({
      sessionId,
      workspaceCwd: () => workspaceCwd,
      persist,
      notify,
      load,
    });
  return { service, persist, notify, load, restart };
}

describe('session sources', () => {
  it('normalizes relative files lexically and keeps distinct URL fragments', async () => {
    const { service, persist } = fixture();
    const first = await service.upsert(
      file('docs\\./draft/../requirements.md'),
    );
    const retry = await service.upsert(file());
    expect(retry).toEqual({
      revision: 1,
      source: first.source,
      change: 'unchanged',
    });
    expect(first.source).toMatchObject({
      workspaceCwd: '/workspace',
      locator: { workspacePath: 'docs/requirements.md' },
    });
    const one = await service.upsert(link());
    const two = await service.upsert(link('https://example.com/doc#two'));
    expect(one.source.id).not.toBe(two.source.id);
    expect(one.source).not.toHaveProperty('workspaceCwd');
    expect(persist).toHaveBeenCalledTimes(3);
  });

  it('preserves significant whitespace in workspace filenames', async () => {
    const { service } = fixture();
    const spaced = await service.upsert(file(' report.md '));
    const plain = await service.upsert(file('report.md'));
    expect(spaced.source.locator).toEqual({
      type: 'workspace_file',
      workspacePath: ' report.md ',
    });
    expect(spaced.source.id).not.toBe(plain.source.id);
  });

  it('keeps identity, creation time and order on metadata edits; omitted description preserves and empty clears', async () => {
    const { service } = fixture();
    const created = await service.upsert({ ...file(), description: 'Details' });
    const changed = await service.upsert({ ...file(), title: 'Updated' });
    expect(changed.source).toMatchObject({
      id: created.source.id,
      createdAt: created.source.createdAt,
      description: 'Details',
    });
    expect(changed.change).toBe('updated');
    const cleared = await service.upsert({
      ...file(),
      title: 'Updated',
      description: '',
    });
    expect(cleared.source.description).toBe('');
    expect(cleared.revision).toBe(3);
    expect((await service.upsert({ ...file(), title: 'Updated' })).change).toBe(
      'unchanged',
    );
  });

  it.each([
    { ...file(), extra: true },
    { ...file(), title: ' ' },
    { ...file(), title: 'a\nb' },
    file('/absolute'),
    file('C:\\absolute'),
    file('../../outside'),
    file('..'),
    file('a\0b'),
    link('file:///etc/passwd'),
    link('https://user:secret@example.com'),
    link('javascript:alert(1)'),
    {
      ...file(),
      locator: {
        type: 'workspace_file',
        workspacePath: 'a',
        url: 'https://example.com',
      },
    },
    { ...file(), locator: { type: 'attachment' } },
    { ...file(), title: 'x'.repeat(201) },
    { ...file(), description: 'x'.repeat(1001) },
    file('x'.repeat(501)),
    link(`https://example.com/${'x'.repeat(2048)}`),
  ])('rejects invalid metadata without persistence: %j', async (input) => {
    const { service, persist } = fixture();
    await expect(service.upsert(input)).rejects.toMatchObject({
      code: 'invalid_source',
    });
    expect(persist).not.toHaveBeenCalled();
  });

  it('serializes concurrent tool/client writes and limits creation without blocking updates', async () => {
    const { service, persist } = fixture();
    await Promise.all(
      Array.from({ length: 200 }, (_, n) => service.upsert(file(`file-${n}`))),
    );
    expect((await service.list()).revision).toBe(200);
    await expect(service.upsert(file('overflow'))).rejects.toMatchObject({
      code: 'source_limit_reached',
    });
    expect(
      (await service.upsert({ ...file('file-0'), title: 'Changed' })).revision,
    ).toBe(201);
    expect(persist).toHaveBeenCalledTimes(201);
  });

  it('publishes only after acknowledged persistence, then repairs an uncertain append before retry', async () => {
    const { service, persist, load, notify } = fixture();
    const first = await service.upsert(file());
    persist.mockRejectedValueOnce(new Error('disk failure'));
    await expect(service.remove(first.source.id)).rejects.toMatchObject({
      code: 'source_persistence_unavailable',
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(await service.list()).toEqual({
      revision: 1,
      sources: [first.source],
    });
    expect(load).toHaveBeenCalledTimes(2);
    expect(await service.remove(first.source.id)).toEqual({
      revision: 2,
      removed: true,
    });
  });

  it('recovers an acknowledged-unknown append before an idempotent retry', async () => {
    const { service, persist } = fixture();
    const write = persist.getMockImplementation()!;
    persist.mockImplementationOnce(async (snapshot) => {
      await write(snapshot);
      throw new Error('ack lost');
    });
    await expect(service.upsert(file())).rejects.toMatchObject({
      code: 'source_persistence_unavailable',
    });
    const retry = await service.upsert(file());
    expect(retry).toMatchObject({ revision: 1, change: 'unchanged' });
    expect(persist).toHaveBeenCalledOnce();
  });

  it('does not resurrect removed sources after restart or append duplicate delete snapshots', async () => {
    const { service, restart, persist } = fixture();
    const created = await service.upsert(file());
    await service.remove(created.source.id);
    expect(await restart().list()).toEqual({ revision: 2, sources: [] });
    expect(await service.remove(created.source.id)).toEqual({
      revision: 2,
      removed: false,
    });
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it('ignores notification delivery failure after a committed mutation', async () => {
    const { service, notify, restart } = fixture();
    notify.mockRejectedValueOnce(new Error('disconnected'));
    const result = await service.upsert(file());
    expect((await restart().list()).sources).toEqual([result.source]);
  });

  it('never restores an older snapshot when the last one is malformed or from a future version', async () => {
    const { service, persist } = fixture();
    await service.upsert(file());
    const record = {
      type: 'system',
      subtype: 'session_sources_snapshot',
      systemPayload: persist.mock.calls[0][0],
    };
    for (const systemPayload of [
      { version: 2, revision: 2, sources: [] },
      { version: 1, revision: 2, sources: [{}] },
    ]) {
      const state = restoreSessionSources(
        [record, { ...record, systemPayload }],
        'session',
      );
      expect(state).toEqual({ sourcesUnavailable: true });
      const unavailable = new SessionSourceService({
        sessionId: 'session',
        workspaceCwd: () => '/workspace',
        load: async () => state,
        persist,
      });
      await expect(unavailable.upsert(file())).rejects.toMatchObject({
        code: 'source_persistence_unavailable',
      });
    }
  });

  it('regenerates fork IDs, maps known attachment IDs, and omits cross-workspace references', async () => {
    const parent = fixture();
    const original = await parent.service.upsert(file());
    await parent.service.upsert(link());
    await parent.service.upsert({
      title: 'Uploaded',
      locator: { type: 'attachment', attachmentId: 'upload-1' },
    });
    const list = (await parent.service.list()).sources;
    const same = fixture('same');
    expect(await same.service.copyFrom(list, ['upload-1'])).toEqual({
      warnings: [],
    });
    const copied = (await same.service.list()).sources;
    expect(copied).toHaveLength(3);
    expect(
      copied.find((source) => source.title === original.source.title)?.id,
    ).not.toBe(original.source.id);
    const other = fixture('other', '/different');
    expect((await other.service.copyFrom(list, [])).warnings).toHaveLength(2);
    expect(
      (await other.service.list()).sources.map((source) => source.kind),
    ).toEqual(['link']);
  });

  it('does not expose mutable source records to callers', async () => {
    const { service } = fixture();
    const created = await service.upsert(file());
    created.source.title = 'tampered';
    const list = await service.list();
    list.sources.length = 0;
    expect((await service.list()).sources[0]?.title).toBe('Requirements');
  });

  it('validates attachments as metadata without file reads or URL fetches', () => {
    expect(
      validateSessionSourceInput({
        title: ' Attachment ',
        locator: { type: 'attachment', attachmentId: 'upload-1' },
      }),
    ).toEqual({
      title: 'Attachment',
      locator: { type: 'attachment', attachmentId: 'upload-1' },
    });
  });
});
