import { useState } from 'react';
import type { ACPToolCall, PermissionRequest } from '../../../adapters/types';
import { StatusIcon, truncateText } from './toolDisplay';
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

function getAgentDescription(agent: ACPToolCall): string {
  if (agent.title) {
    const colonIdx = agent.title.indexOf(': ');
    return colonIdx > 0 ? agent.title.slice(colonIdx + 2) : agent.title;
  }
  const desc = agent.args?.description;
  if (typeof desc === 'string' && desc.trim()) return desc.trim();
  const prompt = agent.args?.prompt;
  if (typeof prompt === 'string' && prompt.trim()) {
    return prompt.trim().split('\n')[0] ?? '';
  }
  return agent.toolName;
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

export function ParallelAgentsGroup({
  agents,
  pendingApproval,
  onConfirm,
}: ParallelAgentsGroupProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const doneCount = agents.filter(
    (a) => a.status === 'completed' || a.status === 'failed',
  ).length;
  const total = agents.length;

  const approvalAgent = pendingApproval?.toolCallId
    ? agents.find((a) => a.callId === pendingApproval.toolCallId)
    : undefined;

  return (
    <div className={styles.group}>
      <div className={styles.header}>
        <span>Parallel agents</span>
        <span className={styles.headerDot}>·</span>
        <span className={styles.headerCount}>
          {doneCount}/{total} done
        </span>
      </div>
      <div className={styles.list}>
        {agents.map((agent, i) => {
          const desc = getAgentDescription(agent);
          const toolHint = getCurrentToolHint(agent);
          const isExpanded = expandedId === agent.callId;
          return (
            <div key={agent.callId}>
              <div
                className={styles.row}
                onClick={() => setExpandedId(isExpanded ? null : agent.callId)}
              >
                <StatusIcon status={agent.status} />
                <span className={styles.rowIndex}>{i + 1}:</span>
                <span className={styles.rowDesc}>{truncateText(desc, 40)}</span>
                {toolHint && <span className={styles.rowTool}>{toolHint}</span>}
              </div>
              {isExpanded && (
                <div className={styles.detail}>
                  <SubAgentPanel tool={agent} />
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
