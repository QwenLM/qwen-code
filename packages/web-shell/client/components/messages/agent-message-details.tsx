/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Check, LoaderCircle, X } from 'lucide-react';
import type {
  QwenAgentMessageMeta,
  SessionAgentStep,
} from '@qwen-code/sdk/daemon';
import { useI18n } from '../../i18n';
import styles from './agent-message-details.module.css';

/**
 * One line per tool call an agent made, like a CI job's step list. Shared by
 * the live run card and the finished reply, so a run reads the same before
 * and after its record lands.
 *
 * Renders in exported transcripts: only `agentMessage.*` strings (i18n.tsx),
 * never the collaboration dictionary.
 */
export function AgentStepList({
  steps,
  label,
}: {
  steps: readonly SessionAgentStep[];
  label?: string;
}) {
  const { t } = useI18n();
  if (steps.length === 0) return null;
  return (
    <ol aria-label={label ?? t('agentMessage.steps')} className={styles.steps}>
      {steps.map((step) => (
        <li key={step.id} className={styles.step}>
          {step.status === 'running' ? (
            <LoaderCircle
              aria-label={t('agentMessage.step.running')}
              className={`${styles.stepIcon} ${styles.stepIconRunning}`}
            />
          ) : step.status === 'completed' ? (
            <Check
              aria-label={t('agentMessage.step.completed')}
              className={`${styles.stepIcon} ${styles.stepIconDone}`}
            />
          ) : (
            <X
              aria-label={t('agentMessage.step.failed')}
              className={`${styles.stepIcon} ${styles.stepIconFailed}`}
            />
          )}
          <span
            className={styles.stepText}
            data-running={step.status === 'running' || undefined}
          >
            {step.title}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** "1,234 tokens", or nothing when the run reported no usage. */
export function AgentTokenUsage({ totalTokens }: { totalTokens?: number }) {
  const { t } = useI18n();
  if (totalTokens === undefined || totalTokens <= 0) return null;
  return (
    <span className={styles.tokens}>
      {t('agentMessage.tokens', { count: totalTokens.toLocaleString() })}
    </span>
  );
}

/**
 * Status, error, steps and token usage of a finished agent reply. A completed
 * run shows no status word: its text is the result.
 */
export function AgentMessageDetails({ meta }: { meta: QwenAgentMessageMeta }) {
  const { t } = useI18n();
  const status =
    meta.status === 'failed' ||
    meta.status === 'cancelled' ||
    meta.status === 'offline'
      ? meta.status
      : undefined;
  const steps = meta.steps ?? [];
  if (
    !status &&
    !meta.error &&
    steps.length === 0 &&
    (meta.totalTokens ?? 0) <= 0
  ) {
    return null;
  }
  return (
    <div className={styles.details} data-agent-status={meta.status}>
      {(status || meta.error) && (
        <div className={styles.status} role="status">
          {status && (
            <span className={styles.statusLabel}>
              {t(`agentMessage.status.${status}`)}
            </span>
          )}
          {meta.error && <span className={styles.error}>{meta.error}</span>}
        </div>
      )}
      <AgentStepList steps={steps} />
      <AgentTokenUsage totalTokens={meta.totalTokens} />
    </div>
  );
}
