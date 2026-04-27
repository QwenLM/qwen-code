#!/usr/bin/env npx tsx
/**
 * Deterministic validation for narrow shell live-output reflow.
 *
 * The shell runner renders live PTY output through a headless xterm viewport.
 * A terminal resize can change soft-wrap segmentation without adding new
 * visible output bytes. Before the fix, that resize-only reflow could be
 * emitted as a fresh live-output event, so the UI appended what looked like a
 * duplicate chunk.
 *
 * This scenario is intentionally narrower than the full TUI screenshot tests:
 * it exercises the exact ShellExecutionService live-output contract, writes
 * metrics, and renders a side-by-side evidence GIF where the base branch shows
 * the duplicate resize-only event and the fixed branch does not.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';

const INITIAL_COLS = 24;
const FIRST_RESIZE_COLS = 12;
const SECOND_RESIZE_COLS = 18;
const ROWS = 8;
const FRAME_COUNT = 8;

type AnsiToken = {
  text?: unknown;
};

type ShellDataEvent = {
  index: number;
  phase: string;
  text: string;
  lines: string[];
};

type ShellScenarioResult = {
  label: string;
  repoRoot: string;
  dataEventCount: number;
  resizeOnlyDataEventCount: number;
  events: ShellDataEvent[];
  output: string;
  exitCode: number | null;
};

type ShellExecutionResult = {
  output: string;
  exitCode: number | null;
};

type ShellExecutionHandle = {
  pid?: number;
  result: Promise<ShellExecutionResult>;
};

type ShellExecutionConfig = {
  terminalWidth: number;
  terminalHeight: number;
  showColor: boolean;
  disableDynamicLineTrimming: boolean;
};

type ShellOutputEvent =
  | {
      type: 'data';
      chunk: unknown;
    }
  | {
      type: string;
    };

type ShellExecutionServiceLike = {
  execute: (
    commandToExecute: string,
    cwd: string,
    onOutputEvent: (event: ShellOutputEvent) => void,
    abortSignal: AbortSignal,
    shouldUseNodePty: boolean,
    shellExecutionConfig: ShellExecutionConfig,
  ) => Promise<ShellExecutionHandle>;
  resizePty: (pid: number, cols: number, rows: number) => void;
};

type ShellExecutionModule = {
  ShellExecutionService: ShellExecutionServiceLike;
};

type Summary = {
  outputDir: string;
  gifPath: string | null;
  fixed: ShellScenarioResult;
  base?: ShellScenarioResult;
  terminal: {
    initialCols: number;
    rows: number;
    resizeCols: number[];
  };
  limits: {
    minBaseResizeOnlyEvents: number;
    maxFixedResizeOnlyEvents: number;
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

function command(): string {
  return [
    "printf 'NARROW_REFLOW_000_ALPHA NARROW_REFLOW_001_BETA NARROW_REFLOW_002_GAMMA NARROW_REFLOW_003_DELTA'",
    'sleep 0.6',
    "printf '\\r'",
    'sleep 0.6',
    "printf '\\r'",
    'sleep 0.2',
  ].join('; ');
}

function chunkToText(chunk: unknown): string {
  if (typeof chunk === 'string') {
    return chunk;
  }

  if (!Array.isArray(chunk)) {
    return String(chunk);
  }

  return chunk
    .map((line) => {
      if (!Array.isArray(line)) {
        return '';
      }

      return line
        .map((token: AnsiToken) =>
          typeof token.text === 'string' ? token.text : '',
        )
        .join('');
    })
    .join('\n');
}

function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function timeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function shellServicePath(repoRoot: string): string {
  return join(
    repoRoot,
    'packages/core/dist/src/services/shellExecutionService.js',
  );
}

async function resetOpenTelemetryDiagLogger(): Promise<void> {
  try {
    const { diag } = await import('@opentelemetry/api');
    diag.disable();
  } catch {
    // This script can still validate shell output if telemetry deps are absent.
  }
}

async function loadShellExecutionService(
  repoRoot: string,
): Promise<ShellExecutionServiceLike> {
  const servicePath = shellServicePath(repoRoot);
  if (!existsSync(servicePath)) {
    throw new Error(
      `Missing ${servicePath}. Run "npm run build" in that checkout first.`,
    );
  }

  await resetOpenTelemetryDiagLogger();
  const moduleUrl = pathToFileURL(servicePath);
  moduleUrl.search = `?reflow=${Date.now()}-${Math.random()}`;
  const module = (await import(moduleUrl.href)) as ShellExecutionModule;
  return module.ShellExecutionService;
}

async function runShellScenario(
  repoRoot: string,
  label: string,
): Promise<ShellScenarioResult> {
  const service = await loadShellExecutionService(repoRoot);
  const abortController = new AbortController();
  const events: ShellDataEvent[] = [];
  let phase = 'initial output';
  let resolveFirstDataEvent: (() => void) | undefined;
  const firstDataEvent = new Promise<void>((resolveFirst) => {
    resolveFirstDataEvent = resolveFirst;
  });

  const handle = await service.execute(
    command(),
    repoRoot,
    (event) => {
      if (event.type !== 'data') {
        return;
      }

      const text = chunkToText(event.chunk);
      events.push({
        index: events.length + 1,
        phase,
        text,
        lines: splitLines(text),
      });
      resolveFirstDataEvent?.();
      resolveFirstDataEvent = undefined;
    },
    abortController.signal,
    true,
    {
      terminalWidth: INITIAL_COLS,
      terminalHeight: ROWS,
      showColor: false,
      disableDynamicLineTrimming: false,
    },
  );

  await timeout(
    firstDataEvent,
    5000,
    `${label}: timed out waiting for first shell live-output event`,
  );

  if (handle.pid === undefined) {
    throw new Error(`${label}: shell command did not start with a PTY pid`);
  }

  await sleep(300);
  phase = `resize-only reflow ${INITIAL_COLS}->${FIRST_RESIZE_COLS}`;
  service.resizePty(handle.pid, FIRST_RESIZE_COLS, ROWS);
  await sleep(350);
  phase = `resize-only reflow ${FIRST_RESIZE_COLS}->${SECOND_RESIZE_COLS}`;
  service.resizePty(handle.pid, SECOND_RESIZE_COLS, ROWS);

  const result = await handle.result;
  return {
    label,
    repoRoot,
    dataEventCount: events.length,
    resizeOnlyDataEventCount: events.filter(
      (event) => event.phase !== 'initial output',
    ).length,
    events,
    output: result.output,
    exitCode: result.exitCode,
  };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function eventBlock(event: ShellDataEvent): string {
  const duplicateClass =
    event.phase === 'initial output' ? 'initial' : 'duplicate';
  const label =
    event.phase === 'initial output'
      ? `event #${event.index}: real shell output`
      : `event #${event.index}: resize-only duplicate`;

  return `
    <div class="event ${duplicateClass}">
      <div class="event-label">${escapeHtml(label)}</div>
      <pre>${escapeHtml(event.lines.join('\n'))}</pre>
    </div>`;
}

function panelHtml(
  result: ShellScenarioResult,
  frameIndex: number,
  expectedFixed: boolean,
): string {
  const visibleEvents = result.events.filter((event) => {
    if (event.phase === 'initial output') {
      return true;
    }
    return frameIndex >= 4;
  });
  const metricClass =
    result.resizeOnlyDataEventCount === 0 ? 'metric-pass' : 'metric-fail';
  const emptyResizeEvent =
    frameIndex >= 4 && result.resizeOnlyDataEventCount === 0
      ? `
        <div class="event no-duplicate">
          <div class="event-label">no resize-only event emitted</div>
          <pre>resize changed soft-wrap only; UI receives no duplicate block</pre>
        </div>`
      : '';

  return `
    <section class="panel">
      <h2>${escapeHtml(result.label)}</h2>
      <div class="${metricClass}">
        data events=${result.dataEventCount} · resize-only events=${result.resizeOnlyDataEventCount}
      </div>
      <div class="repo">${expectedFixed ? 'fixed branch' : 'base branch'}</div>
      <div class="terminal">
        ${visibleEvents.map(eventBlock).join('')}
        ${emptyResizeEvent}
      </div>
    </section>`;
}

function frameHtml(
  fixed: ShellScenarioResult,
  base: ShellScenarioResult | undefined,
  frameIndex: number,
): string {
  const left = base ?? fixed;
  const right = base ? fixed : undefined;
  const title =
    frameIndex < 4
      ? 'Narrow shell output before resize'
      : 'After resize: duplicate live-output gate';
  const subtitle =
    frameIndex < 4
      ? 'Both sides receive the first real shell output event.'
      : 'Only the unfixed path emits an extra resize-only event with no new visible characters.';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #0d1117;
      color: #c9d1d9;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      padding: 28px;
    }
    h1 {
      margin: 0 0 6px 0;
      font-size: 26px;
      font-weight: 650;
      letter-spacing: 0;
    }
    .subtitle {
      color: #8b949e;
      font-size: 16px;
      margin-bottom: 22px;
    }
    .grid {
      display: grid;
      grid-template-columns: ${right ? '1fr 1fr' : '1fr'};
      gap: 24px;
    }
    .panel {
      border: 1px solid #30363d;
      border-radius: 8px;
      overflow: hidden;
      background: #010409;
      min-height: 560px;
    }
    .panel h2 {
      margin: 0;
      padding: 14px 16px 6px;
      font-size: 20px;
      letter-spacing: 0;
    }
    .repo {
      color: #8b949e;
      font-size: 13px;
      padding: 0 16px 12px;
    }
    .metric-pass,
    .metric-fail {
      padding: 0 16px 3px;
      font-size: 15px;
      font-weight: 650;
      letter-spacing: 0;
    }
    .metric-pass { color: #56d364; }
    .metric-fail { color: #ff7b72; }
    .terminal {
      border-top: 1px solid #30363d;
      padding: 16px;
      font-family: Menlo, Monaco, Consolas, 'Courier New', monospace;
      font-size: 15px;
      line-height: 1.35;
    }
    .event {
      border-radius: 8px;
      margin-bottom: 14px;
      padding: 12px;
      border: 1px solid #30363d;
      background: #0d1117;
    }
    .event-label {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-weight: 700;
      letter-spacing: 0;
      margin-bottom: 8px;
    }
    .initial .event-label { color: #79c0ff; }
    .duplicate {
      border-color: #f85149;
      background: rgba(248, 81, 73, 0.12);
    }
    .duplicate .event-label { color: #ff7b72; }
    .no-duplicate {
      border-color: #3fb950;
      background: rgba(63, 185, 80, 0.12);
    }
    .no-duplicate .event-label { color: #56d364; }
    pre {
      margin: 0;
      white-space: pre-wrap;
      color: #c9d1d9;
    }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <div class="subtitle">${escapeHtml(subtitle)}</div>
  <div class="grid">
    ${panelHtml(left, frameIndex, !base)}
    ${right ? panelHtml(right, frameIndex, true) : ''}
  </div>
</body>
</html>`;
}

async function captureFrame(
  page: Page,
  outputDir: string,
  filename: string,
  html: string,
): Promise<string> {
  await page.setContent(html);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(150);
  const filepath = join(outputDir, filename);
  await page.screenshot({ path: filepath });
  return filepath;
}

async function generateFrames(
  fixed: ShellScenarioResult,
  base: ShellScenarioResult | undefined,
  outputDir: string,
): Promise<string[]> {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: base ? 1500 : 900, height: 720 },
      deviceScaleFactor: 1,
    });

    const frames: string[] = [];
    for (let index = 0; index < FRAME_COUNT; index += 1) {
      frames.push(
        await captureFrame(
          page,
          outputDir,
          `shell-reflow-${String(index + 1).padStart(2, '0')}.png`,
          frameHtml(fixed, base, index),
        ),
      );
    }
    return frames;
  } finally {
    await browser?.close();
  }
}

function generateGifWithFfmpeg(
  frames: string[],
  outputDir: string,
): string | null {
  const gifPath = join(outputDir, 'shell-reflow-regression.gif');
  const listFile = join(outputDir, 'frames.txt');
  const lines = frames.flatMap((frame, index) => [
    `file '${resolve(frame).replace(/'/g, "'\\''")}'`,
    `duration ${index < 3 ? '0.65' : '1.25'}`,
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
  const gifPath = join(outputDir, 'shell-reflow-regression.gif');
  const python = process.env['QWEN_TUI_E2E_PYTHON'] ?? 'python3';
  const script = String.raw`
import sys
from PIL import Image

out = sys.argv[1]
frames = sys.argv[2:]
images = [Image.open(frame).convert("P", palette=Image.Palette.ADAPTIVE, colors=128) for frame in frames]
durations = [650 if i < 3 else 1250 for i in range(len(images))]
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
  const fixedRepoRoot = resolve(
    process.env['QWEN_TUI_E2E_REPO'] ?? defaultRepoRoot,
  );
  const baseRepoRoot =
    process.env['QWEN_TUI_E2E_BASE_REPO'] === undefined ||
    process.env['QWEN_TUI_E2E_BASE_REPO'] === ''
      ? undefined
      : resolve(process.env['QWEN_TUI_E2E_BASE_REPO']);
  const defaultOut = join(
    tmpdir(),
    'qwen-tui-shell-reflow-regression',
    basename(fixedRepoRoot),
  );
  const outputDir = resolve(process.env['QWEN_TUI_E2E_OUT'] ?? defaultOut);
  const minBaseResizeOnlyEvents = envNumber(
    'QWEN_TUI_E2E_MIN_BASE_RESIZE_ONLY_EVENTS',
    baseRepoRoot ? 1 : 0,
  );
  const maxFixedResizeOnlyEvents = envNumber(
    'QWEN_TUI_E2E_MAX_FIXED_RESIZE_ONLY_EVENTS',
    0,
  );

  if (existsSync(outputDir)) {
    rmSync(outputDir, { recursive: true });
  }
  mkdirSync(outputDir, { recursive: true });

  const base = baseRepoRoot
    ? await runShellScenario(baseRepoRoot, 'BEFORE origin/main')
    : undefined;
  const fixed = await runShellScenario(fixedRepoRoot, 'AFTER fixed');

  const frames = await generateFrames(fixed, base, outputDir);
  const gifPath = generateGif(frames, outputDir);

  const pass =
    fixed.resizeOnlyDataEventCount <= maxFixedResizeOnlyEvents &&
    (base === undefined ||
      base.resizeOnlyDataEventCount >= minBaseResizeOnlyEvents);

  const summary: Summary = {
    outputDir,
    gifPath,
    fixed,
    ...(base ? { base } : {}),
    terminal: {
      initialCols: INITIAL_COLS,
      rows: ROWS,
      resizeCols: [FIRST_RESIZE_COLS, SECOND_RESIZE_COLS],
    },
    limits: {
      minBaseResizeOnlyEvents,
      maxFixedResizeOnlyEvents,
    },
    pass,
  };

  writeFileSync(
    join(outputDir, 'summary.json'),
    JSON.stringify(summary, null, 2),
  );
  writeFileSync(
    join(outputDir, 'fixed.events.json'),
    JSON.stringify(fixed.events, null, 2),
  );
  if (base) {
    writeFileSync(
      join(outputDir, 'base.events.json'),
      JSON.stringify(base.events, null, 2),
    );
  }

  console.log(JSON.stringify(summary, null, 2));

  if (!pass) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
