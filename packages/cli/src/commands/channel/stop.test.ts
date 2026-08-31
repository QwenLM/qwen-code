import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockReadServiceInfo = vi.hoisted(() => vi.fn());
const mockPeekServiceInfo = vi.hoisted(() => vi.fn());
const mockSignalService = vi.hoisted(() => vi.fn());
const mockWaitForExit = vi.hoisted(() => vi.fn());
const mockRemoveServiceInfo = vi.hoisted(() => vi.fn());
const mockClassifyProcessAccess = vi.hoisted(() => vi.fn());
const mockWriteStdoutLine = vi.hoisted(() => vi.fn());
const mockWriteStdoutLineBestEffort = vi.hoisted(() => vi.fn());
const mockWriteStderrLine = vi.hoisted(() => vi.fn());
const mockStopChannelWorker = vi.hoisted(() => vi.fn());
const mockDaemonClient = vi.hoisted(() =>
  vi.fn(() => ({ stopChannelWorker: mockStopChannelWorker })),
);
const mockChannelStateStoreSetMany = vi.hoisted(() => vi.fn());
const mockChannelStateStore = vi.hoisted(() =>
  vi.fn(() => ({
    readAll: vi.fn(() => ({})),
    set: vi.fn(),
    setMany: mockChannelStateStoreSetMany,
    // Mirror the real best-effort wrappers so throwing `set`/`setMany`
    // mocks still exercise "persistence failure never blocks a stop", and
    // report the persisted boolean so failure-path messages are testable.
    trySet: (name: string, state: 'active' | 'stopped') => {
      try {
        mockChannelStateStoreSetMany([name], state);
        return true;
      } catch {
        return false;
      }
    },
    trySetMany: (names: string[], state: 'active' | 'stopped') => {
      try {
        mockChannelStateStoreSetMany(names, state);
        return true;
      } catch {
        return false;
      }
    },
  })),
);
const mockChannelRuntimeStatePath = vi.hoisted(() =>
  // Argument-sensitive on purpose (mirrors start.test.ts): with a constant
  // mock, a split derivation (one call for the assertion, another for the
  // store) would coincide by accident and ship green — the two real
  // derivations are DIFFERENT files (`channels/channel-state.json` vs
  // `channels/standalone/<hash>/channel-state.json`) (#8975). The return
  // is derived FROM the argument (not collapsed to one constant for every
  // defined argument): the real helper hashes the workspace, so two
  // DIFFERENT defined arguments are two different files — a
  // defined-vs-defined split must fail the constructor-path pin (R9-17).
  vi.fn((cwd?: string) =>
    cwd === undefined
      ? '/tmp/qwen-home/channels/channel-state.json'
      : `/tmp/qwen-home/channels/standalone/${cwd}/channel-state.json`,
  ),
);

vi.mock('@qwen-code/sdk/daemon', () => ({ DaemonClient: mockDaemonClient }));

vi.mock('./pidfile.js', () => ({
  readServiceInfo: mockReadServiceInfo,
  peekServiceInfo: mockPeekServiceInfo,
  signalService: mockSignalService,
  waitForExit: mockWaitForExit,
  removeServiceInfo: mockRemoveServiceInfo,
  classifyProcessAccess: mockClassifyProcessAccess,
}));

vi.mock('./channel-state-store.js', () => ({
  ChannelStateStore: mockChannelStateStore,
  channelRuntimeStatePath: mockChannelRuntimeStatePath,
}));

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: mockWriteStdoutLine,
  // OWN mock, de-aliased from the loud sink (R12-3): with a shared mock,
  // swapping a best-effort diagnostic (the persistence-loss warnings) back
  // to the loud `writeStdoutLine` ships every pin green, while in
  // production a failing stdout target raises the async stdout 'error'
  // event and kills the stop mid-teardown. The EPIPE-crash resilience of
  // the real helper itself is pinned in stdioHelpers.test (R11-13).
  writeStdoutLineBestEffort: mockWriteStdoutLineBestEffort,
  writeStderrLine: mockWriteStderrLine,
}));

import { stopCommand } from './stop.js';

async function invokeStop(argv: Record<string, unknown> = {}): Promise<void> {
  const handler = stopCommand.handler;
  if (!handler) throw new Error('stop handler missing');
  await handler({ _: [], $0: 'qwen', ...argv } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  // The common case: the service runs as THIS user, so it is signalable.
  // The EPERM other-user branch (R12-48) overrides this to 'other-user',
  // the ESRCH-between-probes crash window (R14) to 'dead'.
  mockClassifyProcessAccess.mockReturnValue('signalable');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('stopCommand', () => {
  it('does not signal serve-owned channel workers', async () => {
    mockReadServiceInfo.mockReturnValue({
      owner: 'serve',
      pid: 1234,
      servePid: 1234,
      workerPid: 5678,
      startedAt: '2026-01-01T00:00:00.000Z',
      channels: ['telegram'],
    });
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    await expect(invokeStop()).rejects.toThrow('process.exit: 1');

    expect(mockSignalService).not.toHaveBeenCalled();
    expect(mockRemoveServiceInfo).not.toHaveBeenCalled();
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('managed by qwen serve'),
    );
    // A serve-owned pidfile carries no workspaceCwd; persisting on this path
    // would land serve's channel union in the legacy global file, which the
    // next standalone start in ANY workspace adopts (#8975).
    expect(mockChannelRuntimeStatePath).not.toHaveBeenCalled();
    expect(mockChannelStateStore).not.toHaveBeenCalled();
    expect(mockChannelStateStoreSetMany).not.toHaveBeenCalled();
  });

  it('refuses to stop a live service owned by another user and records nothing (R12-48)', async () => {
    // A shared HOME/QWEN_HOME where the service runs as user B: user A's
    // `kill(B_pid, 0)` raises EPERM. readServiceInfo must then RETURN the
    // info (EPERM proves the process ALIVE — only ESRCH proves death), and
    // stop must refuse without touching anything: signalling is impossible,
    // recording the RUNNING channels as stopped would durably corrupt a
    // service this command never touched, and the pidfile belongs to the
    // live process (#8975).
    mockReadServiceInfo.mockReturnValue({
      owner: 'channel',
      pid: 1234,
      startedAt: '2026-01-01T00:00:00.000Z',
      channels: ['telegram'],
      workspaceCwd: '/workspace/a',
    });
    mockClassifyProcessAccess.mockReturnValue('other-user');
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    await expect(invokeStop()).rejects.toThrow('process.exit: 1');

    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('running under a different user'),
    );
    // Classifier INPUT pin (R15-32): the probe must run against the
    // pidfile's pid — a type-safe `classifyProcessAccess(process.pid)`
    // compiles and ships green through every argument-insensitive stub,
    // while in production the self-probe always returns `signalable` and
    // the EPERM other-user refusal is skipped.
    expect(mockClassifyProcessAccess).toHaveBeenCalledWith(1234);
    // NO channel-state write — scoped or legacy: the crash-path record is
    // exactly what the pre-fix EPERM-as-dead misjudgment produced (#8975).
    expect(mockChannelRuntimeStatePath).not.toHaveBeenCalled();
    expect(mockChannelStateStore).not.toHaveBeenCalled();
    expect(mockChannelStateStoreSetMany).not.toHaveBeenCalled();
    // The pidfile belongs to the live process and must stay on disk.
    expect(mockRemoveServiceInfo).not.toHaveBeenCalled();
    // No signal may be sent to another user's process.
    expect(mockSignalService).not.toHaveBeenCalled();
  });

  it('records the crashed channels when the service dies between the liveness check and the signal probe (R14)', async () => {
    // readServiceInfo's liveness check kept the pidfile (the process was
    // alive), but the service crashed before the signal probe: ESRCH.
    // The old boolean guard collapsed ESRCH into the same `false` as
    // EPERM and misdiagnosed the dead pid as "running under a different
    // user" — exit 1 with the wrong message, no crash-path stop record,
    // and the stale pidfile left behind; a `set -e`/&& teardown then
    // aborts and the next bare start resurrects the channels. The dead
    // probe takes the crashed-service shape instead.
    mockReadServiceInfo.mockReturnValue({
      owner: 'channel',
      pid: 1234,
      startedAt: '2026-01-01T00:00:00.000Z',
      channels: ['telegram', 'feishu'],
      workspaceCwd: '/workspace/a',
    });
    mockClassifyProcessAccess.mockReturnValue('dead');
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    await expect(invokeStop()).rejects.toThrow('process.exit: 0');

    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining(
        'Recorded the crashed service channels as stopped',
      ),
    );
    expect(mockWriteStderrLine).not.toHaveBeenCalledWith(
      expect.stringContaining('running under a different user'),
    );
    // Classifier INPUT pin (R15-32): the dead probe must run against the
    // pidfile's pid, not the self process.
    expect(mockClassifyProcessAccess).toHaveBeenCalledWith(1234);
    // Scoped AND legacy writes, like every other explicit stop.
    expect(mockChannelStateStoreSetMany).toHaveBeenCalledWith(
      ['telegram', 'feishu'],
      'stopped',
    );
    expect(mockChannelStateStore).toHaveBeenCalledWith(
      '/tmp/qwen-home/channels/standalone//workspace/a/channel-state.json',
    );
    expect(mockChannelStateStore).toHaveBeenCalledWith(
      '/tmp/qwen-home/channels/channel-state.json',
    );
    // Write-COUNT pins, twin of the crashed-service test (R14-13).
    expect(mockChannelStateStore).toHaveBeenCalledTimes(2);
    expect(mockChannelStateStoreSetMany).toHaveBeenCalledTimes(2);
    // The dead process's pidfile is cleaned up.
    expect(mockRemoveServiceInfo).toHaveBeenCalled();
    // No signal was sent.
    expect(mockSignalService).not.toHaveBeenCalled();
    // Success path: no false persistence-loss notice on EITHER sink
    // (R12-3 doctrine, R14-30) — hoisting the loss write out of the
    // `!recorded` else would print a contradictory alarm on every
    // successful crash-window stop.
    expect(mockWriteStdoutLine).not.toHaveBeenCalledWith(
      expect.stringContaining('Could not record the crashed service channels'),
    );
    expect(mockWriteStdoutLineBestEffort).not.toHaveBeenCalledWith(
      expect.stringContaining('Could not record the crashed service channels'),
    );
  });

  it('does not record a serve-owned pidfile that dies between probes (R14-1)', async () => {
    // A serve-owned pidfile carries the daemon's channels and NO
    // workspaceCwd; recording them here would write the daemon's state
    // into the legacy GLOBAL standalone store — every later standalone
    // start adopts it and skips channels never stopped in standalone
    // mode. Mirror the crash path's owner gate: a stop in one mode must
    // not carry over to the other (#8975).
    mockReadServiceInfo.mockReturnValue({
      owner: 'serve',
      pid: 1234,
      startedAt: '2026-01-01T00:00:00.000Z',
      channels: ['telegram'],
      workspaceCwd: undefined,
    });
    mockClassifyProcessAccess.mockReturnValue('dead');
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    await expect(invokeStop()).rejects.toThrow('process.exit: 0');

    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'No channel service is running.',
    );
    // The misleading recorded-message must NOT print.
    expect(mockWriteStdoutLine).not.toHaveBeenCalledWith(
      expect.stringContaining(
        'Recorded the crashed service channels as stopped',
      ),
    );
    expect(mockChannelStateStoreSetMany).not.toHaveBeenCalled();
    // Sink-negative twin (R15-54): an arm-scoped hoist emitting the loss
    // alarm inside this bare-notice branch must fail — nothing was
    // recorded, so a resurrection warning would be false.
    expect(mockWriteStdoutLineBestEffort).not.toHaveBeenCalledWith(
      expect.stringContaining('Could not record the crashed service channels'),
    );
    // The stale serve pidfile is still cleaned up.
    expect(mockRemoveServiceInfo).toHaveBeenCalled();
    expect(mockSignalService).not.toHaveBeenCalled();
  });

  it('prints only the bare notice when a zero-channel service dies between probes (R14)', async () => {
    mockReadServiceInfo.mockReturnValue({
      owner: 'channel',
      pid: 1234,
      startedAt: '2026-01-01T00:00:00.000Z',
      channels: [],
      workspaceCwd: '/workspace/a',
    });
    mockClassifyProcessAccess.mockReturnValue('dead');
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    await expect(invokeStop()).rejects.toThrow('process.exit: 0');

    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'No channel service is running.',
    );
    expect(mockChannelStateStoreSetMany).not.toHaveBeenCalled();
    // Sink-negative twin (R15-54): nothing was recorded, so the loss
    // alarm must not print in this bare-notice arm.
    expect(mockWriteStdoutLineBestEffort).not.toHaveBeenCalledWith(
      expect.stringContaining('Could not record the crashed service channels'),
    );
    expect(mockRemoveServiceInfo).toHaveBeenCalled();
  });

  it('surfaces the loss when the window-crash record fails to persist (R14)', async () => {
    mockReadServiceInfo.mockReturnValue({
      owner: 'channel',
      pid: 1234,
      startedAt: '2026-01-01T00:00:00.000Z',
      channels: ['telegram'],
      workspaceCwd: '/workspace/a',
    });
    mockClassifyProcessAccess.mockReturnValue('dead');
    mockChannelStateStoreSetMany.mockImplementation(() => {
      throw new Error('disk full');
    });
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    await expect(invokeStop()).rejects.toThrow('process.exit: 0');

    // Loss notice on the best-effort sink, twin of the crashed-path
    // persistence-failure pin (R12-3).
    expect(mockWriteStdoutLineBestEffort).toHaveBeenCalledWith(
      expect.stringContaining('Could not record the crashed service channels'),
    );
    expect(mockWriteStdoutLine).not.toHaveBeenCalledWith(
      expect.stringContaining('Recorded the crashed service channels'),
    );
  });

  it('stops daemon-managed channels remotely without touching the pidfile', async () => {
    mockStopChannelWorker.mockResolvedValueOnce({ changed: true });
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await invokeStop({
      'daemon-url': 'http://daemon:9',
      token: 'secret',
      timeout: 75,
    });

    expect(mockDaemonClient).toHaveBeenCalledWith({
      baseUrl: 'http://daemon:9',
      token: 'secret',
    });
    expect(mockStopChannelWorker).toHaveBeenCalledWith({ timeoutMs: 75 });
    expect(mockReadServiceInfo).not.toHaveBeenCalled();
    // Full standalone-path negative set (R14-22): a daemon stop must
    // never peek/classify/signal/unlink the standalone pidfile — hoisting
    // standalone cleanup into shared code (the documented production
    // shape: shared HOME/QWEN_HOME, standalone service running while
    // `qwen channel stop --daemon-url …` runs) would orphan/corrupt a
    // service this command never owned. The readServiceInfo negative
    // alone does not catch it (probe-verified).
    expect(mockPeekServiceInfo).not.toHaveBeenCalled();
    expect(mockClassifyProcessAccess).not.toHaveBeenCalled();
    expect(mockSignalService).not.toHaveBeenCalled();
    expect(mockRemoveServiceInfo).not.toHaveBeenCalled();
    // Cross-mode state-store negatives (R15-31): a daemon stop must never
    // record into the standalone legacy GLOBAL store — injecting a
    // daemon-branch local persist (the natural "fix" for a missing
    // statePersisted) would make every later standalone `--channel all`
    // in ANY workspace skip channels never stopped in standalone mode
    // (the issue 8975 outage). The cross-mode siblings carry this full
    // triple; the daemon-success test must too.
    expect(mockChannelRuntimeStatePath).not.toHaveBeenCalled();
    expect(mockChannelStateStore).not.toHaveBeenCalled();
    expect(mockChannelStateStoreSetMany).not.toHaveBeenCalled();
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'Daemon-managed channels stopped.',
    );
    // Mirror-pin the ternary's other half (R9-22, R11-26): a refactor
    // rewriting the ternary into two writes must fail here.
    expect(mockWriteStdoutLine).not.toHaveBeenCalledWith(
      'Daemon-managed channels are already stopped.',
    );
    // The success message must precede the exit — under the no-op exit
    // mock, relocating it below process.exit(0) ships green while
    // production exits silently and the stopped-vs-already-stopped
    // distinction disappears (R10-19).
    const successCall = mockWriteStdoutLine.mock.calls.findIndex((args) =>
      String(args[0]).includes('Daemon-managed channels stopped.'),
    );
    expect(
      mockWriteStdoutLine.mock.invocationCallOrder[successCall],
    ).toBeLessThan(vi.mocked(process.exit).mock.invocationCallOrder[0]!);
    // A response WITHOUT statePersisted (e.g. a long-running pre-#8975
    // daemon) must not print the durability warning: only an explicit
    // `false` means the record was lost. Pin BOTH sinks (R12-3
    // doctrine): production emits the loss warning on the best-effort
    // sink, so a refactor emitting it alongside the success message
    // there must fail — the loud-sink negative alone does not catch it
    // (R14).
    expect(mockWriteStdoutLine).not.toHaveBeenCalledWith(
      expect.stringContaining('could not persist the stopped record'),
    );
    expect(mockWriteStdoutLineBestEffort).not.toHaveBeenCalledWith(
      expect.stringContaining('could not persist the stopped record'),
    );
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('reports when daemon-managed channels are already stopped', async () => {
    mockStopChannelWorker.mockResolvedValueOnce({ changed: false });
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await invokeStop({ 'daemon-url': 'http://daemon:9' });

    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'Daemon-managed channels are already stopped.',
    );
    // Mirror-pin the ternary's other half (R9-22, R11-26).
    expect(mockWriteStdoutLine).not.toHaveBeenCalledWith(
      'Daemon-managed channels stopped.',
    );
    // Negative twin of the changed:true loss-warning test (R12-34):
    // conditioning the warning on `!result.changed` would print a false
    // persistence-loss alarm on every repeated/idempotent stop — the
    // exact loss signal #8975 depends on, devalued (the R9-20 class).
    expect(mockWriteStdoutLine).not.toHaveBeenCalledWith(
      expect.stringContaining('could not persist the stopped record'),
    );
    expect(mockWriteStdoutLineBestEffort).not.toHaveBeenCalledWith(
      expect.stringContaining('could not persist the stopped record'),
    );
    expect(mockReadServiceInfo).not.toHaveBeenCalled();
    expect(mockPeekServiceInfo).not.toHaveBeenCalled();
    expect(mockClassifyProcessAccess).not.toHaveBeenCalled();
    expect(mockSignalService).not.toHaveBeenCalled();
    expect(mockRemoveServiceInfo).not.toHaveBeenCalled();
    // Cross-mode state-store isolation triple (R15-31, R16-48): the
    // daemon-success shape must never persist into the standalone legacy
    // GLOBAL store — a defensive local write here would make every later
    // standalone `--channel all` in ANY workspace skip channels never
    // stopped in standalone mode (the #8975 outage shape).
    expect(mockChannelRuntimeStatePath).not.toHaveBeenCalled();
    expect(mockChannelStateStore).not.toHaveBeenCalled();
    expect(mockChannelStateStoreSetMany).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(0);
    // Message-before-exit ordering, twin of the changed:true test
    // (R10-19).
    const messageCall = mockWriteStdoutLine.mock.calls.findIndex((args) =>
      String(args[0]).includes('Daemon-managed channels are already stopped.'),
    );
    expect(
      mockWriteStdoutLine.mock.invocationCallOrder[messageCall],
    ).toBeLessThan(vi.mocked(process.exit).mock.invocationCallOrder[0]!);
  });

  it('warns when the daemon stop record failed to persist (#8975)', async () => {
    // The route reports a successful stop whose `stopped` record did not
    // persist (ENOSPC/EACCES on the daemon channels dir). The CLI must
    // surface the loss like the standalone path does — printing an
    // unqualified success here resurrects the channels on the next
    // `--channel all` (#8975).
    mockStopChannelWorker.mockResolvedValueOnce({
      changed: true,
      statePersisted: false,
    });
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await invokeStop({ 'daemon-url': 'http://daemon:9' });

    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'Daemon-managed channels stopped.',
    );
    // Sink pin (R12-3): the loss warning rides the best-effort sink — a
    // warning write must not terminate the process when stdout is already
    // failing (the same failing-target condition that lost the record).
    expect(mockWriteStdoutLineBestEffort).toHaveBeenCalledWith(
      expect.stringContaining('could not persist the stopped record'),
    );
    // Mirror-pin the sink AND the stream (R9-22, R11-32, R12-3): the loss
    // warning is a best-effort stdout diagnostic; a refactor moving it to
    // the loud sink or to stderr must not ship green.
    expect(mockWriteStdoutLine).not.toHaveBeenCalledWith(
      expect.stringContaining('could not persist the stopped record'),
    );
    expect(mockWriteStderrLine).not.toHaveBeenCalledWith(
      expect.stringContaining('could not persist the stopped record'),
    );
    expect(mockReadServiceInfo).not.toHaveBeenCalled();
    expect(mockPeekServiceInfo).not.toHaveBeenCalled();
    expect(mockClassifyProcessAccess).not.toHaveBeenCalled();
    expect(mockSignalService).not.toHaveBeenCalled();
    expect(mockRemoveServiceInfo).not.toHaveBeenCalled();
    // Cross-mode state-store isolation triple (R15-31, R16-48): THIS is
    // the branch the triple was built to guard — the natural "fix" for a
    // missing statePersisted is a defensive local persist, which would
    // land the daemon-mode record in the standalone legacy GLOBAL store
    // (the #8975 outage shape).
    expect(mockChannelRuntimeStatePath).not.toHaveBeenCalled();
    expect(mockChannelStateStore).not.toHaveBeenCalled();
    expect(mockChannelStateStoreSetMany).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(0);
    // The no-op exit mock lets execution continue past process.exit, so it
    // cannot pin the ordering the production control flow depends on: the
    // warning must be surfaced BEFORE the exit — relocating it below
    // process.exit(...) would keep this test green while killing the
    // warning in production (#8975).
    const warningCall = mockWriteStdoutLineBestEffort.mock.calls.findIndex(
      (args) =>
        String(args[0]).includes('could not persist the stopped record'),
    );
    expect(warningCall).toBeGreaterThanOrEqual(0);
    expect(
      mockWriteStdoutLineBestEffort.mock.invocationCallOrder[warningCall],
    ).toBeLessThan(vi.mocked(process.exit).mock.invocationCallOrder[0]!);
  });

  it('warns when a failed daemon stop also lost the stopped record (#8975)', async () => {
    // The DELETE route reports a failed stop whose torn-down record ALSO
    // failed to persist via statePersisted: false on the DaemonHttpError
    // body. The CLI must surface the loss before exiting non-zero, or the
    // stopped channels resurrect on the next `--channel all` with no
    // trace (#8975).
    mockStopChannelWorker.mockRejectedValueOnce(
      Object.assign(new Error('stop failed'), {
        status: 500,
        body: { error: 'Stop failed', statePersisted: false },
      }),
    );
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await invokeStop({ 'daemon-url': 'http://daemon:9' });

    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('stop failed'),
    );
    // Pin the FIXED prefix too (R12-20): the variable tail is the mocked
    // rejection's own message; a regression altering or dropping the
    // daemon-managed-vs-standalone prefix ships green against the tail
    // alone.
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('Failed to stop daemon-managed channels: '),
    );
    // Sink pin (R12-3): the loss warning rides the best-effort sink.
    expect(mockWriteStdoutLineBestEffort).toHaveBeenCalledWith(
      expect.stringContaining('could not persist the stopped record'),
    );
    // Mirror-pin the sink AND the stream (R9-22, R11-32, R12-3): the
    // stop-failure diagnostic is the stderr half; the loss warning must
    // not ALSO land on stderr or on the loud stdout sink.
    expect(mockWriteStderrLine).not.toHaveBeenCalledWith(
      expect.stringContaining('could not persist the stopped record'),
    );
    expect(mockWriteStdoutLine).not.toHaveBeenCalledWith(
      expect.stringContaining('could not persist the stopped record'),
    );
    expect(mockReadServiceInfo).not.toHaveBeenCalled();
    expect(mockPeekServiceInfo).not.toHaveBeenCalled();
    expect(mockClassifyProcessAccess).not.toHaveBeenCalled();
    expect(mockSignalService).not.toHaveBeenCalled();
    expect(mockRemoveServiceInfo).not.toHaveBeenCalled();
    // Cross-mode state-store isolation triple (R15-31, R16-48): a failed
    // daemon stop with a lost record must not trigger a defensive local
    // persist into the standalone legacy GLOBAL store either.
    expect(mockChannelRuntimeStatePath).not.toHaveBeenCalled();
    expect(mockChannelStateStore).not.toHaveBeenCalled();
    expect(mockChannelStateStoreSetMany).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
    // Order pin as in the success branch: the warning must precede the
    // exit. A throwing exit mock is not usable here (the surrounding
    // daemon catch would re-exit 1), so assert invocationCallOrder with
    // the no-op mock instead (#8975).
    const warningCall = mockWriteStdoutLineBestEffort.mock.calls.findIndex(
      (args) =>
        String(args[0]).includes('could not persist the stopped record'),
    );
    expect(warningCall).toBeGreaterThanOrEqual(0);
    expect(
      mockWriteStdoutLineBestEffort.mock.invocationCallOrder[warningCall],
    ).toBeLessThan(vi.mocked(process.exit).mock.invocationCallOrder[0]!);
  });

  it('keeps a plain failed daemon stop quiet about persistence (#8975)', async () => {
    // No statePersisted on the error body (ordinary stop failure, or a
    // pre-#8975 daemon): the durability warning would be a false alarm.
    mockStopChannelWorker.mockRejectedValueOnce(new Error('stop failed'));
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await invokeStop({ 'daemon-url': 'http://daemon:9' });

    expect(mockWriteStdoutLine).not.toHaveBeenCalledWith(
      expect.stringContaining('could not persist the stopped record'),
    );
    // Sink twin (R12-3): the real warning sink is the best-effort one.
    expect(mockWriteStdoutLineBestEffort).not.toHaveBeenCalledWith(
      expect.stringContaining('could not persist the stopped record'),
    );

    // The realistic mixed-version rollout shape the gate comment names:
    // an error WITH a body object that LACKS statePersisted (a pre-#8975
    // daemon returns a structured error body without the field). This
    // passes the typeof object gate, so only the strict
    // `body['statePersisted'] === false` comparison keeps it quiet —
    // relaxing the gate to `statePersisted !== true` would print the
    // false warning on every failing stop against an older daemon
    // (R9-20).
    mockStopChannelWorker.mockRejectedValueOnce(
      Object.assign(new Error('stop failed'), {
        status: 500,
        body: { error: 'Stop failed' },
      }),
    );

    await invokeStop({ 'daemon-url': 'http://daemon:9' });

    expect(mockWriteStdoutLine).not.toHaveBeenCalledWith(
      expect.stringContaining('could not persist the stopped record'),
    );
    expect(mockWriteStdoutLineBestEffort).not.toHaveBeenCalledWith(
      expect.stringContaining('could not persist the stopped record'),
    );
    // Warning-silence is pinned above, but the EXIT CODE of the
    // body-duck-typing gate was not: a mutation letting the gate influence
    // the exit code (exit 0 when a body is present without
    // statePersisted) kept this test green while `set -e` / && teardown
    // chains treated a FAILED stop as successful — pin both failing stops
    // to exit 1 (R10-20).
    expect(vi.mocked(process.exit).mock.calls).toEqual([[1], [1]]);
    expect(mockReadServiceInfo).not.toHaveBeenCalled();
    expect(mockPeekServiceInfo).not.toHaveBeenCalled();
    expect(mockClassifyProcessAccess).not.toHaveBeenCalled();
    expect(mockSignalService).not.toHaveBeenCalled();
    expect(mockRemoveServiceInfo).not.toHaveBeenCalled();
    // Cross-mode state-store isolation triple (R15-31, R16-48): the
    // plain-failure shape (no statePersisted on the body) must stay
    // store-quiet too — the duck-type gate relaxation that would print
    // the false warning would also be the natural place to smuggle in a
    // defensive local persist.
    expect(mockChannelRuntimeStatePath).not.toHaveBeenCalled();
    expect(mockChannelStateStore).not.toHaveBeenCalled();
    expect(mockChannelStateStoreSetMany).not.toHaveBeenCalled();
  });

  it('reports remote stop failures without falling through to standalone mode', async () => {
    mockStopChannelWorker.mockRejectedValueOnce(new Error('stop failed'));
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await invokeStop({ 'daemon-url': 'http://daemon:9' });

    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('stop failed'),
    );
    // The FIXED prefix carries the daemon-managed-vs-standalone
    // distinction; only the tail is the variable part (R12-20).
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('Failed to stop daemon-managed channels: '),
    );
    expect(mockReadServiceInfo).not.toHaveBeenCalled();
    expect(mockPeekServiceInfo).not.toHaveBeenCalled();
    expect(mockClassifyProcessAccess).not.toHaveBeenCalled();
    expect(mockSignalService).not.toHaveBeenCalled();
    expect(mockRemoveServiceInfo).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
    // The stderr diagnostic must precede the exit — the no-op exit mock
    // lets execution continue, so relocating the write below
    // process.exit(1) ships green while every failing daemon stop exits
    // with ZERO diagnostic output in production (R10-19).
    const errCall = mockWriteStderrLine.mock.calls.findIndex((args) =>
      String(args[0]).includes('stop failed'),
    );
    expect(mockWriteStderrLine.mock.invocationCallOrder[errCall]).toBeLessThan(
      vi.mocked(process.exit).mock.invocationCallOrder[0]!,
    );
  });

  it('keeps a successful daemon stop successful when the success write throws (R14-3)', async () => {
    // Under the very disk condition that loses the state write
    // (statePersisted: false), stdout redirected to a file on the same
    // volume throws synchronously. While the loud success message shared
    // the SDK try, its ENOSPC converted a SUCCESSFUL stop into stderr
    // "Failed to stop daemon-managed channels…" + exit 1 — aborting
    // `set -e`/&& teardown chains — and the loss warning never fired
    // (the local write error has no `.body`). The success report runs
    // outside the SDK try; a post-stop write failure degrades to the
    // best-effort sink instead of flipping the exit code (#8975).
    mockStopChannelWorker.mockResolvedValueOnce({
      changed: true,
      statePersisted: false,
    });
    mockWriteStdoutLine.mockImplementationOnce(() => {
      const error = new Error('ENOSPC: no space left on device, write');
      (error as NodeJS.ErrnoException).code = 'ENOSPC';
      throw error;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await invokeStop({ 'daemon-url': 'http://daemon:9' });

    // The loud sink must be attempted EXACTLY once; degradation rides the
    // best-effort sink only. A retry of the loud success write inside the
    // catch consumes the one-shot throw mock and hits the default no-op —
    // every assertion below still passes — while in production the
    // persistent disk condition re-throws ENOSPC outside any try and a
    // successful daemon stop dies with an uncaught error (R16-37).
    expect(mockWriteStdoutLine).toHaveBeenCalledTimes(1);
    // The successful stop still exits 0 and is never laundered into the
    // failure diagnostic.
    expect(process.exit).toHaveBeenCalledWith(0);
    expect(mockWriteStderrLine).not.toHaveBeenCalledWith(
      expect.stringContaining('Failed to stop daemon-managed channels'),
    );
    // The success notice degrades to the best-effort sink…
    expect(mockWriteStdoutLineBestEffort).toHaveBeenCalledWith(
      'Daemon-managed channels stopped.',
    );
    // …and the loss warning still fires after it. Membership alone does
    // not pin that ordering — a refactor hoisting the loss warning above
    // the success notice would keep both assertions green while inverting
    // the user-visible output order on a failing disk. Pin the order via
    // invocationCallOrder, matching this file's convention (R15-4).
    expect(mockWriteStdoutLineBestEffort).toHaveBeenCalledWith(
      expect.stringContaining('could not persist the stopped record'),
    );
    const bestEffortCalls = mockWriteStdoutLineBestEffort.mock.calls;
    const successCall = bestEffortCalls.findIndex(
      (args) => args[0] === 'Daemon-managed channels stopped.',
    );
    const lossCall = bestEffortCalls.findIndex((args) =>
      String(args[0]).includes('could not persist the stopped record'),
    );
    expect(successCall).toBeGreaterThanOrEqual(0);
    expect(lossCall).toBeGreaterThan(successCall);
    expect(
      mockWriteStdoutLineBestEffort.mock.invocationCallOrder[successCall],
    ).toBeLessThan(
      mockWriteStdoutLineBestEffort.mock.invocationCallOrder[lossCall]!,
    );
  });

  it('records stopped channels so --channel all does not restart them', async () => {
    mockReadServiceInfo.mockReturnValue({
      owner: 'channel',
      pid: 1234,
      startedAt: '2026-01-01T00:00:00.000Z',
      channels: ['telegram', 'feishu'],
      workspaceCwd: '/workspace/a',
    });
    mockSignalService.mockReturnValue(true);
    mockWaitForExit.mockResolvedValue(true);
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await invokeStop();

    expect(mockChannelStateStoreSetMany).toHaveBeenCalledWith(
      ['telegram', 'feishu'],
      'stopped',
    );
    expect(mockSignalService).toHaveBeenCalledWith(1234, 'SIGTERM');
    // The clean SIGTERM path must clean up the pidfile too (R11-35):
    // only the SIGKILL and signal-failure branches pinned this call, yet
    // a stale pidfile left by the COMMON clean path sends the next stop
    // down the crashed-service branch against a normally-exited process.
    expect(mockRemoveServiceInfo).toHaveBeenCalled();
    expect(mockWriteStdoutLine).toHaveBeenCalledWith('Service stopped.');
    // The record persisted, so the exit message must be the durable-stop
    // guidance (the only user-visible way back out of the stopped state),
    // NOT the durability warning (#8975).
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('stay stopped'),
    );
    expect(mockWriteStdoutLine).not.toHaveBeenCalledWith(
      expect.stringContaining('could not persist the stopped record'),
    );
    // Sink twin (R12-3): the real warning sink is the best-effort one.
    expect(mockWriteStdoutLineBestEffort).not.toHaveBeenCalledWith(
      expect.stringContaining('could not persist the stopped record'),
    );
    // A semantically successful stop must exit 0: callers running `qwen
    // channel stop` under `set -e` or in && chains (CI teardown scripts)
    // abort on a non-zero exit exactly where the stop succeeded (R9-21).
    expect(process.exit).toHaveBeenCalledWith(0);
    // 'Service stopped.' is the only completion trace of a clean stop: it
    // must precede the exit, pinned exactly like its 'stay stopped'
    // sibling below — the no-op exit mock records a relocated-below-exit
    // write, which ships green while production exits silently (R12-21).
    const stoppedCall = mockWriteStdoutLine.mock.calls.findIndex((args) =>
      String(args[0]).includes('Service stopped.'),
    );
    expect(stoppedCall).toBeGreaterThanOrEqual(0);
    expect(
      mockWriteStdoutLine.mock.invocationCallOrder[stoppedCall],
    ).toBeLessThan(vi.mocked(process.exit).mock.invocationCallOrder[0]!);
    // The no-op exit mock lets execution continue past process.exit, so it
    // cannot pin ordering by itself: the final message must be emitted
    // BEFORE the exit — relocating the write below process.exit ships
    // green here while the message is silently dead in production, where
    // the process terminates first (R9-23).
    const finalMessageCall = mockWriteStdoutLine.mock.calls.findIndex((args) =>
      String(args[0]).includes('stay stopped'),
    );
    expect(
      mockWriteStdoutLine.mock.invocationCallOrder[finalMessageCall],
    ).toBeLessThan(vi.mocked(process.exit).mock.invocationCallOrder[0]!);
  });

  it('persists the stopped record before signalling the service (#8975)', async () => {
    mockReadServiceInfo.mockReturnValue({
      owner: 'channel',
      pid: 1234,
      startedAt: '2026-01-01T00:00:00.000Z',
      channels: ['telegram', 'feishu'],
      workspaceCwd: '/workspace/a',
    });
    mockSignalService.mockReturnValue(true);
    mockWaitForExit.mockResolvedValue(true);
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await invokeStop();

    // The ordering is load-bearing: if the service is signalled first,
    // anything interrupting the stop between signal and persist leaves it
    // dead without a `stopped` record, and the next `--channel all` start
    // resurrects the channels the user explicitly stopped.
    const persistedAt =
      mockChannelStateStoreSetMany.mock.invocationCallOrder[0];
    const signalledAt = mockSignalService.mock.invocationCallOrder[0];
    expect(persistedAt).toBeDefined();
    expect(signalledAt).toBeDefined();
    expect(persistedAt!).toBeLessThan(signalledAt!);
    // Pin the LAST write too (R11-33): the record is dual-written
    // (scoped + legacy, two calls guaranteed here since workspaceCwd is
    // set), and an interruption between SIGTERM and a deferred legacy
    // write leaves the service dead with only the scoped record — a
    // restart from another workspace resurrects every stopped channel.
    expect(
      mockChannelStateStoreSetMany.mock.invocationCallOrder.at(-1)!,
    ).toBeLessThan(signalledAt!);
  });

  it('scopes the stop record to the workspace from the pidfile (#8975)', async () => {
    mockReadServiceInfo.mockReturnValue({
      owner: 'channel',
      pid: 1234,
      startedAt: '2026-01-01T00:00:00.000Z',
      channels: ['telegram'],
      workspaceCwd: '/workspace/a',
    });
    mockSignalService.mockReturnValue(true);
    mockWaitForExit.mockResolvedValue(true);
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await invokeStop();

    expect(mockChannelRuntimeStatePath).toHaveBeenCalledWith('/workspace/a');
    // And the store is constructed with the path the helper returns for
    // the workspace form — a split here writes the stop to a different
    // file than start reads (#8975). The mock derives its return from the
    // argument, so a defined-vs-defined split fails this pin (R9-17).
    expect(mockChannelStateStore).toHaveBeenCalledWith(
      '/tmp/qwen-home/channels/standalone//workspace/a/channel-state.json',
    );
    // The service is a GLOBAL singleton: a restart from another workspace
    // reads that workspace's state file and would resurrect the channels.
    // The record must ALSO land in the legacy global file, which adoption
    // merges into every workspace on its next start (R10-33). The legacy
    // derivation is the ZERO-argument call form.
    expect(mockChannelRuntimeStatePath).toHaveBeenCalledWith();
    expect(mockChannelStateStore).toHaveBeenCalledWith(
      '/tmp/qwen-home/channels/channel-state.json',
    );
    expect(mockChannelStateStoreSetMany).toHaveBeenCalledTimes(2);
    // Per-call STATE pins (R11-42): every `toHaveBeenCalledWith(…,
    // 'stopped')` above is satisfied by the FIRST (scoped) write, so the
    // legacy write could persist any state and ship green — recording
    // 'active' in the legacy file resurrects exactly the stopped channels
    // on adoption. Pin both calls' state, per the file's NthCalledWith
    // convention.
    expect(mockChannelStateStoreSetMany).toHaveBeenNthCalledWith(
      1,
      ['telegram'],
      'stopped',
    );
    expect(mockChannelStateStoreSetMany).toHaveBeenNthCalledWith(
      2,
      ['telegram'],
      'stopped',
    );
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('persists the crashed service channels from a stale pidfile (#8975)', async () => {
    // The process died, so readServiceInfo unlinks the stale pidfile and
    // returns null; the peek captures the channels first, or the explicit
    // stop is lost and the next `--channel all` start resurrects them.
    mockPeekServiceInfo.mockReturnValue({
      owner: 'channel',
      pid: 1234,
      startedAt: '2026-01-01T00:00:00.000Z',
      channels: ['telegram', 'feishu'],
      workspaceCwd: '/workspace/a',
    });
    mockReadServiceInfo.mockReturnValue(null);
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await invokeStop();

    // The peek must run BEFORE readServiceInfo: the read unlinks a
    // crashed service's stale pidfile during its liveness check, so a
    // later peek would see no file and silently drop the stop record.
    expect(mockPeekServiceInfo.mock.invocationCallOrder[0]).toBeLessThan(
      mockReadServiceInfo.mock.invocationCallOrder[0]!,
    );
    expect(mockChannelRuntimeStatePath).toHaveBeenCalledWith('/workspace/a');
    // And the store is constructed with the path the helper returns for
    // the workspace form — a split here writes the stop to a different
    // file than start reads (#8975). The mock derives its return from the
    // argument, so a defined-vs-defined split fails this pin (R9-17).
    expect(mockChannelStateStore).toHaveBeenCalledWith(
      '/tmp/qwen-home/channels/standalone//workspace/a/channel-state.json',
    );
    expect(mockChannelStateStoreSetMany).toHaveBeenCalledWith(
      ['telegram', 'feishu'],
      'stopped',
    );
    // Cross-workspace twin of the live-stop pin: a crashed service's
    // channels must also land in the legacy global file, or a restart
    // from another workspace resurrects them (R10-33).
    expect(mockChannelStateStore).toHaveBeenCalledWith(
      '/tmp/qwen-home/channels/channel-state.json',
    );
    // Per-call STATE pins, twin of the live-path test (R11-42): the
    // legacy (second) write must persist 'stopped', not merely happen.
    expect(mockChannelStateStoreSetMany).toHaveBeenNthCalledWith(
      1,
      ['telegram', 'feishu'],
      'stopped',
    );
    expect(mockChannelStateStoreSetMany).toHaveBeenNthCalledWith(
      2,
      ['telegram', 'feishu'],
      'stopped',
    );
    // Write-COUNT pins (R14-13): NthCalledWith(1/2) is satisfied no matter
    // how many ADDITIONAL writes follow — a workspace-conditional
    // duplication of recordStoppedChannels ships green without them, and
    // every extra legacy write bumps the generation watermark by the
    // number of entries (applyChange), misreading the over-advance as a
    // re-stop rewrite on the next adoption (the R13-10 hazard).
    expect(mockChannelStateStore).toHaveBeenCalledTimes(2);
    expect(mockChannelStateStoreSetMany).toHaveBeenCalledTimes(2);
    expect(mockSignalService).not.toHaveBeenCalled();
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining(
        'Recorded the crashed service channels as stopped',
      ),
    );
    // Mirror-pin the ternary's other half (R9-22): a refactor emitting
    // BOTH messages when the record persisted must fail here, like its
    // failure-path twin below. Pin BOTH sinks (R12-3 doctrine): the
    // failure path emits the loss notice on the best-effort sink, so a
    // refactor emitting it there alongside the success message must fail
    // — the loud-sink negative alone does not catch it (R14).
    expect(mockWriteStdoutLine).not.toHaveBeenCalledWith(
      expect.stringContaining('Could not record the crashed service channels'),
    );
    expect(mockWriteStdoutLineBestEffort).not.toHaveBeenCalledWith(
      expect.stringContaining('Could not record the crashed service channels'),
    );
    // The crashed-service stop is semantically successful (the record was
    // persisted): exit 0 so `set -e` / && teardown chains do not abort
    // (R9-21).
    expect(process.exit).toHaveBeenCalledWith(0);
    // The crash-path message must be emitted BEFORE the exit — the
    // no-op exit mock cannot pin ordering by itself, and relocating the
    // write below process.exit(0) ships green while the diagnostic (the
    // only trace that the stops were recorded) is dead in production
    // (R10-19).
    const recordedCall = mockWriteStdoutLine.mock.calls.findIndex((args) =>
      String(args[0]).includes('Recorded the crashed service channels'),
    );
    expect(
      mockWriteStdoutLine.mock.invocationCallOrder[recordedCall],
    ).toBeLessThan(vi.mocked(process.exit).mock.invocationCallOrder[0]!);
  });

  it('reports when the crashed service stop record fails to persist (#8975)', async () => {
    mockPeekServiceInfo.mockReturnValue({
      owner: 'channel',
      pid: 1234,
      startedAt: '2026-01-01T00:00:00.000Z',
      channels: ['telegram'],
      workspaceCwd: '/workspace/a',
    });
    mockReadServiceInfo.mockReturnValue(null);
    mockChannelStateStoreSetMany.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await invokeStop();

    // The success message claims a durable stop; a swallowed write failure
    // must not print it, or the resurrection comes as a surprise (#8975).
    // Sink pin (R12-3): the loss notice rides the best-effort sink — it
    // fires exactly when the disk is failing.
    expect(mockWriteStdoutLineBestEffort).toHaveBeenCalledWith(
      expect.stringContaining('Could not record the crashed service channels'),
    );
    // Mirror-pin the ternary's other half like the live-path failure test:
    // a refactor emitting both messages on a lost record must fail here.
    expect(mockWriteStdoutLine).not.toHaveBeenCalledWith(
      expect.stringContaining('Recorded the crashed service channels'),
    );
    // Sink mirror (R12-3): the loss notice must not ALSO land on the loud
    // stdout sink.
    expect(mockWriteStdoutLine).not.toHaveBeenCalledWith(
      expect.stringContaining('Could not record the crashed service channels'),
    );
    // A lost record still exits 0: the service IS dead and the loss was
    // warned about — failing the exit aborts `set -e` teardown exactly
    // where the user was told what happened (R9-21).
    expect(process.exit).toHaveBeenCalledWith(0);
    // The SECOND (legacy) write is still ATTEMPTED when the first
    // (scoped) write fails (R14-31): a fail-fast
    // `if (!scoped) return scoped;` refactor of recordStoppedChannels
    // loses the legacy global record — the only record a restart from
    // ANOTHER workspace sees via adoption — and ships green without this
    // count pin (the message/exit pins above pass either way).
    expect(mockChannelStateStoreSetMany).toHaveBeenCalledTimes(2);
    // Partial-heal trace (doudouOUC S3): the scoped write failed but the
    // legacy write succeeded — adoption re-seeds the stop on the next
    // start, so the stop survives, but the silent heal must leave an
    // operator-visible trace of the failing scoped write path.
    expect(mockWriteStdoutLineBestEffort).toHaveBeenCalledWith(
      expect.stringContaining('recorded in the legacy global file'),
    );
    // Message-before-exit ordering, twin of the success-path pin: the
    // loss warning is the only trace that `--channel all` may resurrect
    // the channels (R10-19).
    const lossCall = mockWriteStdoutLineBestEffort.mock.calls.findIndex(
      (args) =>
        String(args[0]).includes(
          'Could not record the crashed service channels',
        ),
    );
    expect(
      mockWriteStdoutLineBestEffort.mock.invocationCallOrder[lossCall],
    ).toBeLessThan(vi.mocked(process.exit).mock.invocationCallOrder[0]!);
  });

  it('does not persist for a crashed serve-owned or empty pidfile (#8975)', async () => {
    mockPeekServiceInfo.mockReturnValue({
      owner: 'serve',
      pid: 1234,
      startedAt: '2026-01-01T00:00:00.000Z',
      channels: ['telegram'],
    });
    mockReadServiceInfo.mockReturnValue(null);
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await invokeStop();

    expect(mockChannelStateStoreSetMany).not.toHaveBeenCalled();
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'No channel service is running.',
    );
    expect(process.exit).toHaveBeenCalledWith(0);

    mockPeekServiceInfo.mockReturnValue(null);
    await invokeStop();

    expect(mockChannelStateStoreSetMany).not.toHaveBeenCalled();
    // Pin PER INVOCATION (R11-34): vi.clearAllMocks() runs only in
    // beforeEach, so the mock history accumulates across the two
    // invokeStop() calls — a bare `toHaveBeenCalledWith`/
    // `toHaveBeenCalledWith(0)` for the second subcase is already
    // satisfied by the FIRST. The empty-pidfile branch must exit 0 and
    // print its own diagnostic (the R9-21 doctrine in the most common
    // teardown shape).
    expect(vi.mocked(process.exit).mock.calls).toEqual([[0], [0]]);
    expect(mockWriteStdoutLine).toHaveBeenNthCalledWith(
      2,
      'No channel service is running.',
    );
    // Before-exit ordering pins for BOTH subcases (R16-31): under the
    // no-op exit mock, relocating the bare notice below process.exit(0)
    // ships green while production exits 0 with ZERO output — the only
    // new terminal message in this file that lacked the R9-23/R10-19/
    // R12-21 ordering pin. Each notice must precede ITS exit.
    const noticeCalls = mockWriteStdoutLine.mock.calls
      .map((args, index) => ({ args, index }))
      .filter(({ args }) => args[0] === 'No channel service is running.')
      .map(({ index }) => index);
    expect(noticeCalls).toHaveLength(2);
    expect(
      mockWriteStdoutLine.mock.invocationCallOrder[noticeCalls[0]],
    ).toBeLessThan(vi.mocked(process.exit).mock.invocationCallOrder[0]!);
    expect(
      mockWriteStdoutLine.mock.invocationCallOrder[noticeCalls[1]],
    ).toBeLessThan(vi.mocked(process.exit).mock.invocationCallOrder[1]!);
  });

  it('does not record a crashed zero-channel service as stopped (#8975)', async () => {
    // A zero-channel standalone service is a legitimate state this PR
    // introduces (serveWithoutChannels writes a `channels: []` pidfile);
    // when that process dies, stop must not claim it recorded stops for a
    // service that had no channels (#8975).
    mockPeekServiceInfo.mockReturnValue({
      owner: 'channel',
      pid: 1234,
      startedAt: '2026-01-01T00:00:00.000Z',
      channels: [],
      workspaceCwd: '/workspace/a',
    });
    mockReadServiceInfo.mockReturnValue(null);
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await invokeStop();

    expect(mockChannelStateStoreSetMany).not.toHaveBeenCalled();
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'No channel service is running.',
    );
    expect(process.exit).toHaveBeenCalledWith(0);
    // Before-exit ordering pin (R16-31): twin of the serve-owned/empty
    // pidfile test — the bare notice must precede the exit, or a
    // relocated-below-exit write ships green under the no-op exit mock
    // while production exits silently.
    const noticeCall = mockWriteStdoutLine.mock.calls.findIndex(
      (args) => args[0] === 'No channel service is running.',
    );
    expect(noticeCall).toBeGreaterThanOrEqual(0);
    expect(
      mockWriteStdoutLine.mock.invocationCallOrder[noticeCall],
    ).toBeLessThan(vi.mocked(process.exit).mock.invocationCallOrder[0]!);
  });

  it('stops a LIVE zero-channel service normally (#8975)', async () => {
    // The live twin of the crashed zero-channel test: serveWithoutChannels
    // writes a `channels: []` pidfile whenever `--channel all` finds
    // everything stopped, and that service is real — stop must signal it
    // and report success, not treat the empty channel list as "no
    // service" and leave the process alive (R10-47).
    mockReadServiceInfo.mockReturnValue({
      owner: 'channel',
      pid: 1234,
      startedAt: '2026-01-01T00:00:00.000Z',
      channels: [],
      workspaceCwd: '/workspace/a',
    });
    mockSignalService.mockReturnValue(true);
    mockWaitForExit.mockResolvedValue(true);
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await invokeStop();

    expect(mockSignalService).toHaveBeenCalledWith(1234, 'SIGTERM');
    expect(mockWriteStdoutLine).toHaveBeenCalledWith('Service stopped.');
    // The clean stop must ALWAYS clean up the pidfile, zero-channel shape
    // included (R16-49): gating removeServiceInfo on hadChannels (the
    // natural follow-up to the message gating in this same block) leaves
    // a dangling pidfile — the next start can be refused "already
    // running" under PID reuse, and the next stop is sent down the
    // crashed-service branch against a normally-exited process (the
    // regression the sibling clean-stop's R11-35 pin was written to
    // prevent). The SIGKILL and signal-failure tests carry this pin; this
    // test was the omission.
    expect(mockRemoveServiceInfo).toHaveBeenCalled();
    expect(mockWriteStdoutLine).not.toHaveBeenCalledWith(
      'No channel service is running.',
    );
    // Zero-channel stop records nothing and must NOT print the
    // durable-stop guidance (the crashed path's channels.length > 0
    // guard mirrored): the empty trySetMany no-ops return true, so the
    // unguarded guidance printed a 'stay stopped' promise with zero
    // recorded stops — a later bare start after adding config would
    // contradict it. Loss warning is equally inapplicable (R14).
    expect(mockChannelStateStoreSetMany).not.toHaveBeenCalled();
    expect(mockWriteStdoutLine).not.toHaveBeenCalledWith(
      expect.stringContaining('stay stopped'),
    );
    expect(mockWriteStdoutLineBestEffort).not.toHaveBeenCalledWith(
      expect.stringContaining('could not persist the stopped record'),
    );
    expect(process.exit).toHaveBeenCalledWith(0);
    // The completion message must precede the exit, twin of the clean
    // stop's pin: under the no-op exit mock a relocated-below-exit write
    // ships green while production exits silently (R12-21).
    const stoppedCall = mockWriteStdoutLine.mock.calls.findIndex((args) =>
      String(args[0]).includes('Service stopped.'),
    );
    expect(stoppedCall).toBeGreaterThanOrEqual(0);
    expect(
      mockWriteStdoutLine.mock.invocationCallOrder[stoppedCall],
    ).toBeLessThan(vi.mocked(process.exit).mock.invocationCallOrder[0]!);
  });

  it('falls back to the legacy global file for crashed older pidfiles (#8975)', async () => {
    // Crash-path twin of the live-path legacy test: pidfiles from older
    // releases carry no workspaceCwd, so the recorded stops must land in
    // the legacy global file, where the next start's adoption finds them.
    mockPeekServiceInfo.mockReturnValue({
      owner: 'channel',
      pid: 1234,
      startedAt: '2026-01-01T00:00:00.000Z',
      channels: ['telegram'],
    });
    mockReadServiceInfo.mockReturnValue(null);
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await invokeStop();

    expect(mockChannelRuntimeStatePath).toHaveBeenCalledWith(undefined);
    // And the store is constructed with the path the helper returns — a
    // split here writes the stop to a different file than start reads.
    expect(mockChannelStateStore).toHaveBeenCalledWith(
      '/tmp/qwen-home/channels/channel-state.json',
    );
    expect(mockChannelStateStoreSetMany).toHaveBeenCalledWith(
      ['telegram'],
      'stopped',
    );
    // Write-COUNT pin (R14): without a workspace the scoped path IS the
    // legacy file — dropping recordStoppedChannels' `!workspaceCwd`
    // guard double-writes it, advancing the legacy generation watermark
    // by 2 per stop and forging a rewrite signal that re-applies
    // snapshot-identical entries over an explicit restart (R9-3 in
    // reverse). The two-file tests pin call counts for exactly this
    // reason; the one-file case must too.
    expect(mockChannelStateStore).toHaveBeenCalledTimes(1);
    expect(mockChannelStateStoreSetMany).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('falls back to the legacy global state file for older pidfiles (#8975)', async () => {
    mockReadServiceInfo.mockReturnValue({
      owner: 'channel',
      pid: 1234,
      startedAt: '2026-01-01T00:00:00.000Z',
      channels: ['telegram'],
    });
    mockSignalService.mockReturnValue(true);
    mockWaitForExit.mockResolvedValue(true);
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await invokeStop();

    expect(mockChannelRuntimeStatePath).toHaveBeenCalledWith(undefined);
    // And the store is constructed with the path the helper returns — a
    // split here writes the stop to a different file than start reads.
    expect(mockChannelStateStore).toHaveBeenCalledWith(
      '/tmp/qwen-home/channels/channel-state.json',
    );
    // Path derivation alone is not the contract — the stopped record
    // must actually be WRITTEN, or the mixed-version case the fallback
    // exists for (a pre-#8975 service explicitly stopped) resurrects on
    // the next `--channel all` with nothing persisted (R10-46).
    expect(mockChannelStateStoreSetMany).toHaveBeenCalledWith(
      ['telegram'],
      'stopped',
    );
    // Write-COUNT pin, twin of the crashed-path legacy test (R14).
    expect(mockChannelStateStore).toHaveBeenCalledTimes(1);
    expect(mockChannelStateStoreSetMany).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('still stops the service when state persistence fails', async () => {
    mockReadServiceInfo.mockReturnValue({
      owner: 'channel',
      pid: 1234,
      startedAt: '2026-01-01T00:00:00.000Z',
      channels: ['telegram'],
    });
    mockChannelStateStoreSetMany.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    mockSignalService.mockReturnValue(true);
    mockWaitForExit.mockResolvedValue(true);
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await invokeStop();

    expect(mockSignalService).toHaveBeenCalledWith(1234, 'SIGTERM');
    expect(mockWriteStdoutLine).toHaveBeenCalledWith('Service stopped.');
    // The "stay stopped" message claims a durable stop; a swallowed write
    // failure must surface the contrary warning instead (#8975). Sink pin
    // (R12-3): the warning rides the best-effort sink.
    expect(mockWriteStdoutLineBestEffort).toHaveBeenCalledWith(
      expect.stringContaining('could not persist the stopped record'),
    );
    // Mirror-pin the ternary's other half: production's final message is a
    // single ternary, so a refactor emitting BOTH the durable guidance and
    // the warning on a lost record must fail here — the success-path test
    // asserts both directions; the failure path must too (#8975).
    expect(mockWriteStdoutLine).not.toHaveBeenCalledWith(
      expect.stringContaining('stay stopped'),
    );
    expect(mockWriteStdoutLineBestEffort).not.toHaveBeenCalledWith(
      expect.stringContaining('stay stopped'),
    );
    // Sink mirror (R12-3): the warning must not ALSO land on the loud
    // stdout sink.
    expect(mockWriteStdoutLine).not.toHaveBeenCalledWith(
      expect.stringContaining('could not persist the stopped record'),
    );
    // A lost record still exits 0 (the service IS stopped and the loss
    // was warned about) — and the warning must precede the exit (R9-21,
    // R9-23).
    expect(process.exit).toHaveBeenCalledWith(0);
    // 'Service stopped.' must precede the exit too (R12-21).
    const stoppedCall = mockWriteStdoutLine.mock.calls.findIndex((args) =>
      String(args[0]).includes('Service stopped.'),
    );
    expect(stoppedCall).toBeGreaterThanOrEqual(0);
    expect(
      mockWriteStdoutLine.mock.invocationCallOrder[stoppedCall],
    ).toBeLessThan(vi.mocked(process.exit).mock.invocationCallOrder[0]!);
    const warningCall = mockWriteStdoutLineBestEffort.mock.calls.findIndex(
      (args) =>
        String(args[0]).includes('could not persist the stopped record'),
    );
    expect(
      mockWriteStdoutLineBestEffort.mock.invocationCallOrder[warningCall],
    ).toBeLessThan(vi.mocked(process.exit).mock.invocationCallOrder[0]!);
  });

  it('surfaces a lost record when only the SECOND (legacy) write fails (R11-16)', async () => {
    // Every other failure test injects via mockImplementationOnce, which
    // the FIRST (workspace-scoped) write consumes; the `&& legacy` half
    // of recordStoppedChannels' return was unguarded — a mutation
    // returning `scoped` alone shipped green while the legacy file (the
    // only record a restart from ANOTHER workspace sees via adoption)
    // stayed unwritten and every stopped channel resurrected.
    mockReadServiceInfo.mockReturnValue({
      owner: 'channel',
      pid: 1234,
      startedAt: '2026-01-01T00:00:00.000Z',
      channels: ['telegram'],
      workspaceCwd: '/workspace/a',
    });
    // First (scoped) write succeeds; only the second (legacy) throws.
    mockChannelStateStoreSetMany
      .mockReturnValueOnce(undefined)
      .mockImplementationOnce(() => {
        throw new Error('disk full');
      });
    mockSignalService.mockReturnValue(true);
    mockWaitForExit.mockResolvedValue(true);
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await invokeStop();

    expect(mockChannelStateStoreSetMany).toHaveBeenCalledTimes(2);
    // The loss must replace the durable-stop message, not join it. Sink
    // pin (R12-3): the warning rides the best-effort sink.
    expect(mockWriteStdoutLineBestEffort).toHaveBeenCalledWith(
      expect.stringContaining('could not persist the stopped record'),
    );
    expect(mockWriteStdoutLine).not.toHaveBeenCalledWith(
      expect.stringContaining('stay stopped'),
    );
    expect(mockWriteStdoutLineBestEffort).not.toHaveBeenCalledWith(
      expect.stringContaining('stay stopped'),
    );
    expect(mockWriteStdoutLine).not.toHaveBeenCalledWith(
      expect.stringContaining('could not persist the stopped record'),
    );
    // A lost record still exits 0 (the service IS stopped; R9-21).
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('escalates to SIGKILL when the service ignores SIGTERM (#8975)', async () => {
    // The SIGKILL branch is the other consumer of the recorded-conditional
    // message tail: a hung service is the double-failure shape most likely
    // to coincide with a failed state write, so both halves of the tail
    // must be reachable here (#8975).
    mockReadServiceInfo.mockReturnValue({
      owner: 'channel',
      pid: 1234,
      startedAt: '2026-01-01T00:00:00.000Z',
      channels: ['telegram'],
      workspaceCwd: '/workspace/a',
    });
    mockSignalService.mockReturnValue(true);
    mockWaitForExit.mockResolvedValue(false);
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await invokeStop();

    // Sequence pins, not membership: TERM must precede KILL and the 5s
    // graceful window must precede the 2s kill window — swapping either
    // pair (e.g. silently halving the graceful window) keeps a
    // membership-only assertion green while production hard-kills a
    // service that would have exited cleanly on SIGTERM, losing in-flight
    // channel state. Every other ordering in this file is pinned via
    // invocationCallOrder/NthCalledWith (R9-24).
    expect(mockSignalService).toHaveBeenNthCalledWith(1, 1234, 'SIGTERM');
    expect(mockSignalService).toHaveBeenNthCalledWith(2, 1234, 'SIGKILL');
    expect(mockWaitForExit).toHaveBeenNthCalledWith(1, 1234, 5000);
    expect(mockWaitForExit).toHaveBeenNthCalledWith(2, 1234, 2000);
    // Presence AND ordering pin for the escalation notice (R14): the user
    // of a hung service must see the graceful window closed before the
    // kill — deleting the stderr write or relocating it below the
    // SIGKILL/wait pair shipped green before (the signal-sequence pins
    // alone do not observe it).
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('Sending SIGKILL'),
    );
    const sigkillNoticeCall = mockWriteStderrLine.mock.calls.findIndex((args) =>
      String(args[0]).includes('Sending SIGKILL'),
    );
    expect(sigkillNoticeCall).toBeGreaterThanOrEqual(0);
    const noticeOrder =
      mockWriteStderrLine.mock.invocationCallOrder[sigkillNoticeCall]!;
    expect(noticeOrder).toBeGreaterThan(
      mockWaitForExit.mock.invocationCallOrder[0]!,
    );
    expect(noticeOrder).toBeLessThan(
      mockSignalService.mock.invocationCallOrder[1]!,
    );
    expect(mockWriteStdoutLine).toHaveBeenCalledWith('Service killed.');
    expect(mockRemoveServiceInfo).toHaveBeenCalled();
    // The record persisted, so the conditional tail takes the durable half
    // on this branch too.
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('stay stopped'),
    );
    expect(mockWriteStdoutLine).not.toHaveBeenCalledWith(
      expect.stringContaining('could not persist the stopped record'),
    );
    // Sink twin (R12-3): the real warning sink is the best-effort one.
    expect(mockWriteStdoutLineBestEffort).not.toHaveBeenCalledWith(
      expect.stringContaining('could not persist the stopped record'),
    );
    expect(process.exit).toHaveBeenCalledWith(0);
    // 'Service killed.' is the only completion trace of an escalated stop:
    // it must precede the exit, pinned like its 'Service stopped.' twins —
    // under the no-op exit mock a relocated-below-exit write ships green
    // while production exits silently (R12-21).
    const killedCall = mockWriteStdoutLine.mock.calls.findIndex((args) =>
      String(args[0]).includes('Service killed.'),
    );
    expect(killedCall).toBeGreaterThanOrEqual(0);
    expect(
      mockWriteStdoutLine.mock.invocationCallOrder[killedCall],
    ).toBeLessThan(vi.mocked(process.exit).mock.invocationCallOrder[0]!);
    // The final message must be emitted BEFORE the exit (R9-23).
    const finalMessageCall = mockWriteStdoutLine.mock.calls.findIndex((args) =>
      String(args[0]).includes('stay stopped'),
    );
    expect(
      mockWriteStdoutLine.mock.invocationCallOrder[finalMessageCall],
    ).toBeLessThan(vi.mocked(process.exit).mock.invocationCallOrder[0]!);
  });

  it('surfaces a lost stop record on the SIGKILL branch (#8975)', async () => {
    mockReadServiceInfo.mockReturnValue({
      owner: 'channel',
      pid: 1234,
      startedAt: '2026-01-01T00:00:00.000Z',
      channels: ['telegram'],
      workspaceCwd: '/workspace/a',
    });
    mockChannelStateStoreSetMany.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    mockSignalService.mockReturnValue(true);
    mockWaitForExit.mockResolvedValue(false);
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await invokeStop();

    expect(mockSignalService).toHaveBeenCalledWith(1234, 'SIGKILL');
    expect(mockWriteStdoutLine).toHaveBeenCalledWith('Service killed.');
    // Sink pin (R12-3): the warning rides the best-effort sink.
    expect(mockWriteStdoutLineBestEffort).toHaveBeenCalledWith(
      expect.stringContaining('could not persist the stopped record'),
    );
    expect(mockWriteStdoutLine).not.toHaveBeenCalledWith(
      expect.stringContaining('stay stopped'),
    );
    expect(mockWriteStdoutLineBestEffort).not.toHaveBeenCalledWith(
      expect.stringContaining('stay stopped'),
    );
    expect(mockWriteStdoutLine).not.toHaveBeenCalledWith(
      expect.stringContaining('could not persist the stopped record'),
    );
    expect(process.exit).toHaveBeenCalledWith(0);
    // 'Service killed.' must precede the exit, twin of the escalated
    // stop's pin (R12-21).
    const killedCall = mockWriteStdoutLine.mock.calls.findIndex((args) =>
      String(args[0]).includes('Service killed.'),
    );
    expect(killedCall).toBeGreaterThanOrEqual(0);
    expect(
      mockWriteStdoutLine.mock.invocationCallOrder[killedCall],
    ).toBeLessThan(vi.mocked(process.exit).mock.invocationCallOrder[0]!);
    // The warning must precede the exit (R9-23).
    const warningCall = mockWriteStdoutLineBestEffort.mock.calls.findIndex(
      (args) =>
        String(args[0]).includes('could not persist the stopped record'),
    );
    expect(
      mockWriteStdoutLineBestEffort.mock.invocationCallOrder[warningCall],
    ).toBeLessThan(vi.mocked(process.exit).mock.invocationCallOrder[0]!);
  });

  it('surfaces a lost stop record when the service died before the signal (#8975)', async () => {
    // The realistic shape when stopping a hung or dying service: the state
    // write fails (disk full) AND the service dies between the liveness
    // check and SIGTERM delivery. This branch exits 0 before the final
    // recorded-conditional message, so the warning must be emitted inside
    // it, or the lost record is never surfaced (#8975).
    mockReadServiceInfo.mockReturnValue({
      owner: 'channel',
      pid: 1234,
      startedAt: '2026-01-01T00:00:00.000Z',
      channels: ['telegram'],
      workspaceCwd: '/workspace/a',
    });
    mockChannelStateStoreSetMany.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    mockSignalService.mockReturnValue(false);
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    await expect(invokeStop()).rejects.toThrow('process.exit: 0');

    // Sink pin (R12-3): the warning rides the best-effort sink.
    expect(mockWriteStdoutLineBestEffort).toHaveBeenCalledWith(
      expect.stringContaining('could not persist the stopped record'),
    );
    expect(mockWriteStdoutLine).not.toHaveBeenCalledWith(
      expect.stringContaining('could not persist the stopped record'),
    );
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('Failed to send signal'),
    );
    expect(mockRemoveServiceInfo).toHaveBeenCalled();
    // The branch must exit before any wait/kill fall-through.
    expect(mockWaitForExit).not.toHaveBeenCalled();
  });

  it('keeps the signal-failure branch quiet when the record persisted (#8975)', async () => {
    mockReadServiceInfo.mockReturnValue({
      owner: 'channel',
      pid: 1234,
      startedAt: '2026-01-01T00:00:00.000Z',
      channels: ['telegram'],
      workspaceCwd: '/workspace/a',
    });
    mockSignalService.mockReturnValue(false);
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    await expect(invokeStop()).rejects.toThrow('process.exit: 0');

    // The record persisted, so only the signal failure is reported — the
    // persistence warning would be a false alarm here.
    expect(mockWriteStdoutLine).not.toHaveBeenCalledWith(
      expect.stringContaining('could not persist the stopped record'),
    );
    // Sink twin (R12-3): the real warning sink is the best-effort one.
    expect(mockWriteStdoutLineBestEffort).not.toHaveBeenCalledWith(
      expect.stringContaining('could not persist the stopped record'),
    );
    // The recorded-conditional guidance IS printed (R15-34): this branch
    // exits before the tail guidance block, so it mirrors it — without
    // this, a user whose service died between the liveness check and the
    // signal gets a persisted stop with no "stay stopped" explanation,
    // inconsistent with the clean-stop and SIGKILL siblings.
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('stay stopped'),
    );
    expect(mockRemoveServiceInfo).toHaveBeenCalled();
  });
});
