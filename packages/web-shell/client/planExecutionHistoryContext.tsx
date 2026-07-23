import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import type { ACPToolCall, Message } from './adapters/types';
import {
  extractTodosFromToolCall,
  getAgentToolsForPlan,
  getTodoPlanId,
} from './utils/todos';

interface PlanExecutionSource {
  messageId?: string;
  toolCallId?: string;
}

interface PlanExecutionHistoryContextValue {
  resolveLoaded(source: PlanExecutionSource): ACPToolCall[];
  resolveComplete(source: PlanExecutionSource): Promise<ACPToolCall[]>;
}

const EMPTY_CONTEXT: PlanExecutionHistoryContextValue = {
  resolveLoaded: () => [],
  resolveComplete: async () => [],
};

const PlanExecutionHistoryContext =
  createContext<PlanExecutionHistoryContextValue>(EMPTY_CONTEXT);

function findSource(
  messages: readonly Message[],
  source: PlanExecutionSource,
): { planId: string | null; sourceMessageId: string } | undefined {
  const sourceMessage = source.messageId
    ? messages.find((message) => message.id === source.messageId)
    : messages.find(
        (message) =>
          message.role === 'tool_group' &&
          message.tools.some((tool) => tool.callId === source.toolCallId),
      );
  if (!sourceMessage) return undefined;
  const sourceTool =
    sourceMessage.role === 'tool_group'
      ? sourceMessage.tools.find((tool) => tool.callId === source.toolCallId)
      : undefined;
  return {
    planId: sourceTool ? getTodoPlanId(sourceTool) : null,
    sourceMessageId: sourceMessage.id,
  };
}

function hasEarlierPlanBoundary(
  messages: readonly Message[],
  planId: string,
): boolean {
  const firstPlanIndex = messages.findIndex(
    (message) =>
      message.role === 'tool_group' &&
      message.tools.some(
        (tool) =>
          extractTodosFromToolCall(tool) !== undefined &&
          getTodoPlanId(tool) === planId,
      ),
  );
  if (firstPlanIndex < 0) return false;
  return messages.slice(0, firstPlanIndex).some((message) => {
    if (message.role === 'plan') return true;
    if (message.role !== 'tool_group') return false;
    return message.tools.some((tool) => {
      if (extractTodosFromToolCall(tool) === undefined) return false;
      const earlierPlanId = getTodoPlanId(tool);
      return earlierPlanId !== null && earlierPlanId !== planId;
    });
  });
}

export function PlanExecutionHistoryProvider({
  messages,
  hasOlderHistory = false,
  onLoadOlderHistory,
  children,
}: {
  messages: readonly Message[];
  hasOlderHistory?: boolean;
  onLoadOlderHistory?: () => Promise<boolean>;
  children: ReactNode;
}) {
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const historyRef = useRef({ hasOlderHistory, onLoadOlderHistory });
  historyRef.current = { hasOlderHistory, onLoadOlderHistory };

  const resolveLoaded = useCallback(
    (source: PlanExecutionSource): ACPToolCall[] => {
      const current = messagesRef.current;
      const plan = findSource(current, source);
      return plan ? getAgentToolsForPlan(current, plan) : [];
    },
    [],
  );

  const resolveComplete = useCallback(
    async (source: PlanExecutionSource): Promise<ACPToolCall[]> => {
      const initialPlan = findSource(messagesRef.current, source);
      if (!initialPlan || initialPlan.planId === null) {
        return resolveLoaded(source);
      }

      while (
        historyRef.current.hasOlderHistory &&
        historyRef.current.onLoadOlderHistory &&
        !hasEarlierPlanBoundary(messagesRef.current, initialPlan.planId)
      ) {
        const before = messagesRef.current[0]?.id;
        const loaded = await historyRef.current.onLoadOlderHistory();
        if (!loaded) {
          throw new Error('Unable to load earlier session history');
        }
        await Promise.resolve();
        if (messagesRef.current[0]?.id === before) break;
      }
      return resolveLoaded(source);
    },
    [resolveLoaded],
  );
  const value = useMemo(
    () => ({ resolveLoaded, resolveComplete }),
    [resolveComplete, resolveLoaded],
  );

  return (
    <PlanExecutionHistoryContext.Provider value={value}>
      {children}
    </PlanExecutionHistoryContext.Provider>
  );
}

export function usePlanExecutionHistory(): PlanExecutionHistoryContextValue {
  return useContext(PlanExecutionHistoryContext);
}
