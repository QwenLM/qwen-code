/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import type { DaemonChannelDelivery } from '@qwen-code/sdk/daemon';
import {
  useChannels,
  useWorkspaceActions,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { useI18n } from '../../i18n';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../ui/field';
import { Input } from '../ui/input';
import styles from './ScheduledTasksDialog.module.css';

type Target = DaemonChannelDelivery['target'];
type Suggestion = Target & { label?: string };

export function sameDelivery(
  left: DaemonChannelDelivery | null,
  right: DaemonChannelDelivery | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.target.channelName === right.target.channelName &&
      left.target.type === right.target.type &&
      left.target.id === right.target.id)
  );
}

export function ScheduledTaskDeliveryFields({
  delivery,
  onChange,
  available,
  observedContactsAvailable,
  workspaceId,
  workspaceCwd,
  workspaceMissing,
  perRun,
  disabled,
}: {
  delivery: DaemonChannelDelivery | null;
  onChange: (delivery: DaemonChannelDelivery | null) => void;
  available: boolean;
  observedContactsAvailable: boolean;
  workspaceId?: string;
  workspaceCwd?: string;
  workspaceMissing: boolean;
  perRun: boolean;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const actions = useWorkspaceActions();
  const canDiscover = available && !workspaceMissing && !!workspaceCwd;
  const channels = useChannels({
    workspaceCwd,
    enabled: canDiscover,
    autoLoad: true,
  });
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [contactsError, setContactsError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setSuggestions([]);
    setContactsError(false);
    setContactsLoading(false);
    if (!canDiscover || !observedContactsAvailable) return;
    setContactsLoading(true);
    void actions.listChannelObservedContacts(workspaceId).then(
      (contacts) => {
        if (cancelled) return;
        setSuggestions([
          ...contacts.users.map((contact) => ({
            ...contact,
            type: 'user' as const,
          })),
          ...contacts.groups.map((contact) => ({
            ...contact,
            type: 'chat' as const,
          })),
        ]);
        setContactsLoading(false);
      },
      () => {
        if (cancelled) return;
        setContactsError(true);
        setContactsLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [actions, canDiscover, observedContactsAvailable, workspaceId]);

  const names = canDiscover ? Object.keys(channels.channels) : [];
  const target = delivery?.target;
  const unavailableTarget = !!target && !names.includes(target.channelName);
  const matchingSuggestions = suggestions.filter(
    (suggestion) => suggestion.channelName === target?.channelName,
  );
  const identity = (value: Target) =>
    `${value.channelName} · ${t(`scheduledTasks.delivery.${value.type}`)} · ${value.id}`;
  const suggestionKey = (value: Target) =>
    JSON.stringify({
      channelName: value.channelName,
      type: value.type,
      id: value.id,
    });
  const selectedSuggestion =
    target &&
    matchingSuggestions.some(
      (suggestion) =>
        suggestion.type === target.type && suggestion.id === target.id,
    )
      ? suggestionKey(target)
      : '';
  const updateTarget = (patch: Partial<Target>) => {
    if (target) onChange({ kind: 'channel', target: { ...target, ...patch } });
  };

  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor="scheduled-task-delivery-channel">
          {t('scheduledTasks.delivery.channel')}
        </FieldLabel>
        <select
          id="scheduled-task-delivery-channel"
          className={styles.select}
          value={target?.channelName ?? ''}
          disabled={disabled || !available}
          onChange={(event) =>
            onChange(
              event.target.value
                ? {
                    kind: 'channel',
                    target: {
                      channelName: event.target.value,
                      type: 'chat',
                      id: '',
                    },
                  }
                : null,
            )
          }
        >
          <option value="">{t('scheduledTasks.delivery.off')}</option>
          {unavailableTarget && (
            <option value={target.channelName}>{target.channelName}</option>
          )}
          {names.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <FieldDescription>{t('scheduledTasks.delivery.hint')}</FieldDescription>
        {!available && (
          <FieldDescription>
            {t('scheduledTasks.delivery.unavailable')}
          </FieldDescription>
        )}
        {available && perRun && (
          <FieldDescription>
            {t('scheduledTasks.delivery.perRun')}
          </FieldDescription>
        )}
        {available && !canDiscover && (
          <FieldDescription>
            {t('scheduledTasks.error.workspaceUnavailable')}
          </FieldDescription>
        )}
        {canDiscover && channels.loading && (
          <FieldDescription>
            {t('scheduledTasks.delivery.loading')}
          </FieldDescription>
        )}
        {canDiscover && channels.error && (
          <FieldDescription>
            {t('scheduledTasks.delivery.channelsFailed')}
          </FieldDescription>
        )}
        {canDiscover &&
          !channels.loading &&
          !channels.error &&
          names.length === 0 && (
            <FieldDescription>
              {t('scheduledTasks.delivery.noChannels')}
            </FieldDescription>
          )}
      </Field>
      {target && (
        <>
          <FieldDescription className="min-w-0 break-all">
            {identity(target)}
          </FieldDescription>
          {unavailableTarget && !channels.loading && (
            <FieldDescription>
              {t('scheduledTasks.delivery.targetUnavailable')}
            </FieldDescription>
          )}
          <Field>
            <FieldLabel htmlFor="scheduled-task-delivery-suggestion">
              {t('scheduledTasks.delivery.suggestion')}
            </FieldLabel>
            <select
              id="scheduled-task-delivery-suggestion"
              className={styles.select}
              value={selectedSuggestion}
              disabled={
                disabled || !available || unavailableTarget || contactsLoading
              }
              onChange={(event) => {
                const selected = matchingSuggestions.find(
                  (suggestion) =>
                    suggestionKey(suggestion) === event.target.value,
                );
                if (selected)
                  updateTarget({ type: selected.type, id: selected.id });
              }}
            >
              <option value="">{t('scheduledTasks.delivery.manual')}</option>
              {matchingSuggestions.map((suggestion) => (
                <option
                  key={suggestionKey(suggestion)}
                  value={suggestionKey(suggestion)}
                >
                  {suggestion.label ? `${suggestion.label} · ` : ''}
                  {identity(suggestion)}
                </option>
              ))}
            </select>
            {canDiscover &&
              observedContactsAvailable &&
              !contactsLoading &&
              !contactsError &&
              target.id &&
              !selectedSuggestion && (
                <FieldDescription>
                  {t('scheduledTasks.delivery.notObserved')}
                </FieldDescription>
              )}
            {contactsLoading && (
              <FieldDescription>
                {t('scheduledTasks.delivery.loadingContacts')}
              </FieldDescription>
            )}
            <FieldDescription>
              {t(
                contactsError
                  ? 'scheduledTasks.delivery.contactsFailed'
                  : 'scheduledTasks.delivery.suggestionsHint',
              )}
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="scheduled-task-delivery-type">
              {t('scheduledTasks.delivery.type')}
            </FieldLabel>
            <select
              id="scheduled-task-delivery-type"
              className={styles.select}
              value={target.type}
              disabled={disabled || !available || unavailableTarget}
              onChange={(event) =>
                updateTarget({
                  type: event.target.value === 'user' ? 'user' : 'chat',
                  id: '',
                })
              }
            >
              <option value="user">{t('scheduledTasks.delivery.user')}</option>
              <option value="chat">{t('scheduledTasks.delivery.chat')}</option>
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor="scheduled-task-delivery-id">
              {t('scheduledTasks.delivery.id')}
            </FieldLabel>
            <Input
              id="scheduled-task-delivery-id"
              value={target.id}
              disabled={disabled || !available || unavailableTarget}
              onChange={(event) => updateTarget({ id: event.target.value })}
            />
          </Field>
        </>
      )}
    </FieldGroup>
  );
}
