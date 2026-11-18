import type {
  ManagedAgentSessionEvent,
  ManagedAgentSessionSummary,
} from './managed-agent-provider';

export interface ManagedRecoveryHandoff {
  sourceSessionId: string;
  workspaceId?: string;
  cwdRelative?: string;
  agentId?: string;
  text: string;
  truncated: boolean;
}

const MAX_BYTES = 32 * 1024;
const encoder = new TextEncoder();

function clip(text: string, budget: number): string {
  const bytes = encoder.encode(text);
  return bytes.length <= budget
    ? text
    : new TextDecoder('utf-8', { fatal: false }).decode(
        bytes.subarray(0, budget),
        { stream: true },
      );
}

function userText(event: ManagedAgentSessionEvent): string {
  if (
    event.type !== 'accepted' ||
    !event.data ||
    typeof event.data !== 'object'
  )
    return '';
  const prompt = (event.data as Record<string, unknown>)['prompt'];
  if (!Array.isArray(prompt)) return '';
  return prompt
    .flatMap((block: unknown) => {
      if (!block || typeof block !== 'object') return [];
      const item = block as Record<string, unknown>;
      return (item['type'] === 'text' || item['type'] === 'input_text') &&
        typeof item['text'] === 'string'
        ? [item['text']]
        : [];
    })
    .join('\n');
}

export function buildManagedRecoveryHandoff(
  summary: ManagedAgentSessionSummary,
  events: readonly ManagedAgentSessionEvent[],
  headings: {
    introduction: string;
    source: string;
    task: string;
    confirmed: string;
    uncertain: string;
    truncated: string;
  },
  incompleteHistory = false,
): ManagedRecoveryHandoff {
  const completed = new Set(
    events
      .filter((event) => event.type === 'completed')
      .map((event) => event.turnId),
  );
  const users = events.filter((event) => event.type === 'accepted');
  const lastUser = users.at(-1);
  const reason =
    summary.recovery?.reasonCode ?? summary.failure?.code ?? 'unknown';
  const header =
    `${headings.introduction}\n${headings.source}: ${clip(summary.sessionId, 256)}\n` +
    `${headings.uncertain}: ${clip(reason, 1024)}; ${summary.recovery?.turnId ?? summary.activeTurnId ?? ''}\n`;
  const task =
    `${headings.task}:\n${clip(summary.title, 1024)}\n` +
    `${clip(lastUser ? userText(lastUser) : '', 8 * 1024)}\n`;
  let text = header + task;
  let truncated =
    incompleteHistory ||
    encoder.encode(summary.title).length > 1024 ||
    encoder.encode(reason).length > 1024 ||
    (lastUser !== undefined &&
      encoder.encode(userText(lastUser)).length > 8 * 1024);
  const marker = `\n${headings.truncated}\n`;
  const budget = MAX_BYTES - encoder.encode(marker).length;
  const blocks: string[] = [];
  for (const user of [...users].reverse()) {
    if (!completed.has(user.turnId)) continue;
    const answer = events
      .filter(
        (event) =>
          event.turnId === user.turnId && event.type === 'assistant_delta',
      )
      .flatMap((event) => {
        const data =
          event.data && typeof event.data === 'object'
            ? (event.data as Record<string, unknown>)
            : {};
        return typeof data['text'] === 'string' ? [data['text']] : [];
      })
      .join('');
    const block = `\n${headings.confirmed}\nUser:\n${userText(user)}\nAssistant:\n${answer}\n`;
    if (encoder.encode(text + block + blocks.join('')).length > budget) {
      truncated = true;
      break;
    }
    blocks.unshift(block);
  }
  text += blocks.join('');
  if (truncated) text += marker;
  return {
    sourceSessionId: summary.sessionId,
    workspaceId: summary.workspace?.workspaceId,
    cwdRelative: summary.workspace?.cwdRelative,
    agentId: summary.agentId,
    text,
    truncated,
  };
}
