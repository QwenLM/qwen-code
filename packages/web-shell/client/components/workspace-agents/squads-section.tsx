/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useId, useState, type FormEvent } from 'react';
import { UsersIcon } from 'lucide-react';
import type { SessionSquadView } from '@qwen-code/sdk/daemon';

import { useI18n } from '../../i18n';
import { AuthorAvatar } from '../messages/AuthorAvatar';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardDescription, CardTitle } from '../ui/card';
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from '../ui/empty';
import type { WorkspaceAgentSummaryView } from './ThreadsPage';
import type { SquadInput } from './threads-api';
import styles from './ThreadsPage.module.css';

export interface SquadsSectionProps {
  squads: readonly SessionSquadView[];
  agents: readonly WorkspaceAgentSummaryView[];
  pending?: boolean;
  /** The New squad form is open (its button is in the page header). */
  creating: boolean;
  onCreatingChange: (creating: boolean) => void;
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
  const idPrefix = useId();
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
  // The leader leads; it is not also one of its members.
  const memberCandidates = candidates.filter(
    (agent) => agent.id !== leaderAgentId,
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
      // A squad saved before leaders were kept out of the member list may
      // still name its leader there.
      members: [...members]
        .filter(([agentId]) => agentId !== leaderAgentId)
        .map(([agentId, role]) => ({
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
          placeholder={t('collab.squad.namePlaceholder')}
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
          onChange={(event) => {
            const next = event.target.value;
            setLeaderAgentId(next);
            if (members.has(next)) {
              const rest = new Map(members);
              rest.delete(next);
              setMembers(rest);
            }
          }}
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
        {memberCandidates.map((agent) => {
          const checked = members.has(agent.id);
          // Checkbox · name · role, the role always there (disabled until
          // checked) so rows keep their place.
          return (
            <div key={agent.id} className={styles.squadMemberRow}>
              <input
                id={`${idPrefix}-member-${agent.id}`}
                type="checkbox"
                checked={checked}
                onChange={(event) => {
                  const next = new Map(members);
                  if (event.target.checked) next.set(agent.id, '');
                  else next.delete(agent.id);
                  setMembers(next);
                }}
              />
              <label
                htmlFor={`${idPrefix}-member-${agent.id}`}
                className={styles.squadMemberName}
              >
                {agent.name}
              </label>
              <input
                className={styles.field}
                aria-label={`${agent.name} ${t('collab.squad.role')}`}
                placeholder={t('collab.squad.role')}
                maxLength={200}
                disabled={!checked}
                value={members.get(agent.id) ?? ''}
                onChange={(event) => {
                  const next = new Map(members);
                  next.set(agent.id, event.target.value);
                  setMembers(next);
                }}
              />
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

/** No squads (or a daemon without squad routes). */
export function SquadsEmpty() {
  const { t } = useI18n();
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <UsersIcon />
        </EmptyMedia>
        <EmptyTitle>{t('collab.squad.empty')}</EmptyTitle>
      </EmptyHeader>
    </Empty>
  );
}

/** One agent of a squad: its avatar, name and, when set, its role. */
function SquadChip({
  name,
  color,
  role,
  leader,
}: {
  name: string;
  color?: string;
  role?: string;
  leader?: boolean;
}) {
  const { t } = useI18n();
  return (
    <li
      className={styles.squadChip}
      data-squad-role={leader ? 'leader' : 'member'}
    >
      <AuthorAvatar name={name} color={color} />
      <span className={styles.squadChipName}>{name}</span>
      {leader ? (
        <span className={styles.squadLeaderMark}>
          {t('collab.squad.leader')}
        </span>
      ) : role ? (
        <span className={styles.squadChipRole}>{role}</span>
      ) : null}
    </li>
  );
}

/**
 * The Agents page's Squads view: list, create, edit, retire. A squad is
 * addressed by `@name` in a chat, which wakes its leader (plan §11.5).
 */
export function SquadsSection({
  squads,
  agents,
  pending,
  creating,
  onCreatingChange,
  onCreate,
  onUpdate,
  onRetire,
  onMention,
}: SquadsSectionProps) {
  const { t } = useI18n();
  // The squad being edited, if any.
  const [editing, setEditing] = useState<string>();
  const visible = squads.filter((squad) => !squad.retiredAt);
  const colorOf = (agentId: string) =>
    agents.find((agent) => agent.id === agentId)?.color;
  return (
    <section className={styles.roster} data-testid="squads-section">
      {creating ? (
        <Card size="sm" className={styles.agentCard}>
          <SquadForm
            agents={agents}
            pending={pending}
            onCancel={() => onCreatingChange(false)}
            onSubmit={(input) => {
              onCreate(input);
              onCreatingChange(false);
            }}
          />
        </Card>
      ) : null}
      {visible.length === 0 && !creating ? <SquadsEmpty /> : null}
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
              {squad.description ? (
                <CardDescription className="truncate text-xs">
                  {squad.description}
                </CardDescription>
              ) : null}
              <ul className={styles.squadChips}>
                {squad.leaderName ? (
                  <SquadChip
                    name={squad.leaderName}
                    color={colorOf(squad.leaderAgentId)}
                    leader
                  />
                ) : null}
                {squad.members.map((member) => (
                  <SquadChip
                    key={member.agentId}
                    name={member.name}
                    color={colorOf(member.agentId)}
                    role={member.role}
                  />
                ))}
              </ul>
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
