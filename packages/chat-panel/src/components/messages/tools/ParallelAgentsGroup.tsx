import { useEffect, useRef, useState } from 'react';
import type { ACPToolCall, PermissionRequest } from '../../../adapters/types';
import { useI18n } from '../../../i18n';
import {
  formatElapsed,
  formatLiveElapsed,
  StatusIcon,
  truncateText,
} from './toolDisplay';
import {
  getTaskExecutionRecord,
  getAgentType,
  getAgentDescription,
  getAgentCurrentToolHint,
  formatTokenCount,
  getAgentCancellationReason,
  getAgentDisplayStatus,
  toolContainsCallId,
} from '../toolFormatting';
import { SubAgentPanel } from './SubAgentPanel';
import { ToolApproval } from '../ToolApproval';
import styles from './ParallelAgentsGroup.module.css';

interface ParallelAgentsGroupProps {
  agents: ACPToolCall[];
  pendingApproval?: PermissionRequest | null;
  onConfirm?: (
    id: string,
    selectedOption: string,
    answers?: Record<string, string>,
  ) => void;
}

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
}

function getAgentStats(agent: ACPToolCall, now: number): string {
  const parts: string[] = [];
  const taskExec = getTaskExecutionRecord(agent.rawOutput);
  const stats = taskExec?.['executionSummary'] as
    | Record<string, unknown>
    | undefined;
  const elapsed =
    stats && typeof stats['totalDurationMs'] === 'number'
      ? formatDuration(stats['totalDurationMs'])
      : formatElapsed(
          agent.startTime,
          agent.endTime ?? (agent.status === 'in_progress' ? now : undefined),
        );
  if (elapsed) parts.push(elapsed);
  const tokens =
    taskExec &&
    typeof taskExec['tokenCount'] === 'number' &&
    taskExec['tokenCount'] > 0
      ? (taskExec['tokenCount'] as number)
      : stats &&
          typeof stats['totalTokens'] === 'number' &&
          stats['totalTokens'] > 0
        ? (stats['totalTokens'] as number)
        : 0;
  if (tokens > 0) {
    parts.push(formatTokenCount(tokens));
  }
  const reason = getAgentCancellationReason(agent);
  if (reason) parts.push(truncateText(reason, 80));
  return parts.join(' · ');
}

function ToolGroupIcon() {
  return (
    <svg
      className={styles.summaryToolIcon}
      width="14"
      height="14"
      viewBox="0 0 1024 1024"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        d="M770.08 96.32c1.728.64 3.072 1.984 3.712 3.712l38.848 107.584c.64 1.728 1.984 3.104 3.712 3.712l107.584 38.848a6.144 6.144 0 0 1 0 11.584l-107.584 38.848a6.144 6.144 0 0 0-3.712 3.712l-38.848 107.584a6.144 6.144 0 0 1-11.584 0L723.36 304.32a6.144 6.144 0 0 0-3.712-3.712L612.064 261.76a6.144 6.144 0 0 1 0-11.584l107.584-38.848a6.144 6.144 0 0 0 3.712-3.712l38.848-107.584c1.184-3.2 4.704-4.8 7.872-3.68zM576 160H384q-119.296 0-203.648 84.352Q96 328.704 96 448v192q0 119.296 84.352 203.648Q264.704 928 384 928h256q119.296 0 203.648-84.352Q928 759.296 928 640V512h-64v128q0 92.8-65.6 158.4Q732.8 864 640 864H384q-92.8 0-158.4-65.6Q160 732.8 160 640V448q0-92.8 65.6-158.4Q291.2 224 384 224h192v-64zm96 248.224L568.224 512 672 615.776l45.248-45.28L658.752 512l58.496-58.496L672 408.224zM320 608V448h64v160h-64z"
        stroke="currentColor"
        strokeWidth="28"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ParallelAgentsGroup({
  agents,
  pendingApproval,
  onConfirm,
}: ParallelAgentsGroupProps) {
  const { t } = useI18n();
  const [groupExpanded, setGroupExpanded] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const liveStartedAtRef = useRef(Date.now());

  const hasRunning = agents.some((a) => a.status === 'in_progress');

  useEffect(() => {
    if (!hasRunning) return;
    liveStartedAtRef.current = Date.now();
    setNow(Date.now());
  }, [hasRunning]);

  useEffect(() => {
    if (!hasRunning) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasRunning]);
  const runningDuration = hasRunning
    ? formatLiveElapsed(now - liveStartedAtRef.current)
    : '';

  const doneCount = agents.filter(
    (a) => a.status === 'completed' || a.status === 'failed',
  ).length;
  const total = agents.length;

  const approvalAgent = pendingApproval?.toolCallId
    ? agents.find((a) => toolContainsCallId(a, pendingApproval.toolCallId!))
    : undefined;
  const showGroup = groupExpanded || !!approvalAgent;
  const summaryStatus = agents.some(
    (a) => getAgentDisplayStatus(a) === 'failed',
  )
    ? 'failed'
    : hasRunning
      ? 'in_progress'
      : 'completed';

  return (
    <div className={styles.wrap}>
      <button
        type="button"
        className={styles.summary}
        onClick={() => setGroupExpanded((value) => !value)}
        aria-expanded={showGroup}
        title={showGroup ? t('tool.collapseHint') : t('tool.expand')}
      >
        <span className={styles.summaryIcon} aria-hidden="true">
          {summaryStatus === 'failed' ? (
            <StatusIcon status={summaryStatus} />
          ) : (
            <ToolGroupIcon />
          )}
        </span>
        <span
          className={
            hasRunning
              ? `${styles.summaryText} ${styles.summaryTextActive}`
              : styles.summaryText
          }
        >
          {t('parallelAgents.title')}
          {runningDuration && <> {runningDuration}</>}
          <span className={styles.summaryDot}>·</span>
          {t('parallelAgents.done', { done: doneCount, total })}
        </span>
        <span
          className={showGroup ? styles.chevronDown : styles.chevronRight}
          aria-hidden="true"
        />
      </button>
      {showGroup && (
        <div className={styles.group}>
          <div className={styles.list}>
            {agents.map((agent) => {
              const agentType = getAgentType(agent);
              const desc = getAgentDescription(agent);
              const toolHint = getAgentCurrentToolHint(agent, t);
              const stats = getAgentStats(agent, now);
              const status = getAgentDisplayStatus(agent);
              const isExpanded = expandedId === agent.callId;
              return (
                <div key={agent.callId}>
                  <div
                    className={styles.row}
                    onClick={() =>
                      setExpandedId(isExpanded ? null : agent.callId)
                    }
                  >
                    <StatusIcon status={status} />
                    <span className={styles.rowDesc}>
                      {truncateText(desc || agentType, 50)}
                      {toolHint && (
                        <span
                          className={styles.rowTool}
                        >{` (${toolHint})`}</span>
                      )}
                    </span>
                    {stats && <span className={styles.rowStats}>{stats}</span>}
                  </div>
                  {isExpanded && (
                    <div className={styles.detail}>
                      <SubAgentPanel tool={agent} hideHeader />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {approvalAgent && pendingApproval && onConfirm && (
            <ToolApproval request={pendingApproval} onConfirm={onConfirm} />
          )}
        </div>
      )}
    </div>
  );
}
