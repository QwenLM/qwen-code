import type { DaemonWorkspaceCapability } from '@qwen-code/sdk/daemon';
import { workspaceLabel } from './workspace';

/**
 * `/send [--workspace <name|path|id>] [--session-id <id>] <message>`.
 *
 * Options come first; everything after them is the message, newlines
 * included. A value may be quoted ("…" or '…') when it holds spaces, and
 * `--option=value` works too. Without `--session-id` the message starts a new
 * session; without `--workspace` it goes to the current workspace.
 */
export type SendCommandParse =
  | { ok: true; workspace?: string; sessionId?: string; message: string }
  | {
      ok: false;
      error: 'missing-message' | 'missing-value' | 'duplicate-option';
      option?: string;
    };

export const SEND_COMMAND_OPTIONS = ['--workspace', '--session-id'] as const;
type SendOption = (typeof SEND_COMMAND_OPTIONS)[number];

function readValue(
  text: string,
  start: number,
): { value: string; end: number } | undefined {
  const quote = text[start];
  if (quote === '"' || quote === "'") {
    const close = text.indexOf(quote, start + 1);
    if (close === -1) return undefined;
    return { value: text.slice(start + 1, close), end: close + 1 };
  }
  const match = /^\S+/.exec(text.slice(start));
  return match ? { value: match[0], end: start + match[0].length } : undefined;
}

export function parseSendCommand(args: string): SendCommandParse {
  const values: Partial<Record<SendOption, string>> = {};
  let pos = 0;
  for (;;) {
    while (pos < args.length && /\s/.test(args[pos]!)) pos += 1;
    const option = SEND_COMMAND_OPTIONS.find(
      (name) =>
        args.startsWith(name, pos) &&
        (pos + name.length === args.length ||
          /[\s=]/.test(args[pos + name.length]!)),
    );
    if (!option) break;
    if (values[option] !== undefined) {
      return { ok: false, error: 'duplicate-option', option };
    }
    pos += option.length;
    if (args[pos] === '=') {
      pos += 1;
    } else {
      while (pos < args.length && /[^\S\n]/.test(args[pos]!)) pos += 1;
    }
    const read = readValue(args, pos);
    if (!read || !read.value.trim()) {
      return { ok: false, error: 'missing-value', option };
    }
    values[option] = read.value.trim();
    pos = read.end;
  }
  const message = args.slice(pos).trim();
  if (!message) return { ok: false, error: 'missing-message' };
  return {
    ok: true,
    ...(values['--workspace'] ? { workspace: values['--workspace'] } : {}),
    ...(values['--session-id'] ? { sessionId: values['--session-id'] } : {}),
    message,
  };
}

export type SendCommand = Extract<SendCommandParse, { ok: true }>;

/**
 * Map a `--workspace` value to a registered workspace: its path or id, or
 * its name when only one workspace has that name. Anything else goes to the
 * daemon as typed, which refuses what it does not know.
 */
export function resolveSendWorkspace(
  workspaces: readonly DaemonWorkspaceCapability[],
  value: string,
): string {
  const exact = workspaces.find(
    (workspace) => workspace.cwd === value || workspace.id === value,
  );
  if (exact) return exact.cwd;
  const name = value.toLowerCase();
  const named = workspaces.filter(
    (workspace) => workspaceLabel(workspace).toLowerCase() === name,
  );
  return named.length === 1 ? named[0]!.cwd : value;
}
