import { useEffect, useMemo, useState } from 'react';
import {
  DaemonSessionProvider,
  useConnection,
  useWorkspace,
} from '@qwen-code/webui/daemon-react-sdk';
import type { ACPToolCall, Message } from '../../adapters/types';
import { useMessages } from '../../hooks/useMessages';
import { useI18n } from '../../i18n';
import { MessageList } from '../MessageList';
import { getAgentDescription } from '../messages/toolFormatting';
import { Badge } from '../ui/badge';
import styles from './SubagentDetail.module.css';

interface SubagentResolution {
  sessionId: string;
  status: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
}

interface SubagentMetrics {
  status: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
}

function getSubagentMetrics(
  rootTool: ACPToolCall,
  resolution: SubagentResolution,
): SubagentMetrics {
  const raw =
    typeof rootTool.rawOutput === 'object' && rootTool.rawOutput !== null
      ? (rootTool.rawOutput as Record<string, unknown>)
      : undefined;
  const summary =
    typeof raw?.['executionSummary'] === 'object' &&
    raw['executionSummary'] !== null
      ? (raw['executionSummary'] as Record<string, unknown>)
      : undefined;
  const summaryDuration = summary?.['totalDurationMs'];
  const inputTokens = summary?.['inputTokens'];
  const outputTokens = summary?.['outputTokens'];
  const cachedTokens = summary?.['cachedTokens'];

  return {
    status: resolution.status,
    durationMs:
      typeof summaryDuration === 'number'
        ? summaryDuration
        : rootTool.endTime && rootTool.startTime
          ? Math.max(0, rootTool.endTime - rootTool.startTime)
          : resolution.durationMs,
    inputTokens:
      typeof inputTokens === 'number' ? inputTokens : resolution.inputTokens,
    outputTokens:
      typeof outputTokens === 'number' ? outputTokens : resolution.outputTokens,
    cachedTokens:
      typeof cachedTokens === 'number' ? cachedTokens : resolution.cachedTokens,
  };
}

function createDetailClientId(): string {
  const suffix =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `subagent-detail:${suffix}`;
}

export function findSubagentRootTool(
  messages: readonly Message[],
  rootToolCallId: string,
): ACPToolCall | undefined {
  for (const message of messages) {
    if (message.role !== 'tool_group') continue;
    const tool = message.tools.find(
      (candidate) => candidate.callId === rootToolCallId,
    );
    if (tool) return tool;
  }
  return undefined;
}

export function getSubagentPrompt(
  messages: readonly Message[],
  rootTool: ACPToolCall,
): string {
  const firstUserMessage = messages.find((message) => message.role === 'user');
  return (
    (firstUserMessage?.role === 'user' ? firstUserMessage.content : '') ||
    (typeof rootTool.args?.prompt === 'string' ? rootTool.args.prompt : '')
  );
}

function statusLabel(status: string, t: ReturnType<typeof useI18n>['t']) {
  switch (status) {
    case 'completed':
    case 'success':
      return t('subagent.completed');
    case 'failed':
    case 'error':
      return t('subagent.failed');
    case 'cancelled':
    case 'canceled':
      return t('subagent.cancelled');
    case 'paused':
      return t('subagent.paused');
    default:
      return t('subagent.running');
  }
}

function SubagentDetailContent({
  rootTool,
  resolution,
  onStop,
}: {
  rootTool: ACPToolCall;
  resolution: SubagentResolution;
  onStop: () => Promise<{ cancelled: boolean }>;
}) {
  const { t } = useI18n();
  const connection = useConnection();
  const messages = useMessages(t);
  const description = getAgentDescription(rootTool);
  const prompt = getSubagentPrompt(messages, rootTool);
  const metrics = useMemo(
    () => getSubagentMetrics(rootTool, resolution),
    [resolution, rootTool],
  );
  const isRunning =
    metrics.status === 'running' || metrics.status === 'in_progress';
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState('');

  useEffect(() => {
    if (isRunning) return;
    setStopping(false);
    setStopError('');
  }, [isRunning]);

  const handleStop = async () => {
    if (stopping) return;
    setStopping(true);
    setStopError('');
    try {
      const result = await onStop();
      if (!result.cancelled) {
        setStopping(false);
      }
    } catch {
      setStopping(false);
      setStopError(t('tasks.cancelFailed'));
    }
  };

  return (
    <div className={styles.detail}>
      <div className={styles.overview}>
        <div className={styles.descriptionRow}>
          {description && (
            <div className={styles.description}>{description}</div>
          )}
          <div className={styles.statusActions}>
            <Badge
              variant="outline"
              className={styles.statusTag}
              data-status={metrics.status}
            >
              {statusLabel(metrics.status, t)}
            </Badge>
            {isRunning && (
              <button
                type="button"
                className={styles.stopButton}
                disabled={stopping}
                onClick={() => void handleStop()}
              >
                {stopping ? t('common.loading') : t('tasks.action.stop')}
              </button>
            )}
          </div>
        </div>
        {stopError && <div className={styles.stopError}>{stopError}</div>}
        {prompt && <pre className={styles.prompt}>{prompt}</pre>}
      </div>
      <div className={styles.transcript}>
        <MessageList
          messages={messages}
          pendingApproval={null}
          loadingTranscript={connection.loadingTranscript}
          isResponding={isRunning}
          workspaceCwd={connection.workspaceCwd || ''}
          hideSessionTimeline
          hideFirstUserMessage
          firstTurnMetrics={metrics}
          includeSubagentToolUsageInMetrics={false}
        />
      </div>
    </div>
  );
}

export function SubagentDetail({
  sessionId,
  rootToolCallId,
  initialRootTool,
  workspaceCwd,
}: {
  sessionId: string;
  rootToolCallId: string;
  initialRootTool: ACPToolCall;
  workspaceCwd?: string;
}) {
  const { t } = useI18n();
  const workspace = useWorkspace();
  const parentConnection = useConnection();
  const parentMessages = useMessages(t);
  const rootTool =
    (parentConnection.sessionId === sessionId
      ? findSubagentRootTool(parentMessages, rootToolCallId)
      : undefined) ?? initialRootTool;
  const [instance, setInstance] = useState(() => ({
    key: 0,
    clientId: createDetailClientId(),
  }));
  const [resolution, setResolution] = useState<SubagentResolution>();
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let hasResolved = false;
    let retryCount = 0;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    setResolution(undefined);
    setLoadError(false);
    const refresh = async () => {
      try {
        // @ts-expect-error resolveSubagentSession exists in SDK source, not in stale dist
        const resolved = await workspace.client.resolveSubagentSession(
          sessionId,
          rootToolCallId,
        );
        if (cancelled) return;
        hasResolved = true;
        setResolution(resolved);
        if (resolved.status === 'running') {
          refreshTimer = setTimeout(() => void refresh(), 3_000);
        }
      } catch {
        if (cancelled) return;
        if (!hasResolved && retryCount < 3) {
          retryCount += 1;
          refreshTimer = setTimeout(() => void refresh(), 3_000);
        } else if (!hasResolved) {
          setLoadError(true);
        } else {
          refreshTimer = setTimeout(() => void refresh(), 3_000);
        }
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [instance.key, rootToolCallId, sessionId, workspace.client]);

  if (loadError) {
    return (
      <div className={styles.state}>
        <div>{t('subagent.detailsLoadFailed')}</div>
        <button
          type="button"
          className={styles.retry}
          onClick={() =>
            setInstance((current) => ({
              key: current.key + 1,
              clientId: createDetailClientId(),
            }))
          }
        >
          {t('common.retry')}
        </button>
      </div>
    );
  }
  if (!resolution) {
    return <div className={styles.state}>{t('subagent.detailsLoading')}</div>;
  }

  return (
    <DaemonSessionProvider
      key={`${instance.key}:${resolution.sessionId}`}
      sessionId={resolution.sessionId}
      workspaceCwd={workspaceCwd}
      clientId={instance.clientId}
      maxQueued={256}
      // @ts-expect-error subagentTranscriptMode exists in webui source, not in stale dist
      subagentTranscriptMode="full"
      suppressOwnUserEcho
    >
      <SubagentDetailContent
        rootTool={rootTool}
        resolution={resolution}
        onStop={() =>
          // @ts-expect-error cancelSubagentSession exists in SDK source, not in stale dist
          workspace.client.cancelSubagentSession(sessionId, rootToolCallId)
        }
      />
    </DaemonSessionProvider>
  );
}
