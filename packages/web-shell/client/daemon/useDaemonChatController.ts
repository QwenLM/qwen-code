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
import { extractPendingPermission } from '../adapters/transcriptAdapter.js';
import { isAskUserPermission } from '../utils/askUserPermission.js';
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
import {
  derivePermissionSignals,
  questionSubmitOptionId,
} from './permission-signals.js';

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
    // features are unvalidated wire strings; guard against Object.prototype
    // members (e.g. "toString") resolving to a non-iterable inherited value.
    if (!Object.hasOwn(map, feature)) continue;
    for (const region of map[feature]) regions.add(region);
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
  // Questions are permission blocks too; split them from tool approvals the same
  // way the existing UI does, so a question is answered with answers rather than
  // routed through the approval lane as a bare vote.
  const approvals: PendingApproval[] = [];
  const questions: PendingQuestion[] = [];
  for (const permission of pendingPermissions) {
    if (isAskUserPermission(extractPendingPermission([permission]))) {
      questions.push({ id: permission.requestId });
    } else {
      approvals.push({ id: permission.requestId, status: 'pending' });
    }
  }
  const pendingApprovals: readonly PendingApproval[] = approvals;
  const pendingQuestions: readonly PendingQuestion[] = questions;

  const factsRef = useRef<LiveFacts>({
    messages,
    transcriptState: 'loading',
    pendingApprovals,
    pendingQuestions,
    statusFacts: { queueLength: 0, goalActive: false },
    capabilities: regionsToCapabilities([]),
    settledPhase: 'idle',
  });
  factsRef.current = {
    messages,
    transcriptState:
      connection.missingSession || connection.error
        ? 'error'
        : connection.loadingTranscript
          ? 'loading'
          : 'ready',
    pendingApprovals,
    pendingQuestions,
    // Queue length and goal activity are surfaced by the ChatSurface increment;
    // the provider exposes no direct selector/hook for them yet.
    statusFacts: { queueLength: 0, goalActive: false },
    capabilities: capabilitiesFromFeatures(
      connection.capabilities?.features ?? [],
    ),
    settledPhase: 'idle',
  };

  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  const pendingPermissionsRef = useRef(pendingPermissions);
  pendingPermissionsRef.current = pendingPermissions;

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
              // The composer's @-file references reach the daemon only through
              // inputAnnotations; dropping them loses the reference chips.
              ...(input.metadata?.inputAnnotations?.length
                ? { inputAnnotations: [...input.metadata.inputAnnotations] }
                : {}),
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
            // Admission unknown: the controller abandons the attempt, so a
            // later permission-resolution signal could not settle it anyway;
            // drop the answer tracking instead of retaining a useless entry.
            answeredRef.current.delete(requestId);
            return 'unknown';
          }
        },
        async submitQuestionAnswers(requestId, answers) {
          // A question is answered by voting its submit (allow_once) option with
          // the answers attached — the same wire shape AskUserQuestion uses.
          // Voting with no optionId sends a 'cancelled' outcome, which discards
          // the answers and cancels the question, so require the submit option.
          const submitOptionId = questionSubmitOptionId(
            pendingPermissionsRef.current,
            requestId,
          );
          if (!submitOptionId) return 'rejected';
          // The daemon keys answers by the question's decimal index (the shape
          // AskUserQuestion.buildResult emits); an id-shaped key would be
          // silently discarded while the vote still succeeds, so validate each
          // questionId against the question count instead.
          const permission = pendingPermissionsRef.current.find(
            (candidate) => candidate.requestId === requestId,
          );
          const questions = permission
            ? extractPendingPermission([permission])?.rawInput?.questions
            : undefined;
          const questionCount = Array.isArray(questions) ? questions.length : 0;
          const record: Record<string, string> = {};
          for (const answer of answers) {
            const index = Number(answer.questionId);
            if (
              !Number.isInteger(index) ||
              index < 0 ||
              index >= questionCount
            ) {
              return 'rejected';
            }
            record[String(index)] = answer.value;
          }
          answeredRef.current.add(requestId);
          try {
            const applied = await actionsRef.current.submitPermission(
              requestId,
              submitOptionId,
              record,
            );
            if (!applied) answeredRef.current.delete(requestId);
            return applied ? 'accepted' : 'rejected';
          } catch {
            answeredRef.current.delete(requestId);
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
