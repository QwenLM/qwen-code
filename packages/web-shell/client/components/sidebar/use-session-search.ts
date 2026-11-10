/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import type { DaemonClient, DaemonSessionSummary } from '@qwen-code/sdk/daemon';
import { sessionMatchesGitQuery, sessionMatchesSource } from './sessionSearch';

export interface SessionSearchEntry {
  session: DaemonSessionSummary;
  workspaceCwd?: string;
  snippet?: string;
}

export interface SessionSearchOptions {
  client: DaemonClient | undefined;
  workspaces: readonly {
    cwd: string;
    trusted?: boolean;
    displayName?: string;
  }[];
  initialSessions: readonly DaemonSessionSummary[];
  primaryWorkspaceCwd?: string;
  includeStandalone: boolean;
  source?: string;
  organizationEnabled: boolean;
  qualified: boolean;
  query: string;
}

function matchesSource(entry: SessionSearchEntry, source: string | undefined) {
  return entry.workspaceCwd === undefined
    ? source === undefined || source === 'default' || source === 'standalone'
    : sessionMatchesSource(entry.session, source);
}

export function useSessionSearch({
  client,
  workspaces,
  initialSessions,
  primaryWorkspaceCwd,
  includeStandalone,
  source,
  organizationEnabled,
  qualified,
  query,
}: SessionSearchOptions) {
  const workspaceKey = JSON.stringify(
    [
      ...new Set(
        workspaces
          .filter((item) => item.trusted !== false)
          .map((item) => item.cwd),
      ),
    ].sort(),
  );
  let normalizedQuery = query.trim().slice(0, 200);
  if (/[\uD800-\uDBFF]$/.test(normalizedQuery)) {
    normalizedQuery = normalizedQuery.slice(0, -1);
  }
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([
    workspaceKey,
    primaryWorkspaceCwd,
    includeStandalone,
    source,
    organizationEnabled,
    qualified,
    normalizedQuery,
    attempt,
  ]);
  const [state, setState] = useState<{
    key: string;
    client: DaemonClient | undefined;
    entries: SessionSearchEntry[];
    loading: boolean;
    failed: boolean;
  }>();

  useEffect(() => {
    const controller = new AbortController();
    const cwds = (JSON.parse(workspaceKey) as string[]).filter(
      (cwd) => qualified || cwd === primaryWorkspaceCwd,
    );
    const entries = new Map<string, SessionSearchEntry>();
    let failed = false;
    const publish = (loading: boolean) => {
      if (!controller.signal.aborted) {
        setState({
          key,
          client,
          entries: [...entries.values()],
          loading,
          failed,
        });
      }
    };
    const add = (entry: SessionSearchEntry) => {
      if (entry.session.isArchived || !matchesSource(entry, source)) return;
      const id = JSON.stringify([entry.workspaceCwd, entry.session.sessionId]);
      const previous = entries.get(id);
      entries.set(id, {
        ...previous,
        ...entry,
        snippet: entry.snippet ?? previous?.snippet,
      });
    };
    publish(Boolean(client));
    const run = async () => {
      if (!client) return;
      const tasks = cwds.map(async (cwd) => {
        if (typeof client.listWorkspaceSessionsPage !== 'function') return;
        let cursor: string | undefined;
        const cursors = new Set<string>();
        do {
          const options = {
            pageSize: 50,
            ...(organizationEnabled
              ? {
                  archiveState: 'active' as const,
                  view: 'organized' as const,
                  group: 'all',
                }
              : {}),
            ...(cursor ? { cursor } : {}),
          };
          const page = await (qualified
            ? client.workspaceByCwd(cwd).listWorkspaceSessionsPage(options)
            : client.listWorkspaceSessionsPage(cwd, options));
          if (controller.signal.aborted) return;
          for (const session of page.sessions)
            add({ session, workspaceCwd: cwd });
          if (page.liveMergeFailed || page.truncated) failed = true;
          publish(true);
          cursor = page.nextCursor;
          if (!normalizedQuery || !cursor || cursors.has(cursor)) break;
          cursors.add(cursor);
        } while (!controller.signal.aborted);
      });
      if (
        includeStandalone &&
        typeof client.listStandaloneSessionsPage === 'function'
      ) {
        tasks.push(
          (async () => {
            let cursor: string | undefined;
            const cursors = new Set<string>();
            do {
              const page = await client.listStandaloneSessionsPage({
                pageSize: 50,
                ...(organizationEnabled
                  ? { archiveState: 'active' as const }
                  : {}),
                ...(cursor ? { cursor } : {}),
              });
              if (controller.signal.aborted) return;
              for (const session of page.sessions) add({ session });
              if (page.liveMergeFailed || page.truncated) failed = true;
              publish(true);
              cursor = page.nextCursor;
              if (!normalizedQuery || !cursor || cursors.has(cursor)) break;
              cursors.add(cursor);
            } while (!controller.signal.aborted);
          })(),
        );
      }
      if (
        normalizedQuery.length >= 2 &&
        typeof client.searchWorkspaceSessions === 'function'
      ) {
        tasks.push(
          ...cwds.map(async (cwd) => {
            const result = await client.searchWorkspaceSessions(
              cwd,
              normalizedQuery,
              {
                signal: controller.signal,
              },
            );
            if (controller.signal.aborted) return;
            for (const hit of result.results)
              add({ ...hit, workspaceCwd: cwd });
            publish(true);
          }),
        );
      }
      await Promise.all(
        tasks.map(async (task) => {
          try {
            await task;
          } catch {
            failed = true;
          }
        }),
      );
      publish(false);
    };
    const timer = setTimeout(() => void run(), normalizedQuery ? 300 : 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    client,
    key,
    workspaceKey,
    primaryWorkspaceCwd,
    includeStandalone,
    source,
    organizationEnabled,
    qualified,
    normalizedQuery,
  ]);

  const allowed = new Set(JSON.parse(workspaceKey) as string[]);
  const current =
    state?.key === key && state.client === client ? state : undefined;
  const merged = new Map<string, SessionSearchEntry>();
  for (const session of initialSessions) {
    const cwd = session.workspaceCwd || primaryWorkspaceCwd;
    if (
      !cwd ||
      !allowed.has(cwd) ||
      (!qualified && cwd !== primaryWorkspaceCwd)
    )
      continue;
    merged.set(JSON.stringify([cwd, session.sessionId]), {
      session,
      workspaceCwd: cwd,
    });
  }
  for (const entry of current?.entries ?? []) {
    merged.set(
      JSON.stringify([entry.workspaceCwd, entry.session.sessionId]),
      entry,
    );
  }
  const needle = normalizedQuery.toLowerCase();
  const entries = [...merged.values()]
    .filter(
      (entry) =>
        !entry.session.isArchived &&
        matchesSource(entry, source) &&
        (!needle ||
          entry.snippet !== undefined ||
          entry.session.displayName?.toLowerCase().includes(needle) ||
          entry.session.sessionId.toLowerCase().includes(needle) ||
          sessionMatchesGitQuery(entry.session, needle)),
    )
    .sort((a, b) => {
      const time = (session: DaemonSessionSummary) =>
        Date.parse(session.updatedAt ?? session.createdAt ?? '') || 0;
      return time(b.session) - time(a.session);
    });
  return {
    entries,
    loading: current?.loading ?? Boolean(client),
    failed: current?.failed ?? false,
    retry: () => setAttempt((value) => value + 1),
  };
}
