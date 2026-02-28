/**
 * TerminalCapture - Terminal Screenshot Tool
 *
 * Terminal screenshot solution based on xterm.js + Playwright + node-pty.
 * Core philosophy: WYSIWYG — let xterm.js complete terminal simulation and rendering
 * inside the browser. Screenshots always capture the terminal's current real state,
 * no manual output cleaning needed.
 *
 * Architecture:
 *   node-pty (pseudo-terminal)
 *     ↓  raw ANSI byte stream
 *   xterm.js (running inside Playwright headless Chromium)
 *     ↓  perfect rendering: colors, bold, cursor, scrolling
 *   Playwright element screenshot
 *     ↓  pixel-perfect screenshots (optional macOS window decorations)
 */

import { chromium, type Browser, type Page } from 'playwright';
import * as pty from '@lydell/node-pty';
import stripAnsi from 'strip-ansi';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);

// ─────────────────────────────────────────────
// Theme definitions
// ─────────────────────────────────────────────

export interface XtermTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent?: string;
  selectionBackground?: string;
  selectionForeground?: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export const THEMES: Record<string, XtermTheme> = {
  dracula: {
    background: '#282a36',
    foreground: '#f8f8f2',
    cursor: '#f8f8f2',
    selectionBackground: '#44475a',
    black: '#21222c',
    red: '#ff5555',
    green: '#50fa7b',
    yellow: '#f1fa8c',
    blue: '#bd93f9',
    magenta: '#ff79c6',
    cyan: '#8be9fd',
    white: '#f8f8f2',
    brightBlack: '#6272a4',
    brightRed: '#ff6e6e',
    brightGreen: '#69ff94',
    brightYellow: '#ffffa5',
    brightBlue: '#d6acff',
    brightMagenta: '#ff92df',
    brightCyan: '#a4ffff',
    brightWhite: '#ffffff',
  },

  'one-dark': {
    background: '#282c34',
    foreground: '#abb2bf',
    cursor: '#528bff',
    selectionBackground: '#3e4451',
    black: '#545862',
    red: '#e06c75',
    green: '#98c379',
    yellow: '#e5c07b',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#abb2bf',
    brightBlack: '#545862',
    brightRed: '#e06c75',
    brightGreen: '#98c379',
    brightYellow: '#e5c07b',
    brightBlue: '#61afef',
    brightMagenta: '#c678dd',
    brightCyan: '#56b6c2',
    brightWhite: '#c8ccd4',
  },

  'github-dark': {
    background: '#0d1117',
    foreground: '#c9d1d9',
    cursor: '#c9d1d9',
    selectionBackground: '#264f78',
    black: '#484f58',
    red: '#ff7b72',
    green: '#3fb950',
    yellow: '#d29922',
    blue: '#58a6ff',
    magenta: '#bc8cff',
    cyan: '#39c5cf',
    white: '#b1bac4',
    brightBlack: '#6e7681',
    brightRed: '#ffa198',
    brightGreen: '#56d364',
    brightYellow: '#e3b341',
    brightBlue: '#79c0ff',
    brightMagenta: '#d2a8ff',
    brightCyan: '#56d4dd',
    brightWhite: '#f0f6fc',
  },

  monokai: {
    background: '#272822',
    foreground: '#f8f8f2',
    cursor: '#f8f8f0',
    selectionBackground: '#49483e',
    black: '#272822',
    red: '#f92672',
    green: '#a6e22e',
    yellow: '#f4bf75',
    blue: '#66d9ef',
    magenta: '#ae81ff',
    cyan: '#a1efe4',
    white: '#f8f8f2',
    brightBlack: '#75715e',
    brightRed: '#f92672',
    brightGreen: '#a6e22e',
    brightYellow: '#f4bf75',
    brightBlue: '#66d9ef',
    brightMagenta: '#ae81ff',
    brightCyan: '#a1efe4',
    brightWhite: '#f9f8f5',
  },

  'night-owl': {
    background: '#011627',
    foreground: '#d6deeb',
    cursor: '#80a4c2',
    selectionBackground: '#1d3b53',
    black: '#011627',
    red: '#ef5350',
    green: '#22da6e',
    yellow: '#addb67',
    blue: '#82aaff',
    magenta: '#c792ea',
    cyan: '#21c7a8',
    white: '#d6deeb',
    brightBlack: '#575656',
    brightRed: '#ef5350',
    brightGreen: '#22da6e',
    brightYellow: '#ffeb95',
    brightBlue: '#82aaff',
    brightMagenta: '#c792ea',
    brightCyan: '#7fdbca',
    brightWhite: '#ffffff',
  },
};

// ─────────────────────────────────────────────
// Options
// ─────────────────────────────────────────────

export interface TerminalCaptureOptions {
  /** Number of terminal columns, default 120 */
  cols?: number;
  /** Number of terminal rows, default 40 */
  rows?: number;
  /** Working directory */
  cwd?: string;
  /** Environment variables */
  env?: NodeJS.ProcessEnv;
  /** Theme name or custom theme object, default 'dracula' */
  theme?: keyof typeof THEMES | XtermTheme;
  /** Whether to show macOS window decorations (traffic lights + title bar), default true */
  chrome?: boolean;
  /** Window title (only effective when chrome=true), default 'Terminal' */
  title?: string;
  /** Font size, default 14 */
  fontSize?: number;
  /** Font family, default system monospace font */
  fontFamily?: string;
  /** Default screenshot output directory */
  outputDir?: string;
}

// ─────────────────────────────────────────────
// Main class
// ─────────────────────────────────────────────

export class TerminalCapture {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private ptyProcess: pty.IPty | null = null;
  private rawOutput = '';
  private lastFlushedLength = 0;

  private readonly cols: number;
  private readonly rows: number;
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly theme: XtermTheme;
  private readonly showChrome: boolean;
  private readonly windowTitle: string;
  private readonly fontSize: number;
  private readonly fontFamily: string;
  private readonly outputDir: string;

  // ── Factory ──────────────────────────────

  /**
   * Create and initialize a TerminalCapture instance
   *
   * @example
   * ```ts
   * const t = await TerminalCapture.create({
   *   theme: 'dracula',
   *   chrome: true,
   *   title: 'qwen-code',
   * });
   * ```
   */
  static async create(
    options?: TerminalCaptureOptions,
  ): Promise<TerminalCapture> {
    const instance = new TerminalCapture(options);
    await instance.init();
    return instance;
  }

  private constructor(options?: TerminalCaptureOptions) {
    this.cols = options?.cols ?? 120;
    this.rows = options?.rows ?? 40;
    this.cwd = options?.cwd ?? process.cwd();
    // Build a clean env for optimal terminal rendering:
    // - Remove NO_COLOR (conflicts with FORCE_COLOR, can crash gradient components)
    // - Suppress Node.js warnings (noisy in screenshots)
    // - Force color output and 256-color terminal
    const baseEnv = { ...process.env };
    delete baseEnv['NO_COLOR'];
    this.env = options?.env ?? {
      ...baseEnv,
      FORCE_COLOR: '1',
      TERM: 'xterm-256color',
      NODE_NO_WARNINGS: '1',
    };
    this.showChrome = options?.chrome ?? true;
    this.windowTitle = options?.title ?? 'Terminal';
    this.fontSize = options?.fontSize ?? 14;
    this.fontFamily =
      options?.fontFamily ??
      "'Menlo', 'Monaco', 'Consolas', 'Courier New', monospace";
    this.outputDir = options?.outputDir ?? join(process.cwd(), 'screenshots');

    // Resolve theme
    if (typeof options?.theme === 'string') {
      this.theme = THEMES[options.theme] ?? THEMES['dracula'];
    } else if (options?.theme && typeof options.theme === 'object') {
      this.theme = options.theme;
    } else {
      this.theme = THEMES['dracula'];
    }
  }

  // ── Lifecycle ────────────────────────────

  private async init(): Promise<void> {
    // 1. Launch browser
    this.browser = await chromium.launch({ headless: true });
    this.page = await this.browser.newPage({
      viewport: { width: 1600, height: 1000 },
    });

    // 2. Set base HTML (with chrome decoration, container, etc.)
    await this.page.setContent(this.buildHTML());

    // 3. Load xterm.js from node_modules
    const xtermDir = this.resolveXtermDir();
    await this.page.addStyleTag({ path: join(xtermDir, 'css', 'xterm.css') });
    await this.page.addScriptTag({ path: join(xtermDir, 'lib', 'xterm.js') });

    // 4. Create xterm Terminal instance inside the page

    await this.page.evaluate(
      ({ cols, rows, theme, fontSize, fontFamily }) => {
        const W = window as unknown as Record<string, unknown>;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const Terminal = W['Terminal'] as new (opts: unknown) => any;
        const term = new Terminal({
          cols,
          rows,
          theme,
          fontFamily,
          fontSize,
          lineHeight: 1.2,
          cursorBlink: false,
          allowProposedApi: true,
          scrollback: 1000,
        });

        const container = document.getElementById('xterm-container')!;

        term.open(container);

        // Expose to outer scope
        W['term'] = term;
        W['termReady'] = true;
      },
      {
        cols: this.cols,
        rows: this.rows,
        theme: this.theme as unknown as Record<string, string>,
        fontSize: this.fontSize,
        fontFamily: this.fontFamily,
      },
    );

    // 5. Wait until terminal is ready
    await this.page.waitForFunction(
      () =>
        (window as unknown as Record<string, unknown>)['termReady'] === true,
    );
  }

  /**
   * Spawn a command (via pseudo-terminal)
   *
   * @example
   * ```ts
   * await terminal.spawn('node', ['dist/cli.js', '--yolo']);
   * ```
   */
  async spawn(command: string, args: string[] = []): Promise<void> {
    if (!this.page) {
      throw new Error(
        'Not initialized. Use TerminalCapture.create() factory method.',
      );
    }

    this.ptyProcess = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env: this.env,
    });

    this.ptyProcess.onData((data) => {
      this.rawOutput += data;
    });
  }

  // ── Input ────────────────────────────────

  /**
   * Input text. Supports `\n` as Enter.
   *
   * @param text   Text to input
   * @param options.delay  Delay after input (ms), default 10
   * @param options.slow   Type character by character (simulate real typing), default false
   *
   * @example
   * ```ts
   * await terminal.type('Hello world\n');          // Input + Enter
   * await terminal.type('ls -la\n', { slow: true, delay: 80 });
   * ```
   */
  async type(
    text: string,
    options?: { delay?: number; slow?: boolean },
  ): Promise<void> {
    if (!this.ptyProcess) {
      throw new Error('No process running. Call spawn() first.');
    }

    // Convert \n to \r for PTY
    const translated = text.replace(/\n/g, '\r');

    if (options?.slow) {
      for (const char of translated) {
        this.ptyProcess.write(char);
        await this.sleep(options.delay ?? 50);
      }
    } else {
      this.ptyProcess.write(translated);
      await this.sleep(options?.delay ?? 10);
    }
  }

  // ── Wait ─────────────────────────────────

  /**
   * Wait for specific text to appear in terminal output
   *
   * @throws Error on timeout
   *
   * @example
   * ```ts
   * await terminal.waitFor('Type your message');
   * await terminal.waitFor('tokens', { timeout: 30000 });
   * ```
   */
  async waitFor(text: string, options?: { timeout?: number }): Promise<void> {
    const timeout = options?.timeout ?? 15000;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      if (
        stripAnsi(this.rawOutput).toLowerCase().includes(text.toLowerCase())
      ) {
        return;
      }
      await this.sleep(200);
    }

    throw new Error(
      `Timeout (${timeout}ms) waiting for text: "${text}"\n` +
        `Last 500 chars of output: ${stripAnsi(this.rawOutput).slice(-500)}`,
    );
  }

  /**
   * Wait for output to stabilize (no new output within specified time)
   *
   * @param stableMs  Stability detection duration (ms), default 500
   * @param timeout   Maximum wait time (ms), default 30000
   *
   * @example
   * ```ts
   * await terminal.idle();           // Default: 500ms with no new output considered stable
   * await terminal.idle(2000);       // 2s with no new output
   * ```
   */
  async idle(stableMs: number = 500, timeout: number = 30000): Promise<void> {
    const start = Date.now();
    let lastLength = this.rawOutput.length;
    let lastChangeTime = Date.now();

    while (Date.now() - start < timeout) {
      await this.sleep(100);
      if (this.rawOutput.length !== lastLength) {
        lastLength = this.rawOutput.length;
        lastChangeTime = Date.now();
      } else if (Date.now() - lastChangeTime >= stableMs) {
        return;
      }
    }
    // Timeout for idle() is not an error — just means output kept coming
  }

  /**
   * Wait for text to appear, then wait for output to stabilize (common combination)
   */
  async waitForAndIdle(
    text: string,
    options?: { timeout?: number; stableMs?: number },
  ): Promise<void> {
    await this.waitFor(text, { timeout: options?.timeout });
    await this.idle(options?.stableMs ?? 300, 5000);
  }

  // ── Capture ──────────────────────────────

  /**
   * Capture and save a screenshot. Filenames are deterministic (no timestamps) for easy regression comparison.
   *
   * @param filename   Filename, e.g., 'initial.png'
   * @param outputDir  Output directory, defaults to the outputDir from construction
   * @returns          Full path to the screenshot file
   *
   * @example
   * ```ts
   * await terminal.capture('01-initial.png');
   * await terminal.capture('02-output.png', '/tmp/screenshots');
   * ```
   */
  async capture(filename: string, outputDir?: string): Promise<string> {
    if (!this.page) {
      throw new Error('Not initialized');
    }

    // 1. Flush all accumulated PTY data to xterm.js
    await this.flush();

    // 2. Wait for xterm.js rendering to complete
    await this.sleep(150);

    // 3. Prepare output directory
    const dir = outputDir ?? this.outputDir;
    mkdirSync(dir, { recursive: true });
    const filepath = join(dir, filename);

    // 4. Screenshot the capture root (terminal + optional chrome)
    const element = await this.page.$('#capture-root');
    if (element) {
      await element.screenshot({ path: filepath });
    } else {
      await this.page.screenshot({ path: filepath });
    }

    console.log(`📸 Captured: ${filepath}`);
    return filepath;
  }

  /**
   * Capture full terminal output (including scrollback buffer) as a long image.
   * Suitable for scenarios where output exceeds the visible area, e.g., detailed token lists from /context.
   *
   * Principle: Temporarily expand xterm.js rows to show complete scrollback, then restore original dimensions after screenshot.
   * Note: Only resizes xterm.js inside the browser, not the PTY dimensions, so it won't trigger CLI re-render.
   *
   * @param filename   Filename
   * @param outputDir  Output directory
   * @returns          Full path to the screenshot file
   *
   * @example
   * ```ts
   * // Regular screenshot (only current viewport)
   * await terminal.capture('output.png');
   * // Full-length image (including scrollback buffer)
   * await terminal.captureFull('output-full.png');
   * ```
   */
  async captureFull(filename: string, outputDir?: string): Promise<string> {
    if (!this.page) {
      throw new Error('Not initialized');
    }

    // 1. Flush all accumulated PTY data to xterm.js
    await this.flush();
    await this.sleep(150);

    // 2. Query xterm.js for the actual content height (skip trailing empty lines)
    const contentLines = await this.page.evaluate(() => {
      const W = window as unknown as Record<string, unknown>;
      const term = W['term'] as {
        buffer: {
          active: {
            length: number;
            getLine: (i: number) =>
              | {
                  translateToString: (trimRight?: boolean) => string;
                }
              | undefined;
          };
        };
      };
      const buf = term.buffer.active;
      let lastNonEmpty = 0;
      for (let i = buf.length - 1; i >= 0; i--) {
        const line = buf.getLine(i);
        if (line && line.translateToString(true).trim().length > 0) {
          lastNonEmpty = i;
          break;
        }
      }
      return lastNonEmpty + 1;
    });

    const expandedRows = Math.max(contentLines + 2, this.rows);

    // 3. Temporarily resize xterm.js only (NOT the PTY) to show all content
    //    This avoids sending SIGWINCH to the child process, so the CLI won't re-render
    await this.page.evaluate(
      ({ cols, rows }: { cols: number; rows: number }) => {
        const W = window as unknown as Record<string, unknown>;
        const term = W['term'] as {
          resize: (c: number, r: number) => void;
          scrollToTop: () => void;
        };
        term.resize(cols, rows);
        // Scroll to top to ensure rendering starts from scrollback beginning position
        term.scrollToTop();
      },
      { cols: this.cols, rows: expandedRows },
    );

    // 4. Expand viewport to accommodate the taller terminal
    await this.page.setViewportSize({
      width: 1600,
      height: Math.max(expandedRows * 22, 1000), // ~22px per row (fontSize 14 * lineHeight 1.2 + padding)
    });

    await this.sleep(300);

    // 5. Screenshot the full content
    const dir = outputDir ?? this.outputDir;
    mkdirSync(dir, { recursive: true });
    const filepath = join(dir, filename);

    const element = await this.page.$('#capture-root');
    if (element) {
      await element.screenshot({ path: filepath });
    } else {
      await this.page.screenshot({ path: filepath, fullPage: true });
    }

    // 6. Restore original xterm.js dimensions and viewport
    await this.page.evaluate(
      ({ cols, rows }: { cols: number; rows: number }) => {
        const W = window as unknown as Record<string, unknown>;
        const term = W['term'] as { resize: (c: number, r: number) => void };
        term.resize(cols, rows);
      },
      { cols: this.cols, rows: this.rows },
    );

    await this.page.setViewportSize({ width: 1600, height: 1000 });

    console.log(`📸 Captured (full): ${filepath}`);
    return filepath;
  }

  // ── Output access ────────────────────────

  /**
   * Get cleaned terminal output (without ANSI escape sequences)
   */
  getOutput(): string {
    return stripAnsi(this.rawOutput);
  }

  /**
   * Get raw terminal output (with ANSI escape sequences)
   */
  getRawOutput(): string {
    return this.rawOutput;
  }

  // ── Cleanup ──────────────────────────────

  /**
   * Release all resources (PTY process, browser)
   */
  async close(): Promise<void> {
    if (this.ptyProcess) {
      try {
        this.ptyProcess.kill();
      } catch {
        // Process may have already exited
      }
      this.ptyProcess = null;
    }

    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }
  }

  // ── Internal: flush PTY → xterm.js ──────

  /**
   * Flush accumulated PTY raw output to xterm.js inside the browser.
   * Uses xterm.js's write callback to ensure data is fully parsed,
   * then waits one requestAnimationFrame to ensure rendering is complete.
   */
  private async flush(): Promise<void> {
    if (!this.page || this.rawOutput.length <= this.lastFlushedLength) {
      return;
    }

    const newData = this.rawOutput.slice(this.lastFlushedLength);
    this.lastFlushedLength = this.rawOutput.length;

    // Send data in chunks to avoid hitting string size limits
    const CHUNK_SIZE = 64 * 1024;
    for (let i = 0; i < newData.length; i += CHUNK_SIZE) {
      const chunk = newData.slice(i, i + CHUNK_SIZE);
      await this.page.evaluate((data: string) => {
        return new Promise<void>((resolve) => {
          const W = window as unknown as Record<string, unknown>;
          const term = W['term'] as {
            write: (d: string, cb: () => void) => void;
          };
          term.write(data, () => {
            // Data parsed → wait one frame for rendering
            requestAnimationFrame(() => resolve());
          });
        });
      }, chunk);
    }
  }

  // ── Internal: resolve xterm.js path ─────

  private resolveXtermDir(): string {
    try {
      const pkgJsonPath = _require.resolve('@xterm/xterm/package.json');
      return dirname(pkgJsonPath);
    } catch {
      throw new Error(
        '@xterm/xterm is not installed.\n' +
          'Run: npm install --save-dev @xterm/xterm',
      );
    }
  }

  // ── Internal: build HTML ────────────────

  private buildHTML(): string {
    const bg = this.theme.background;

    // Title bar color: slightly lighter than background
    // Use a manual approximation instead of color-mix for compatibility
    const titleBarBg = this.lighten(bg, 0.08);

    const chromeHTML = this.showChrome
      ? `
      <div class="title-bar" style="background: ${titleBarBg};">
        <div class="traffic-lights">
          <span class="tl tl-close"></span>
          <span class="tl tl-minimize"></span>
          <span class="tl tl-maximize"></span>
        </div>
        <span class="title-text">${this.escapeHtml(this.windowTitle)}</span>
        <div class="traffic-lights-spacer"></div>
      </div>`
      : '';

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      background: #0e0e1a;
      display: flex;
      justify-content: center;
      align-items: flex-start;
      padding: 40px;
      min-height: 100vh;
    }

    #capture-root {
      display: inline-block;
      border-radius: ${this.showChrome ? '10px' : '6px'};
      overflow: hidden;
      background: ${bg};
      box-shadow:
        0 25px 70px rgba(0, 0, 0, 0.6),
        0 0 0 1px rgba(255, 255, 255, 0.08);
    }

    /* ── Title bar (macOS chrome) ── */
    .title-bar {
      height: 40px;
      display: flex;
      align-items: center;
      padding: 0 16px;
      user-select: none;
    }

    .traffic-lights {
      display: flex;
      gap: 8px;
      width: 56px;
    }

    .traffic-lights-spacer {
      width: 56px;
    }

    .tl {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      display: block;
    }

    .tl-close    { background: #ff5f57; }
    .tl-minimize { background: #ffbd2e; }
    .tl-maximize { background: #28c840; }

    .title-text {
      flex: 1;
      text-align: center;
      color: rgba(255, 255, 255, 0.45);
      font-size: 13px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      font-weight: 500;
    }

    /* ── Terminal container ── */
    #xterm-container {
      padding: 4px 8px 8px 8px;
    }

    /* Hide scrollbar in xterm */
    .xterm-viewport::-webkit-scrollbar { display: none; }
    .xterm-viewport { scrollbar-width: none; }

    /* Ensure xterm canvas renders sharply */
    .xterm canvas { image-rendering: pixelated; }
  </style>
</head>
<body>
  <div id="capture-root">
    ${chromeHTML}
    <div id="xterm-container"></div>
  </div>
</body>
</html>`;
  }

  // ── Internal: utils ─────────────────────

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  /**
   * Lighten a hex color by a factor (0-1)
   */
  private lighten(hex: string, factor: number): string {
    const h = hex.replace('#', '');
    const r = Math.min(
      255,
      parseInt(h.slice(0, 2), 16) + Math.round(255 * factor),
    );
    const g = Math.min(
      255,
      parseInt(h.slice(2, 4), 16) + Math.round(255 * factor),
    );
    const b = Math.min(
      255,
      parseInt(h.slice(4, 6), 16) + Math.round(255 * factor),
    );
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
