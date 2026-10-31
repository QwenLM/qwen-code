import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileTeamsReferenceStore } from './reference-store.js';
import type { TeamsTarget } from './types.js';

describe('FileTeamsReferenceStore', () => {
  it('persists references across instances without using remote IDs as paths', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qwen-teams-references-'));
    try {
      const store = new FileTeamsReferenceStore(directory);
      expect(await store.get('missing')).toBeUndefined();
      const target: TeamsTarget = {
        chatId: 'chat',
        threadId: 'thread',
        reference: {
          channelId: 'msteams',
          conversation: { id: 'chat;messageid=thread' },
          serviceUrl: 'https://smba.trafficmanager.net/amer/',
        },
      };
      await store.set('../../outside', target);
      expect(
        await new FileTeamsReferenceStore(directory).get('../../outside'),
      ).toEqual(target);
      const files = await readdir(directory);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/);
      if (process.platform !== 'win32')
        expect((await stat(join(directory, files[0]))).mode & 0o777).toBe(
          0o600,
        );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
