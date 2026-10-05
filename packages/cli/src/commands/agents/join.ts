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

import { createInterface } from 'node:readline/promises';
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

async function promptTokenFromTty(): Promise<string | undefined> {
  if (!process.stdin.isTTY) return undefined;
  // TODO(multi-agent): the token is echoed; it is single-use and expires in
  // 15 minutes, but a hidden prompt would be better.
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(
      'Enrollment token (from the join dialog): ',
    );
    return answer.trim();
  } finally {
    rl.close();
  }
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
