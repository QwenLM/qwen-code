import type { Message } from '../../adapters/types';
import { isTurnCallsPrompt } from '../../turnCallsContext';
import type { HookStatisticsTurn } from './hook-statistics-context';

export function collectHookStatisticsTurns(
  messages: readonly Message[],
  sessionId: string,
): ReadonlyMap<string, HookStatisticsTurn> {
  const turns = new Map<string, HookStatisticsTurn>();
  let head: Message | undefined;
  let target: string | undefined;
  let hasAssistant = false;
  const finish = () => {
    if (head && target)
      turns.set(target, {
        sessionId,
        promptId: head.promptId,
        recordId: head.sourceRecordIds?.[0],
      });
  };
  for (const message of messages) {
    if (
      message.role === 'user' &&
      isTurnCallsPrompt(message.source, message.content)
    ) {
      finish();
      head = message;
      target = message.id;
      hasAssistant = false;
    } else if (message.role === 'user_shell') {
      finish();
      head = undefined;
      target = undefined;
      hasAssistant = false;
    } else if (head && !message.backgroundTurn) {
      if (
        message.role === 'assistant' &&
        !message.agentMessage &&
        !!message.content &&
        message.content.trim()
      ) {
        target = message.id;
        hasAssistant = true;
      } else if (
        !hasAssistant &&
        message.role === 'system' &&
        (message.source === 'turn_error' ||
          message.source === 'prompt_cancelled')
      ) {
        target = message.id;
      }
    }
  }
  finish();
  return turns;
}
