/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `qwen agents join <link>`: make the running local `qwen serve` join a
 * coordinator as an Agent Host, without restarting it. It calls the daemon's
 * own `POST /workspaces/<cwd>/agent/hosts/connect`; the daemon enrolls,
 * remembers the connection and reconnects after restarts.
 */

import type { CommandModule } from 'yargs';
import { parseJoinLink } from '../../serve/agent-host-join.js';
import {
  QWEN_DAEMON_TOKEN_ENV,
  QWEN_DAEMON_URL_ENV,
  QWEN_SERVER_TOKEN_ENV,
} from '../../serve/channel-worker-env.js';
import { writeStderrLine, writeStdoutLine } from '../../utils/stdioHelpers.js';

export const DEFAULT_DAEMON_URL = 'http://127.0.0.1:4170';
export const ENROLLMENT_TOKEN_ENV = 'QWEN_AGENT_HOST_ENROLLMENT_TOKEN';

export interface JoinArgs {
  link: string;
  'daemon-url'?: string;
  token?: string;
  workspace?: string;
  'allow-http'?: boolean;
}

export interface JoinDeps {
  fetch: typeof fetch;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Asks for the enrollment token; undefined when nobody can answer. */
  promptToken: () => Promise<string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** The parts of a TTY stdin a hidden prompt uses. */
export interface HiddenInput {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (raw: boolean) => unknown;
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  off(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

/**
 * Reads one line from a TTY without echoing it (raw mode, restored after).
 * Enter or Ctrl+D ends the line, Backspace edits it, Ctrl+C cancels
 * (undefined). Undefined as well when `input` is not a TTY.
 */
export function readHiddenLine(
  question: string,
  input: HiddenInput,
  write: (text: string) => void,
): Promise<string | undefined> {
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    return Promise.resolve(undefined);
  }
  const wasRaw = input.isRaw === true;
  input.setRawMode(true);
  write(question);
  return new Promise<string | undefined>((resolve) => {
    let line = '';
    // Escape sequences (arrow keys, bracketed paste markers, mouse reports)
    // are consumed whole: after ESC, a CSI runs to its final byte (@ to ~)
    // and an SS3 to its one following byte. Dropping only the ESC byte would
    // append the printable tail ("[A", "[200~") to the token.
    let escape: 'none' | 'esc' | 'csi' | 'ss3' = 'none';
    const finish = (answer: string | undefined) => {
      input.off('data', onData);
      input.setRawMode?.(wasRaw);
      input.pause();
      write('\n');
      resolve(answer);
    };
    const onData = (chunk: Buffer | string) => {
      for (const char of chunk.toString('utf8')) {
        if (escape === 'esc') {
          escape = char === '[' ? 'csi' : char === 'O' ? 'ss3' : 'none';
          continue;
        }
        if (escape === 'csi') {
          if (char >= '@' && char <= '~') escape = 'none';
          continue;
        }
        if (escape === 'ss3') {
          escape = 'none';
          continue;
        }
        switch (char) {
          case '\u001b':
            escape = 'esc';
            break;
          case '\r':
          case '\n':
          case '\u0004':
            finish(line);
            return;
          case '\u0003':
            finish(undefined);
            return;
          case '\u007f':
          case '\b':
            line = [...line].slice(0, -1).join('');
            break;
          default:
            // Other control bytes are not part of a token.
            if (char >= ' ') line += char;
        }
      }
    };
    input.on('data', onData);
    input.resume();
  });
}

async function promptTokenFromTty(): Promise<string | undefined> {
  const answer = await readHiddenLine(
    'Enrollment token (from the join dialog, not shown): ',
    process.stdin,
    (text) => process.stderr.write(text),
  );
  return answer?.trim();
}

/** Returns the process exit code. */
export async function runAgentsJoin(
  argv: JoinArgs,
  deps: JoinDeps,
): Promise<number> {
  let target: { serverUrl: string; workspaceId: string };
  try {
    target = parseJoinLink(argv.link);
  } catch {
    deps.err(
      'qwen agents join expects the link shown by the coordinator, like https://host:4170/join/<workspace>.',
    );
    return 1;
  }
  const enrollmentToken =
    deps.env[ENROLLMENT_TOKEN_ENV]?.trim() || (await deps.promptToken());
  if (!enrollmentToken) {
    deps.err(
      `Set ${ENROLLMENT_TOKEN_ENV} to the enrollment token shown with the link.`,
    );
    return 1;
  }
  const baseUrl = (
    argv['daemon-url'] ||
    deps.env[QWEN_DAEMON_URL_ENV] ||
    DEFAULT_DAEMON_URL
  ).replace(/\/+$/, '');
  const daemonToken =
    argv.token ??
    deps.env[QWEN_SERVER_TOKEN_ENV] ??
    deps.env[QWEN_DAEMON_TOKEN_ENV];
  const workspace = argv.workspace || deps.cwd;
  const url = `${baseUrl}/workspaces/${encodeURIComponent(workspace)}/agent/hosts/connect`;
  let response: Response;
  try {
    response = await deps.fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(daemonToken ? { authorization: `Bearer ${daemonToken}` } : {}),
      },
      body: JSON.stringify({
        serverUrl: target.serverUrl,
        workspaceId: target.workspaceId,
        enrollmentToken,
        allowHttp: argv['allow-http'] === true,
      }),
      redirect: 'error',
      // Enrollment plus the first heartbeat, each bounded at 10 s.
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    deps.err(`No running qwen serve daemon answered at ${baseUrl}.`);
    deps.err(
      `Start one that joins directly instead:\n  ${ENROLLMENT_TOKEN_ENV}=<token> qwen serve --join ${argv.link}${argv['allow-http'] ? ' --agent-host-allow-http' : ''}`,
    );
    return 1;
  }
  const result = (await response.json().catch(() => ({}))) as {
    error?: string;
    connected?: boolean;
    providers?: string[];
  };
  if (!response.ok || !result.connected) {
    if (response.status === 401 || response.status === 403) {
      deps.err(
        `The daemon at ${baseUrl} refused the request; pass --token or set ${QWEN_SERVER_TOKEN_ENV}.`,
      );
    } else if (response.status === 404 && !result.error) {
      deps.err(
        `The daemon at ${baseUrl} does not serve ${workspace} or is too old to join without a restart.`,
      );
    } else {
      deps.err(
        `Join failed (${response.status}): ${result.error ?? 'no detail'}`,
      );
    }
    return 1;
  }
  deps.out(
    `Joined ${target.serverUrl} as a runtime for workspace ${target.workspaceId}${
      result.providers?.length
        ? ` (programs: ${result.providers.join(', ')})`
        : ''
    }. The daemon reconnects after restarts.`,
  );
  return 0;
}

export const joinCommand: CommandModule<unknown, JoinArgs> = {
  command: 'join <link>',
  describe:
    'Join a coordinator as an Agent Host from the running local qwen serve (no restart)',
  builder: (yargs) =>
    yargs
      .positional('link', {
        type: 'string',
        demandOption: true,
        description: 'The join link shown by the coordinator',
      })
      .option('daemon-url', {
        type: 'string',
        description: `Local daemon base URL (default: $${QWEN_DAEMON_URL_ENV} or ${DEFAULT_DAEMON_URL})`,
      })
      .option('token', {
        type: 'string',
        description: `Local daemon bearer token (default: $${QWEN_SERVER_TOKEN_ENV} or $${QWEN_DAEMON_TOKEN_ENV})`,
      })
      .option('workspace', {
        type: 'string',
        description:
          'Workspace on the local daemon that joins (default: current directory)',
      })
      .option('allow-http', {
        type: 'boolean',
        description:
          'Allow a plain-HTTP coordinator outside loopback (trusted networks only)',
      }),
  handler: async (argv) => {
    const code = await runAgentsJoin(argv, {
      fetch,
      env: process.env,
      cwd: process.cwd(),
      promptToken: promptTokenFromTty,
      out: writeStdoutLine,
      err: writeStderrLine,
    });
    process.exitCode = code;
  },
};
