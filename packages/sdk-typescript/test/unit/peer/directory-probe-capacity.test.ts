import { describe, expect, it } from 'vitest';
import { reachableEntries } from '../../../src/peer/directory.js';
import type { SessionRecord } from '../../../src/peer/registry.js';

describe('peer discovery under a finite descriptor budget', () => {
  it('finds every live peer without exhausting the probe capacity', async () => {
    const records: SessionRecord[] = Array.from({ length: 80 }, (_, index) => ({
      schemaVersion: 1,
      pid: 100 + index,
      procStart: null,
      pidNs: null,
      sessionId: `session-${index}`,
      cwd: '/work',
      name: `peer-${index}`,
      startedAt: index,
      qwenVersion: null,
      ipcPath: `/tmp/peer-${index}.sock`,
    }));
    let inFlight = 0;
    const peers = await reachableEntries(records, async () => {
      // Descriptor exhaustion makes the real probe return unknown, even
      // though the peer is alive. Leave room for a realistic small budget.
      if (inFlight >= 32) return 'unknown';
      inFlight++;
      await new Promise<void>((resolve) => setImmediate(resolve));
      inFlight--;
      return 'alive';
    });

    expect(peers.map((peer) => peer.sessionId)).toEqual(
      records.map((record) => record.sessionId),
    );
    expect(inFlight).toBe(0);
  });
});
