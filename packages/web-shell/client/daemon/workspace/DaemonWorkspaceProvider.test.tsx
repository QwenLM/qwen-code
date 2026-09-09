/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonHttpError } from '@qwen-code/sdk/daemon';
import {
  BRAND_RETRY_DELAY_MS,
  DaemonWorkspaceProvider,
  useDaemonWorkspace,
  useOptionalDaemonWorkspace,
  type DaemonWorkspaceActions,
  type DaemonWorkspaceContextValue,
} from './DaemonWorkspaceProvider.js';
import { useDaemonSessions } from './hooks/useDaemonSessions.js';

const sdkMocks = vi.hoisted(() => {
  const capabilities = vi.fn();
  const brand = vi.fn();
  const workspaceMcp = vi.fn();
  const workspaceMcpTools = vi.fn();
  const workspaceMcpResources = vi.fn();
  const restartMcpServer = vi.fn();
  const workspaceSkills = vi.fn();
  const setWorkspaceSkillEnabled = vi.fn();
  const installWorkspaceSkill = vi.fn();
  const deleteWorkspaceSkill = vi.fn();
  const workspaceAcpStatus = vi.fn();
  const workspaceAcpPreheat = vi.fn();
  const workspaceTools = vi.fn();
  const setWorkspaceToolEnabled = vi.fn();
  const workspaceMemory = vi.fn();
  const readWorkspaceFile = vi.fn();
  const writeWorkspaceMemory = vi.fn();
  const listWorkspaceAgents = vi.fn();
  const getWorkspaceAgent = vi.fn();
  const createWorkspaceAgent = vi.fn();
  const deleteWorkspaceAgent = vi.fn();
  const workspaceProviders = vi.fn();
  const listWorkspaceSessionsPage = vi.fn();
  const deleteSessionsData = vi.fn();
  const exportSession = vi.fn();
  const daemonStatus = vi.fn();
  const instances: MockDaemonClient[] = [];

  class MockDaemonClient {
    constructor(opts: unknown) {
      this.baseUrl = (opts as { baseUrl?: string }).baseUrl;
      instances.push(this);
    }

    /** The baseUrl this client was constructed with, for attribution. */
    readonly baseUrl: string | undefined;

    // Per-instance wrapper so a test can attribute each call to the client
    // it was issued against; delegates to the shared mock so the existing
    // queue/count assertions are unaffected.
    brand = vi.fn(() => brand());

    workspaceByCwd = vi.fn(() => ({
      runtimeMcpTools: workspaceMcpTools,
      runtimeMcpResources: workspaceMcpResources,
    }));

    capabilities = capabilities;
    workspaceMcp = workspaceMcp;
    workspaceMcpTools = workspaceMcpTools;
    workspaceMcpResources = workspaceMcpResources;
    restartMcpServer = restartMcpServer;
    workspaceSkills = workspaceSkills;
    setWorkspaceSkillEnabled = setWorkspaceSkillEnabled;
    installWorkspaceSkill = installWorkspaceSkill;
    deleteWorkspaceSkill = deleteWorkspaceSkill;
    workspaceAcpStatus = workspaceAcpStatus;
    workspaceAcpPreheat = workspaceAcpPreheat;
    workspaceTools = workspaceTools;
    setWorkspaceToolEnabled = setWorkspaceToolEnabled;
    workspaceMemory = workspaceMemory;
    readWorkspaceFile = readWorkspaceFile;
    writeWorkspaceMemory = writeWorkspaceMemory;
    listWorkspaceAgents = listWorkspaceAgents;
    getWorkspaceAgent = getWorkspaceAgent;
    createWorkspaceAgent = createWorkspaceAgent;
    deleteWorkspaceAgent = deleteWorkspaceAgent;
    workspaceProviders = workspaceProviders;
    listWorkspaceSessionsPage = listWorkspaceSessionsPage;
    deleteSessionsData = deleteSessionsData;
    exportSession = exportSession;
    daemonStatus = daemonStatus;
    dispose = vi.fn();
  }

  return {
    MockDaemonClient,
    capabilities,
    brand,
    workspaceMcp,
    workspaceMcpTools,
    workspaceMcpResources,
    restartMcpServer,
    workspaceSkills,
    setWorkspaceSkillEnabled,
    installWorkspaceSkill,
    deleteWorkspaceSkill,
    workspaceAcpStatus,
    workspaceAcpPreheat,
    workspaceTools,
    setWorkspaceToolEnabled,
    workspaceMemory,
    readWorkspaceFile,
    writeWorkspaceMemory,
    listWorkspaceAgents,
    getWorkspaceAgent,
    createWorkspaceAgent,
    deleteWorkspaceAgent,
    workspaceProviders,
    listWorkspaceSessionsPage,
    deleteSessionsData,
    exportSession,
    daemonStatus,
    instances,
    reset() {
      instances.length = 0;
      capabilities.mockReset();
      capabilities.mockResolvedValue({
        workspaceCwd: '/mock-workspace',
        features: [],
      });
      brand.mockReset();
      brand.mockResolvedValue({});
      workspaceMcp.mockReset();
      workspaceMcp.mockResolvedValue({
        v: 1,
        workspaceCwd: '/mock-workspace',
        initialized: true,
        servers: [],
      });
      workspaceMcpTools.mockReset();
      workspaceMcpTools.mockResolvedValue({
        v: 1,
        serverName: 'mock',
        tools: [],
      });
      workspaceMcpResources.mockReset();
      workspaceMcpResources.mockResolvedValue({
        v: 1,
        serverName: 'mock',
        resources: [],
      });
      restartMcpServer.mockReset();
      restartMcpServer.mockResolvedValue({ restarted: true });
      workspaceSkills.mockReset();
      workspaceSkills.mockResolvedValue({
        v: 1,
        workspaceCwd: '/mock-workspace',
        initialized: true,
        skills: [],
      });
      setWorkspaceSkillEnabled.mockReset();
      setWorkspaceSkillEnabled.mockResolvedValue({
        skillName: 'review',
        enabled: false,
        changed: true,
        activation: 'applied',
        sessionsRefreshed: 1,
        sessionsFailed: 0,
      });
      installWorkspaceSkill.mockReset();
      installWorkspaceSkill.mockResolvedValue({
        skillName: 'review',
        scope: 'workspace',
        installedPath: '/mock-workspace/.qwen/skills/review/SKILL.md',
      });
      deleteWorkspaceSkill.mockReset();
      deleteWorkspaceSkill.mockResolvedValue({
        skillName: 'review',
        scope: 'workspace',
        deleted: true,
      });
      workspaceAcpStatus.mockReset();
      workspaceAcpStatus.mockResolvedValue({ channelLive: true });
      workspaceAcpPreheat.mockReset();
      workspaceAcpPreheat.mockResolvedValue({
        ready: true,
        channelLive: true,
        durationMs: 1,
      });
      workspaceTools.mockReset();
      workspaceTools.mockResolvedValue({
        v: 1,
        workspaceCwd: '/mock-workspace',
        initialized: true,
        acpChannelLive: true,
        tools: [],
      });
      setWorkspaceToolEnabled.mockReset();
      setWorkspaceToolEnabled.mockResolvedValue({ ok: true });
      workspaceMemory.mockReset();
      workspaceMemory.mockResolvedValue({
        v: 1,
        workspaceCwd: '/mock-workspace',
        initialized: true,
        files: [],
      });
      readWorkspaceFile.mockReset();
      readWorkspaceFile.mockResolvedValue({ path: 'QWEN.md', text: '' });
      writeWorkspaceMemory.mockReset();
      writeWorkspaceMemory.mockResolvedValue({ ok: true });
      listWorkspaceAgents.mockReset();
      listWorkspaceAgents.mockResolvedValue({
        v: 1,
        workspaceCwd: '/mock-workspace',
        agents: [],
      });
      getWorkspaceAgent.mockReset();
      getWorkspaceAgent.mockResolvedValue({ agent: undefined });
      createWorkspaceAgent.mockReset();
      createWorkspaceAgent.mockResolvedValue({ ok: true });
      deleteWorkspaceAgent.mockReset();
      deleteWorkspaceAgent.mockResolvedValue(undefined);
      workspaceProviders.mockReset();
      workspaceProviders.mockResolvedValue({
        v: 1,
        workspaceCwd: '/mock-workspace',
        initialized: true,
        providers: [],
      });
      listWorkspaceSessionsPage.mockReset();
      listWorkspaceSessionsPage.mockResolvedValue({ sessions: [] });
      deleteSessionsData.mockReset();
      deleteSessionsData.mockResolvedValue({
        removed: [],
        notFound: [],
        errors: [],
      });
      exportSession.mockReset();
      exportSession.mockResolvedValue({
        content: '<html>export</html>',
        filename: 'session.html',
        mimeType: 'text/html',
        format: 'html',
      });
      daemonStatus.mockReset();
      daemonStatus.mockResolvedValue({
        v: 1,
        detail: 'summary',
        status: 'ok',
        issues: [],
      });
    },
  };
});

vi.mock('@qwen-code/sdk/daemon', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@qwen-code/sdk/daemon')>();
  return {
    ...actual,
    DaemonClient: sdkMocks.MockDaemonClient,
  };
});

describe('DaemonWorkspaceProvider', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    sdkMocks.reset();
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
    vi.unstubAllGlobals();
  });

  function renderWithProvider(children: ReactNode) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    return new Promise<void>((resolve) => {
      act(() => {
        root?.render(
          <DaemonWorkspaceProvider baseUrl="http://127.0.0.1:4170">
            {children}
          </DaemonWorkspaceProvider>,
        );
      });
      resolve();
    });
  }

  it('exposes workspace context with autoConnect', async () => {
    let context: DaemonWorkspaceContextValue | undefined;

    function Harness() {
      context = useOptionalDaemonWorkspace();
      return null;
    }

    await renderWithProvider(<Harness />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(context).toBeDefined();
    expect(context?.baseUrl).toBe('http://127.0.0.1:4170');
    expect(context?.workspaceCwd).toBe('/mock-workspace');
  });

  it('exposes the daemon-resolved brand on the workspace context', async () => {
    sdkMocks.brand.mockResolvedValue({ name: 'QiuQiu Code' });
    let context: DaemonWorkspaceContextValue | undefined;

    function Harness() {
      context = useOptionalDaemonWorkspace();
      return null;
    }

    await renderWithProvider(<Harness />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(sdkMocks.brand).toHaveBeenCalledTimes(1);
    expect(context?.brand).toEqual({ name: 'QiuQiu Code' });
    expect(context?.brandSettled).toBe(true);
  });

  it('keeps the connection healthy when the daemon has no /brand route', async () => {
    // An older daemon answers 404 — the one definitive "no brand here"
    // answer. Branding is cosmetic, so the failure is swallowed and the
    // client falls back to its built-in brand rather than putting the whole
    // shell into an error state. The fetch still SETTLES — that is what lets
    // a consumer clear branding cached from an earlier daemon.
    sdkMocks.brand.mockRejectedValue(
      new DaemonHttpError(404, undefined, '404 not found'),
    );
    let context: DaemonWorkspaceContextValue | undefined;

    function Harness() {
      context = useOptionalDaemonWorkspace();
      return null;
    }

    await renderWithProvider(<Harness />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(context?.brand).toBeUndefined();
    expect(context?.brandSettled).toBe(true);
    expect(context?.status).toBe('connected');
    expect(context?.error).toBeUndefined();
  });

  it('does not settle the brand on a retryable failure', async () => {
    // A 503 while the deferred runtime is still starting (likewise a 429 or a
    // transport failure) means unknown, not "no brand configured". Settling
    // would report an authoritative empty brand — resetting the tab title and
    // deleting the pre-paint cache mid-session — over a blip that is never
    // retried.
    sdkMocks.brand.mockRejectedValue(
      new DaemonHttpError(503, undefined, 'runtime starting'),
    );
    let context: DaemonWorkspaceContextValue | undefined;

    function Harness() {
      context = useOptionalDaemonWorkspace();
      return null;
    }

    await renderWithProvider(<Harness />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(context?.brand).toBeUndefined();
    expect(context?.brandSettled).toBe(false);
    expect(context?.status).toBe('connected');
    expect(context?.error).toBeUndefined();
  });

  it('re-issues the brand fetch on refreshBrand, keeping the 404-only settle rule', async () => {
    // The retryable failure above leaves the brand unsettled for the page's
    // lifetime without a re-ask. refreshBrand is that re-ask: it re-issues
    // the fetch for the SAME client, and the retry applies the same settle
    // rule — a 404 settles, another retryable failure stays unsettled.
    sdkMocks.brand
      .mockRejectedValueOnce(
        new DaemonHttpError(503, undefined, 'runtime starting'),
      )
      .mockResolvedValueOnce({ name: 'QiuQiu Code' });
    let context: DaemonWorkspaceContextValue | undefined;

    function Harness() {
      context = useOptionalDaemonWorkspace();
      return null;
    }

    await renderWithProvider(<Harness />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(sdkMocks.brand).toHaveBeenCalledTimes(1);
    expect(context?.brandSettled).toBe(false);

    await act(async () => {
      context?.refreshBrand?.();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(sdkMocks.brand).toHaveBeenCalledTimes(2);
    expect(context?.brand).toEqual({ name: 'QiuQiu Code' });
    expect(context?.brandSettled).toBe(true);
  });

  it('lets a retried 404 settle the brand as definitively absent', async () => {
    sdkMocks.brand
      .mockRejectedValueOnce(
        new DaemonHttpError(503, undefined, 'runtime starting'),
      )
      .mockRejectedValueOnce(
        new DaemonHttpError(404, undefined, '404 not found'),
      );
    let context: DaemonWorkspaceContextValue | undefined;

    function Harness() {
      context = useOptionalDaemonWorkspace();
      return null;
    }

    await renderWithProvider(<Harness />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(context?.brandSettled).toBe(false);

    await act(async () => {
      context?.refreshBrand?.();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(sdkMocks.brand).toHaveBeenCalledTimes(2);
    expect(context?.brand).toBeUndefined();
    expect(context?.brandSettled).toBe(true);
  });

  it('does not re-issue the fetch when the brand is already resolved or settled', async () => {
    // The gate protects the mid-session brand: an already-resolved brand must
    // not be blanked by a recovery-path refresh, and a definitive 404 must
    // not be turned back into "loading".
    sdkMocks.brand.mockResolvedValue({ name: 'QiuQiu Code' });
    let context: DaemonWorkspaceContextValue | undefined;

    function Harness() {
      context = useOptionalDaemonWorkspace();
      return null;
    }

    await renderWithProvider(<Harness />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(context?.brand).toEqual({ name: 'QiuQiu Code' });

    await act(async () => {
      context?.refreshBrand?.();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(sdkMocks.brand).toHaveBeenCalledTimes(1);
    expect(context?.brand).toEqual({ name: 'QiuQiu Code' });
    expect(context?.brandSettled).toBe(true);
  });

  it('retries a retryable failure once on its own, without a refreshBrand call', async () => {
    // A 429 with a one-token bucket (capabilities took the other), a 503
    // while the runtime starts, or a transport blip must not leave the shell
    // split-brained — built-in name in-app, cached white-label in the tab —
    // until a manual reload. One bounded retry fires without any caller.
    // Fake timers drive the retry delay: the case must not sleep through the
    // production constant on a real clock.
    vi.useFakeTimers();
    try {
      sdkMocks.brand
        .mockRejectedValueOnce(new DaemonHttpError(429, undefined, 'limited'))
        .mockResolvedValueOnce({ name: 'QiuQiu Code' });
      let context: DaemonWorkspaceContextValue | undefined;

      function Harness() {
        context = useOptionalDaemonWorkspace();
        return null;
      }

      await renderWithProvider(<Harness />);
      await act(async () => {
        await Promise.resolve();
      });
      // The immediate aftermath is still the unsettled "unknown" state.
      expect(sdkMocks.brand).toHaveBeenCalledTimes(1);
      expect(context?.brandSettled).toBe(false);

      await act(async () => {
        vi.advanceTimersByTime(BRAND_RETRY_DELAY_MS);
        await Promise.resolve();
      });

      expect(sdkMocks.brand).toHaveBeenCalledTimes(2);
      expect(context?.brand).toEqual({ name: 'QiuQiu Code' });
      expect(context?.brandSettled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('warns once a retryable failure persists past the retry, but not on a definitive 404', async () => {
    // The daemon's stderr cannot cover a request that never arrived, so the
    // exhausted-retry state gets the console. A 404 is an expected old-daemon
    // state and stays silent.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      sdkMocks.brand.mockRejectedValue(
        new DaemonHttpError(503, undefined, 'runtime starting'),
      );
      let context: DaemonWorkspaceContextValue | undefined;

      function Harness() {
        context = useOptionalDaemonWorkspace();
        return null;
      }

      await renderWithProvider(<Harness />);
      await act(async () => {
        await Promise.resolve();
      });
      // Silent while the retry is still pending.
      expect(warn).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(BRAND_RETRY_DELAY_MS);
        await Promise.resolve();
      });
      expect(sdkMocks.brand).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('brand could not be fetched'),
      );
      expect(context?.brandSettled).toBe(false);

      warn.mockClear();
      sdkMocks.brand.mockRejectedValue(
        new DaemonHttpError(404, undefined, '404 not found'),
      );
      await act(async () => {
        context?.refreshBrand?.();
        await Promise.resolve();
      });
      expect(sdkMocks.brand).toHaveBeenCalledTimes(3);
      expect(context?.brandSettled).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  it('does not re-issue the fetch while one is in flight', async () => {
    // The in-flight gate leg: a recovery-path refresh during the mount fetch
    // must not supersede it into a duplicate request (on a rate-limited
    // daemon the duplicate 429s where the original would have succeeded).
    let resolveFetch!: (brand: unknown) => void;
    const pending = new Promise((r) => (resolveFetch = r));
    sdkMocks.brand.mockImplementation(() => pending);
    let context: DaemonWorkspaceContextValue | undefined;

    function Harness() {
      context = useOptionalDaemonWorkspace();
      return null;
    }

    await renderWithProvider(<Harness />);
    await act(async () => {
      context?.refreshBrand?.();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(sdkMocks.brand).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFetch({ name: 'Daemon Brand' });
      await pending;
    });
    expect(context?.brand).toEqual({ name: 'Daemon Brand' });
    expect(context?.brandSettled).toBe(true);
  });

  it('does not re-issue the fetch after a definitive 404 settled it', async () => {
    // The settled gate leg: re-asking after a 404 would turn the definitive
    // answer back into "loading" and re-fire the cache-clearing report.
    sdkMocks.brand.mockRejectedValue(
      new DaemonHttpError(404, undefined, '404 not found'),
    );
    let context: DaemonWorkspaceContextValue | undefined;

    function Harness() {
      context = useOptionalDaemonWorkspace();
      return null;
    }

    await renderWithProvider(<Harness />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(context?.brandSettled).toBe(true);

    await act(async () => {
      context?.refreshBrand?.();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(sdkMocks.brand).toHaveBeenCalledTimes(1);
    expect(context?.brand).toBeUndefined();
    expect(context?.brandSettled).toBe(true);
  });

  it('survives an SDK client that has no brand method at all', async () => {
    // `@qwen-code/sdk` is a peer dependency, so a host on an older SDK hands the
    // provider a client without `brand()`. Calling it throws a synchronous
    // TypeError, which must not escape the effect: branding is cosmetic and must
    // never white-screen the shell. A TypeError is indistinguishable from a
    // transport failure, so the fetch is treated as unknown rather than absent
    // — cached chrome is kept instead of cleared on a maybe-temporary state.
    sdkMocks.brand.mockImplementation(() => {
      throw new TypeError('client.brand is not a function');
    });
    let context: DaemonWorkspaceContextValue | undefined;

    function Harness() {
      context = useOptionalDaemonWorkspace();
      return null;
    }

    await renderWithProvider(<Harness />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(context?.brand).toBeUndefined();
    expect(context?.brandSettled).toBe(false);
    expect(context?.status).toBe('connected');
    expect(context?.error).toBeUndefined();
  });

  it('does not let a superseded client write its brand into the new connection', async () => {
    // `client` is memoized on baseUrl/token, so a host that re-points the shell
    // at another daemon creates a new client while the first `/brand` response
    // is still in flight. The disposed flag on the first effect's then-handler
    // is the only thing keeping daemon A's white-label off daemon B's shell.
    let resolveFirst!: (brand: unknown) => void;
    let resolveSecond!: (brand: unknown) => void;
    const first = new Promise((r) => (resolveFirst = r));
    const second = new Promise((r) => (resolveSecond = r));
    sdkMocks.brand
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(() => second);

    let context: DaemonWorkspaceContextValue | undefined;
    function Harness() {
      context = useOptionalDaemonWorkspace();
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <DaemonWorkspaceProvider baseUrl="http://127.0.0.1:4170">
          <Harness />
        </DaemonWorkspaceProvider>,
      );
    });

    // Re-point the shell: a new client, a new brand fetch. The first effect's
    // cleanup has now marked its resolution as disposed.
    await act(async () => {
      root.render(
        <DaemonWorkspaceProvider baseUrl="http://127.0.0.1:5173">
          <Harness />
        </DaemonWorkspaceProvider>,
      );
    });

    await act(async () => {
      resolveSecond({ name: 'Daemon B' });
      await second;
    });
    expect(context?.brand).toEqual({ name: 'Daemon B' });

    await act(async () => {
      resolveFirst({ name: 'Daemon A' });
      await first;
    });

    expect(context?.brand).toEqual({ name: 'Daemon B' });

    act(() => root.unmount());
    container.remove();
  });

  it('resets a superseded brand while the new client fetches', async () => {
    // A host that re-points AFTER daemon A resolved must not keep A's brand
    // object while B's fetch is in flight: the catch path never clears
    // `brand`, so without the reset on effect re-run, A's white-label would
    // survive indefinitely on a shell connected to daemon B.
    let resolveFirst!: (brand: unknown) => void;
    let rejectSecond!: (error: unknown) => void;
    const first = new Promise((r) => (resolveFirst = r));
    const second = new Promise((_r, rej) => (rejectSecond = rej));
    sdkMocks.brand
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(() => second);

    let context: DaemonWorkspaceContextValue | undefined;
    function Harness() {
      context = useOptionalDaemonWorkspace();
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <DaemonWorkspaceProvider baseUrl="http://127.0.0.1:4170">
          <Harness />
        </DaemonWorkspaceProvider>,
      );
    });

    await act(async () => {
      resolveFirst({ name: 'Daemon A' });
      await first;
    });
    expect(context?.brand).toEqual({ name: 'Daemon A' });
    expect(context?.brandSettled).toBe(true);

    // Re-point: the effect re-runs and resets before fetching B.
    await act(async () => {
      root.render(
        <DaemonWorkspaceProvider baseUrl="http://127.0.0.1:5173">
          <Harness />
        </DaemonWorkspaceProvider>,
      );
    });
    expect(context?.brand).toBeUndefined();
    expect(context?.brandSettled).toBe(false);

    // B turns out to be an old daemon: the definitive 404 settles with no
    // brand, so cached chrome from A's era can be cleared.
    await act(async () => {
      rejectSecond(new DaemonHttpError(404, undefined, '404 not found'));
      await second.catch(() => undefined);
    });
    expect(context?.brand).toBeUndefined();
    expect(context?.brandSettled).toBe(true);

    act(() => root.unmount());
    container.remove();
  });

  it('does not let a superseded client settle the new connection on failure', async () => {
    // The catch-leg `disposed` guard: a late answer from the superseded client
    // — even a definitive 404 — must not settle the NEW connection's in-flight
    // fetch, or a dead daemon's ECONNREFUSED would clobber the tab title and
    // cache while a healthy daemon B is still answering.
    let rejectFirst!: (error: unknown) => void;
    let resolveSecond!: (brand: unknown) => void;
    const first = new Promise((_r, rej) => (rejectFirst = rej));
    const second = new Promise((r) => (resolveSecond = r));
    sdkMocks.brand
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(() => second);

    let context: DaemonWorkspaceContextValue | undefined;
    function Harness() {
      context = useOptionalDaemonWorkspace();
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <DaemonWorkspaceProvider baseUrl="http://127.0.0.1:4170">
          <Harness />
        </DaemonWorkspaceProvider>,
      );
    });

    await act(async () => {
      root.render(
        <DaemonWorkspaceProvider baseUrl="http://127.0.0.1:5173">
          <Harness />
        </DaemonWorkspaceProvider>,
      );
    });

    await act(async () => {
      rejectFirst(new DaemonHttpError(404, undefined, '404 not found'));
      await first.catch(() => undefined);
    });
    expect(context?.brand).toBeUndefined();
    expect(context?.brandSettled).toBe(false);

    // A recovery-path refresh while the successor is still in flight must not
    // supersede it into a duplicate request — only the in-flight leg of the
    // gate blocks here, so this is the witness for the finally-leg guard:
    // without it, the superseded rejection would have cleared the flag and
    // this call would fire a third request.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
      context?.refreshBrand?.();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(sdkMocks.brand).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveSecond({ name: 'Daemon B' });
      await second;
    });
    expect(context?.brand).toEqual({ name: 'Daemon B' });
    expect(context?.brandSettled).toBe(true);

    act(() => root.unmount());
    container.remove();
  });

  it('re-fetches the brand when only the token changes', async () => {
    // The client is memoized on [autoConnect, baseUrl, token, transport], so
    // a token rotation produces a NEW client: the brand effect must re-run
    // (resetting, then fetching against the new identity) — otherwise the
    // context keeps describing the previous token's connection.
    sdkMocks.brand
      .mockResolvedValueOnce({ name: 'Token A Brand' })
      .mockResolvedValueOnce({ name: 'Token B Brand' });
    let context: DaemonWorkspaceContextValue | undefined;
    function Harness() {
      context = useOptionalDaemonWorkspace();
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <DaemonWorkspaceProvider baseUrl="http://127.0.0.1:4170" token="token-a">
          <Harness />
        </DaemonWorkspaceProvider>,
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(context?.brand).toEqual({ name: 'Token A Brand' });

    await act(async () => {
      root.render(
        <DaemonWorkspaceProvider baseUrl="http://127.0.0.1:4170" token="token-b">
          <Harness />
        </DaemonWorkspaceProvider>,
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(sdkMocks.brand).toHaveBeenCalledTimes(2);
    expect(context?.brand).toEqual({ name: 'Token B Brand' });
    expect(context?.brandSettled).toBe(true);

    act(() => root.unmount());
    container.remove();
  });

  it('re-asks the CURRENT client when refreshBrand fires after a re-point', async () => {
    // The retry must go to the client the shell is connected to NOW: the
    // shared brand spy queues by call order, so without per-instance
    // attribution a retry that asks the superseded client would satisfy
    // every assertion while painting daemon A's white-label on daemon B's
    // shell.
    let context: DaemonWorkspaceContextValue | undefined;
    function Harness() {
      context = useOptionalDaemonWorkspace();
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <DaemonWorkspaceProvider baseUrl="http://127.0.0.1:4170">
          <Harness />
        </DaemonWorkspaceProvider>,
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    // Re-point; the retryable failure on B's mount fetch leaves the brand
    // unsettled, so the gate permits a re-ask.
    sdkMocks.brand.mockRejectedValue(
      new DaemonHttpError(503, undefined, 'runtime starting'),
    );
    await act(async () => {
      root.render(
        <DaemonWorkspaceProvider baseUrl="http://127.0.0.1:5173">
          <Harness />
        </DaemonWorkspaceProvider>,
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(context?.brandSettled).toBe(false);

    sdkMocks.brand.mockResolvedValue({ name: 'Daemon B' });
    await act(async () => {
      context?.refreshBrand?.();
      await new Promise((r) => setTimeout(r, 0));
    });

    const [clientA, clientB] = sdkMocks.instances;
    expect(clientA?.brand).toHaveBeenCalledTimes(1);
    expect(clientB?.baseUrl).toBe('http://127.0.0.1:5173');
    expect(clientB?.brand).toHaveBeenCalledTimes(2);
    expect(context?.brand).toEqual({ name: 'Daemon B' });

    act(() => root.unmount());
    container.remove();
  });

  it('never publishes the previous client\'s brand on the re-point commit', async () => {
    // The reset lives in the render that observes the client change, so no
    // committed frame may carry daemon A's brand beside daemon B's baseUrl —
    // a consumer effect keyed on baseUrl must see the reset state.
    sdkMocks.brand
      .mockResolvedValueOnce({ name: 'Daemon A' })
      .mockResolvedValueOnce({ name: 'Daemon B' });
    const frames: Array<{
      baseUrl: string | undefined;
      brand: unknown;
      settled: boolean | undefined;
    }> = [];
    function Harness() {
      const context = useOptionalDaemonWorkspace();
      // Log COMMITTED frames (an effect fires after commit), not render
      // passes — a render-phase setState discards the stale render before
      // commit, and only committed frames can reach a consumer.
      useEffect(() => {
        frames.push({
          baseUrl: context?.baseUrl,
          brand: context?.brand,
          settled: context?.brandSettled,
        });
      });
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <DaemonWorkspaceProvider baseUrl="http://127.0.0.1:4170">
          <Harness />
        </DaemonWorkspaceProvider>,
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(frames.at(-1)?.brand).toEqual({ name: 'Daemon A' });

    await act(async () => {
      root.render(
        <DaemonWorkspaceProvider baseUrl="http://127.0.0.1:5173">
          <Harness />
        </DaemonWorkspaceProvider>,
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(
      frames.some(
        (frame) =>
          frame.baseUrl === 'http://127.0.0.1:5173' &&
          (frame.brand as { name?: string } | undefined)?.name === 'Daemon A',
      ),
    ).toBe(false);

    act(() => root.unmount());
    container.remove();
  });

  it('refreshCapabilities re-fetches and updates capabilities state', async () => {
    let context: DaemonWorkspaceContextValue | undefined;

    function Harness() {
      context = useOptionalDaemonWorkspace();
      return null;
    }

    await renderWithProvider(<Harness />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    // Initial mount fetched capabilities once; no workspaces registered yet.
    expect(sdkMocks.capabilities).toHaveBeenCalledTimes(1);
    expect(context?.capabilities?.workspaces).toBeUndefined();

    // A workspace was registered out of band (e.g. POST /workspaces); the
    // next capabilities fetch reflects it.
    sdkMocks.capabilities.mockResolvedValueOnce({
      workspaceCwd: '/mock-workspace',
      features: [],
      workspaces: [
        { id: 'a', cwd: '/mock-workspace', primary: true, trusted: true },
        { id: 'b', cwd: '/other', primary: false, trusted: true },
      ],
    });

    await act(async () => {
      await context?.refreshCapabilities?.();
    });

    // A fresh request was issued (the getCapabilities promise cache is
    // bypassed) and state updated so the new workspace shows without a
    // full page reload.
    expect(sdkMocks.capabilities).toHaveBeenCalledTimes(2);
    expect(context?.capabilities?.workspaces).toHaveLength(2);
    expect(context?.capabilities?.workspaces?.[1]?.cwd).toBe('/other');
  });

  it('does not let the initial request overwrite a newer refresh', async () => {
    let resolveInitial!: (value: never) => void;
    sdkMocks.capabilities.mockImplementationOnce(
      () => new Promise((resolve) => (resolveInitial = resolve)),
    );
    let context: DaemonWorkspaceContextValue | undefined;
    function Harness() {
      context = useOptionalDaemonWorkspace();
      return null;
    }
    await renderWithProvider(<Harness />);
    const accepted = {
      workspaceCwd: '/mock-workspace',
      features: [],
      workspaces: [
        { id: 'accepted', cwd: '/accepted', primary: false, trusted: true },
      ],
    };
    sdkMocks.capabilities.mockResolvedValueOnce(accepted);

    await act(async () => {
      await context!.refreshCapabilities!();
    });
    await act(async () => {
      resolveInitial({
        workspaceCwd: '/mock-workspace',
        features: [],
        workspaces: [],
      } as never);
      await Promise.resolve();
    });

    expect(context?.capabilities).toBe(accepted);
  });

  it('makes superseded refreshes resolve to the accepted successor', async () => {
    let context: DaemonWorkspaceContextValue | undefined;
    function Harness() {
      context = useOptionalDaemonWorkspace();
      return null;
    }
    await renderWithProvider(<Harness />);
    await act(async () => {
      await Promise.resolve();
    });

    let resolveFirst!: (value: never) => void;
    let resolveSecond!: (value: never) => void;
    sdkMocks.capabilities
      .mockImplementationOnce(
        () => new Promise((resolve) => (resolveFirst = resolve)),
      )
      .mockImplementationOnce(
        () => new Promise((resolve) => (resolveSecond = resolve)),
      );
    const first = context!.refreshCapabilities!();
    const second = context!.refreshCapabilities!();
    const accepted = {
      workspaceCwd: '/mock-workspace',
      features: [],
      workspaces: [
        { id: 'accepted', cwd: '/accepted', primary: false, trusted: true },
      ],
    };
    await act(async () => {
      resolveSecond(accepted as never);
      await second;
    });
    await act(async () => {
      resolveFirst({
        workspaceCwd: '/mock-workspace',
        features: [],
        workspaces: [],
      } as never);
      expect(await first).toBe(accepted);
    });

    expect(context?.capabilities).toBe(accepted);
  });

  it('propagates the accepted successor rejection to a superseded refresh', async () => {
    let context: DaemonWorkspaceContextValue | undefined;
    function Harness() {
      context = useOptionalDaemonWorkspace();
      return null;
    }
    await renderWithProvider(<Harness />);
    await act(async () => {
      await Promise.resolve();
    });

    let resolveFirst!: (value: never) => void;
    let rejectSecond!: (reason: Error) => void;
    sdkMocks.capabilities
      .mockImplementationOnce(
        () => new Promise((resolve) => (resolveFirst = resolve)),
      )
      .mockImplementationOnce(
        () => new Promise((_resolve, reject) => (rejectSecond = reject)),
      );
    const first = context!.refreshCapabilities!();
    const second = context!.refreshCapabilities!();
    const acceptedError = new Error('accepted refresh failed');
    const firstOutcome = first.catch((error: unknown) => error);
    const secondOutcome = second.catch((error: unknown) => error);

    await act(async () => {
      rejectSecond(acceptedError);
      expect(await secondOutcome).toBe(acceptedError);
      resolveFirst({
        workspaceCwd: '/mock-workspace',
        features: [],
      } as never);
      expect(await firstOutcome).toBe(acceptedError);
    });
  });

  it('throws when useDaemonWorkspace is used without provider', async () => {
    let error: Error | undefined;

    function Harness() {
      try {
        useDaemonWorkspace();
      } catch (e) {
        error = e as Error;
      }
      return null;
    }

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<Harness />);
    });

    expect(error?.message).toContain(
      'useDaemonWorkspace must be used within DaemonWorkspaceProvider',
    );
  });

  it('exposes workspace actions', async () => {
    let actions: DaemonWorkspaceActions | undefined;

    function Harness() {
      const workspace = useOptionalDaemonWorkspace();
      actions = workspace?.actions;
      return null;
    }

    await renderWithProvider(<Harness />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(actions).toBeDefined();
    expect(typeof actions?.loadMcpStatus).toBe('function');
    expect(typeof actions?.reloadMcp).toBe('function');
    expect(typeof actions?.loadSkillsStatus).toBe('function');
    expect(typeof actions?.setWorkspaceSkillEnabled).toBe('function');
    expect(typeof actions?.installWorkspaceSkill).toBe('function');
    expect(typeof actions?.deleteWorkspaceSkill).toBe('function');
    expect(typeof actions?.listAgents).toBe('function');
    expect(typeof actions?.globWorkspace).toBe('function');

    await actions?.setWorkspaceSkillEnabled('review', false);
    expect(sdkMocks.setWorkspaceSkillEnabled).toHaveBeenCalledWith(
      'review',
      false,
    );
  });

  it('useOptionalDaemonWorkspace returns undefined without provider', async () => {
    let context: DaemonWorkspaceContextValue | undefined = {
      client: {} as never,
    } as never;

    function Harness() {
      context = useOptionalDaemonWorkspace();
      return null;
    }

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<Harness />);
    });

    expect(context).toBeUndefined();
  });

  it('propagates MCP tools failures', async () => {
    sdkMocks.workspaceMcpTools.mockRejectedValueOnce(
      new Error('missing route'),
    );
    let actions: DaemonWorkspaceActions | undefined;

    function Harness() {
      const workspace = useOptionalDaemonWorkspace();
      actions = workspace?.actions;
      return null;
    }

    await renderWithProvider(<Harness />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    if (!actions) throw new Error('actions not defined');

    const workspaceActions = actions;

    await act(async () => {
      await expect(workspaceActions.loadMcpTools('server-a')).rejects.toThrow(
        'missing route',
      );
    });
  });

  it('loads MCP resources for a server', async () => {
    sdkMocks.workspaceMcpResources.mockResolvedValueOnce({
      v: 1,
      workspaceCwd: '/mock-workspace',
      serverName: 'docs',
      initialized: true,
      acpChannelLive: true,
      resources: [{ uri: 'file:///docs/intro.md', name: 'Intro' }],
    });
    let actions: DaemonWorkspaceActions | undefined;

    function Harness() {
      const workspace = useOptionalDaemonWorkspace();
      actions = workspace?.actions;
      return null;
    }

    await renderWithProvider(<Harness />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    if (!actions) throw new Error('actions not defined');
    const workspaceActions = actions;

    await act(async () => {
      await expect(
        workspaceActions.loadMcpResources('docs'),
      ).resolves.toMatchObject({
        serverName: 'docs',
        resources: [{ uri: 'file:///docs/intro.md', name: 'Intro' }],
      });
    });
    expect(sdkMocks.workspaceMcpResources).toHaveBeenCalledWith('docs');
  });

  it('propagates MCP resources failures', async () => {
    sdkMocks.workspaceMcpResources.mockRejectedValueOnce(
      new Error('missing route'),
    );
    let actions: DaemonWorkspaceActions | undefined;

    function Harness() {
      const workspace = useOptionalDaemonWorkspace();
      actions = workspace?.actions;
      return null;
    }

    await renderWithProvider(<Harness />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    if (!actions) throw new Error('actions not defined');
    const workspaceActions = actions;

    await act(async () => {
      await expect(
        workspaceActions.loadMcpResources('server-a'),
      ).rejects.toThrow('missing route');
    });
  });

  it('loads workspace glob matches', async () => {
    const fetchMock = vi.fn(
      async (
        _input: RequestInfo | URL,
        _init?: RequestInit,
      ): Promise<Response> =>
        new Response(
          JSON.stringify({ matches: ['src/App.tsx', 42, 'src/index.ts'] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    let actions: DaemonWorkspaceActions | undefined;

    function Harness() {
      const workspace = useOptionalDaemonWorkspace();
      actions = workspace?.actions;
      return null;
    }

    await renderWithProvider(<Harness />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    if (!actions) throw new Error('actions not defined');

    const workspaceActions = actions;

    let result: { matches: string[] } | undefined;
    await act(async () => {
      result = await workspaceActions.globWorkspace('src/*', {
        maxResults: 10,
        includeIgnored: true,
        cwd: 'packages/web-shell',
      });
    });

    expect(result).toEqual({ matches: ['src/App.tsx', 'src/index.ts'] });
  });

  it('actions.deleteSession calls client.deleteSessionsData with single-element array', async () => {
    sdkMocks.deleteSessionsData.mockResolvedValueOnce({
      removed: ['session-123'],
      notFound: [],
      errors: [],
    });
    let actions: DaemonWorkspaceActions | undefined;

    function Harness() {
      const workspace = useOptionalDaemonWorkspace();
      actions = workspace?.actions;
      return null;
    }

    await renderWithProvider(<Harness />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    if (!actions) throw new Error('actions not defined');

    let result: boolean | undefined;
    await act(async () => {
      result = await actions!.deleteSession('session-123');
    });

    expect(result).toBe(true);
    expect(sdkMocks.deleteSessionsData).toHaveBeenCalledWith(['session-123']);
  });

  it('actions.deleteSession throws when result has errors', async () => {
    sdkMocks.deleteSessionsData.mockResolvedValueOnce({
      removed: [],
      notFound: [],
      errors: [{ sessionId: 'session-456', error: 'invalid client id' }],
    });
    let actions: DaemonWorkspaceActions | undefined;

    function Harness() {
      const workspace = useOptionalDaemonWorkspace();
      actions = workspace?.actions;
      return null;
    }

    await renderWithProvider(<Harness />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    if (!actions) throw new Error('actions not defined');

    await act(async () => {
      await expect(actions!.deleteSession('session-456')).rejects.toThrow(
        'invalid client id',
      );
    });
  });

  it('actions.deleteSessions calls client.deleteSessionsData', async () => {
    const batchResult = {
      removed: ['s-1', 's-2'],
      notFound: ['s-3'],
      errors: [] as Array<{ sessionId: string; error: string }>,
    };
    sdkMocks.deleteSessionsData.mockResolvedValueOnce(batchResult);
    let actions: DaemonWorkspaceActions | undefined;

    function Harness() {
      const workspace = useOptionalDaemonWorkspace();
      actions = workspace?.actions;
      return null;
    }

    await renderWithProvider(<Harness />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    if (!actions) throw new Error('actions not defined');

    let result: typeof batchResult | undefined;
    await act(async () => {
      result = await actions!.deleteSessions(['s-1', 's-2', 's-3']);
    });

    expect(result).toEqual(batchResult);
    expect(sdkMocks.deleteSessionsData).toHaveBeenCalledWith([
      's-1',
      's-2',
      's-3',
    ]);
  });

  it('actions.exportSession calls client.exportSession for a session', async () => {
    let actions: DaemonWorkspaceActions | undefined;

    function Harness() {
      const workspace = useOptionalDaemonWorkspace();
      actions = workspace?.actions;
      return null;
    }

    await renderWithProvider(<Harness />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    if (!actions) throw new Error('actions not defined');

    const workspaceActions = actions as DaemonWorkspaceActions & {
      exportSession(
        sessionId: string,
        format?: 'html',
      ): Promise<{
        content: string;
        filename: string;
        mimeType: string;
        format: string;
      }>;
    };
    let result:
      | {
          content: string;
          filename: string;
          mimeType: string;
          format: string;
        }
      | undefined;
    await act(async () => {
      result = await workspaceActions.exportSession('session-123', 'html');
    });

    expect(result).toEqual({
      content: '<html>export</html>',
      filename: 'session.html',
      mimeType: 'text/html',
      format: 'html',
    });
    expect(sdkMocks.exportSession).toHaveBeenCalledWith('session-123', {
      format: 'html',
    });
  });

  it('useDaemonSessions exposes exportSession', async () => {
    let exportSession:
      | ReturnType<typeof useDaemonSessions>['exportSession']
      | undefined;

    function Harness() {
      exportSession = useDaemonSessions({
        autoLoad: false,
      }).exportSession;
      return null;
    }

    await renderWithProvider(<Harness />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    if (!exportSession) throw new Error('exportSession not defined');
    const runExportSession = exportSession;

    await act(async () => {
      await runExportSession('session-456', 'jsonl');
    });

    expect(sdkMocks.exportSession).toHaveBeenCalledWith('session-456', {
      format: 'jsonl',
    });
  });

  it('useDaemonSessions exposes session list page metadata', async () => {
    const session = {
      sessionId: 'session-123',
      workspaceCwd: '/mock-workspace',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      displayName: 'Session 123',
      clientCount: 0,
      hasActivePrompt: false,
    };
    sdkMocks.listWorkspaceSessionsPage.mockResolvedValueOnce({
      sessions: [session],
      nextCursor: 'next-page',
      liveMergeFailed: true,
      truncated: true,
    });
    let result: ReturnType<typeof useDaemonSessions> | undefined;

    function Harness() {
      result = useDaemonSessions({
        autoLoad: true,
        view: 'organized',
        group: 'all',
        cursor: 'cursor-1',
        pageSize: 10,
        sourceType: 'default',
      });
      return null;
    }

    await renderWithProvider(<Harness />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(sdkMocks.listWorkspaceSessionsPage).toHaveBeenCalledWith(
      '/mock-workspace',
      {
        pageSize: 10,
        cursor: 'cursor-1',
        view: 'organized',
        group: 'all',
        sourceType: 'default',
      },
    );
    expect(result?.data).toEqual([session]);
    expect(result?.sessions).toEqual([session]);
    expect(result?.nextCursor).toBe('next-page');
    expect(result?.liveMergeFailed).toBe(true);
    expect(result?.truncated).toBe(true);

    sdkMocks.listWorkspaceSessionsPage.mockResolvedValueOnce({
      sessions: [session],
      nextCursor: 'after-reload',
    });
    let reloaded:
      | Awaited<ReturnType<ReturnType<typeof useDaemonSessions>['reload']>>
      | undefined;
    await act(async () => {
      reloaded = await result?.reload();
    });
    expect(reloaded).toEqual([session]);
  });

  it('actions.loadDaemonStatus forwards the detail level to client.daemonStatus', async () => {
    const report = {
      v: 1,
      detail: 'full',
      status: 'warning',
      issues: [
        {
          code: 'pending_permissions',
          severity: 'warning',
          message: '2 pending permissions',
        },
      ],
    };
    sdkMocks.daemonStatus.mockResolvedValueOnce(report);
    let actions: DaemonWorkspaceActions | undefined;

    function Harness() {
      const workspace = useOptionalDaemonWorkspace();
      actions = workspace?.actions;
      return null;
    }

    await renderWithProvider(<Harness />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    if (!actions) throw new Error('actions not defined');

    let result: unknown;
    await act(async () => {
      result = await actions!.loadDaemonStatus('full');
    });

    expect(result).toEqual(report);
    expect(sdkMocks.daemonStatus).toHaveBeenCalledWith('full');
  });
});
