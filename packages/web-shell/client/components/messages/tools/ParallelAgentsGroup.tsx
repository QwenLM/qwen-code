import { useEffect, useState } from 'react';
import type { ACPToolCall, PermissionRequest } from '../../../adapters/types';
import { useI18n } from '../../../i18n';
import { formatElapsed, StatusIcon, truncateText } from './toolDisplay';
import {
  getTaskExecutionRecord,
  getAgentType,
  getAgentDescription,
  formatTokenCount,
  getAgentCancellationReason,
  getAgentDisplayStatus,
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

function getCurrentToolHint(agent: ACPToolCall): string {
  if (agent.status !== 'in_progress') return '';
  const subs = agent.subTools;
  if (!subs || subs.length === 0) return '';
  const last = subs[subs.length - 1];
  if (last.status !== 'in_progress' && last.status !== 'pending') return '';
  let hint = last.toolName;
  if (last.title) {
    const colonIdx = last.title.indexOf(': ');
    hint += ' ' + (colonIdx > 0 ? last.title.slice(colonIdx + 2) : last.title);
  } else if (last.args?.command) {
    hint += ' ' + (last.args.command as string);
  } else if (last.args?.file_path) {
    hint += ' ' + (last.args.file_path as string);
  }
  return truncateText(hint, 50);
}

function toolMatchesApprovalId(tool: ACPToolCall, toolCallId: string): boolean {
  if (tool.callId === toolCallId) return true;
  if (tool.subTools) {
    return tool.subTools.some((sub) => toolMatchesApprovalId(sub, toolCallId));
  }
  return false;
}

export function ParallelAgentsGroup({
  agents,
  pendingApproval,
  onConfirm,
}: ParallelAgentsGroupProps) {
  const { t } = useI18n();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const hasRunning = agents.some((a) => a.status === 'in_progress');
  useEffect(() => {
    if (!hasRunning) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasRunning]);

  const doneCount = agents.filter(
    (a) => a.status === 'completed' || a.status === 'failed',
  ).length;
  const total = agents.length;

  const approvalAgent = pendingApproval?.toolCallId
    ? agents.find((a) => toolMatchesApprovalId(a, pendingApproval.toolCallId!))
    : undefined;

  return (
    <div className={styles.group}>
      <div className={styles.header}>
        <span>{t('parallelAgents.title')}</span>
        <span className={styles.headerDot}>·</span>
        <span className={styles.headerTotal}>{total}</span>
        <span className={styles.headerDot}>·</span>
        <span className={styles.headerCount}>
          {t('parallelAgents.done', { done: doneCount, total })}
        </span>
      </div>
      <div className={styles.list}>
        {agents.map((agent) => {
          const agentType = getAgentType(agent);
          const desc = getAgentDescription(agent);
          const toolHint = getCurrentToolHint(agent);
          const stats = getAgentStats(agent, now);
          const status = getAgentDisplayStatus(agent);
          const isExpanded = expandedId === agent.callId;
          return (
            <div key={agent.callId}>
              <div
                className={styles.row}
                onClick={() => setExpandedId(isExpanded ? null : agent.callId)}
              >
                <StatusIcon status={status} />
                <span className={styles.rowDesc}>
                  {truncateText(desc || agentType, 50)}
                  {toolHint && (
                    <span className={styles.rowTool}>{` (${toolHint})`}</span>
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
  );
}
