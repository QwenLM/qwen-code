/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useId, useState, type FormEvent } from 'react';
import { MoreHorizontalIcon, UsersIcon } from 'lucide-react';
import type { SessionSquadView } from '@qwen-code/sdk/daemon';

import { useI18n } from '../../i18n';
import { AuthorAvatar } from '../messages/AuthorAvatar';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardDescription, CardTitle } from '../ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
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
  onCreate: (input: SquadInput) => Promise<boolean>;
  onUpdate: (squadId: string, input: SquadInput) => Promise<boolean>;
  onRetire: (squadId: string) => void;
  /** Puts `@name ` into the chat composer; absent hides the button. */
  onMention?: (name: string) => void;
}

/** Agents that can lead or join: not retired (a paused one may still join). */
function selectableAgents(
  agents: readonly WorkspaceAgentSummaryView[],
): ReadonlyArray<WorkspaceAgentSummaryView> {
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
  onSubmit: (input: SquadInput) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const candidates = selectableAgents(agents);
  const idPrefix = useId();
  // Controlled, for the live "Called as @name" hint under it.
  const [name, setName] = useState(squad?.name ?? '');
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
    const text = (field: string): string | null => {
      const value = String(data.get(field) ?? '').trim();
      return value === '' ? null : value;
    };
    void onSubmit({
      name: name.trim(),
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
  const hintId = `${idPrefix}-name-hint`;
  const calledAs = name.trim();
  // Who before how: name, leader, members, then the leader's instructions
  // and the description.
  return (
    <form
      className={styles.agentConfig}
      onSubmit={submit}
      data-testid="squad-form"
    >
      <div className={styles.configLabel}>
        <label htmlFor={`${idPrefix}-name`}>{t('collab.squad.name')}</label>
        <input
          id={`${idPrefix}-name`}
          className={styles.field}
          name="name"
          required
          maxLength={48}
          aria-describedby={hintId}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <span id={hintId} className={styles.fieldHint}>
          {calledAs
            ? t('collab.squad.calledAs', { name: calledAs })
            : t('collab.squad.nameHint')}
        </span>
      </div>
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
      <fieldset className={styles.squadMemberPicker}>
        <legend className={styles.squadMemberLegend}>
          {t('collab.squad.members')}
        </legend>
        {memberCandidates.map((agent) => {
          const checked = members.has(agent.id);
          // Checkbox, avatar, name, and a role field once checked; the row
          // keeps its height either way, so checking one moves nothing.
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
              <AuthorAvatar name={agent.name} color={agent.color} />
              <label
                htmlFor={`${idPrefix}-member-${agent.id}`}
                className={styles.squadMemberName}
              >
                {agent.name}
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
        {t('collab.squad.description')}
        <input
          className={styles.field}
          name="description"
          defaultValue={squad?.description ?? ''}
        />
      </label>
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

/**
 * One row of a squad's roster: avatar, name and, in a second column every row
 * shares, its role ("leads" for the leader). Members hang off the leader on a
 * rail drawn in CSS.
 */
function SquadRosterRow({
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
  const shownRole = leader ? t('collab.squad.leads') : role;
  return (
    <li
      className={styles.squadRosterRow}
      data-squad-role={leader ? 'leader' : 'member'}
    >
      <span className={styles.squadRosterWho}>
        <AuthorAvatar name={name} color={color} />
        <span className={styles.squadRosterName}>{name}</span>
      </span>
      {shownRole ? (
        <span className={styles.squadRosterRole}>{shownRole}</span>
      ) : null}
    </li>
  );
}

/**
 * The Agents page's Squads view: list, create, edit, retire. A squad is
 * addressed by `@name` in a chat, which wakes its leader (session-multi-agent design §11.5).
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
            onSubmit={async (input) => {
              if (await onCreate(input)) onCreatingChange(false);
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
            <span className={styles.squadTile} aria-hidden="true">
              <UsersIcon />
            </span>
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
              <ul className={styles.squadRoster}>
                {squad.leaderName ? (
                  <SquadRosterRow
                    name={squad.leaderName}
                    color={colorOf(squad.leaderAgentId)}
                    leader
                  />
                ) : null}
                {squad.members.map((member) => (
                  <SquadRosterRow
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
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('collab.agent.more', { name: squad.name })}
                  >
                    <MoreHorizontalIcon aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-40">
                  <DropdownMenuItem
                    disabled={pending}
                    onSelect={() => setEditing(squad.id)}
                  >
                    {t('collab.squad.edit')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={pending}
                    onSelect={() => {
                      if (
                        window.confirm(
                          t('collab.squad.retireConfirm', {
                            name: squad.name,
                          }),
                        )
                      ) {
                        onRetire(squad.id);
                      }
                    }}
                  >
                    {t('collab.squad.retire')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          {editing === squad.id ? (
            <SquadForm
              squad={squad}
              agents={agents}
              pending={pending}
              onCancel={() => setEditing(undefined)}
              onSubmit={async (input) => {
                if (await onUpdate(squad.id, input)) setEditing(undefined);
              }}
            />
          ) : null}
        </Card>
      ))}
    </section>
  );
}
