/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import { SquareIcon } from 'lucide-react';
import type {
  SessionAgentPermissionPrompt,
  SessionAgentRunFrame,
} from '@qwen-code/sdk/daemon';
import { Markdown } from '../messages/Markdown';
import { AuthorAvatar } from '../messages/AuthorAvatar';
import { parseTitle, ToolApproval } from '../messages/ToolApproval';
import {
  AgentStepList,
  AgentTokenUsage,
} from '../messages/agent-message-details';
import { Button } from '../ui/button';
import type {
  PermissionOption,
  PermissionRequest,
} from '../../adapters/types';
import { useI18n } from '../../i18n';
import { formatElapsed } from './agents-view-logic';
import { isTerminalRunStatus } from './use-session-agent-runs';
import assistantStyles from '../messages/AssistantMessage.module.css';
import styles from './session-agent-live-runs.module.css';

type Translate = ReturnType<typeof useI18n>['t'];

/** No agent activity for this long: say it may be stuck. */
export const STALL_NOTICE_MS = 5 * 60_000;

/** A clock that ticks while `active`, for the stall notice. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * One line saying where a live run is. Returns `attention` for the states the
 * user should notice (stuck, failed, offline).
 */
export function describeRun(
  run: SessionAgentRunFrame,
  now: number,
  t: Translate,
): { text?: string; attention: boolean } {
  const agent = run.author.name;
  switch (run.status) {
    case 'queued': {
      const ahead = (run.queuePosition ?? 1) - 1;
      return {
        text:
          ahead > 0
            ? t('collab.run.queuedBehind', { agent, count: ahead })
            : t('collab.run.queued', { agent }),
        attention: false,
      };
    }
    case 'awaiting_approval':
      return {
        text: t('collab.session.awaitingApproval', { agent }),
        attention: true,
      };
    case 'running': {
      const idle = now - run.activityAt;
      if (idle >= STALL_NOTICE_MS) {
        return {
          text: t('collab.run.stalled', {
            agent,
            elapsed: formatElapsed(idle, t),
          }),
          attention: true,
        };
      }
      return {
        text:
          !run.outputText && run.thoughtText
            ? t('collab.session.thinking', { agent })
            : t('collab.session.working', { agent }),
        attention: false,
      };
    }
    case 'failed':
      return { text: t('collab.run.failed', { agent }), attention: true };
    case 'offline':
      return { text: t('collab.session.offline', { agent }), attention: true };
    case 'cancelled':
      return {
        text: t('collab.session.cancelled', { agent }),
        attention: false,
      };
    case 'completed':
    default:
      // The output is the result; its record replaces this card shortly.
      return { attention: false };
  }
}

/** The run's permission prompt as the main chat's approval card reads it. */
export function toApprovalRequest(
  permission: SessionAgentPermissionPrompt,
  agent: string,
  t: Translate,
): PermissionRequest {
  // "WriteFile: docs/testing.md" heads the card as the tool with its target
  // under it, as the main chat's approval shows it.
  const { description } = parseTitle(permission.title);
  return {
    id: permission.requestId,
    title: permission.title || t('collab.approval.title', { agent }),
    ...(permission.toolName ? { toolName: permission.toolName } : {}),
    content: [],
    ...(description || permission.inputPreview
      ? {
          rawInput: {
            ...(description ? { description } : {}),
            // TODO(multi-agent): ToolApproval reads `command` only for
            // shell-like tools; other tools' input preview is not shown yet.
            ...(permission.inputPreview
              ? { command: permission.inputPreview }
              : {}),
          },
        }
      : {}),
    options: permission.options.map(
      (option): PermissionOption => ({
        id: option.optionId,
        label: option.name,
        kind: option.kind,
      }),
    ),
  };
}

function LiveRun({
  run,
  now,
  onCancel,
  onRespond,
}: {
  run: SessionAgentRunFrame;
  now: number;
  onCancel: (runId: string) => Promise<void>;
  onRespond: (
    runId: string,
    requestId: string,
    optionId: string,
  ) => Promise<void>;
}) {
  const { t } = useI18n();
  const [stopping, setStopping] = useState(false);
  // A vote hides its card at once; a failed vote brings it back.
  const [answered, setAnswered] = useState<string | undefined>();
  const terminal = isTerminalRunStatus(run.status);
  const described = describeRun(run, now, t);
  const permission =
    run.permission && run.permission.requestId !== answered
      ? run.permission
      : undefined;
  return (
    <div
      className={`${assistantStyles.message} ${styles.run}`}
      data-agent-run-status={run.status}
      data-run-id={run.runId}
    >
      <div className={assistantStyles.author}>
        <AuthorAvatar name={run.author.name} color={run.author.color} />
        <span className={assistantStyles.authorName}>{run.author.name}</span>
        {!terminal && (
          <Button
            size="xs"
            variant="ghost"
            className={styles.stop}
            disabled={stopping}
            onClick={() => {
              setStopping(true);
              void onCancel(run.runId).finally(() => setStopping(false));
            }}
          >
            {stopping
              ? t('collab.run.stopping', { agent: run.author.name })
              : t('collab.run.stop')}
          </Button>
        )}
      </div>
      {run.outputText && (
        <div className={assistantStyles.content}>
          <div className={assistantStyles.contentBody}>
            <Markdown
              content={run.outputText}
              source="assistant"
              isStreaming={!terminal}
            />
          </div>
        </div>
      )}
      {(described.text || run.error) && (
        <div
          role="status"
          className={styles.status}
          data-attention={described.attention || undefined}
        >
          {described.text && <span>{described.text}</span>}
          {run.error && <span className={styles.error}>{run.error}</span>}
        </div>
      )}
      <AgentStepList
        steps={run.steps ?? []}
        label={t('collab.run.steps', { agent: run.author.name })}
      />
      {permission && (
        <div className={styles.approval}>
          <ToolApproval
            request={toApprovalRequest(permission, run.author.name, t)}
            keyboardActive={false}
            onConfirm={(requestId, optionId) => {
              setAnswered(requestId);
              void onRespond(run.runId, requestId, optionId).catch(() =>
                setAnswered((current) =>
                  current === requestId ? undefined : current,
                ),
              );
            }}
          />
        </div>
      )}
      <AgentTokenUsage totalTokens={run.totalTokens} />
    </div>
  );
}

/**
 * The session's live agent runs, rendered at the bottom of the message list as
 * the agents' messages-in-progress. Each is replaced by the agent's recorded
 * reply once that lands in the transcript.
 *
 * Mounted only by App (through MessageList's `tailContent`), never by the
 * exported transcript, so it may use the collaboration dictionary.
 */
export function SessionAgentLiveRuns({
  runs,
  onCancel,
  onRespond,
}: {
  runs: readonly SessionAgentRunFrame[];
  onCancel: (runId: string) => Promise<void>;
  onRespond: (
    runId: string,
    requestId: string,
    optionId: string,
  ) => Promise<void>;
}) {
  const now = useNow(runs.some((run) => run.status === 'running'));
  if (runs.length === 0) return null;
  return (
    <div className={styles.list} data-testid="session-agent-live-runs">
      {runs.map((run) => (
        <LiveRun
          key={run.runId}
          run={run}
          now={now}
          onCancel={onCancel}
          onRespond={onRespond}
        />
      ))}
    </div>
  );
}

/** Shown near the composer while any agent in this session is working. */
export function StopAllAgentsButton({
  onStopAll,
}: {
  onStopAll: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [pending, setPending] = useState(false);
  return (
    <div className={styles.stopAllRow} data-testid="session-agent-stop-all">
      <Button
        size="xs"
        variant="outline"
        disabled={pending}
        onClick={() => {
          setPending(true);
          void onStopAll().finally(() => setPending(false));
        }}
      >
        <SquareIcon aria-hidden="true" />
        {t('collab.session.stopAll')}
      </Button>
    </div>
  );
}
