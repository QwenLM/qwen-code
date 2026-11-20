import { useCallback, useEffect, useRef } from 'react';
import type {
  ChatCapabilities,
  ChatStatusFacts,
  PendingApproval,
  PendingQuestion,
  SessionChatController,
} from '../chat-core/contract.js';
import type { DaemonPromptSettledEvent } from './session/types.js';
import {
  regionsToCapabilities,
  type ChatRegion,
} from '../chat-core/capabilities.js';
import { useI18n } from '../i18n.js';
import { useMessagesFromBlocks } from '../hooks/useMessages.js';
import { getComposerDraftStorageKey } from '../hooks/useComposerCore.js';
import {
  useDaemonActions,
  useDaemonConnection,
  useDaemonPendingPermissions,
  useDaemonPromptSettled,
  useDaemonTranscriptBlocks,
} from './session/DaemonSessionProvider.js';
import {
  createDaemonChatController,
  type DaemonDecisionSettlement,
  type DaemonPromptSettlement,
} from './chat-controller.js';
import { DAEMON_CHAT_CAPABILITY_MAP } from './chat-capabilities.js';
import { derivePermissionSignals } from './permission-signals.js';

interface LiveFacts {
  messages: SessionChatController['messages'];
  transcriptState: SessionChatController['transcriptState'];
  pendingApprovals: readonly PendingApproval[];
  pendingQuestions: readonly PendingQuestion[];
  statusFacts: ChatStatusFacts;
  capabilities: ChatCapabilities;
  settledPhase: 'idle' | 'failed';
}

function capabilitiesFromFeatures(
  features: readonly string[],
): ChatCapabilities {
  const regions = new Set<ChatRegion>();
  const map = DAEMON_CHAT_CAPABILITY_MAP as Record<
    string,
    readonly ChatRegion[]
  >;
  for (const feature of features) {
    const mapped = map[feature];
    if (mapped) for (const region of mapped) regions.add(region);
  }
  return regionsToCapabilities(regions);
}

/**
 * Binds the daemon session provider to the backend-neutral chat controller
 * (slice 2d). It constructs {@link createDaemonChatController} once per session
 * and feeds it live provider facts, wiring the intent transports to the session
 * actions and deriving the two evidence channels the provider does not expose
 * explicitly: prompt settlement comes from the terminal-event subscription, and
 * approval currency / decision settlement are derived from the pending-permission
 * set (see {@link derivePermissionSignals}).
 *
 * The optional capability-gated sub-controllers (model / approval-mode / context
 * usage / session ops) are not bound yet; their regions stay hidden until a later
 * increment wires them, so this binding is additive and renders nothing on its own.
 */
export function useDaemonChatController(): SessionChatController {
  const { t } = useI18n();
  const connection = useDaemonConnection();
  const actions = useDaemonActions();
  const blocks = useDaemonTranscriptBlocks();
  const pendingPermissions = useDaemonPendingPermissions();
  const messages = useMessagesFromBlocks(t, blocks);

  const sessionId = connection.sessionId;
  const pendingApprovals: readonly PendingApproval[] = pendingPermissions.map(
    (permission) => ({ id: permission.requestId, status: 'pending' }),
  );

  const factsRef = useRef<LiveFacts>({
    messages,
    transcriptState: 'loading',
    pendingApprovals,
    pendingQuestions: [],
    statusFacts: { queueLength: 0, goalActive: false },
    capabilities: regionsToCapabilities([]),
    settledPhase: 'idle',
  });
  factsRef.current = {
    messages,
    transcriptState: connection.loadingTranscript ? 'loading' : 'ready',
    pendingApprovals,
    // Pending questions, queue length and goal activity are surfaced by the
    // ChatSurface increment; the provider exposes no direct selector/hook for
    // them yet, so they are bound conservatively here.
    pendingQuestions: [],
    statusFacts: { queueLength: 0, goalActive: false },
    capabilities: capabilitiesFromFeatures(
      connection.capabilities?.features ?? [],
    ),
    settledPhase: 'idle',
  };

  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  const promptListenerRef = useRef<
    ((e: DaemonPromptSettlement) => void) | undefined
  >(undefined);
  const decisionListenerRef = useRef<
    ((e: DaemonDecisionSettlement) => void) | undefined
  >(undefined);
  const currencyListenerRef = useRef<
    ((id: string, live: boolean) => void) | undefined
  >(undefined);
  const answeredRef = useRef<Set<string>>(new Set());
  const prevPendingRef = useRef<Set<string>>(new Set());

  const controllerRef = useRef<{
    sessionId: string | undefined;
    controller: SessionChatController;
  } | null>(null);

  if (!controllerRef.current || controllerRef.current.sessionId !== sessionId) {
    answeredRef.current = new Set();
    prevPendingRef.current = new Set();
    controllerRef.current = {
      sessionId,
      controller: createDaemonChatController({
        sessionId: sessionId ?? '',
        storageKey:
          getComposerDraftStorageKey(sessionId, connection.workspaceCwd) ?? '',
        get messages() {
          return factsRef.current.messages;
        },
        get transcriptState() {
          return factsRef.current.transcriptState;
        },
        get pendingApprovals() {
          return factsRef.current.pendingApprovals;
        },
        get pendingQuestions() {
          return factsRef.current.pendingQuestions;
        },
        get statusFacts() {
          return factsRef.current.statusFacts;
        },
        get capabilities() {
          return factsRef.current.capabilities;
        },
        get settledPhase() {
          return factsRef.current.settledPhase;
        },
        liveApprovalRequestIds: pendingApprovals.map((approval) => approval.id),
        async submitPrompt(input, onAdmitted) {
          try {
            await actionsRef.current.submitPrompt(input.text, {
              images: input.images ? [...input.images] : undefined,
              files: input.files ? [...input.files] : undefined,
              onAdmitted: ({ promptId }) => onAdmitted(promptId),
            });
            return 'accepted';
          } catch {
            return 'unknown';
          }
        },
        async cancelPrompt() {
          try {
            await actionsRef.current.cancel();
            return 'accepted';
          } catch {
            return 'unknown';
          }
        },
        async submitPermission(requestId, optionId) {
          answeredRef.current.add(requestId);
          try {
            const applied = await actionsRef.current.submitPermission(
              requestId,
              optionId,
            );
            if (!applied) answeredRef.current.delete(requestId);
            return applied ? 'accepted' : 'rejected';
          } catch {
            // Admission unknown: the answer may still have been applied (lost
            // response), so keep it tracked for the permission-resolution signal.
            return 'unknown';
          }
        },
        async submitQuestionAnswers(requestId, answers) {
          answeredRef.current.add(requestId);
          const record: Record<string, string> = {};
          for (const answer of answers)
            record[answer.questionId] = answer.value;
          try {
            const applied = await actionsRef.current.submitPermission(
              requestId,
              undefined,
              record,
            );
            if (!applied) answeredRef.current.delete(requestId);
            return applied ? 'accepted' : 'rejected';
          } catch {
            return 'unknown';
          }
        },
        subscribePromptSettlement(listener) {
          promptListenerRef.current = listener;
          return () => {
            promptListenerRef.current = undefined;
          };
        },
        subscribeDecisionSettlement(listener) {
          decisionListenerRef.current = listener;
          return () => {
            decisionListenerRef.current = undefined;
          };
        },
        subscribeApprovalCurrency(listener) {
          currencyListenerRef.current = listener;
          return () => {
            currencyListenerRef.current = undefined;
          };
        },
      }),
    };
  }

  useDaemonPromptSettled(
    useCallback((event: DaemonPromptSettledEvent) => {
      promptListenerRef.current?.({
        promptId: event.promptId,
        outcome: event.outcome,
      });
    }, []),
  );

  useEffect(() => {
    const nextPending = new Set(
      pendingPermissions.map((permission) => permission.requestId),
    );
    const signals = derivePermissionSignals(
      prevPendingRef.current,
      nextPending,
      answeredRef.current,
    );
    prevPendingRef.current = nextPending;
    answeredRef.current = new Set(signals.answered);
    for (const [requestId, live] of signals.currency) {
      currencyListenerRef.current?.(requestId, live);
    }
    for (const decision of signals.decisions) {
      decisionListenerRef.current?.(decision);
    }
  }, [pendingPermissions]);

  return controllerRef.current.controller;
}
