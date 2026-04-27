#!/usr/bin/env npx tsx
/**
 * Deterministic TUI validation for long assistant streaming output.
 *
 * This script records screenshots/GIF and checks the raw ANSI stream from the
 * same run. It intentionally disables synchronized-output wrapping so the pass
 * signal measures whether Ink had to clear and replay the screen, not whether a
 * terminal emulator hid the clear sequence.
 *
 * Usage:
 *   npm run build && npm run bundle
 *   cd integration-tests/terminal-capture
 *   npm run capture:streaming-clear-storm
 *
 * Useful env:
 *   QWEN_TUI_E2E_REPO=/path/to/qwen-code
 *   QWEN_TUI_E2E_OUT=/tmp/qwen-tui-streaming-clear-storm
 *   QWEN_TUI_E2E_MIN_CLEAR_PAIRS=1
 *   QWEN_TUI_E2E_MAX_CLEAR_PAIRS=Infinity
 */

import { execFileSync } from 'node:child_process';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import {
  existsSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TerminalCapture } from './terminal-capture.js';

const STREAM_DONE = 'E2E_STREAM_DONE';
const STREAM_CHUNK_COUNT = 220;
const STREAM_INTERVAL_MS = 70;
const FRAME_COUNT = 52;
const FRAME_INTERVAL_MS = 350;
const TERMINAL_COLS = 88;
const TERMINAL_ROWS = 26;
const ESC = '\u001B';
const ESC_PATTERN = '\\u001B';

type FakeServer = {
  baseUrl: string;
  getRequestCount: () => number;
  close: () => Promise<void>;
};

type Counts = {
  clearTerminalPairCount: number;
  clearScreenCodeCount: number;
  eraseLineCount: number;
  cursorUpCount: number;
};

type Summary = Counts & {
  repoRoot: string;
  outputDir: string;
  gifPath: string | null;
  framesCaptured: number;
  rawBytes: number;
  streamDeltaBytes: number;
  finalScreenLines: number;
  finalDoneCount: number;
  requestCount: number;
  limits: {
    minClearTerminalPairs: number;
    maxClearTerminalPairs: number | 'Infinity';
    minFrames: number;
  };
  pass: boolean;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function envNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === '') {
    return fallback;
  }
  return Number(value);
}

function serializeNumberLimit(value: number): number | 'Infinity' {
  return Number.isFinite(value) ? value : 'Infinity';
}

function qwenArgs(baseUrl: string): string[] {
  return [
    'dist/cli.js',
    '--bare',
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

function streamOpenAIResponse(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });

  const send = (payload: unknown) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  const base = {
    id: 'chatcmpl-qwen-tui-clear-storm',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'dummy',
  };

  send({
    ...base,
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  });

  const chunks = Array.from({ length: STREAM_CHUNK_COUNT }, (_, index) => {
    const marker = String(index).padStart(3, '0');
    return `clear-storm-${marker} `.repeat(3);
  });
  chunks.push(STREAM_DONE);

  let index = 0;
  const timer = setInterval(() => {
    if (index < chunks.length) {
      send({
        ...base,
        choices: [
          {
            index: 0,
            delta: { content: chunks[index] },
            finish_reason: null,
          },
        ],
      });
      index += 1;
      return;
    }

    clearInterval(timer);
    send({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 221, total_tokens: 231 },
    });
    res.write('data: [DONE]\n\n');
    res.end();
  }, STREAM_INTERVAL_MS);
}

async function startFakeOpenAIServer(): Promise<FakeServer> {
  let requestCount = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requestCount += 1;
    if (req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }

    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      if (body.includes('"stream":true')) {
        streamOpenAIResponse(res);
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-qwen-tui-clear-storm',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'dummy',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: STREAM_DONE },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
        }),
      );
    });
  });

  await new Promise<void>((resolveListen) => {
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('failed to start fake OpenAI server');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    getRequestCount: () => requestCount,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      }),
  };
}

function generateGifWithFfmpeg(
  frames: string[],
  outputDir: string,
): string | null {
  const gifPath = join(outputDir, 'streaming-clear-storm.gif');
  const listFile = join(outputDir, 'frames.txt');
  const lines = frames.flatMap((frame) => [
    `file '${resolve(frame).replace(/'/g, "'\\''")}'`,
    `duration ${frame.includes('-stream-') ? '0.35' : '1.0'}`,
  ]);
  lines.push(
    `file '${resolve(frames[frames.length - 1]).replace(/'/g, "'\\''")}'`,
  );
  writeFileSync(listFile, lines.join('\n'));

  try {
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listFile,
        '-vf',
        'split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse',
        '-loop',
        '0',
        gifPath,
      ],
      { stdio: 'pipe' },
    );
    return gifPath;
  } catch {
    return null;
  } finally {
    try {
      unlinkSync(listFile);
    } catch {
      // Ignore cleanup failures.
    }
  }
}

function generateGifWithPython(
  frames: string[],
  outputDir: string,
): string | null {
  const gifPath = join(outputDir, 'streaming-clear-storm.gif');
  const python = process.env['QWEN_TUI_E2E_PYTHON'] ?? 'python3';
  const script = String.raw`
import os
import sys
from PIL import Image

out = sys.argv[1]
frames = sys.argv[2:]
images = []
durations = []
for frame in frames:
    image = Image.open(frame)
    images.append(
        image.convert("P", palette=Image.Palette.ADAPTIVE, colors=128)
    )
    durations.append(350 if "-stream-" in os.path.basename(frame) else 1000)

images[0].save(
    out,
    save_all=True,
    append_images=images[1:],
    duration=durations,
    loop=0,
    optimize=False,
)
`;

  try {
    execFileSync(python, ['-c', script, gifPath, ...frames], {
      stdio: 'pipe',
    });
    return gifPath;
  } catch {
    return null;
  }
}

function generateGif(frames: string[], outputDir: string): string | null {
  if (frames.length === 0) {
    return null;
  }

  return (
    generateGifWithFfmpeg(frames, outputDir) ??
    generateGifWithPython(frames, outputDir)
  );
}

async function main(): Promise<void> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const defaultRepoRoot = resolve(scriptDir, '../..');
  const repoRoot = resolve(process.env['QWEN_TUI_E2E_REPO'] ?? defaultRepoRoot);
  const defaultOut = join(
    tmpdir(),
    'qwen-tui-streaming-clear-storm',
    basename(repoRoot),
  );
  const outputDir = resolve(process.env['QWEN_TUI_E2E_OUT'] ?? defaultOut);
  const minClearTerminalPairs = envNumber('QWEN_TUI_E2E_MIN_CLEAR_PAIRS', 0);
  const maxClearTerminalPairs = envNumber('QWEN_TUI_E2E_MAX_CLEAR_PAIRS', 0);
  const minFrames = envNumber('QWEN_TUI_E2E_MIN_FRAMES', 40);

  if (existsSync(outputDir)) {
    rmSync(outputDir, { recursive: true });
  }
  mkdirSync(outputDir, { recursive: true });

  const fakeServer = await startFakeOpenAIServer();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FORCE_COLOR: '1',
    NODE_NO_WARNINGS: '1',
    QWEN_CODE_DISABLE_SYNCHRONIZED_OUTPUT: '1',
    QWEN_CODE_NO_RELAUNCH: '1',
    QWEN_CODE_SIMPLE: '1',
    QWEN_SANDBOX: 'false',
    TERM: 'xterm-256color',
  };
  delete env['NO_COLOR'];

  const terminal = await TerminalCapture.create({
    cols: TERMINAL_COLS,
    rows: TERMINAL_ROWS,
    cwd: repoRoot,
    outputDir,
    title: 'streaming clear storm',
    theme: 'github-dark',
    chrome: true,
    fontSize: 14,
    env,
  });
  const frames: string[] = [];

  try {
    await terminal.spawn('node', qwenArgs(fakeServer.baseUrl));
    await terminal.waitFor('Type your message', { timeout: 30000 });
    frames.push(await terminal.capture('00-ready.png'));
    await terminal.type('Run the deterministic streaming clear-storm test.');
    frames.push(await terminal.capture('01-prompt-entered.png'));

    const rawBefore = terminal.getRawOutput().length;
    await terminal.type('\n');

    for (let index = 0; index < FRAME_COUNT; index += 1) {
      await sleep(FRAME_INTERVAL_MS);
      const filename = `02-stream-${String(index + 1).padStart(2, '0')}.png`;
      frames.push(await terminal.capture(filename));
    }

    await terminal.idle(3000, 90000);
    frames.push(await terminal.capture('03-final.png'));

    const finalScreen = await terminal.getScreenText();
    const raw = terminal.getRawOutput();
    const streamDelta = raw.slice(rawBefore);
    const counts = captureCounts(streamDelta);
    const gifPath = generateGif(frames, outputDir);
    const pass =
      counts.clearTerminalPairCount >= minClearTerminalPairs &&
      counts.clearTerminalPairCount <= maxClearTerminalPairs &&
      frames.length >= minFrames &&
      countOccurrences(finalScreen, STREAM_DONE) === 1;

    const summary: Summary = {
      repoRoot,
      outputDir,
      gifPath,
      framesCaptured: frames.length,
      rawBytes: raw.length,
      streamDeltaBytes: streamDelta.length,
      ...counts,
      finalScreenLines: finalScreen.split('\n').length,
      finalDoneCount: countOccurrences(finalScreen, STREAM_DONE),
      requestCount: fakeServer.getRequestCount(),
      limits: {
        minClearTerminalPairs,
        maxClearTerminalPairs: serializeNumberLimit(maxClearTerminalPairs),
        minFrames,
      },
      pass,
    };

    writeFileSync(
      join(outputDir, 'summary.json'),
      JSON.stringify(summary, null, 2),
    );
    writeFileSync(join(outputDir, 'final.screen.txt'), finalScreen);
    writeFileSync(join(outputDir, 'stream.raw.ansi.log'), streamDelta);

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
