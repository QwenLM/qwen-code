/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, type FormEvent } from 'react';
import { PlusIcon, UsersIcon } from 'lucide-react';
import type { SessionSquadView } from '@qwen-code/sdk/daemon';

import { useI18n } from '../../i18n';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardDescription, CardTitle } from '../ui/card';
import type { WorkspaceAgentSummaryView } from './ThreadsPage';
import type { SquadInput } from './threads-api';
import styles from './ThreadsPage.module.css';

export interface SquadsSectionProps {
  squads: readonly SessionSquadView[];
  agents: readonly WorkspaceAgentSummaryView[];
  pending?: boolean;
  onCreate: (input: SquadInput) => void;
  onUpdate: (squadId: string, input: SquadInput) => void;
  onRetire: (squadId: string) => void;
  /** Puts `@name ` into the chat composer; absent hides the button. */
  onMention?: (name: string) => void;
}

/** Agents that can lead or join: not retired (a paused one may still join). */
function selectableAgents(
  agents: readonly WorkspaceAgentSummaryView[],
): WorkspaceAgentSummaryView[] {
  return agents.filter((agent) => !agent.retiredAt);
}

function SquadForm({
  squad,
  agents,
  pending,
  onSubmit,
  onCancel,
}: {
  squad?: SessionSquadView;
  agents: readonly WorkspaceAgentSummaryView[];
  pending?: boolean;
  onSubmit: (input: SquadInput) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const candidates = selectableAgents(agents);
  // A leader that can no longer lead must be replaced before saving.
  const [leaderAgentId, setLeaderAgentId] = useState(
    squad && !squad.leaderIssue ? squad.leaderAgentId : '',
  );
  // agentId -> role, for the checked members.
  const [members, setMembers] = useState<Map<string, string>>(
    () =>
      new Map(
        (squad?.members ?? []).map((member) => [
          member.agentId,
          member.role ?? '',
        ]),
      ),
  );
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = (name: string): string | null => {
      const value = String(data.get(name) ?? '').trim();
      return value === '' ? null : value;
    };
    onSubmit({
      name: String(data.get('name') ?? '').trim(),
      description: text('description'),
      instructions: text('instructions'),
      leaderAgentId,
      members: [...members].map(([agentId, role]) => ({
        agentId,
        ...(role.trim() ? { role: role.trim() } : {}),
      })),
    });
  };
  return (
    <form
      className={styles.agentConfig}
      onSubmit={submit}
      data-testid="squad-form"
    >
      <label className={styles.configLabel}>
        {t('collab.squad.name')}
        <input
          className={styles.field}
          name="name"
          required
          maxLength={48}
          defaultValue={squad?.name ?? ''}
        />
      </label>
      <label className={styles.configLabel}>
        {t('collab.squad.description')}
        <input
          className={styles.field}
          name="description"
          defaultValue={squad?.description ?? ''}
        />
      </label>
      <label className={styles.configLabel}>
        {t('collab.squad.instructions')}
        <textarea
          className={styles.field}
          name="instructions"
          rows={3}
          defaultValue={squad?.instructions ?? ''}
        />
      </label>
      <label className={styles.configLabel}>
        {t('collab.squad.leader')}
        <select
          className={styles.field}
          required
          value={leaderAgentId}
          onChange={(event) => setLeaderAgentId(event.target.value)}
        >
          <option value="" disabled>
            {t('collab.squad.leaderPick')}
          </option>
          {candidates
            .filter((agent) => agent.enabled)
            .map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
        </select>
      </label>
      <fieldset className={styles.configLabel}>
        <legend>{t('collab.squad.members')}</legend>
        {candidates.map((agent) => {
          const checked = members.has(agent.id);
          return (
            <div key={agent.id} className="flex items-center gap-2">
              <label className="flex min-w-0 flex-1 items-center gap-2">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) => {
                    const next = new Map(members);
                    if (event.target.checked) next.set(agent.id, '');
                    else next.delete(agent.id);
                    setMembers(next);
                  }}
                />
                <span className="truncate">{agent.name}</span>
              </label>
              {checked ? (
                <input
                  className={styles.field}
                  aria-label={`${agent.name} ${t('collab.squad.role')}`}
                  placeholder={t('collab.squad.role')}
                  maxLength={200}
                  value={members.get(agent.id) ?? ''}
                  onChange={(event) => {
                    const next = new Map(members);
                    next.set(agent.id, event.target.value);
                    setMembers(next);
                  }}
                />
              ) : null}
            </div>
          );
        })}
      </fieldset>
      <div className={styles.formActions}>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t('collab.form.cancel')}
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={pending || leaderAgentId === ''}
        >
          {t('collab.squad.save')}
        </Button>
      </div>
    </form>
  );
}

/**
 * The Agents page's squads: list, create, edit, retire. A squad is addressed
 * by `@name` in a chat, which wakes its leader (plan §11.5).
 */
export function SquadsSection({
  squads,
  agents,
  pending,
  onCreate,
  onUpdate,
  onRetire,
  onMention,
}: SquadsSectionProps) {
  const { t } = useI18n();
  // 'new', a squad id being edited, or nothing.
  const [editing, setEditing] = useState<string>();
  const visible = squads.filter((squad) => !squad.retiredAt);
  return (
    <section className={styles.roster} data-testid="squads-section">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">
            {t('collab.squad.section')}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('collab.squad.sectionHint')}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => setEditing('new')}
        >
          <PlusIcon data-icon="inline-start" />
          {t('collab.squad.new')}
        </Button>
      </div>
      {editing === 'new' ? (
        <Card size="sm" className={styles.agentCard}>
          <SquadForm
            agents={agents}
            pending={pending}
            onCancel={() => setEditing(undefined)}
            onSubmit={(input) => {
              onCreate(input);
              setEditing(undefined);
            }}
          />
        </Card>
      ) : null}
      {visible.length === 0 && editing !== 'new' ? (
        <p className="text-sm text-muted-foreground">
          {t('collab.squad.empty')}
        </p>
      ) : null}
      {visible.map((squad) => (
        <Card
          key={squad.id}
          size="sm"
          className={
            squad.leaderIssue
              ? `${styles.agentCard} ${styles.agentRowDisabled}`
              : styles.agentCard
          }
          data-testid="squad-card"
        >
          <div className={styles.agentRow}>
            <UsersIcon aria-hidden="true" className="mt-1 size-5 shrink-0" />
            <div className={styles.agentMain}>
              <div className={styles.agentTitleLine}>
                <CardTitle className="min-w-0 truncate">{squad.name}</CardTitle>
                {squad.leaderIssue ? (
                  <Badge
                    variant="secondary"
                    className={styles.statusBadge}
                    data-status="error"
                  >
                    {squad.leaderIssue === 'disabled'
                      ? t('collab.squad.leaderPaused')
                      : t('collab.squad.needsLeader')}
                  </Badge>
                ) : null}
              </div>
              <CardDescription className="truncate text-xs">
                {squad.description || '—'}
              </CardDescription>
              <span className="truncate text-xs text-muted-foreground">
                {t('collab.squad.summary', {
                  leader: squad.leaderName ?? '—',
                  count: squad.members.length,
                })}
                {squad.members.length > 0
                  ? ` · ${squad.members
                      .map((member) =>
                        member.role
                          ? `${member.name} (${member.role})`
                          : member.name,
                      )
                      .join(', ')}`
                  : ''}
              </span>
            </div>
            <div className={styles.agentActions}>
              {onMention ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!!squad.leaderIssue || pending}
                  onClick={() => onMention(squad.name)}
                >
                  {t('collab.agent.mentionIt')}
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => setEditing(squad.id)}
              >
                {t('collab.squad.edit')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => {
                  if (
                    window.confirm(
                      t('collab.squad.retireConfirm', { name: squad.name }),
                    )
                  ) {
                    onRetire(squad.id);
                  }
                }}
              >
                {t('collab.squad.retire')}
              </Button>
            </div>
          </div>
          {editing === squad.id ? (
            <SquadForm
              squad={squad}
              agents={agents}
              pending={pending}
              onCancel={() => setEditing(undefined)}
              onSubmit={(input) => {
                onUpdate(squad.id, input);
                setEditing(undefined);
              }}
            />
          ) : null}
        </Card>
      ))}
    </section>
  );
}
