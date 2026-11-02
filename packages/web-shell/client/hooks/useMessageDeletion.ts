import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { DaemonHttpError } from '@qwen-code/sdk/daemon';
import {
  useActions,
  useConnection,
  useTranscriptStore,
  useWorkspace,
} from '@qwen-code/web-shell/daemon-react-sdk';
import type { Message } from '../adapters/types';
import { useInteractionBlocker } from '../interactionBlockContext';
import { useI18n } from '../i18n';
import { McpAppGeneratedUiOwnerContext } from '../mcpAppHostContext';
import {
  localMessageDeletionGroups,
  hasPendingLocalCommands,
  restoreLocalDeletionBlocks,
  removeDeletedMessageBlocks,
  messageDeletionGroups,
  type MessageDeletionGroup,
} from '../utils/message-deletion';

export interface MessageDeletionControls {
  active: boolean;
  busy: boolean;
  disabled: boolean;
  selected: ReadonlySet<string>;
  allowed: ReadonlySet<string>;
  groupByMessage: ReadonlyMap<string, string>;
  error?: string;
  confirming: boolean;
  canDelete(message: Message): boolean;
  start(message: Message): void;
  toggle(groupId: string): void;
  cancel(): void;
  setConfirming(value: boolean): void;
  submit(): void;
}

export function useMessageDeletion(
  messages: Message[],
  sessionBlocked: boolean,
  historical = false,
) {
  const generatedUiOwner = useContext(McpAppGeneratedUiOwnerContext);
  const connection = useConnection();
  const actions = useActions();
  const store = useTranscriptStore();
  const blocked =
    historical || sessionBlocked || hasPendingLocalCommands(store);
  const { client } = useWorkspace();
  const { t } = useI18n();
  const registerBlocker = useInteractionBlocker();
  const key = `${connection.workspaceCwd}:${connection.sessionId}`;
  const currentKey = useRef(key);
  currentKey.current = key;
  const [selection, setSelection] = useState<{
    key: string;
    snapshot: string;
    groups: MessageDeletionGroup[];
    allowed: Set<string>;
    selected: Set<string>;
  }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const operation = useRef(0);
  const active = selection?.key === key;
  const supported =
    connection.capabilities?.features.includes('session_message_deletion') ===
      true && connection.status === 'connected';
  const localGroups = useMemo(
    () => localMessageDeletionGroups(messages),
    [messages],
  );
  const groupByMessage = useMemo(
    () =>
      messageDeletionGroups(
        messages,
        active ? [...selection.groups, ...localGroups] : localGroups,
      ),
    [messages, active, selection, localGroups],
  );

  useEffect(() => {
    operation.current += 1;
    setSelection(undefined);
    setBusy(false);
    setError(undefined);
    setConfirming(false);
  }, [key, historical]);
  useEffect(
    () => (active || busy ? registerBlocker() : undefined),
    [active, busy, registerBlocker],
  );
  useEffect(() => {
    if (!active || busy || !connection.loadingTranscript) return;
    operation.current += 1;
    setSelection(undefined);
    setConfirming(false);
    setError(t('messageDelete.conflict'));
  }, [active, busy, connection.loadingTranscript, t]);

  if (!supported && localGroups.length === 0) return undefined;
  const failureMessage = (cause: unknown) => {
    const code =
      cause instanceof DaemonHttpError
        ? (cause.body as { code?: string } | undefined)?.code
        : undefined;
    return t(
      code === 'unsupported_operation' ||
        code === 'session_message_deletion_unsupported'
        ? 'messageDelete.unsupported'
        : code === 'session_busy'
          ? 'messageDelete.busy'
          : code === 'message_history_invalid'
            ? 'messageDelete.invalidHistory'
            : 'messageDelete.failed',
    );
  };
  const cancel = () => {
    if (busy) return;
    operation.current += 1;
    setSelection(undefined);
    setError(undefined);
    setConfirming(false);
  };
  const start = async (message: Message) => {
    if (blocked || hasPendingLocalCommands(store) || busy || active) return;
    const token = ++operation.current;
    setBusy(true);
    setError(undefined);
    try {
      const catalog =
        supported && connection.sessionId
          ? await client
              .getMessageGroups(connection.sessionId)
              .catch((cause: unknown) => {
                if (message.localCommandId) return { snapshot: '', groups: [] };
                throw cause;
              })
          : { snapshot: '', groups: [] };
      if (currentKey.current !== key || token !== operation.current) return;
      const mapping = messageDeletionGroups(messages, [
        ...catalog.groups,
        ...localGroups,
      ]);
      const groupId = mapping.get(message.id);
      if (!groupId) {
        setError(t('messageDelete.unavailable'));
        return;
      }
      const allowed = new Set(
        [...catalog.groups, ...localGroups].map((group) => group.id),
      );
      setSelection({ key, ...catalog, selected: new Set([groupId]), allowed });
    } catch (cause) {
      if (currentKey.current === key && token === operation.current)
        setError(failureMessage(cause));
    } finally {
      if (currentKey.current === key && token === operation.current)
        setBusy(false);
    }
  };
  const submit = async () => {
    if (
      !active ||
      blocked ||
      hasPendingLocalCommands(store) ||
      busy ||
      selection.selected.size === 0
    )
      return;
    const token = ++operation.current;
    setBusy(true);
    setError(undefined);
    let reopenRequired = false;
    let deleted = false;
    try {
      const persisted = selection.groups.filter((group) =>
        selection.selected.has(group.id),
      );
      const before = store.getSnapshot();
      const localIds = new Set(
        messages
          .filter(
            (message) =>
              selection.selected.has(groupByMessage.get(message.id) ?? '') &&
              !persisted.some(
                (group) => group.id === groupByMessage.get(message.id),
              ),
          )
          .flatMap((message) => [
            message.id,
            ...(message.sourceBlockIds ?? []),
          ]),
      );
      if (persisted.length > 0 && connection.sessionId) {
        try {
          await client.deleteMessageGroups(
            connection.sessionId,
            selection.snapshot,
            persisted.map((group) => group.id),
            connection.clientId,
          );
        } catch (cause) {
          const body =
            cause instanceof DaemonHttpError
              ? (cause.body as
                  | { code?: string; persisted?: boolean }
                  | undefined)
              : undefined;
          if (
            body?.code !== 'message_deletion_context_unavailable' ||
            body.persisted !== true
          )
            throw cause;
          reopenRequired = true;
        }
      }
      deleted = true;
      if (generatedUiOwner && connection.sessionId && persisted.length > 0) {
        generatedUiOwner.invalidate({
          scopeId: generatedUiOwner.scopeId,
          sessionId: connection.sessionId,
          reason: 'deleted',
        });
      }
      if (currentKey.current !== key || token !== operation.current) return;
      if (localIds.size > 0) {
        const snapshot = store.getSnapshot();
        store.reset({
          ...snapshot,
          blocks: snapshot.blocks.filter((block) => !localIds.has(block.id)),
          retainedBytes: undefined,
          activeUserBlockId: undefined,
        });
      }
      setConfirming(false);
      setSelection(undefined);
      if (persisted.length > 0) {
        const retained = before.blocks.filter(
          (block) => !localIds.has(block.id),
        );
        removeDeletedMessageBlocks(
          store,
          persisted.map((group) => group.id),
          persisted.flatMap((group) => [
            ...(group.promptIds ?? []),
            ...(group.promptId ? [group.promptId] : []),
          ]),
        );
        try {
          await actions.reloadSession(new AbortController().signal);
        } finally {
          if (currentKey.current === key && token === operation.current)
            restoreLocalDeletionBlocks(store, retained);
        }
      }
      if (reopenRequired) setError(t('messageDelete.reopenRequired'));
    } catch (cause) {
      if (currentKey.current === key && token === operation.current) {
        setConfirming(false);
        const body =
          cause instanceof DaemonHttpError
            ? (cause.body as { code?: string } | undefined)
            : undefined;
        if (body?.code === 'message_groups_conflict') {
          setSelection(undefined);
          setError(t('messageDelete.conflict'));
        } else
          setError(
            reopenRequired
              ? t('messageDelete.reopenRequired')
              : deleted
                ? t('messageDelete.reloadFailed')
                : failureMessage(cause),
          );
      }
    } finally {
      if (currentKey.current === key && token === operation.current)
        setBusy(false);
    }
  };
  return {
    active,
    busy,
    disabled: busy || blocked,
    groupByMessage,
    error,
    confirming,
    selected: active ? selection.selected : new Set<string>(),
    allowed: active ? selection.allowed : new Set<string>(),
    canDelete: (message) => supported || !!message.localCommandId,
    start: (message) => {
      void start(message);
    },
    toggle: (id) => {
      if (blocked || busy) return;
      setSelection((current) => {
        if (!current?.allowed.has(id)) return current;
        const selected = new Set(current.selected);
        if (selected.has(id)) selected.delete(id);
        else selected.add(id);
        return { ...current, selected };
      });
    },
    cancel,
    setConfirming,
    submit: () => {
      void submit();
    },
  } satisfies MessageDeletionControls;
}
