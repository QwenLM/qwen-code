import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Message } from '../adapters/types';
import type { DaemonSessionActions } from '@qwen-code/webui/daemon-react-sdk';

const MIN_PROMPT_LENGTH = 12;
const MIN_MESSAGE_COUNT = 8;
const MIN_CONTEXT_USAGE_RATIO = 0.35;
const MIN_EXPLICIT_CUE_MESSAGE_COUNT = 2;
const MIN_EXPLICIT_CUE_CONTEXT_USAGE_RATIO = 0.1;
const REQUEST_DEBOUNCE_MS = 700;
const SUPPRESS_MS = 10 * 60 * 1000;
const MIN_CONFIDENCE = 0.75;
const MAX_RECENT_MESSAGES = 8;
const MAX_MESSAGE_TEXT_CHARS = 280;

const FOLLOWUP_LIKE_PATTERNS = [
  /^继续[吧呢]?$/,
  /^行[吧吗]?$/,
  /^好的?$/,
  /^再[看试说解释改跑补].*/,
  /^顺手.*/,
  /^上面.*/,
  /^刚才.*/,
  /^这个报错.*/,
  /^那你.*/,
  /^帮我修.*/,
  /^帮我看下.*/,
  /^跑(一下)?(测试|看看).*/,
  /^这个实现.*/,
  /^这个 PR.*/i,
  /^继续当前.*/,
  /^continue$/i,
  /^ok(?:ay)?$/i,
  /^retry$/i,
  /^fix (?:that|this|it)/i,
  /^run (?:the )?tests?/i,
];

const EXPLICIT_NEW_TASK_PATTERNS = [
  /新的?(功能|任务|方向|话题)/,
  /写(一篇)?(设计文档|文档|spec|方案)/i,
  /产品方案/,
  /脑爆/,
  /另一个(功能|方向|任务|主题)/,
  /不继续当前/,
  /切到(一个)?新的?(任务|方向|话题)/,
  /start (a )?new/i,
  /new (feature|task|design|spec|doc|workflow)/i,
  /product (design|plan|spec)/i,
  /brainstorm/i,
];

type SuggestionKind = 'btw' | 'new_session' | 'none';

interface ComposerSuggestionDecision {
  suggestion: SuggestionKind;
  confidence: number;
}

export interface NewSessionSuggestionState {
  suggestion: Exclude<SuggestionKind, 'none'>;
  confidence: number;
  classifiedInput: string;
  sourceSessionId: string;
}

export interface UseNewSessionSuggestionOptions {
  enabled: boolean;
  inputText: string;
  messages: Message[];
  sessionId?: string;
  contextUsageRatio: number;
  isRunning: boolean;
  dialogOpen: boolean;
  hasAttachments: boolean | null;
  generateContent?: DaemonSessionActions['generateSessionContent'];
}

export interface UseNewSessionSuggestionReturn {
  suggestion: NewSessionSuggestionState | null;
  dismiss: () => void;
  suppress: () => void;
}

function isFollowupLike(text: string): boolean {
  const trimmed = text.trim();
  return FOLLOWUP_LIKE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function hasExplicitNewTaskCue(text: string): boolean {
  const trimmed = text.trim();
  return EXPLICIT_NEW_TASK_PATTERNS.some((pattern) => pattern.test(trimmed));
}

type VisibleConversationMessage = Extract<
  Message,
  { role: 'user' | 'assistant' }
> & {
  content: string;
};

function summarizeMessages(
  messages: Message[],
): Array<{ role: 'user' | 'assistant'; text: string }> {
  const visible = messages.filter(
    (message): message is VisibleConversationMessage =>
      (message.role === 'user' || message.role === 'assistant') &&
      typeof message.content === 'string' &&
      message.content.trim().length > 0,
  );
  return visible.slice(-MAX_RECENT_MESSAGES).map((message) => ({
    role: message.role,
    text: message.content.trim().slice(0, MAX_MESSAGE_TEXT_CHARS),
  }));
}

function buildPrompt(params: {
  recentMessages: Array<{ role: 'user' | 'assistant'; text: string }>;
  currentInput: string;
  contextUsageRatio: number;
  messageCount: number;
}): string {
  const recent = params.recentMessages
    .map((message, index) => `${index + 1}. ${message.role}: ${message.text}`)
    .join('\n');
  return [
    "You are deciding how a user's new message should be handled in the current coding session.",
    'Choose "new_session" only when the message is clearly a different task or topic and continuing here would add context noise.',
    'Choose "btw" only for a brief side question that can be answered without changing the main task or adding its answer to the main conversation context.',
    'Choose "none" for follow-ups, implementation continuations, debugging iterations, review follow-ups, and adjacent discussion about the same repo, PR, bug, or feature.',
    'Be conservative. When in doubt, choose "none".',
    'Return JSON only with keys: suggestion ("btw", "new_session", or "none") and confidence (0-1 number).',
    '',
    `Context usage ratio: ${params.contextUsageRatio.toFixed(2)}`,
    `Visible message count: ${params.messageCount}`,
    '',
    'Recent visible messages:',
    recent || '(none)',
    '',
    'Current user input:',
    params.currentInput,
  ].join('\n');
}

function tryParseDecision(text: string): ComposerSuggestionDecision | null {
  try {
    const parsed = JSON.parse(text) as Partial<ComposerSuggestionDecision>;
    if (
      parsed.suggestion !== 'btw' &&
      parsed.suggestion !== 'new_session' &&
      parsed.suggestion !== 'none'
    ) {
      return null;
    }
    if (
      typeof parsed.confidence !== 'number' ||
      !Number.isFinite(parsed.confidence) ||
      parsed.confidence < 0 ||
      parsed.confidence > 1
    ) {
      return null;
    }
    return {
      suggestion: parsed.suggestion,
      confidence: parsed.confidence,
    };
  } catch {
    return null;
  }
}

function parseDecision(text: string): ComposerSuggestionDecision | null {
  const direct = tryParseDecision(text);
  if (direct) return direct;
  // Despite the JSON-only instruction, the model sometimes wraps a perfectly
  // valid decision in prose or a code fence (observed live: prose preamble +
  // bare JSON on ~1 of 3 runs). A bare JSON.parse throws and the warranted
  // suggestion is silently dropped — a pure recall loss. Recover by slicing
  // from the first '{' to the last '}' and re-parsing; anything still
  // unparseable or mis-shaped stays null, so the gate remains fail-closed
  // (the banner can only ever be under-shown, never mis-shown).
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  const sliced = text.slice(start, end + 1);
  if (sliced === text) return null;
  return tryParseDecision(sliced);
}

export function useNewSessionSuggestion({
  enabled,
  inputText,
  messages,
  sessionId,
  contextUsageRatio,
  isRunning,
  dialogOpen,
  hasAttachments,
  generateContent,
}: UseNewSessionSuggestionOptions): UseNewSessionSuggestionReturn {
  const [suggestion, setSuggestion] =
    useState<NewSessionSuggestionState | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const suppressUntilRef = useRef(0);
  const latestSessionIdRef = useRef(sessionId);

  const recentMessages = useMemo(() => summarizeMessages(messages), [messages]);

  const clearPending = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const dismiss = useCallback(() => {
    setSuggestion(null);
    clearPending();
  }, [clearPending]);

  const suppress = useCallback(() => {
    suppressUntilRef.current = Date.now() + SUPPRESS_MS;
    setSuggestion(null);
    clearPending();
  }, [clearPending]);

  useEffect(() => {
    if (latestSessionIdRef.current !== sessionId) {
      setSuggestion(null);
      clearPending();
      latestSessionIdRef.current = sessionId;
    }
  }, [clearPending, sessionId]);

  useEffect(() => {
    clearPending();
    if (!enabled || !generateContent || !sessionId) {
      setSuggestion(null);
      return;
    }
    const trimmed = inputText.trim();
    if (trimmed.length < MIN_PROMPT_LENGTH) {
      setSuggestion(null);
      return;
    }
    if (isFollowupLike(trimmed)) {
      setSuggestion(null);
      return;
    }
    const explicitNewTaskCue = hasExplicitNewTaskCue(trimmed);
    if (isRunning || dialogOpen) {
      setSuggestion(null);
      return;
    }
    if (
      explicitNewTaskCue
        ? recentMessages.length < MIN_EXPLICIT_CUE_MESSAGE_COUNT &&
          contextUsageRatio < MIN_EXPLICIT_CUE_CONTEXT_USAGE_RATIO
        : recentMessages.length < MIN_MESSAGE_COUNT &&
          contextUsageRatio < MIN_CONTEXT_USAGE_RATIO
    ) {
      setSuggestion(null);
      return;
    }
    if (Date.now() < suppressUntilRef.current) {
      setSuggestion(null);
      return;
    }

    setSuggestion(null);
    timerRef.current = setTimeout(() => {
      const controller = new AbortController();
      abortRef.current = controller;
      const prompt = buildPrompt({
        recentMessages,
        currentInput: trimmed,
        contextUsageRatio,
        messageCount: recentMessages.length,
      });
      void (async () => {
        let text = '';
        try {
          for await (const event of generateContent(prompt, {
            signal: controller.signal,
          })) {
            if (abortRef.current !== controller) return;
            if (event.type === 'delta') {
              text += event.text;
            } else if (event.type === 'error') {
              if (abortRef.current === controller) {
                setSuggestion(null);
              }
              return;
            }
          }
          if (abortRef.current !== controller) return;
          const decision = parseDecision(text.trim());
          if (
            decision &&
            decision.suggestion !== 'none' &&
            (decision.suggestion !== 'btw' || hasAttachments === false) &&
            decision.confidence >= MIN_CONFIDENCE
          ) {
            setSuggestion({
              suggestion: decision.suggestion,
              confidence: decision.confidence,
              classifiedInput: trimmed,
              sourceSessionId: sessionId,
            });
            return;
          }
          setSuggestion(null);
        } catch {
          if (!controller.signal.aborted) {
            setSuggestion(null);
          }
        } finally {
          if (abortRef.current === controller) {
            abortRef.current = null;
          }
        }
      })();
    }, REQUEST_DEBOUNCE_MS);

    return () => {
      clearPending();
    };
  }, [
    clearPending,
    contextUsageRatio,
    dialogOpen,
    enabled,
    generateContent,
    hasAttachments,
    inputText,
    isRunning,
    recentMessages,
    sessionId,
  ]);

  return {
    suggestion,
    dismiss,
    suppress,
  };
}
