#!/usr/bin/env npx tsx
/**
 * Deterministic TUI validation for resize-triggered clear flicker.
 *
 * This records the same terminal run that produces the raw ANSI metrics. The
 * failure signal is a full-screen clear emitted after the initial prompt is
 * already visible and the terminal width changes.
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

const FRAME_INTERVAL_MS = 120;
const FRAMES_PER_RESIZE = 24;
const LIVE_FLUSH_INTERVAL_MS = 16;
const INITIAL_COLS = 88;
const NARROW_COLS = 62;
const WIDE_COLS = 100;
const TERMINAL_ROWS = 26;
const ESC = '\u001B';
const ESC_PATTERN = '\\u001B';

type FakeServer = {
  baseUrl: string;
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
  resizeDeltaBytes: number;
  finalScreenLines: number;
  promptVisibleCount: number;
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

async function startFakeOpenAIServer(): Promise<FakeServer> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }

    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-qwen-tui-resize',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'dummy',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'resize ready' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
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
  const gifPath = join(outputDir, 'resize-clear-regression.gif');
  const listFile = join(outputDir, 'frames.txt');
  const lines = frames.flatMap((frame) => [
    `file '${resolve(frame).replace(/'/g, "'\\''")}'`,
    `duration ${frame.includes('-resize-') ? FRAME_INTERVAL_MS / 1000 : 1.0}`,
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
  const gifPath = join(outputDir, 'resize-clear-regression.gif');
  const python = process.env['QWEN_TUI_E2E_PYTHON'] ?? 'python3';
  const script = String.raw`
import os
import sys
from PIL import Image

out = sys.argv[1]
frames = sys.argv[2:]
opened = [Image.open(frame).convert("RGBA") for frame in frames]
width = max(image.width for image in opened)
height = max(image.height for image in opened)
images = []
durations = []
for frame, image in zip(frames, opened):
    canvas = Image.new("RGBA", (width, height), (13, 17, 23, 255))
    canvas.paste(image, ((width - image.width) // 2, 0))
    images.append(canvas.convert("P", palette=Image.Palette.ADAPTIVE, colors=128))
    durations.append(120 if "-resize-" in os.path.basename(frame) else 1000)

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
    'qwen-tui-resize-clear-regression',
    basename(repoRoot),
  );
  const outputDir = resolve(process.env['QWEN_TUI_E2E_OUT'] ?? defaultOut);
  const minClearTerminalPairs = envNumber('QWEN_TUI_E2E_MIN_CLEAR_PAIRS', 0);
  const maxClearTerminalPairs = envNumber('QWEN_TUI_E2E_MAX_CLEAR_PAIRS', 0);
  const minFrames = envNumber('QWEN_TUI_E2E_MIN_FRAMES', 30);

  if (existsSync(outputDir)) {
    rmSync(outputDir, { recursive: true });
  }
  mkdirSync(outputDir, { recursive: true });

  const fakeServer = await startFakeOpenAIServer();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEV: 'true',
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
    cols: INITIAL_COLS,
    rows: TERMINAL_ROWS,
    cwd: repoRoot,
    outputDir,
    title: 'resize clear regression',
    theme: 'github-dark',
    chrome: true,
    fontSize: 14,
    env,
  });
  const frames: string[] = [];

  try {
    await terminal.spawn('node', qwenArgs(fakeServer.baseUrl));
    terminal.startAutoFlush(LIVE_FLUSH_INTERVAL_MS);
    await terminal.waitFor('Type your message', { timeout: 30000 });
    frames.push(await terminal.capture('00-ready.png'));

    const rawBefore = terminal.getRawOutput().length;

    await terminal.resize(NARROW_COLS, TERMINAL_ROWS);
    for (let index = 0; index < FRAMES_PER_RESIZE; index += 1) {
      await sleep(FRAME_INTERVAL_MS);
      frames.push(
        await terminal.capture(
          `01-resize-narrow-${String(index + 1).padStart(2, '0')}.png`,
        ),
      );
    }

    await terminal.resize(WIDE_COLS, TERMINAL_ROWS);
    for (let index = 0; index < FRAMES_PER_RESIZE; index += 1) {
      await sleep(FRAME_INTERVAL_MS);
      frames.push(
        await terminal.capture(
          `02-resize-wide-${String(index + 1).padStart(2, '0')}.png`,
        ),
      );
    }

    await terminal.stopAutoFlush();
    frames.push(await terminal.capture('03-final.png'));

    const finalScreen = await terminal.getScreenText();
    const raw = terminal.getRawOutput();
    const resizeDelta = raw.slice(rawBefore);
    const counts = captureCounts(resizeDelta);
    const gifPath = generateGif(frames, outputDir);
    const promptVisibleCount = countOccurrences(
      finalScreen,
      'Type your message',
    );
    const pass =
      counts.clearTerminalPairCount >= minClearTerminalPairs &&
      counts.clearTerminalPairCount <= maxClearTerminalPairs &&
      frames.length >= minFrames &&
      promptVisibleCount >= 1;

    const summary: Summary = {
      repoRoot,
      outputDir,
      gifPath,
      framesCaptured: frames.length,
      rawBytes: raw.length,
      resizeDeltaBytes: resizeDelta.length,
      ...counts,
      finalScreenLines: finalScreen.split('\n').length,
      promptVisibleCount,
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
    writeFileSync(join(outputDir, 'resize.raw.ansi.log'), resizeDelta);

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
