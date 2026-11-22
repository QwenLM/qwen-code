import { describe, expect, it, vi } from 'vitest';
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
    records.splice(10, 0, {
      ...records[0]!,
      sessionId: 'shared-inbox-session',
      name: 'shared-inbox-peer',
    });
    const firstPath = records[0]!.ipcPath!;
    const secondPath = records[1]!.ipcPath!;
    let releaseFirst!: () => void;
    const firstReady = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let inFlight = 0;
    let peak = 0;
    const completed: string[] = [];
    const probe = vi.fn(async (path: string) => {
      // Descriptor exhaustion makes the real probe return unknown, even
      // though the peer is alive. Leave room for a realistic small budget.
      if (inFlight >= 32) return 'unknown' as const;
      inFlight++;
      peak = Math.max(peak, inFlight);
      if (path === firstPath) await firstReady;
      else await new Promise<void>((resolve) => setImmediate(resolve));
      completed.push(path);
      inFlight--;
      return 'alive' as const;
    });
    const finding = reachableEntries(records, probe);
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseFirst();
    const peers = await finding;

    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(16);
    expect(completed.indexOf(secondPath)).toBeLessThan(
      completed.indexOf(firstPath),
    );
    expect(probe).toHaveBeenCalledTimes(
      new Set(records.map((record) => record.ipcPath)).size,
    );
    expect(
      probe.mock.calls.filter(([path]) => path === firstPath),
    ).toHaveLength(1);
    expect(peers.map((peer) => peer.sessionId)).toEqual(
      records.map((record) => record.sessionId),
    );
    expect(inFlight).toBe(0);
  });
});
