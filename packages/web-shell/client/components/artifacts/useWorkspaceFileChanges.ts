import { useEffect, useMemo, useState } from 'react';
import type { DaemonSessionArtifact } from '@qwen-code/sdk/daemon';
import {
  useConnection,
  useWorkspace,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { useDaemonAvailability } from '../../daemon/availability-context';
import type { ACPToolCall, Message } from '../../adapters/types';
import { getFileChangesByTurn, getToolFilePath } from './turnOutputSelectors';
import type { TurnOutputFileChange } from './TurnOutputs';
import {
  filterWorkspaceFileChanges,
  fileChangeOwnerSessionId,
  loadGitIgnoredChangePaths,
  workspaceRelativeChangePath,
} from './workspace-file-changes';

function completedEditIds(messages: readonly Message[], cwd: string): string[] {
  const ids: string[] = [];
  const visit = (tool: ACPToolCall) => {
    if (
      tool.status === 'completed' &&
      ['edit', 'write_file'].includes(tool.toolName.toLowerCase()) &&
      workspaceRelativeChangePath(getToolFilePath(tool) ?? '', cwd) !==
        undefined
    )
      ids.push(tool.callId);
    tool.subTools?.forEach(visit);
  };
  for (const message of messages) {
    if (message.role === 'tool_group') message.tools.forEach(visit);
  }
  return ids;
}

export function useWorkspaceFileChanges(
  messages: readonly Message[],
  artifactsByTurn: ReadonlyMap<string, readonly DaemonSessionArtifact[]>,
  workspaceCwd: string,
  sessionId?: string,
  gitCwd?: string | null,
) {
  const workspace = useWorkspace();
  const { client } = workspace;
  const connection = useConnection();
  const ownerSessionId = sessionId
    ? fileChangeOwnerSessionId(sessionId)
    : undefined;
  const available = useDaemonAvailability() === 'available';
  const supported = workspace.capabilities?.features?.includes(
    'workspace_git_check_ignore',
  );
  const sourceChanges = useMemo(
    () => getFileChangesByTurn(messages, artifactsByTurn, workspaceCwd),
    [messages, artifactsByTurn, workspaceCwd],
  );
  const hasChanges = sourceChanges.size > 0;
  const directoryKey = JSON.stringify([workspaceCwd, sessionId]);
  const [directory, setDirectory] = useState<{
    key: string;
    client: typeof client;
    cwd: string | null;
  }>();
  useEffect(() => {
    if (
      gitCwd !== undefined ||
      !hasChanges ||
      !available ||
      connection.status !== 'connected' ||
      connection.loadingTranscript ||
      !sessionId
    )
      return;
    let active = true;
    void (async () => {
      const summary = ownerSessionId
        ? await client.sessionStatus(ownerSessionId)
        : undefined;
      return summary ? (summary.worktree?.path ?? workspaceCwd) : null;
    })()
      .catch(() => null)
      .then((cwd) => {
        if (active) setDirectory({ key: directoryKey, client, cwd });
      });
    return () => {
      active = false;
    };
  }, [
    gitCwd,
    hasChanges,
    available,
    connection.status,
    connection.loadingTranscript,
    sessionId,
    ownerSessionId,
    client,
    workspaceCwd,
    directoryKey,
  ]);
  // Undefined awaits metadata; null is a settled containment-only fallback.
  const executionCwd =
    gitCwd !== undefined
      ? gitCwd
      : directory?.key === directoryKey && directory.client === client
        ? directory.cwd
        : undefined;
  const pending = supported && executionCwd === undefined;
  const enabled = supported && typeof executionCwd === 'string';
  const cwd = executionCwd ?? workspaceCwd;
  const scope = JSON.stringify([workspaceCwd, cwd, sessionId]);
  const contained = useMemo(
    () =>
      cwd ? filterWorkspaceFileChanges(sourceChanges, cwd) : sourceChanges,
    [sourceChanges, cwd],
  );
  const key = JSON.stringify({
    workspaceCwd,
    cwd,
    sessionId,
    editIds: completedEditIds(messages, cwd),
    paths: Array.from(
      new Set(
        Array.from(contained.values())
          .flat()
          .flatMap((change) => {
            const path = workspaceRelativeChangePath(change.path, cwd);
            return path === undefined ? [] : [path];
          }),
      ),
    ),
  });
  const paths = useMemo(
    () => (JSON.parse(key) as { paths: string[] }).paths,
    [key],
  );
  const [verdict, setVerdict] = useState<{
    scope: string;
    client: typeof client;
    ignored: ReadonlySet<string>;
    known: ReadonlySet<string>;
  }>();

  useEffect(() => {
    if (
      !enabled ||
      !available ||
      connection.status !== 'connected' ||
      paths.length === 0
    )
      return;
    let active = true;
    void (async () => {
      const ignored = await loadGitIgnoredChangePaths(paths, async (batch) => {
        if (!active) return { ignoredPaths: [] };
        return client
          .workspaceByCwd(workspaceCwd)
          .workspaceGitIgnoredPaths(
            batch,
            cwd === workspaceCwd ? undefined : cwd,
            ownerSessionId,
          );
      });
      if (active) setVerdict({ scope, client, ignored, known: new Set(paths) });
    })().catch(() => {
      // An unavailable ignore verdict must not hide a potentially valid edit.
      if (active)
        setVerdict({
          scope,
          client,
          ignored: new Set(),
          known: new Set(paths),
        });
    });
    return () => {
      active = false;
    };
  }, [
    client,
    enabled,
    available,
    connection.status,
    paths,
    key,
    scope,
    workspaceCwd,
    cwd,
    ownerSessionId,
  ]);

  return useMemo(
    () =>
      !workspace.capabilities || pending
        ? new Map<string, readonly TurnOutputFileChange[]>()
        : !enabled || paths.length === 0
          ? contained
          : verdict?.scope === scope && verdict.client === client
            ? filterWorkspaceFileChanges(
                contained,
                cwd,
                verdict.ignored,
                verdict.known,
              )
            : new Map<string, readonly TurnOutputFileChange[]>(),
    [
      contained,
      cwd,
      verdict,
      client,
      scope,
      enabled,
      paths.length,
      workspace.capabilities,
      pending,
    ],
  );
}
