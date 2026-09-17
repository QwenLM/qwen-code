import { describe, it, expect } from 'vitest';
import { asKnownDaemonEvent } from '../../src/daemon/events.js';
import { normalizeDaemonEvent } from '../../src/daemon/ui/normalizer.js';
import type { DaemonEvent } from '../../src/daemon/types.js';
const terminal = (extra: Record<string, unknown> = {}): DaemonEvent => ({
  id: 1,
  v: 1,
  type: 'session_closed',
  data: {
    sessionId: 'session',
    reason: 'client_close',
    cause: 'workspace_runtime_stop',
    persistenceUnconfirmed: true,
    exitCode: null,
    signalCode: 'SIGKILL',
    ...extra,
  },
});
describe('workspace runtime stop terminal events', () => {
  it('accepts a legitimate forced-stop event with nullable exit code', () => {
    const frame = terminal();
    expect(asKnownDaemonEvent(frame)).toBe(frame);
  });
  it.each([{ exitCode: 'none' }, { signalCode: 3 }])(
    'rejects malformed forced-stop exit fields %j',
    (extra) => {
      const frame = terminal(extra);
      expect(asKnownDaemonEvent(frame)).toBeUndefined();
    },
  );
  it('warns UI consumer when stopped session persistence is unconfirmed', () => {
    const events = normalizeDaemonEvent(terminal());
    const visible = events
      .map((event) => ('text' in event ? event.text : ''))
      .join(' ');
    expect(visible).toMatch(/persist|sav|record/i);
  });
});
