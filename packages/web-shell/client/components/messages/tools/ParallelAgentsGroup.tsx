import { useEffect, useRef, useState } from 'react';
import type { ACPToolCall, PermissionRequest } from '../../../adapters/types';
import { hasActiveAgents } from '../../../adapters/toolClassification';
import { useI18n } from '../../../i18n';
import { useSubagentDetails } from '../../../subagentDetailsContext';
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
  isActiveToolStatus,
  localizeAgentTypeName,
  toolContainsCallId,
} from '../toolFormatting';
import { SubAgentPanel } from './SubAgentPanel';
import styles from './ParallelAgentsGroup.module.css';

interface ParallelAgentsGroupProps {
  agents: ACPToolCall[];
  autoManageExpansion?: boolean;
  automaticCollapseDelayMs?: number;
  deferAutomaticCollapse?: boolean;
  expandActiveWhenLive?: boolean;
  onAutomaticExpansionChange?: (expanded: boolean) => void;
  pendingApproval?: PermissionRequest | null;
}

const AUTO_COLLAPSE_DELAY_MS = 1_500;
const AUTO_COLLAPSE_ANIMATION_MS = 180;

function automaticCollapseAnimationMs(): number {
  return typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ? 0
    : AUTO_COLLAPSE_ANIMATION_MS;
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
          typeof stats['outputTokens'] === 'number' &&
          stats['outputTokens'] > 0
        ? (stats['outputTokens'] as number)
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
  autoManageExpansion = false,
  automaticCollapseDelayMs = AUTO_COLLAPSE_DELAY_MS,
  deferAutomaticCollapse = false,
  expandActiveWhenLive = false,
  onAutomaticExpansionChange,
  pendingApproval,
}: ParallelAgentsGroupProps) {
  const { t } = useI18n();
  const subagentDetails = useSubagentDetails();
  const [groupExpanded, setGroupExpanded] = useState(false);
  const [automaticCollapseAnimating, setAutomaticCollapseAnimating] =
    useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const liveStartedAtRef = useRef(Date.now());
  const expansionOwnerRef = useRef<'none' | 'automatic' | 'manual'>('none');
  const automaticExpansionChangeRef = useRef(onAutomaticExpansionChange);
  automaticExpansionChangeRef.current = onAutomaticExpansionChange;
  const autoCollapseTimerRef = useRef<
    ReturnType<typeof setTimeout> | undefined
  >(undefined);
  const autoCollapseAnimationTimerRef = useRef<
    ReturnType<typeof setTimeout> | undefined
  >(undefined);

  const hasActive = hasActiveAgents(agents);
  const activeStartedAt = agents.reduce<number | undefined>(
    (earliest, agent) => {
      if (
        !isActiveToolStatus(agent.status) ||
        typeof agent.startTime !== 'number'
      ) {
        return earliest;
      }
      return earliest === undefined
        ? agent.startTime
        : Math.min(earliest, agent.startTime);
    },
    undefined,
  );
  const approvalAgent = pendingApproval?.toolCallId
    ? agents.find((agent) =>
        toolContainsCallId(agent, pendingApproval.toolCallId!),
      )
    : undefined;
  const hasApprovalAgent = !!approvalAgent;
  const approvalAgentRef = useRef(approvalAgent);
  approvalAgentRef.current = approvalAgent;

  const wasActiveRef = useRef(false);
  const wasAutoManageExpansionRef = useRef(autoManageExpansion);
  const wasExpandActiveWhenLiveRef = useRef(expandActiveWhenLive);
  const previousAutomaticCollapseDelayRef = useRef(automaticCollapseDelayMs);
  const wasDeferringAutomaticCollapseRef = useRef(deferAutomaticCollapse);
  useEffect(() => {
    const wasActive = wasActiveRef.current;
    const wasAutoManaging = wasAutoManageExpansionRef.current;
    const wasExpandActiveWhenLive = wasExpandActiveWhenLiveRef.current;
    const collapseDelayChanged =
      previousAutomaticCollapseDelayRef.current !== automaticCollapseDelayMs;
    const wasDeferringAutomaticCollapse =
      wasDeferringAutomaticCollapseRef.current;
    // Latch the anchor on the false->true edge: re-anchoring while agents
    // finish would rewind the header clock to a later start time.
    if (hasActive && !wasActive) {
      liveStartedAtRef.current = activeStartedAt ?? Date.now();
      setNow(Date.now());
    }

    if (
      hasActive ||
      !autoManageExpansion ||
      deferAutomaticCollapse ||
      collapseDelayChanged
    ) {
      clearTimeout(autoCollapseTimerRef.current);
      autoCollapseTimerRef.current = undefined;
    }
    if (hasActive || !autoManageExpansion || deferAutomaticCollapse) {
      clearTimeout(autoCollapseAnimationTimerRef.current);
      autoCollapseAnimationTimerRef.current = undefined;
      if (
        automaticCollapseAnimating &&
        expansionOwnerRef.current === 'automatic'
      ) {
        setAutomaticCollapseAnimating(false);
        setGroupExpanded(true);
      }
    }
    if (
      hasApprovalAgent &&
      automaticCollapseAnimating &&
      expansionOwnerRef.current === 'automatic'
    ) {
      clearTimeout(autoCollapseAnimationTimerRef.current);
      autoCollapseAnimationTimerRef.current = undefined;
      expansionOwnerRef.current = 'none';
      setAutomaticCollapseAnimating(false);
      automaticExpansionChangeRef.current?.(false);
    }
    if (autoManageExpansion && expansionOwnerRef.current !== 'manual') {
      if (
        hasActive &&
        (!wasActive ||
          (expandActiveWhenLive &&
            (!wasAutoManaging || !wasExpandActiveWhenLive)))
      ) {
        expansionOwnerRef.current = 'automatic';
        setGroupExpanded(true);
        automaticExpansionChangeRef.current?.(true);
      } else if (
        !hasActive &&
        !automaticCollapseAnimating &&
        !deferAutomaticCollapse &&
        (wasActive ||
          !wasAutoManaging ||
          wasDeferringAutomaticCollapse ||
          collapseDelayChanged) &&
        expansionOwnerRef.current === 'automatic'
      ) {
        autoCollapseTimerRef.current = setTimeout(() => {
          if (
            !wasActiveRef.current &&
            expansionOwnerRef.current === 'automatic'
          ) {
            setGroupExpanded(false);
            if (approvalAgentRef.current) {
              expansionOwnerRef.current = 'none';
              automaticExpansionChangeRef.current?.(false);
              return;
            }
            const animationMs = automaticCollapseAnimationMs();
            if (animationMs === 0) {
              expansionOwnerRef.current = 'none';
              automaticExpansionChangeRef.current?.(false);
              return;
            }
            setAutomaticCollapseAnimating(true);
            autoCollapseAnimationTimerRef.current = setTimeout(() => {
              autoCollapseAnimationTimerRef.current = undefined;
              if (
                !wasActiveRef.current &&
                expansionOwnerRef.current === 'automatic'
              ) {
                expansionOwnerRef.current = 'none';
                setAutomaticCollapseAnimating(false);
                automaticExpansionChangeRef.current?.(false);
              }
            }, animationMs);
          }
        }, automaticCollapseDelayMs);
      }
    }
    wasActiveRef.current = hasActive;
    wasAutoManageExpansionRef.current = autoManageExpansion;
    wasExpandActiveWhenLiveRef.current = expandActiveWhenLive;
    previousAutomaticCollapseDelayRef.current = automaticCollapseDelayMs;
    wasDeferringAutomaticCollapseRef.current = deferAutomaticCollapse;
  }, [
    activeStartedAt,
    automaticCollapseAnimating,
    autoManageExpansion,
    automaticCollapseDelayMs,
    deferAutomaticCollapse,
    expandActiveWhenLive,
    hasApprovalAgent,
    hasActive,
  ]);

  useEffect(() => {
    if (expansionOwnerRef.current === 'automatic') {
      automaticExpansionChangeRef.current?.(true);
    }
    return () => {
      clearTimeout(autoCollapseTimerRef.current);
      clearTimeout(autoCollapseAnimationTimerRef.current);
      if (expansionOwnerRef.current === 'automatic') {
        automaticExpansionChangeRef.current?.(false);
      }
    };
  }, []);

  useEffect(() => {
    if (!hasActive) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasActive]);
  const runningDuration = hasActive
    ? formatLiveElapsed(now - liveStartedAtRef.current)
    : '';

  const doneCount = agents.filter(
    (a) => a.status === 'completed' || a.status === 'failed',
  ).length;
  const total = agents.length;

  const showGroup = groupExpanded || !!approvalAgent;
  const renderGroup = showGroup || automaticCollapseAnimating;
  const automaticCollapseClosing =
    automaticCollapseAnimating && !hasApprovalAgent;
  const summaryStatus = agents.some(
    (a) => getAgentDisplayStatus(a) === 'failed',
  )
    ? 'failed'
    : hasActive
      ? 'in_progress'
      : 'completed';

  return (
    <div className={styles.wrap}>
      <button
        type="button"
        className={styles.summary}
        onClick={() => {
          clearTimeout(autoCollapseTimerRef.current);
          autoCollapseTimerRef.current = undefined;
          clearTimeout(autoCollapseAnimationTimerRef.current);
          autoCollapseAnimationTimerRef.current = undefined;
          if (expansionOwnerRef.current === 'automatic') {
            automaticExpansionChangeRef.current?.(false);
          }
          expansionOwnerRef.current = 'manual';
          setAutomaticCollapseAnimating(false);
          setGroupExpanded((value) => !value);
        }}
        disabled={automaticCollapseClosing}
        aria-expanded={showGroup}
        title={showGroup ? t('tool.collapseHint') : t('tool.expand')}
      >
        {summaryStatus === 'failed' ? (
          <span className={styles.summaryStatus}>
            <StatusIcon status={summaryStatus} />
          </span>
        ) : (
          <span className={styles.summaryIcon} aria-hidden="true">
            <ToolGroupIcon />
          </span>
        )}
        <span
          className={
            hasActive
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
      {renderGroup && (
        <div
          ref={(element) => {
            element?.toggleAttribute('inert', automaticCollapseClosing);
          }}
          className={`${styles.groupViewport} ${
            automaticCollapseClosing ? styles.groupViewportClosing : ''
          }`}
          data-agent-collapse-exit={
            automaticCollapseClosing ? 'true' : undefined
          }
          aria-hidden={automaticCollapseClosing || undefined}
        >
          <div className={styles.groupViewportInner}>
            <div className={styles.group}>
              <div className={styles.list}>
                {agents.map((agent) => {
                  const agentType = getAgentType(agent);
                  const desc = getAgentDescription(agent);
                  const toolHint = getAgentCurrentToolHint(agent, t);
                  const stats = getAgentStats(agent, now);
                  const status = getAgentDisplayStatus(agent);
                  const rowStatus =
                    status === 'failed'
                      ? 'failed'
                      : isActiveToolStatus(agent.status)
                        ? 'active'
                        : 'completed';
                  const rowStatusLabel =
                    rowStatus === 'active'
                      ? t('subagent.running')
                      : rowStatus === 'failed'
                        ? t('subagent.failed')
                        : t('subagent.completed');
                  const isExpanded = expandedId === agent.callId;
                  return (
                    <div key={agent.callId}>
                      <button
                        type="button"
                        className={
                          rowStatus === 'active'
                            ? `${styles.row} ${styles.rowActive}`
                            : styles.row
                        }
                        data-agent-status={rowStatus}
                        aria-expanded={subagentDetails ? undefined : isExpanded}
                        onClick={() => {
                          if (subagentDetails) subagentDetails.onOpen(agent);
                          else setExpandedId(isExpanded ? null : agent.callId);
                        }}
                      >
                        <span
                          className={styles.rowStatus}
                          aria-label={rowStatusLabel}
                          title={rowStatusLabel}
                        >
                          {rowStatus === 'active'
                            ? '●'
                            : rowStatus === 'failed'
                              ? '×'
                              : '✓'}
                        </span>
                        <span className={styles.rowText}>
                          <span className={styles.rowTask}>
                            {truncateText(
                              desc || localizeAgentTypeName(agentType, t),
                              50,
                            )}
                          </span>
                          {toolHint && (
                            <span
                              className={styles.rowTool}
                            >{` · ${toolHint}`}</span>
                          )}
                        </span>
                        {stats && (
                          <span className={styles.rowStats}>{stats}</span>
                        )}
                      </button>
                      {!subagentDetails && isExpanded && (
                        <div className={styles.detail}>
                          <SubAgentPanel tool={agent} hideHeader />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
