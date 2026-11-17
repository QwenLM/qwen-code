import type {
  SlashArgumentCompleter,
  SlashCommandCompletionResult,
} from './slashCompletion';
import { SEND_COMMAND_OPTIONS } from '../utils/sendCommand';

type SendOption = (typeof SEND_COMMAND_OPTIONS)[number];

export interface SendCompletionChoice {
  /** What goes into the command line. */
  value: string;
  label: string;
  detail?: string;
}

export interface SendCompletionSources {
  /** `--workspace` choices; `value` is what the command resolves to `cwd`. */
  workspaces: ReadonlyArray<SendCompletionChoice & { cwd: string }>;
  /** The workspace `/send` targets without `--workspace`. */
  currentWorkspaceCwd: string;
  /** `--session-id` choices for a workspace, or `undefined` until loaded. */
  sessionsFor(
    workspaceCwd: string,
  ): readonly SendCompletionChoice[] | undefined;
  optionDetail(option: SendOption): string;
}

const TOKEN = /"[^"]*"?|'[^']*'?|\S+/g;

function unquote(token: string): string {
  const quote = token[0];
  if (quote !== '"' && quote !== "'") return token;
  return token.length > 1 && token.endsWith(quote)
    ? token.slice(1, -1)
    : token.slice(1);
}

function quoteIfNeeded(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

/**
 * Completes `/send` options and their values: option names, registered
 * workspaces, and the sessions of the chosen workspace. Once the message
 * starts, it offers nothing. Each item replaces the line up to the cursor.
 */
export function createSendArgumentCompleter(
  sources: SendCompletionSources,
): SlashArgumentCompleter {
  return (line) => {
    const head = /^\/send(\s+)/.exec(line);
    if (!head) return /^\/send$/.test(line) ? null : undefined;
    const args = line.slice(head[0].length);
    const tokens = Array.from(args.matchAll(TOKEN), (match) => ({
      text: match[0],
      start: head[0].length + match.index,
    }));
    const current = /\s$/.test(line) ? undefined : tokens.pop();
    const typedFrom = current?.start ?? line.length;
    const typed = current?.text ?? '';
    // Every token before the one being typed is an option and its value.
    const used = new Map<SendOption, string>();
    let pending: SendOption | undefined;
    for (const token of tokens) {
      if (pending) {
        used.set(pending, unquote(token.text));
        pending = undefined;
        continue;
      }
      const option = SEND_COMMAND_OPTIONS.find((name) => name === token.text);
      if (!option) return null;
      pending = option;
    }

    let choices: readonly SendCompletionChoice[] | undefined;
    if (pending === '--workspace') {
      choices = sources.workspaces;
    } else if (pending === '--session-id') {
      const named = used.get('--workspace');
      const cwd =
        named === undefined
          ? sources.currentWorkspaceCwd
          : sources.workspaces.find(
              (workspace) =>
                workspace.value === named ||
                workspace.cwd === named ||
                workspace.label.toLowerCase() === named.toLowerCase(),
            )?.cwd;
      choices = cwd === undefined ? undefined : sources.sessionsFor(cwd);
    } else {
      if (typed && !typed.startsWith('-')) return null;
      choices = SEND_COMMAND_OPTIONS.filter((option) => !used.has(option)).map(
        (option) => ({
          value: option,
          label: option,
          detail: sources.optionDetail(option),
        }),
      );
    }
    if (!choices) return null;

    const query = unquote(typed).toLowerCase();
    const matching = choices.filter(
      (choice) =>
        !query ||
        choice.label.toLowerCase().includes(query) ||
        choice.value.toLowerCase().includes(query),
    );
    if (matching.length === 0) return null;
    const prefix = line.slice(0, typedFrom);
    const items: SlashCommandCompletionResult['items'] = matching.map(
      (choice) => ({
        id: `${pending ?? 'option'}:${choice.value}`,
        label: choice.label,
        ...(choice.detail ? { detail: choice.detail } : {}),
        apply: `${prefix}${quoteIfNeeded(choice.value)} `,
      }),
    );
    return {
      kind: 'subcommand',
      from: 0,
      to: line.length,
      query: typed,
      items,
    };
  };
}
