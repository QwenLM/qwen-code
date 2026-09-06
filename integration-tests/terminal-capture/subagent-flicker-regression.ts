#!/usr/bin/env npx tsx
/**
 * Deterministic TUI ratchet for SubAgent display rendering.
 *
 * Drives an end-to-end run with a mock OpenAI server that:
 *   1. answers the main loop with an `agent` tool_call dispatching the
 *      built-in `general-purpose` subagent;
 *   2. answers each subagent turn with one `read_file` tool_call against a
 *      known-existing file (`package.json`) so the SubAgent's runtime display
 *      accumulates real tool entries one round-trip at a time;
 *   3. answers the subagent's follow-up turn with a final assistant message;
 *   4. answers the main loop's follow-up turn with another final message.
 *
 * Then we read every byte the PTY produced inside the SubAgent display window
 * and count the ANSI sequences Ink emits when redrawing — clear-terminal
 * triples (`\x1b[2J\x1b[3J\x1b[H`), erase-line, cursor-up.
 *
 * Scope: this is an end-to-end *ratchet*, not a full flicker stress test. It
 * exercises the streaming SubAgent path with a fixed-size terminal, so it
 * does NOT directly cover resize-time flicker (the parent repo's
 * TerminalCapture in this branch lacks a public `resize()` method). The
 * targeted coverage map is:
 *
 *   - Resize-time clear:       AppContainer.test.tsx
 *     ("does not clear the terminal just because width changed")
 *   - Visual-height budgeting: AgentExecutionDisplay.test.tsx
 *     ("keeps the rendered running/completed frame within availableHeight")
 *   - End-to-end byte trail:   *this script* — catches regressions that
 *                              slip past the unit-level assertions.
 *
 * Reference numbers (M2 Pro Mac, 60-col / 18-row terminal, 5 tool calls,
 * compact → default → verbose mode transitions):
 *
 *   With visual-height fix (current):
 *     clearTerminalPair=5, clearScreen=10, eraseLine=434, cursorUp=130
 *   Without the fix (sliceTextByVisualHeight + overhead-aware budget removed):
 *     clearTerminalPair=2, clearScreen=4,  eraseLine=469, cursorUp=134
 *
 * The clear-pair / clear-screen counts go *up* with the fix in this scenario
 * — the new "Showing N visual lines" footer + bounded slicing trigger extra
 * commits to Ink's static area, which are committed pieces of the static
 * area, not flicker churn. The signal that *does* separate fix from no-fix
 * is `eraseLine` — the in-place-update count drops by ~7% because Ink no
 * longer needs to repaint individual rows when the SubAgent display stays
 * inside its assigned slot. That's why this script asserts an upper bound
 * on `eraseLine` in addition to the clear-screen ratchets.
 *
 * Default thresholds are calibrated so the build fails if the visual-height
 * fix is reverted to the old hard-coded behavior:
 *   - eraseLine > 460        → fix is broken (no-fix observed at 469).
 *   - clearTerminalPair > 10 → unrelated regression (e.g. width-driven
 *                              refreshStatic comes back).
 *   - clearScreen > 20       → unrelated regression.
 *
 * Usage:
 *   npm run build && npm run bundle
 *   cd integration-tests/terminal-capture
 *   npx tsx subagent-flicker-regression.ts
 *
 * Useful env:
 *   QWEN_TUI_E2E_REPO=/path/to/qwen-code
 *   QWEN_TUI_E2E_OUT=/tmp/qwen-tui-subagent-flicker
 *   QWEN_TUI_E2E_MAX_CLEAR_PAIRS=10       (default: 10)
 *   QWEN_TUI_E2E_MAX_CLEAR_SCREEN=20      (default: 20)
 *   QWEN_TUI_E2E_MAX_ERASE_LINE=460       (default: 460 — separates fix from
 *                                          no-fix; reverting the fix raises
 *                                          this counter to ~469)
 *   QWEN_TUI_E2E_SUBAGENT_TOOL_CALLS=5
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TerminalCapture } from './terminal-capture.js';
import {
  fakeToolCall,
  startFakeOpenAIServer,
  type FakeOpenAIResponse,
} from '../fake-openai-server.js';

const TERMINAL_COLS = 60;
const TERMINAL_ROWS = 18;
const PROMPT_TEXT = 'Use the general-purpose subagent to inspect package.json';
const SUBAGENT_DESCRIPTION = 'flicker probe';
const SUBAGENT_PROMPT_MARKER = 'SUBAGENT_FLICKER_PROBE';
const SUBAGENT_DONE_MARKER = 'SUBAGENT_FLICKER_DONE';
const MAIN_DONE_MARKER = 'MAIN_FLICKER_DONE';
const ESC = '\u001B';
const ESC_PATTERN = '\\u001B';

type Counts = {
  clearTerminalPairCount: number;
  clearScreenCodeCount: number;
  eraseLineCount: number;
  cursorUpCount: number;
};

type Summary = Counts & {
  repoRoot: string;
  outputDir: string;
  rawBytes: number;
  subagentDeltaBytes: number;
  finalScreenLines: number;
  subagentToolCalls: number;
  requestCount: number;
  limits: {
    maxClearTerminalPairs: number;
    maxClearScreen: number;
    maxEraseLine: number;
  };
  pass: boolean;
};

function envNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let index = 0;
  while ((index = text.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}

function countPattern(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

function captureCounts(raw: string): Counts {
  return {
    clearTerminalPairCount: countOccurrences(raw, `${ESC}[2J${ESC}[3J${ESC}[H`),
    clearScreenCodeCount:
      countOccurrences(raw, `${ESC}[2J`) +
      countOccurrences(raw, `${ESC}[3J`) +
      countOccurrences(raw, `${ESC}c`),
    eraseLineCount: countPattern(
      raw,
      new RegExp(`${ESC_PATTERN}\\[[0-2]?K`, 'g'),
    ),
    cursorUpCount: countPattern(
      raw,
      new RegExp(`${ESC_PATTERN}\\[[0-9]+A`, 'g'),
    ),
  };
}

function buildMainAgentToolCall(packageJsonPath: string): FakeOpenAIResponse {
  return {
    toolCalls: [
      fakeToolCall(
        'agent',
        {
          description: SUBAGENT_DESCRIPTION,
          prompt: `${SUBAGENT_PROMPT_MARKER}: read ${packageJsonPath} a few times to drive the SubAgent display, then reply with "${SUBAGENT_DONE_MARKER}"`,
          subagent_type: 'general-purpose',
        },
        'call_dispatch_main',
      ),
    ],
    usage: { prompt_tokens: 32, completion_tokens: 16, total_tokens: 48 },
  };
}

function buildSubagentSingleToolCall(
  packageJsonPath: string,
  index: number,
): FakeOpenAIResponse {
  return {
    toolCalls: [
      fakeToolCall(
        'read_file',
        {
          absolute_path: packageJsonPath,
          offset: index * 2,
          limit: 6,
        },
        `call_subagent_read_${index}`,
      ),
    ],
    usage: { prompt_tokens: 50, completion_tokens: 12, total_tokens: 62 },
  };
}

function buildSubagentFinal(): FakeOpenAIResponse {
  return {
    content: SUBAGENT_DONE_MARKER,
    usage: { prompt_tokens: 80, completion_tokens: 8, total_tokens: 88 },
  };
}

function buildMainFinal(): FakeOpenAIResponse {
  return {
    content: MAIN_DONE_MARKER,
    usage: { prompt_tokens: 100, completion_tokens: 4, total_tokens: 104 },
  };
}

function messageText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  return content === undefined ? '' : JSON.stringify(content);
}

function roleContentMessages(body: Record<string, unknown>): string {
  const messages = body['messages'];
  if (!Array.isArray(messages)) {
    return '';
  }

  return messages
    .filter(
      (message): message is Record<string, unknown> =>
        typeof message === 'object' && message !== null,
    )
    .filter(
      (message) => message['role'] === 'system' || message['role'] === 'user',
    )
    .map((message) => messageText(message['content']))
    .join('\n');
}

function startSubagentFakeOpenAIServer(
  packageJsonPath: string,
  subagentToolCalls: number,
): ReturnType<typeof startFakeOpenAIServer> {
  let mainTurnCount = 0;
  let subagentTurnCount = 0;

  const verbose = process.env['QWEN_TUI_E2E_VERBOSE'] === '1';
  const log = (...args: unknown[]) => {
    if (verbose) {
      console.error('[fake-openai]', ...args);
    }
  };

  return startFakeOpenAIServer(({ body, requestIndex }) => {
    const bodyText = JSON.stringify(body);
    log('request', requestIndex + 1, 'first 200:', bodyText.slice(0, 200));
    // SubAgent loop is identified by the marker we planted in the prompt.
    // Main-loop tool-call arguments and tool results can also contain the
    // marker, so only `system`/`user` content participates in this check.
    const roleContent = roleContentMessages(body);
    const isSubagentLoop =
      roleContent.includes('general-purpose agent') &&
      roleContent.includes(SUBAGENT_PROMPT_MARKER);

    const isStream = body['stream'] === true;

    if (isSubagentLoop) {
      subagentTurnCount += 1;
      log('subagent turn', subagentTurnCount, 'stream', isStream);
      // Emit one tool_call per turn so the SubAgent display has to commit
      // and re-render between roundtrips. Sending all tool_calls in a
      // single response lets the CLI batch the renders and hides the
      // streaming-flicker pattern we want to expose.
      if (subagentTurnCount <= subagentToolCalls) {
        return buildSubagentSingleToolCall(packageJsonPath, subagentTurnCount);
      }
      return buildSubagentFinal();
    }

    mainTurnCount += 1;
    log('main turn', mainTurnCount, 'stream', isStream);
    if (mainTurnCount === 1) {
      return buildMainAgentToolCall(packageJsonPath);
    }
    return buildMainFinal();
  });
}

function qwenArgs(baseUrl: string): string[] {
  // NOTE: --bare is intentionally omitted. Bare mode hard-codes the registered
  // tool set to read_file / edit / shell, which means the model's `agent`
  // tool_call is rejected as "Tool not found in registry" and the SubAgent
  // path never runs. Instead we redirect HOME to a scratch dir below so the
  // child process doesn't pick up real user settings.
  return [
    'dist/cli.js',
    '--approval-mode',
    'yolo',
    '--auth-type',
    'openai',
    '--openai-api-key',
    'dummy',
    '--openai-base-url',
    baseUrl,
    '--model',
    'dummy',
  ];
}

async function main(): Promise<void> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const defaultRepoRoot = resolve(scriptDir, '../..');
  const repoRoot = resolve(process.env['QWEN_TUI_E2E_REPO'] ?? defaultRepoRoot);
  const defaultOut = join(
    tmpdir(),
    'qwen-tui-subagent-flicker',
    basename(repoRoot),
  );
  const outputDir = resolve(process.env['QWEN_TUI_E2E_OUT'] ?? defaultOut);
  const maxClearPairs = envNumber('QWEN_TUI_E2E_MAX_CLEAR_PAIRS', 10);
  const maxClearScreen = envNumber('QWEN_TUI_E2E_MAX_CLEAR_SCREEN', 20);
  // The eraseLine ceiling is the metric that actually distinguishes the
  // visual-height fix from no-fix. With the fix in place we observe ~434;
  // reverting to the old hard-coded budget pushes it to ~469. 460 sits in
  // between so a full regression trips the ratchet.
  const maxEraseLine = envNumber('QWEN_TUI_E2E_MAX_ERASE_LINE', 460);
  const subagentToolCalls = envNumber('QWEN_TUI_E2E_SUBAGENT_TOOL_CALLS', 5);
  const packageJsonPath = join(repoRoot, 'package.json');

  if (existsSync(outputDir)) {
    rmSync(outputDir, { recursive: true });
  }
  mkdirSync(outputDir, { recursive: true });

  const fakeServer = await startSubagentFakeOpenAIServer(
    packageJsonPath,
    subagentToolCalls,
  );
  console.error('[fake-openai] baseUrl =', fakeServer.baseUrl);

  // Sandbox HOME to keep ~/.qwen settings out of the run.
  const homeDir = join(outputDir, 'home');
  mkdirSync(homeDir, { recursive: true });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FORCE_COLOR: '1',
    NODE_NO_WARNINGS: '1',
    QWEN_CODE_DISABLE_SYNCHRONIZED_OUTPUT: '1',
    QWEN_CODE_NO_RELAUNCH: '1',
    // Intentionally NOT setting QWEN_CODE_SIMPLE so the agent tool stays in
    // the registry — see comment in qwenArgs() above.
    QWEN_SANDBOX: 'false',
    TERM: 'xterm-256color',
    HOME: homeDir,
    USERPROFILE: homeDir,
  };
  delete env['NO_COLOR'];
  delete env['QWEN_CODE_SIMPLE'];
  // OpenAI SDK / undici routes through HTTP_PROXY even when NO_PROXY lists
  // 127.0.0.1, so the fake-server traffic would go to the corp proxy instead
  // of our loopback. Strip every proxy variable so the child process talks
  // straight to the fake server.
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
    cols: TERMINAL_COLS,
    rows: TERMINAL_ROWS,
    cwd: repoRoot,
    outputDir,
    title: 'subagent flicker regression',
    theme: 'github-dark',
    chrome: false,
    fontSize: 14,
    env,
  });

  try {
    await terminal.spawn('node', qwenArgs(fakeServer.baseUrl));
    await terminal.waitFor('Type your message', { timeout: 30000 });

    const rawBefore = terminal.getRawOutput().length;

    // Mirror the official scenario-runner: type the body first, let the input
    // area settle, then send Enter as its own write so the CLI sees a single
    // submit keypress instead of bulk paste.
    await terminal.type(PROMPT_TEXT, { slow: true, delay: 12 });
    await terminal.idle(400, 4000);
    await terminal.type('\n');

    // As soon as the SubAgent display materialises, expand to "default" then
    // "verbose" so the tool-call list is fully rendered. This is where the
    // height-bounded slicing matters — without the fix, soft wraps caused by
    // the narrow column count make every new tool_call shift the rendered
    // height and Ink commits a fresh full-screen draw.
    await terminal.waitFor('flicker probe', { timeout: 30000 });
    await terminal.type(''); // Ctrl+E → default
    await terminal.idle(150, 1000);
    await terminal.type(''); // Ctrl+F → verbose

    // Wait for the SubAgent run to finish — main loop's final assistant
    // message lands once the subagent reports done and the parent's tool
    // result is returned. If anything stalls, idle() will time out and we
    // still capture whatever raw bytes accumulated.
    await terminal.waitFor(MAIN_DONE_MARKER, { timeout: 60000 });
    await terminal.idle(1500, 5000);

    const raw = terminal.getRawOutput();
    const subagentDelta = raw.slice(rawBefore);
    const counts = captureCounts(subagentDelta);
    const finalScreen = await terminal.getScreenText();
    const pass =
      counts.clearTerminalPairCount <= maxClearPairs &&
      counts.clearScreenCodeCount <= maxClearScreen &&
      counts.eraseLineCount <= maxEraseLine;

    const summary: Summary = {
      repoRoot,
      outputDir,
      rawBytes: raw.length,
      subagentDeltaBytes: subagentDelta.length,
      ...counts,
      finalScreenLines: finalScreen.split('\n').length,
      subagentToolCalls,
      requestCount: fakeServer.requests.length,
      limits: {
        maxClearTerminalPairs: maxClearPairs,
        maxClearScreen,
        maxEraseLine,
      },
      pass,
    };

    writeFileSync(
      join(outputDir, 'summary.json'),
      JSON.stringify(summary, null, 2),
    );
    writeFileSync(join(outputDir, 'final.screen.txt'), finalScreen);
    writeFileSync(join(outputDir, 'subagent.raw.ansi.log'), subagentDelta);

    console.log(JSON.stringify(summary, null, 2));

    if (!pass) {
      process.exitCode = 1;
    }
  } finally {
    await terminal.close();
    await fakeServer.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
