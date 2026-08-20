#!/usr/bin/env npx tsx
/**
 * PR #6580 evidence capture — subagent observability (issue #6569).
 *
 * Drives two deterministic scenarios against a fake OpenAI server and
 * captures PNG screenshots for the PR's Before/After section:
 *
 *   detail  (yolo): the subagent performs 11 read_file calls, then runs a
 *           long shell command that sleeps. While it sleeps we open the
 *           background-tasks dialog detail view and capture:
 *             - Progress rows (5 truncated on main vs 10 + wrapped live
 *               row on the branch)
 *             - Transcript section (branch only)
 *   approval (default approval mode): the subagent performs 2 read_file
 *           calls, then a shell command that parks an approval. We capture
 *           the inline "Approval requested by" banner (bare on main vs
 *           with prior-call context lines on the branch).
 *
 * Usage:
 *   npm run build && npm run bundle
 *   cd integration-tests/terminal-capture
 *   npx tsx observability-6569-capture.ts <detail|approval> <outputDir> <label>
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TerminalCapture } from './terminal-capture.js';
import {
  fakeToolCall,
  startFakeOpenAIServer,
  type FakeOpenAIResponse,
} from '../fake-openai-server.js';

const COLS = 100;
const ROWS = 34;
const SUBAGENT_MARKER = 'OBSERVABILITY_6569_PROBE';
const SUBAGENT_DONE = 'OBSERVABILITY_6569_SUBAGENT_DONE';
const MAIN_DONE = 'OBSERVABILITY_6569_MAIN_DONE';
const DOWN_ARROW = '[B';

// Long enough to exceed the detail view's content width (~96 cols) so the
// live-row wrap vs truncate difference is visible, and slow enough (sleep)
// to give the capture flow a stable window.
const LONG_COMMAND =
  'git log --format="%h %an %ad %s" --date=iso --since="6 months ago" -- ' +
  'packages/core/src/agents packages/cli/src/ui/components/background-view ' +
  '> /dev/null && sleep 45 && echo LONG_COMMAND_FINISHED';

function subagentRead(
  packageJsonPath: string,
  index: number,
): FakeOpenAIResponse {
  return {
    toolCalls: [
      fakeToolCall(
        'read_file',
        { file_path: packageJsonPath, offset: index * 3, limit: 5 },
        `call_sub_read_${index}`,
      ),
    ],
    usage: { prompt_tokens: 50, completion_tokens: 12, total_tokens: 62 },
  };
}

function subagentShell(): FakeOpenAIResponse {
  return {
    toolCalls: [
      fakeToolCall(
        'run_shell_command',
        { command: LONG_COMMAND, description: 'Scan recent agent history' },
        'call_sub_shell',
      ),
    ],
    usage: { prompt_tokens: 60, completion_tokens: 20, total_tokens: 80 },
  };
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  return content === undefined ? '' : JSON.stringify(content);
}

function roleContent(body: Record<string, unknown>): string {
  const messages = body['messages'];
  if (!Array.isArray(messages)) return '';
  return messages
    .filter(
      (m): m is Record<string, unknown> => typeof m === 'object' && m !== null,
    )
    .filter((m) => m['role'] === 'system' || m['role'] === 'user')
    .map((m) => messageText(m['content']))
    .join('\n');
}

async function main(): Promise<void> {
  const scenario = process.argv[2];
  const outputDir = resolve(process.argv[3] ?? '/tmp/obs-6569');
  const label = process.argv[4] ?? 'run';
  if (scenario !== 'detail' && scenario !== 'approval') {
    throw new Error(
      'usage: observability-6569-capture.ts <detail|approval> <outputDir> <label>',
    );
  }

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, '../..');
  const packageJsonPath = join(repoRoot, 'package.json');
  const readCalls = scenario === 'detail' ? 11 : 2;

  let mainTurns = 0;
  let subTurns = 0;
  const fakeServer = await startFakeOpenAIServer(({ body }) => {
    const rc = roleContent(body);
    const isSubagent =
      rc.includes('general-purpose agent') && rc.includes(SUBAGENT_MARKER);
    if (isSubagent) {
      subTurns += 1;
      if (subTurns <= readCalls) return subagentRead(packageJsonPath, subTurns);
      if (subTurns === readCalls + 1) return subagentShell();
      return {
        content: SUBAGENT_DONE,
        usage: { prompt_tokens: 80, completion_tokens: 8, total_tokens: 88 },
      };
    }
    mainTurns += 1;
    if (mainTurns === 1) {
      return {
        toolCalls: [
          fakeToolCall(
            'agent',
            {
              description: 'Audit agent runtime sources',
              prompt: `${SUBAGENT_MARKER}: read ${packageJsonPath} several times, then run the scan command, then reply "${SUBAGENT_DONE}"`,
              subagent_type: 'general-purpose',
            },
            'call_dispatch_main',
          ),
        ],
        usage: { prompt_tokens: 32, completion_tokens: 16, total_tokens: 48 },
      };
    }
    return {
      content: MAIN_DONE,
      usage: { prompt_tokens: 100, completion_tokens: 4, total_tokens: 104 },
    };
  });

  const homeDir = join(outputDir, 'home');
  mkdirSync(homeDir, { recursive: true });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FORCE_COLOR: '1',
    NODE_NO_WARNINGS: '1',
    QWEN_CODE_DISABLE_SYNCHRONIZED_OUTPUT: '1',
    QWEN_CODE_NO_RELAUNCH: '1',
    QWEN_SANDBOX: 'false',
    TERM: 'xterm-256color',
    HOME: homeDir,
    USERPROFILE: homeDir,
  };
  delete env['NO_COLOR'];
  delete env['QWEN_CODE_SIMPLE'];
  for (const key of [
    'HTTP_PROXY',
    'http_proxy',
    'HTTPS_PROXY',
    'https_proxy',
    'ALL_PROXY',
    'all_proxy',
  ]) {
    delete env[key];
  }

  const terminal = await TerminalCapture.create({
    cols: COLS,
    rows: ROWS,
    cwd: repoRoot,
    outputDir,
    title: `qwen-code — subagent observability (${label})`,
    theme: 'github-dark',
    chrome: true,
    fontSize: 14,
    env,
  });

  const approvalMode = scenario === 'detail' ? 'yolo' : 'default';
  try {
    await terminal.spawn('node', [
      'dist/cli.js',
      '--approval-mode',
      approvalMode,
      '--auth-type',
      'openai',
      '--openai-api-key',
      'dummy',
      '--openai-base-url',
      fakeServer.baseUrl,
      '--model',
      'dummy',
    ]);
    // The composer placeholder doesn't reach the raw PTY stream as one
    // contiguous string at wider terminal sizes, so key readiness off the
    // footer (model name) plus an idle window instead.
    await terminal.waitFor('dummy', { timeout: 30000 });
    await terminal.idle(1200, 15000);

    await terminal.type(
      'Use the general-purpose subagent to audit the agent runtime sources',
      { slow: true, delay: 8 },
    );
    await terminal.idle(400, 4000);
    await terminal.type('\n');

    if (scenario === 'detail') {
      // The long shell command's activity label reaches the LiveAgentPanel
      // once the subagent starts executing it; from then we have ~45s.
      try {
        // The panel truncates the activity row, so wait on the command's
        // head (always visible) rather than its tail.
        await terminal.waitFor('git log --format', { timeout: 60000 });
      } catch (err) {
        await terminal.capture(`${label}-timeout-debug.png`);
        console.error(
          `[debug] server requests=${fakeServer.requests.length} mainTurns=${mainTurns} subTurns=${subTurns}`,
        );
        console.error('[debug] screen:\n' + (await terminal.getScreenText()));
        throw err;
      }
      await terminal.idle(800, 5000);
      await terminal.capture(`${label}-panel.png`);
      writeFileSync(
        join(outputDir, `${label}-panel.txt`),
        await terminal.getScreenText(),
      );
      // Down focuses the live panel (row 0 = main), a second Down selects
      // the agent row, Enter opens its detail view.
      await terminal.type(DOWN_ARROW, { delay: 600 });
      await terminal.type(DOWN_ARROW, { delay: 600 });
      await terminal.type('\r', { delay: 1000 });
      await terminal.idle(800, 5000);
      await terminal.capture(`${label}-detail.png`);
      writeFileSync(
        join(outputDir, `${label}-detail.txt`),
        await terminal.getScreenText(),
      );
    } else {
      // Default mode gates the Agent tool launch itself first — approve it
      // so the subagent starts; its read_file calls are auto-allowed and
      // the shell call then parks the subagent-side approval we're after.
      await terminal.waitFor('Do you want to proceed', { timeout: 30000 });
      await terminal.idle(600, 5000);
      await terminal.type('\r', { delay: 500 });
      try {
        await terminal.waitFor('Approval requested', { timeout: 60000 });
      } catch (err) {
        await terminal.capture(`${label}-approval-timeout.png`);
        console.error(
          `[debug] requests=${fakeServer.requests.length} mainTurns=${mainTurns} subTurns=${subTurns}`,
        );
        console.error('[debug] screen:\n' + (await terminal.getScreenText()));
        throw err;
      }
      await terminal.idle(800, 5000);
      await terminal.capture(`${label}-approval.png`);
      writeFileSync(
        join(outputDir, `${label}-approval.txt`),
        await terminal.getScreenText(),
      );
    }
    console.log(`[capture] ${scenario}/${label} done`);
  } finally {
    await terminal.close().catch(() => {});
    await fakeServer.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
