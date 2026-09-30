#!/usr/bin/env npx tsx
/**
 * E2E visual + behavioral regression for VP-mode native mouse parity.
 *
 * Spawns the bundled CLI against a fake OpenAI server that replies with a
 * markdown link, then injects raw SGR mouse bytes while the app is in
 * Virtualized History with mouse tracking on:
 *   - a plain left-click on the link label opens the URL (recorded via a
 *     BROWSER wrapper script);
 *   - a right-click on the link label raises the in-app context menu;
 *   - Escape dismisses the menu.
 *
 * Run after build:
 *   npx tsx integration-tests/terminal-capture/vp-link-click.ts
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TerminalCapture } from './terminal-capture.js';
import { startFakeOpenAIServer } from '../fake-openai-server.js';

const TERMINAL_COLS = 120;
const TERMINAL_ROWS = 40;
const LINK_LABEL = 'Example Domain';
const LINK_URL = 'https://example.com/';
const RESPONSE = `See [${LINK_LABEL}](${LINK_URL}) for details.`;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptDir, '../..');
const repoRoot = resolve(process.env['QWEN_TUI_E2E_REPO'] ?? defaultRepoRoot);
const outputDir = resolve(
  process.env['QWEN_TUI_E2E_OUT'] ??
    join(tmpdir(), 'qwen-vp-link-click', basename(repoRoot)),
);
const expectedPass = process.env['QWEN_TUI_E2E_EXPECT_PASS'] !== 'false';

function qwenArgs(baseUrl: string): string[] {
  return [
    'dist/cli.js',
    '--no-chat-recording',
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function findLabelPosition(
  screenText: string,
): { col: number; row: number } | null {
  const lines = screenText.split('\n');
  for (let rowIndex = lines.length - 1; rowIndex >= 0; rowIndex--) {
    const line = lines[rowIndex] ?? '';
    const index = line.indexOf(LINK_LABEL);
    if (index !== -1) {
      const mid = Math.floor(LINK_LABEL.length / 2);
      return { col: index + mid + 1, row: rowIndex + 1 };
    }
  }
  return null;
}

function sgrMouse(
  button: number,
  col: number,
  row: number,
  release: boolean,
): string {
  const trailing = release ? 'm' : 'M';
  return `\x1b[<${button};${col};${row}${trailing}`;
}

async function main(): Promise<void> {
  if (existsSync(outputDir)) {
    rmSync(outputDir, { recursive: true });
  }
  mkdirSync(outputDir, { recursive: true });

  const fakeServer = await startFakeOpenAIServer(() => ({
    content: RESPONSE,
    usage: {
      prompt_tokens: 24,
      completion_tokens: 16,
      total_tokens: 40,
    },
  }));

  const homeDir = join(outputDir, 'home');
  mkdirSync(homeDir, { recursive: true });

  // Browser wrapper that records the URL passed by openBrowserSecurely().
  const linkRecordFile = join(outputDir, 'opened-link.txt');
  const browserWrapper = join(outputDir, 'record-browser.cjs');
  writeFileSync(
    browserWrapper,
    `const fs = require('fs');\n` +
      `const url = process.argv[process.argv.length - 1];\n` +
      `fs.writeFileSync(process.env.LINK_RECORD_FILE, url);\n`,
  );

  const baseEnv = { ...process.env };
  delete baseEnv['NO_COLOR'];
  for (const key of [
    'HTTP_PROXY',
    'http_proxy',
    'HTTPS_PROXY',
    'https_proxy',
    'ALL_PROXY',
    'all_proxy',
    'CI',
    'CONTINUOUS_INTEGRATION',
  ]) {
    delete baseEnv[key];
  }

  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    BROWSER: `node ${browserWrapper}`,
    LINK_RECORD_FILE: linkRecordFile,
    FORCE_COLOR: '1',
    FORCE_HYPERLINK: '1',
    HOME: homeDir,
    NODE_NO_WARNINGS: '1',
    QWEN_CODE_DISABLE_SYNCHRONIZED_OUTPUT: '1',
    QWEN_CODE_NO_RELAUNCH: '1',
    QWEN_SANDBOX: 'false',
    TERM: 'xterm-256color',
    USERPROFILE: homeDir,
  };

  const terminal = await TerminalCapture.create({
    chrome: true,
    cols: TERMINAL_COLS,
    cwd: repoRoot,
    env,
    fontSize: 14,
    outputDir,
    rows: TERMINAL_ROWS,
    theme: 'dracula',
    title: 'qwen-code — VP link click',
  });

  const screenshots: string[] = [];
  let linkOpened = false;
  try {
    await terminal.spawn('node', qwenArgs(fakeServer.baseUrl));
    await terminal.waitFor('Type your message', { timeout: 30000 });

    await terminal.type('Reply with the example link.\n');
    await terminal.waitFor(LINK_LABEL, { timeout: 30000 });
    await terminal.idle(500, 10000);

    const screenText = await terminal.getScreenText();
    const pos = findLabelPosition(screenText);
    if (!pos) {
      throw new Error(
        `Could not locate "${LINK_LABEL}" on screen.\nLast screen:\n${screenText}`,
      );
    }
    console.log(`🔗 link label at col=${pos.col}, row=${pos.row}`);

    screenshots.push(await terminal.capture('01-link-visible.png'));

    // Plain left-click on the link should open it after the multi-click window.
    await terminal.type(sgrMouse(0, pos.col, pos.row, false));
    await terminal.type(sgrMouse(0, pos.col, pos.row, true));
    await sleep(900);

    if (existsSync(linkRecordFile)) {
      const recorded = readFileSync(linkRecordFile, 'utf8');
      linkOpened = recorded === LINK_URL;
      console.log(`📂 BROWSER wrapper recorded: ${recorded}`);
    }
    screenshots.push(await terminal.capture('02-after-left-click.png'));

    // Right-click on the link label should raise the in-app context menu.
    await terminal.type(sgrMouse(2, pos.col, pos.row, false));
    await terminal.type(sgrMouse(2, pos.col, pos.row, true));
    await sleep(300);
    screenshots.push(await terminal.capture('03-context-menu-open.png'));

    // Escape dismisses the menu.
    await terminal.type('\x1b');
    await sleep(300);
    screenshots.push(await terminal.capture('04-context-menu-closed.png'));

    screenshots.push(await terminal.captureFull('05-full-flow.png'));

    const pass = fakeServer.requests.length > 0 && linkOpened;
    const summary = {
      repoRoot,
      outputDir,
      requestCount: fakeServer.requests.length,
      linkOpened,
      screenshots,
      pass,
      expectedPass,
    };
    writeFileSync(
      join(outputDir, 'summary.json'),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
    console.log(JSON.stringify(summary, null, 2));

    if (pass !== expectedPass) {
      throw new Error(
        `Expected pass=${expectedPass} but observed pass=${pass}. ` +
          `See ${join(outputDir, 'summary.json')}`,
      );
    }
  } finally {
    await terminal.close();
    await fakeServer.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
