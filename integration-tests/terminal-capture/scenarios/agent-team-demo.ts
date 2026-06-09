#!/usr/bin/env npx tsx
/**
 * Full agent-team feature demo — one continuous streaming GIF.
 *
 * Merges the team-lifecycle streaming capture and the tab-navigation demo into
 * a single engine-driven run so the GIF tells the whole story end to end:
 *
 *   create team → spawn two teammates in parallel (tab bar appears)
 *     → DIVE INTO each teammate's own tab to watch their live tool-call stream
 *     → return to Main → teammates report → leader's combined summary → cleanup
 *
 * This is a standalone driver script, NOT a declarative scenario-runner
 * scenario: the scenario format only supports fixed `sleep` waits, which can't
 * reliably hit the tab-navigation window when glm-5.1's reason→create→spawn
 * varies ~20-40s. Here we drive the engine directly: stream frames while
 * polling, but gate the tab navigation on the teammates actually spawning
 * (`waitFor` on the Agent tool's deterministic "is now running concurrently"
 * text). Static stretches (the leader idling while teammates read) are
 * de-duplicated so the GIF stays tight. It lives under scenarios/ for
 * discoverability but guards its own entrypoint so the batch runner
 * (run.ts) skips it instead of executing it on import.
 *
 * Run:
 *   QWEN_CODE_ENABLE_AGENT_TEAM=1 npx tsx \
 *     integration-tests/terminal-capture/scenarios/agent-team-demo.ts
 * Auth: glm-5.1 via the openai provider (DASHSCOPE_API_KEY in env).
 * Output: scenarios/screenshots/agent-team-demo/ (frames + demo.gif).
 */
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  rmSync,
  mkdirSync,
  existsSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { execSync } from 'node:child_process';
import stripAnsi from 'strip-ansi';
import { TerminalCapture } from '../terminal-capture.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../../..');
const outputDir = resolve(scriptDir, 'screenshots/agent-team-demo');

const PROMPT =
  'Use the agent team tools to create a team "explorers" with two teammates ' +
  '"scout-core" and "scout-cli". Spawn BOTH in parallel right away, then end ' +
  'your turn and wait for their reports. scout-core: read README.md, ' +
  'package.json, and packages/core/package.json one at a time, then write a ' +
  'concise summary of the core package. scout-cli: read ' +
  'packages/cli/package.json, tsconfig.json, and eslint.config.js one at a ' +
  'time, then write a concise summary of the CLI package. After BOTH have ' +
  'reported back, give a short combined summary, then delete the team.';

// Raw ANSI escape sequences for arrow keys (sent straight to the PTY).
const ARROW = {
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
};

type FrameHold = 'fast' | 'slow';
interface Frame {
  path: string;
  hold: FrameHold;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  if (existsSync(outputDir)) {
    rmSync(outputDir, { recursive: true });
  }
  mkdirSync(outputDir, { recursive: true });

  const terminal = await TerminalCapture.create({
    cols: 120,
    rows: 40,
    cwd: repoRoot,
    outputDir,
    title: 'qwen-code',
    theme: 'dracula',
    chrome: true,
  });

  const frames: Frame[] = [];
  let frameNo = 0;
  const snap = async (hold: FrameHold): Promise<void> => {
    frameNo += 1;
    const name = `frame-${String(frameNo).padStart(4, '0')}.png`;
    await terminal.capture(name);
    frames.push({ path: join(outputDir, name), hold });
  };

  const seen = (marker: string): boolean =>
    stripAnsi(terminal.getRawOutput())
      .toLowerCase()
      .includes(marker.toLowerCase());

  /**
   * Poll at `intervalMs`, capturing a frame only when the output actually
   * changed since the last capture (so idle stretches don't bloat the GIF).
   * Stops when `marker` appears, after `maxFrames` captures, or `maxPolls`.
   */
  const stream = async (
    marker: string | null,
    opts: { intervalMs: number; maxFrames: number; maxPolls: number },
  ): Promise<void> => {
    let prevLen = -1;
    let captured = 0;
    for (let i = 0; i < opts.maxPolls; i += 1) {
      const len = terminal.getRawOutput().length;
      if (len !== prevLen) {
        await snap('fast');
        prevLen = len;
        captured += 1;
        if (captured >= opts.maxFrames) return;
      }
      if (marker && seen(marker)) return;
      await sleep(opts.intervalMs);
    }
  };

  /** Send a key, let the UI settle, then take a (held) navigation frame. */
  const press = async (key: string): Promise<void> => {
    await terminal.type(key);
    await terminal.idle(500, 3000);
    await snap('slow');
  };

  try {
    await terminal.spawn('node', [
      'dist/cli.js',
      '--yolo',
      '--auth-type',
      'openai',
      '--model',
      'glm-5.1',
    ]);
    await terminal.waitFor('Type your message', { timeout: 30000 });

    await terminal.type(PROMPT, { slow: true, delay: 8 });
    await terminal.idle(400, 4000);
    await terminal.type('\n');

    // ── Phase A: stream team creation + teammate spawning ──
    // Stop once a teammate's tab has registered (tab bar is up).
    await stream('is now running concurrently', {
      intervalMs: 1100,
      maxFrames: 22,
      maxPolls: 45,
    });
    // Give the second parallel spawn + the tab bar a moment to settle.
    await terminal.idle(1200, 5000);
    await snap('slow'); // Main view: both teammates running, tab bar visible

    // ── Phase B: dive into each teammate's tab and back ──
    await press(ARROW.down); // focus the tab bar (hint → "←/→ switch")
    await press(ARROW.right); // first teammate's own view
    await sleep(1600);
    await snap('slow'); // linger on their live tool-call stream
    await press(ARROW.right); // second teammate's view
    await sleep(1600);
    await snap('slow');
    await press(ARROW.left); // back to the first teammate
    await press(ARROW.left); // back to Main
    await press(ARROW.up); // release tab-bar focus

    // ── Phase C: stream reports → combined summary → cleanup ──
    await stream('deleted', {
      intervalMs: 1400,
      maxFrames: 34,
      maxPolls: 80,
    });
    await terminal.idle(1500, 8000);
    await snap('slow'); // final consolidated state (scrolled to live bottom)

    const gifPath = generateGif(frames, outputDir);
    console.log(`\n✅ Agent-team demo: ${frames.length} frames`);
    if (gifPath) {
      console.log(`   GIF: ${gifPath}`);
    }
  } finally {
    await terminal.close();
  }
}

/**
 * Assemble frames into a single looping GIF via ffmpeg (concat demuxer +
 * palettegen). Streaming frames play quickly; navigation frames are held so
 * each tab switch is readable; the final frame lingers so the combined summary
 * can be read before the loop restarts.
 */
function generateGif(frames: Frame[], dir: string): string | null {
  if (frames.length === 0) return null;
  const gifPath = join(dir, 'demo.gif');
  const listFile = join(dir, 'frames.txt');
  const FAST = 0.5;
  const SLOW = 1.3;
  const FINAL_HOLD = 3.0;

  const lines: string[] = [];
  frames.forEach((f, i) => {
    const isLast = i === frames.length - 1;
    const dur = isLast ? FINAL_HOLD : f.hold === 'fast' ? FAST : SLOW;
    lines.push(`file '${f.path}'`, `duration ${dur}`);
  });
  // concat demuxer needs the final frame repeated without a duration.
  lines.push(`file '${frames[frames.length - 1]!.path}'`);
  writeFileSync(listFile, lines.join('\n'));

  try {
    execSync(
      `ffmpeg -y -f concat -safe 0 -i "${listFile}" ` +
        `-vf "split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" ` +
        `-loop 0 "${gifPath}"`,
      { stdio: 'pipe' },
    );
    return gifPath;
  } catch {
    console.log('   ⚠️  GIF generation requires ffmpeg');
    return null;
  } finally {
    try {
      unlinkSync(listFile);
    } catch {
      // ignore
    }
  }
}

// Run only when invoked directly (e.g. `npx tsx scenarios/agent-team-demo.ts`),
// NOT when the scenario-runner's batch loader imports this file looking for a
// ScenarioConfig — this is a driver script, not a declarative scenario.
const invokedDirectly =
  process.argv[1] != null &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
