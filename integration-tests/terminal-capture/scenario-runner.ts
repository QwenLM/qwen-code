/**
 * Scenario Runner v3 — TypeScript Configuration-Driven Terminal Screenshots
 *
 * Configuration has only two core concepts: type (input) and capture (screenshot).
 * All intelligent waiting is handled automatically by the Runner.
 *
 * Usage:
 *   npx tsx integration-tests/terminal-capture/run.ts integration-tests/terminal-capture/scenarios/about.ts
 *   npx tsx integration-tests/terminal-capture/run.ts integration-tests/terminal-capture/scenarios/
 */

import { TerminalCapture, THEMES } from './terminal-capture.js';
import { dirname, resolve, isAbsolute } from 'node:path';

// ─────────────────────────────────────────────
// Schema — Minimal
// ─────────────────────────────────────────────

export interface FlowStep {
  /** Input text (auto-press Enter, auto-wait for output to stabilize, auto-screenshot before/after) */
  type?: string;
  /**
   * Send special key presses (no auto-Enter, no auto-screenshot)
   * Supported: ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Enter, Tab, Escape, Backspace, Space
   * Can also pass ANSI escape sequence strings
   */
  key?: string | string[];
  /** Explicit screenshot: current viewport (standalone capture when no type) */
  capture?: string;
  /** Explicit screenshot: full scrollback buffer long image (standalone capture when no type) */
  captureFull?: string;
}

export interface ScenarioConfig {
  /** Scenario name */
  name: string;
  /** Launch command, e.g., ["node", "dist/cli.js", "--yolo"] */
  spawn: string[];
  /** Execution flow: array, each item can contain type / capture / captureFull */
  flow: FlowStep[];
  /** Terminal configuration (all optional) */
  terminal?: {
    cols?: number;
    rows?: number;
    theme?: string;
    chrome?: boolean;
    title?: string;
    fontSize?: number;
    cwd?: string;
  };
  /** Screenshot output directory (relative to config file) */
  outputDir?: string;
}

// ─────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────

export interface RunResult {
  name: string;
  screenshots: string[];
  success: boolean;
  error?: string;
  durationMs: number;
}

/** Dynamically load configuration from .ts file (supports single object or array) */
export async function loadScenarios(
  tsPath: string,
): Promise<{ configs: ScenarioConfig[]; basedir: string }> {
  const absPath = isAbsolute(tsPath) ? tsPath : resolve(tsPath);
  const mod = (await import(absPath)) as {
    default: ScenarioConfig | ScenarioConfig[];
  };
  const raw = mod.default;
  const configs = Array.isArray(raw) ? raw : [raw];

  for (const config of configs) {
    if (!config?.name) throw new Error(`Missing 'name': ${absPath}`);
    if (!config.spawn?.length) throw new Error(`Missing 'spawn': ${absPath}`);
    if (!config.flow?.length) throw new Error(`Missing 'flow': ${absPath}`);
  }

  return { configs, basedir: dirname(absPath) };
}

/** Execute a single scenario */
export async function runScenario(
  config: ScenarioConfig,
  basedir: string,
): Promise<RunResult> {
  const startTime = Date.now();
  const screenshots: string[] = [];
  const t = config.terminal ?? {};

  const cwd = t.cwd ? resolve(basedir, t.cwd) : resolve(basedir, '..');
  // Use scenario name as subdirectory to isolate screenshot outputs from different scenarios
  const scenarioDir =
    config.name
      .replace(/^\//, '')
      .replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'unnamed';
  const outputDir = config.outputDir
    ? resolve(basedir, config.outputDir, scenarioDir)
    : resolve(basedir, 'screenshots', scenarioDir);

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`▶ ${config.name}`);
  console.log('═'.repeat(60));

  const terminal = await TerminalCapture.create({
    cols: t.cols ?? 100,
    rows: t.rows ?? 28,
    theme: (t.theme ?? 'dracula') as keyof typeof THEMES,
    chrome: t.chrome ?? true,
    title: t.title ?? 'Terminal',
    fontSize: t.fontSize,
    cwd,
    outputDir,
  });

  try {
    // ── Spawn ──
    const [command, ...args] = config.spawn;
    console.log(`  spawn: ${config.spawn.join(' ')}`);
    await terminal.spawn(command, args);

    // ── Auto-wait for CLI readiness ──
    console.log('  ⏳ waiting for ready...');
    await terminal.idle(1500, 30000);
    console.log('  ✅ ready');

    // ── Execute flow ──
    let seq = 0; // Global screenshot sequence number

    for (let i = 0; i < config.flow.length; i++) {
      const step = config.flow[i];
      const label = `[${i + 1}/${config.flow.length}]`;

      if (step.type) {
        const display =
          step.type.length > 60 ? step.type.slice(0, 60) + '...' : step.type;

        // If next step is key, there's more interaction to do, so don't auto-press Enter
        const nextStep = config.flow[i + 1];
        const autoEnter = !nextStep?.key;

        console.log(
          `  ${label} type: "${display}"${autoEnter ? '' : ' (no auto-enter)'}`,
        );

        const text = step.type.replace(/\n$/, '');
        await terminal.type(text);
        await sleep(300);

        // Only send Escape for / commands to close auto-complete, not for regular text
        if (text.startsWith('/') && autoEnter) {
          await terminal.type('\x1b');
          await sleep(100);
        }

        // ── 01: Text input complete ──
        seq++;
        const inputName = step.capture
          ? step.capture.replace(/\.png$/, '-01.png')
          : `${pad(seq)}-01.png`;
        console.log(`  ${label} 📸 input:  ${inputName}`);
        screenshots.push(await terminal.capture(inputName));

        if (autoEnter) {
          // ── Auto-press Enter → Wait for stabilization → 02 screenshot ──
          await terminal.type('\n');
          console.log(`         ⏳ waiting for output to settle...`);
          await terminal.idle(2000, 60000);
          console.log(`         ✅ settled`);

          const resultName = step.capture ?? `${pad(seq)}-02.png`;
          console.log(`  ${label} 📸 result: ${resultName}`);
          screenshots.push(await terminal.capture(resultName));

          // full-flow: Only the last type step auto-captures full-length image
          const isLastType = !config.flow.slice(i + 1).some((s) => s.type);
          if (isLastType || step.captureFull) {
            const fullName = step.captureFull ?? 'full-flow.png';
            console.log(`  ${label} 📸 full:   ${fullName}`);
            screenshots.push(await terminal.captureFull(fullName));
          }
        }
        // When not autoEnter, only captured before state, subsequent key steps take over interaction
      } else if (step.key) {
        // ── key: Send special key presses (arrow keys, Tab, Enter, etc.) ──
        const keys = Array.isArray(step.key) ? step.key : [step.key];
        console.log(`  ${label} key: ${keys.join(', ')}`);

        for (const k of keys) {
          await terminal.type(resolveKey(k));
          await sleep(150);
        }
        // Wait for UI response to key press
        await terminal.idle(500, 5000);

        // If key step has explicit capture/captureFull
        if (step.capture || step.captureFull) {
          seq++;
          if (step.capture) {
            console.log(`  ${label} 📸 capture: ${step.capture}`);
            screenshots.push(await terminal.capture(step.capture));
          }
          if (step.captureFull) {
            console.log(`  ${label} 📸 captureFull: ${step.captureFull}`);
            screenshots.push(await terminal.captureFull(step.captureFull));
          }
        }

        // After key sequence ends (next step is not key), auto-add result + full screenshots
        const nextStep = config.flow[i + 1];
        if (!nextStep?.key) {
          console.log(`         ⏳ waiting for output to settle...`);
          await terminal.idle(2000, 60000);
          console.log(`         ✅ settled`);

          const resultName = `${pad(seq)}-02.png`;
          console.log(`  ${label} 📸 result: ${resultName}`);
          screenshots.push(await terminal.capture(resultName));

          // If this is the last interaction step, add full-length image
          const isLastType = !config.flow.slice(i + 1).some((s) => s.type);
          if (isLastType) {
            console.log(`  ${label} 📸 full:   full-flow.png`);
            screenshots.push(await terminal.captureFull('full-flow.png'));
          }
        }
      } else {
        // ── Standalone screenshot step (no type/key) ──
        seq++;
        if (step.capture) {
          console.log(`  ${label} 📸 capture: ${step.capture}`);
          screenshots.push(await terminal.capture(step.capture));
        }
        if (step.captureFull) {
          console.log(`  ${label} 📸 captureFull: ${step.captureFull}`);
          screenshots.push(await terminal.captureFull(step.captureFull));
        }
      }
    }

    const duration = Date.now() - startTime;
    console.log(
      `\n  ✅ ${config.name} — ${screenshots.length} screenshots, ${(duration / 1000).toFixed(1)}s`,
    );
    return {
      name: config.name,
      screenshots,
      success: true,
      durationMs: duration,
    };
  } catch (err) {
    const duration = Date.now() - startTime;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n  ❌ ${config.name} — ${msg}`);
    return {
      name: config.name,
      screenshots,
      success: false,
      error: msg,
      durationMs: duration,
    };
  } finally {
    await terminal.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Pad sequence number with zero: 1 → "01" */
function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Key name → PTY escape sequence */
const KEY_MAP: Record<string, string> = {
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
  Enter: '\r',
  Tab: '\t',
  Escape: '\x1b',
  Backspace: '\x7f',
  Space: ' ',
  Home: '\x1b[H',
  End: '\x1b[F',
  PageUp: '\x1b[5~',
  PageDown: '\x1b[6~',
  Delete: '\x1b[3~',
};

/** Parse key name to PTY-recognizable character sequence */
function resolveKey(key: string): string {
  return KEY_MAP[key] ?? key;
}
