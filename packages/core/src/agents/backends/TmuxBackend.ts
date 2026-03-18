/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview TmuxBackend implements Backend using tmux split-pane.
 *
 * Layout (inside tmux): main process on the left (leader pane ~30%),
 * agent panes on the right, arranged via `main-vertical`.
 *
 * ┌────────────┬──────────────────────────────────┐
 * │            │             Agent 1              │
 * │   Leader   ├──────────────────────────────────┤
 * │   (30%)    │             Agent 2              │
 * │            ├──────────────────────────────────┤
 * │            │             Agent 3              │
 * └────────────┴──────────────────────────────────┘
 *
 * Outside tmux: a dedicated tmux server is created and panes are arranged
 * using `tiled` layout in a separate session/window.
 */

import { createDebugLogger } from '../../utils/debugLogger.js';
import type { AnsiOutput } from '../../utils/terminalSerializer.js';
import { DISPLAY_MODE } from './types.js';
import type { AgentSpawnConfig, AgentExitCallback, Backend } from './types.js';
import {
  verifyTmux,
  tmuxCurrentWindowTarget,
  tmuxCurrentPaneId,
  tmuxHasSession,
  tmuxHasWindow,
  tmuxNewSession,
  tmuxNewWindow,
  tmuxSplitWindow,
  tmuxSendKeys,
  tmuxSelectPane,
  tmuxSelectPaneTitle,
  tmuxSelectPaneStyle,
  tmuxSelectLayout,
  tmuxListPanes,
  tmuxSetOption,
  tmuxRespawnPane,
  tmuxKillPane,
  tmuxKillSession,
  tmuxResizePane,
  tmuxGetFirstPaneId,
  type TmuxPaneInfo,
} from './tmux-commands.js';

const debugLogger = createDebugLogger('TMUX_BACKEND');

/** Polling interval for exit detection (ms) */
const EXIT_POLL_INTERVAL_MS = 500;

/** Default tmux server name prefix (for -L) when running outside tmux.
 *  Actual name is `${prefix}-${process.pid}` so each leader process is isolated. */
const TMUX_SERVER_PREFIX = 'arena-server';
/** Default tmux session name when running outside tmux */
const DEFAULT_TMUX_SESSION = 'arena-view';
/** Default tmux window name when running outside tmux */
const DEFAULT_TMUX_WINDOW = 'arena-view';
/** Default leader pane width percent (main pane) */
const DEFAULT_LEADER_WIDTH_PERCENT = 30;
/** Default first split percent (right side) */
const DEFAULT_FIRST_SPLIT_PERCENT = 70;
/** Default pane border format */
const DEFAULT_PANE_BORDER_FORMAT = '#{pane_title}';
/** Layout settle delays */
const INTERNAL_LAYOUT_SETTLE_MS = 200;
const EXTERNAL_LAYOUT_SETTLE_MS = 120;

interface TmuxAgentPane {
  agentId: string;
  paneId: string;
  status: 'running' | 'exited';
  exitCode: number;
}

interface ResolvedTmuxOptions {
  serverName: string;
  sessionName: string;
  windowName: string;
  paneTitle: string;
  paneBorderStyle?: string;
  paneActiveBorderStyle?: string;
  paneBorderFormat: string;
  paneBorderStatus?: 'top' | 'bottom' | 'off';
  leaderPaneWidthPercent: number;
  firstSplitPercent: number;
}

export class TmuxBackend implements Backend {
  readonly type = DISPLAY_MODE.TMUX;

  /** The pane ID where the main process runs (left side) */
  private mainPaneId = '';
  /** Window target (session:window) */
  private windowTarget = '';
  /** Whether we are running inside tmux */
  private insideTmux = false;
  /** External tmux server name (when outside tmux) */
  private serverName: string | null = null;
  /** External tmux session name (when outside tmux) */
  private sessionName: string | null = null;
  /** External tmux window name (when outside tmux) */
  private windowName: string | null = null;

  private panes: Map<string, TmuxAgentPane> = new Map();
  private agentOrder: string[] = [];
  private activeAgentId: string | null = null;
  private onExitCallback: AgentExitCallback | null = null;
  private exitPollTimer: NodeJS.Timeout | null = null;
  private initialized = false;
  /** Whether cleanup() has been called */
  private cleanedUp = false;
  /** Number of agents currently being spawned asynchronously */
  private pendingSpawns = 0;
  /** Queue to serialize spawn operations (prevents race conditions) */
  private spawnQueue: Promise<void> = Promise.resolve();
  async init(): Promise<void> {
    if (this.initialized) return;

    // Verify tmux is available and version is sufficient
    await verifyTmux();

    this.insideTmux = Boolean(process.env['TMUX']);

    if (this.insideTmux) {
      // Get the current pane ID (this is where the main process runs)
      this.mainPaneId = await tmuxCurrentPaneId();
      this.windowTarget = await tmuxCurrentWindowTarget();
      debugLogger.info(
        `Initialized inside tmux: pane ${this.mainPaneId}, window ${this.windowTarget}`,
      );
    } else {
      debugLogger.info(
        'Initialized outside tmux; will use external tmux server',
      );
    }

    this.initialized = true;
  }

  // ─── Agent Lifecycle ────────────────────────────────────────

  async spawnAgent(config: AgentSpawnConfig): Promise<void> {
    if (!this.initialized) {
      throw new Error('TmuxBackend not initialized. Call init() first.');
    }
    if (this.panes.has(config.agentId)) {
      throw new Error(`Agent "${config.agentId}" already exists.`);
    }

    // Build the shell command string for the agent
    const cmd = this.buildShellCommand(config);

    // Track pending spawn so waitForAll/allExited don't return
    // prematurely before the pane is registered.
    this.pendingSpawns++;

    // Chain spawn operations to ensure they run sequentially.
    // This prevents race conditions where multiple agents all see
    // panes.size === 0 and try to split from mainPaneId.
    const spawnPromise = this.spawnQueue.then(() =>
      this.spawnAgentAsync(config, cmd),
    );
    this.spawnQueue = spawnPromise;

    // Wait for this specific spawn to complete
    await spawnPromise;
  }

  private async spawnAgentAsync(
    config: AgentSpawnConfig,
    cmd: string,
  ): Promise<void> {
    const { agentId } = config;
    const options = this.resolveTmuxOptions(config);

    debugLogger.info(
      `[spawnAgentAsync] Starting spawn for agent "${agentId}", mainPane="${this.mainPaneId}", currentPanesCount=${this.panes.size}`,
    );
    try {
      let paneId = '';
      if (this.insideTmux) {
        paneId = await this.spawnInsideTmux(cmd, options);
      } else {
        paneId = await this.spawnOutsideTmux(config, cmd, options);
      }

      const serverName = this.getServerName();

      // Set remain-on-exit so we can detect when the process exits
      await tmuxSetOption(paneId, 'remain-on-exit', 'on', serverName);

      // Apply pane title/border styling
      await this.applyPaneDecorations(paneId, options, serverName);

      if (this.insideTmux) {
        await this.applyInsideLayout(options);
        await this.sleep(INTERNAL_LAYOUT_SETTLE_MS);
        // Keep focus on the main pane
        await tmuxSelectPane(this.mainPaneId);
        this.triggerMainProcessRedraw();
      } else {
        await this.applyExternalLayout(serverName);
        await this.sleep(EXTERNAL_LAYOUT_SETTLE_MS);
      }

      const agentPane: TmuxAgentPane = {
        agentId,
        paneId,
        status: 'running',
        exitCode: 0,
      };

      this.panes.set(agentId, agentPane);
      this.agentOrder.push(agentId);

      // First agent becomes active
      if (this.activeAgentId === null) {
        this.activeAgentId = agentId;
      }

      // Start exit polling if not already running
      this.startExitPolling();

      debugLogger.info(
        `[spawnAgentAsync] Spawned agent "${agentId}" in pane ${paneId} — SUCCESS`,
      );
    } catch (error) {
      debugLogger.error(
        `[spawnAgentAsync] Failed to spawn agent "${agentId}":`,
        error,
      );
      // Still register the agent as failed so exit callback fires
      this.panes.set(agentId, {
        agentId,
        paneId: '',
        status: 'exited',
        exitCode: 1,
      });
      this.agentOrder.push(agentId);
      this.onExitCallback?.(agentId, 1, null);
    } finally {
      this.pendingSpawns--;
    }
  }

  /**
   * Trigger terminal redraw in main process after pane layout changes.
   * Uses multiple methods to ensure Ink picks up the new terminal size.
   */
  private triggerMainProcessRedraw(): void {
    if (!this.insideTmux) return;
    // Small delay to let tmux finish the resize operation
    setTimeout(() => {
      try {
        // Method 1: Emit resize event on stdout (Ink listens to this)
        if (process.stdout.isTTY) {
          process.stdout.emit('resize');
          debugLogger.info(
            '[triggerMainProcessRedraw] Emitted stdout resize event',
          );
        }

        // Method 2: Send SIGWINCH signal
        process.kill(process.pid, 'SIGWINCH');
        debugLogger.info('[triggerMainProcessRedraw] Sent SIGWINCH');
      } catch (error) {
        debugLogger.info(`[triggerMainProcessRedraw] Failed: ${error}`);
      }
    }, 100);
  }

  stopAgent(agentId: string): void {
    const pane = this.panes.get(agentId);
    if (!pane || pane.status !== 'running') return;
    // Kill the pane outright — a single Ctrl-C only cancels the current
    // turn in interactive CLI agents and does not reliably exit the process.
    if (pane.paneId) {
      void tmuxKillPane(pane.paneId, this.getServerName());
    }
    pane.status = 'exited';
    debugLogger.info(`Killed pane for agent "${agentId}"`);
  }

  stopAll(): void {
    for (const [agentId, pane] of this.panes.entries()) {
      if (pane.status === 'running') {
        if (pane.paneId) {
          void tmuxKillPane(pane.paneId, this.getServerName());
        }
        pane.status = 'exited';
        debugLogger.info(`Killed pane for agent "${agentId}"`);
      }
    }
  }

  async cleanup(): Promise<void> {
    this.cleanedUp = true;
    this.stopExitPolling();

    // Kill all agent panes (but not the main pane)
    for (const pane of this.panes.values()) {
      if (pane.paneId) {
        try {
          await tmuxKillPane(pane.paneId, this.getServerName());
          debugLogger.info(`Killed agent pane ${pane.paneId}`);
        } catch (_error) {
          // Pane may already be gone
          debugLogger.info(
            `Failed to kill pane ${pane.paneId} (may already be gone)`,
          );
        }
      }
    }

    // Kill the external tmux session/server if we created one
    if (!this.insideTmux && this.sessionName && this.serverName) {
      try {
        await tmuxKillSession(this.sessionName, this.serverName);
        debugLogger.info(
          `Killed external tmux session "${this.sessionName}" on server "${this.serverName}"`,
        );
      } catch (_error) {
        debugLogger.info(
          `Failed to kill external tmux session (may already be gone)`,
        );
      }
    }

    this.panes.clear();
    this.agentOrder = [];
    this.activeAgentId = null;
    this.serverName = null;
    this.sessionName = null;
    this.windowName = null;
    this.windowTarget = '';
    this.mainPaneId = '';
  }

  setOnAgentExit(callback: AgentExitCallback): void {
    this.onExitCallback = callback;
  }

  async waitForAll(timeoutMs?: number): Promise<boolean> {
    if (this.allExited() || this.cleanedUp) return this.allExited();

    return new Promise<boolean>((resolve) => {
      let timeoutHandle: NodeJS.Timeout | undefined;

      const checkInterval = setInterval(() => {
        if (this.allExited() || this.cleanedUp) {
          clearInterval(checkInterval);
          if (timeoutHandle) clearTimeout(timeoutHandle);
          resolve(this.allExited());
        }
      }, EXIT_POLL_INTERVAL_MS);

      if (timeoutMs !== undefined) {
        timeoutHandle = setTimeout(() => {
          clearInterval(checkInterval);
          resolve(false);
        }, timeoutMs);
      }
    });
  }

  // ─── Active Agent & Navigation ──────────────────────────────

  switchTo(agentId: string): void {
    if (!this.panes.has(agentId)) {
      throw new Error(`Agent "${agentId}" not found.`);
    }
    const pane = this.panes.get(agentId)!;
    this.activeAgentId = agentId;
    void tmuxSelectPane(pane.paneId, this.getServerName());
  }

  switchToNext(): void {
    if (this.agentOrder.length <= 1) return;
    const currentIndex = this.agentOrder.indexOf(this.activeAgentId ?? '');
    const nextIndex = (currentIndex + 1) % this.agentOrder.length;
    this.switchTo(this.agentOrder[nextIndex]!);
  }

  switchToPrevious(): void {
    if (this.agentOrder.length <= 1) return;
    const currentIndex = this.agentOrder.indexOf(this.activeAgentId ?? '');
    const prevIndex =
      (currentIndex - 1 + this.agentOrder.length) % this.agentOrder.length;
    this.switchTo(this.agentOrder[prevIndex]!);
  }

  getActiveAgentId(): string | null {
    return this.activeAgentId;
  }

  // ─── Screen Capture ─────────────────────────────────────────

  getActiveSnapshot(): AnsiOutput | null {
    if (!this.activeAgentId) return null;
    return this.getAgentSnapshot(this.activeAgentId);
  }

  getAgentSnapshot(
    agentId: string,
    _scrollOffset: number = 0,
  ): AnsiOutput | null {
    // tmux panes are rendered by tmux itself. capture-pane is available
    // but returns raw text. For the progress bar we don't need snapshots;
    // full rendering is handled by tmux directly.
    // Return null — the UI doesn't use snapshots for split-pane backends.
    return null;
  }

  getAgentScrollbackLength(_agentId: string): number {
    // Scrollback is managed by tmux, not by us
    return 0;
  }

  // ─── Input ──────────────────────────────────────────────────

  forwardInput(data: string): boolean {
    if (!this.activeAgentId) return false;
    return this.writeToAgent(this.activeAgentId, data);
  }

  writeToAgent(agentId: string, data: string): boolean {
    const pane = this.panes.get(agentId);
    if (!pane || pane.status !== 'running') return false;
    void tmuxSendKeys(
      pane.paneId,
      data,
      { literal: true },
      this.getServerName(),
    );
    return true;
  }

  // ─── Resize ─────────────────────────────────────────────────

  resizeAll(_cols: number, _rows: number): void {
    // tmux manages pane sizes automatically based on the terminal window
  }

  // ─── External Session Info ─────────────────────────────────

  getAttachHint(): string | null {
    if (this.insideTmux) {
      return null;
    }
    // When outside tmux, the server name is determined at init time
    // (per-process unique). Return the attach command even before
    // ensureExternalSession runs, since the server name is deterministic.
    const server = this.serverName ?? `${TMUX_SERVER_PREFIX}-${process.pid}`;
    return `tmux -L ${server} a`;
  }

  // ─── Private ────────────────────────────────────────────────

  private resolveTmuxOptions(config: AgentSpawnConfig): ResolvedTmuxOptions {
    const opts = config.backend?.tmux ?? {};
    return {
      serverName: opts.serverName ?? `${TMUX_SERVER_PREFIX}-${process.pid}`,
      sessionName: opts.sessionName ?? DEFAULT_TMUX_SESSION,
      windowName: opts.windowName ?? DEFAULT_TMUX_WINDOW,
      paneTitle: opts.paneTitle ?? config.agentId,
      paneBorderStyle: opts.paneBorderStyle,
      paneActiveBorderStyle: opts.paneActiveBorderStyle,
      paneBorderFormat: opts.paneBorderFormat ?? DEFAULT_PANE_BORDER_FORMAT,
      paneBorderStatus:
        opts.paneBorderStatus ?? (this.insideTmux ? undefined : 'top'),
      leaderPaneWidthPercent:
        opts.leaderPaneWidthPercent ?? DEFAULT_LEADER_WIDTH_PERCENT,
      firstSplitPercent: opts.firstSplitPercent ?? DEFAULT_FIRST_SPLIT_PERCENT,
    };
  }

  private getServerName(): string | undefined {
    return this.insideTmux ? undefined : (this.serverName ?? undefined);
  }

  private async ensureExternalSession(
    config: AgentSpawnConfig,
    options: ResolvedTmuxOptions,
  ): Promise<void> {
    if (
      this.windowTarget &&
      this.serverName &&
      this.sessionName &&
      this.windowName
    ) {
      return;
    }

    this.serverName = options.serverName;
    this.sessionName = options.sessionName;
    this.windowName = options.windowName;

    const serverName = this.serverName;
    const sessionExists = await tmuxHasSession(this.sessionName, serverName);

    if (!sessionExists) {
      await tmuxNewSession(
        this.sessionName,
        {
          cols: config.cols,
          rows: config.rows,
          windowName: this.windowName,
        },
        serverName,
      );
    }

    const windowExists = sessionExists
      ? await tmuxHasWindow(this.sessionName, this.windowName, serverName)
      : true;

    if (!windowExists) {
      await tmuxNewWindow(this.sessionName, this.windowName, serverName);
    }

    this.windowTarget = `${this.sessionName}:${this.windowName}`;

    if (!this.mainPaneId) {
      this.mainPaneId = await tmuxGetFirstPaneId(this.windowTarget, serverName);
    }
  }

  private async spawnInsideTmux(
    cmd: string,
    options: ResolvedTmuxOptions,
  ): Promise<string> {
    if (!this.windowTarget) {
      throw new Error('Tmux window target not initialized.');
    }

    const panes = await tmuxListPanes(this.windowTarget);
    const paneCount = panes.length;
    if (paneCount === 1) {
      debugLogger.info(
        `[spawnInsideTmux] First agent — split -h -l ${options.firstSplitPercent}% from ${this.mainPaneId}`,
      );
      return await tmuxSplitWindow(this.mainPaneId, {
        horizontal: true,
        percent: options.firstSplitPercent,
        command: cmd,
      });
    }

    const splitTarget = this.pickMiddlePane(panes).paneId;
    const horizontal = this.shouldSplitHorizontally(paneCount);
    debugLogger.info(
      `[spawnInsideTmux] Split from middle pane ${splitTarget} (${paneCount} panes, ${horizontal ? 'horizontal' : 'vertical'})`,
    );
    return await tmuxSplitWindow(splitTarget, {
      horizontal,
      command: cmd,
    });
  }

  private async spawnOutsideTmux(
    config: AgentSpawnConfig,
    cmd: string,
    options: ResolvedTmuxOptions,
  ): Promise<string> {
    await this.ensureExternalSession(config, options);
    if (!this.windowTarget) {
      throw new Error('External tmux window target not initialized.');
    }

    const serverName = this.getServerName();

    if (this.panes.size === 0) {
      const firstPaneId = await tmuxGetFirstPaneId(
        this.windowTarget,
        serverName,
      );
      this.mainPaneId = firstPaneId;
      debugLogger.info(
        `[spawnOutsideTmux] First agent — respawn in pane ${firstPaneId}`,
      );
      await tmuxRespawnPane(firstPaneId, cmd, serverName);
      return firstPaneId;
    }

    const panes = await tmuxListPanes(this.windowTarget, serverName);
    const splitTarget = this.pickMiddlePane(panes).paneId;
    const horizontal = this.shouldSplitHorizontally(panes.length);
    debugLogger.info(
      `[spawnOutsideTmux] Split from middle pane ${splitTarget} (${panes.length} panes, ${horizontal ? 'horizontal' : 'vertical'})`,
    );
    return await tmuxSplitWindow(
      splitTarget,
      { horizontal, command: cmd },
      serverName,
    );
  }

  private pickMiddlePane(panes: TmuxPaneInfo[]): TmuxPaneInfo {
    if (panes.length === 0) {
      throw new Error('No panes available to split.');
    }
    return panes[Math.floor(panes.length / 2)]!;
  }

  private shouldSplitHorizontally(paneCount: number): boolean {
    return paneCount % 2 === 1;
  }

  private async applyPaneDecorations(
    paneId: string,
    options: ResolvedTmuxOptions,
    serverName?: string,
  ): Promise<void> {
    if (!this.windowTarget) return;

    if (options.paneBorderStatus) {
      await tmuxSetOption(
        this.windowTarget,
        'pane-border-status',
        options.paneBorderStatus,
        serverName,
      );
    }

    if (options.paneBorderFormat) {
      await tmuxSetOption(
        this.windowTarget,
        'pane-border-format',
        options.paneBorderFormat,
        serverName,
      );
    }

    if (options.paneBorderStyle) {
      await tmuxSetOption(
        this.windowTarget,
        'pane-border-style',
        options.paneBorderStyle,
        serverName,
      );
      await tmuxSelectPaneStyle(paneId, options.paneBorderStyle, serverName);
    }

    if (options.paneActiveBorderStyle) {
      await tmuxSetOption(
        this.windowTarget,
        'pane-active-border-style',
        options.paneActiveBorderStyle,
        serverName,
      );
    }

    await tmuxSelectPaneTitle(paneId, options.paneTitle, serverName);
  }

  private async applyInsideLayout(options: ResolvedTmuxOptions): Promise<void> {
    if (!this.windowTarget || !this.mainPaneId) return;
    await tmuxSelectLayout(this.windowTarget, 'main-vertical');
    await tmuxResizePane(this.mainPaneId, {
      width: `${options.leaderPaneWidthPercent}%`,
    });
  }

  private async applyExternalLayout(serverName?: string): Promise<void> {
    if (!this.windowTarget) return;
    await tmuxSelectLayout(this.windowTarget, 'tiled', serverName);
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private buildShellCommand(config: AgentSpawnConfig): string {
    // Build env prefix + command + args
    const envParts: string[] = [];
    if (config.env) {
      for (const [key, value] of Object.entries(config.env)) {
        envParts.push(`${key}=${shellQuote(value)}`);
      }
    }

    const cmdParts = [
      shellQuote(config.command),
      ...config.args.map(shellQuote),
    ];

    // cd to the working directory first
    const parts = [`cd ${shellQuote(config.cwd)}`];
    if (envParts.length > 0) {
      parts.push(`env ${envParts.join(' ')} ${cmdParts.join(' ')}`);
    } else {
      parts.push(cmdParts.join(' '));
    }

    const fullCommand = parts.join(' && ');
    debugLogger.info(
      `[buildShellCommand] agentId=${config.agentId}, command=${config.command}, args=${JSON.stringify(config.args)}, cwd=${config.cwd}`,
    );
    debugLogger.info(`[buildShellCommand] full shell command: ${fullCommand}`);
    return fullCommand;
  }

  private allExited(): boolean {
    if (this.pendingSpawns > 0) return false;
    if (this.panes.size === 0) return true;
    for (const pane of this.panes.values()) {
      if (pane.status === 'running') return false;
    }
    return true;
  }

  private startExitPolling(): void {
    if (this.exitPollTimer) return;

    this.exitPollTimer = setInterval(() => {
      void this.pollPaneStatus();
    }, EXIT_POLL_INTERVAL_MS);
  }

  private stopExitPolling(): void {
    if (this.exitPollTimer) {
      clearInterval(this.exitPollTimer);
      this.exitPollTimer = null;
    }
  }

  private async pollPaneStatus(): Promise<void> {
    let paneInfos: TmuxPaneInfo[];
    const serverName = this.getServerName();
    try {
      if (!this.windowTarget) return;
      // List panes in the active window
      paneInfos = await tmuxListPanes(this.windowTarget, serverName);
    } catch (err) {
      // Window may have been killed externally
      debugLogger.info(
        `[pollPaneStatus] Failed to list panes for window "${this.windowTarget}": ${err}`,
      );
      return;
    }

    // Build a lookup: paneId → TmuxPaneInfo
    const paneMap = new Map<string, TmuxPaneInfo>();
    for (const info of paneInfos) {
      paneMap.set(info.paneId, info);
    }

    // Log all pane statuses for debugging (only when there are agent panes)
    if (this.panes.size > 0) {
      debugLogger.info(
        `[pollPaneStatus] paneCount=${paneInfos.length}, agentPanes=${JSON.stringify(
          Array.from(this.panes.values()).map((p) => {
            const info = paneMap.get(p.paneId);
            return {
              agentId: p.agentId,
              paneId: p.paneId,
              status: p.status,
              dead: info?.dead,
              deadStatus: info?.deadStatus,
            };
          }),
        )}`,
      );
    }

    for (const agent of this.panes.values()) {
      if (agent.status !== 'running') continue;

      const info = paneMap.get(agent.paneId);
      if (!info) {
        // Pane was killed externally — treat as exited
        agent.status = 'exited';
        agent.exitCode = 1;
        debugLogger.info(
          `[pollPaneStatus] Agent "${agent.agentId}" pane ${agent.paneId} not found in tmux list — marking as exited`,
        );
        this.onExitCallback?.(agent.agentId, 1, null);
        continue;
      }

      if (info.dead) {
        agent.status = 'exited';
        agent.exitCode = info.deadStatus;

        debugLogger.info(
          `[pollPaneStatus] Agent "${agent.agentId}" (pane ${agent.paneId}) detected as DEAD with exit code ${info.deadStatus}`,
        );

        this.onExitCallback?.(agent.agentId, info.deadStatus, null);
      }
    }

    // Stop polling if all agents have exited
    if (this.allExited()) {
      this.stopExitPolling();
    }
  }
}

/**
 * Simple shell quoting for building command strings.
 * Wraps value in single quotes, escaping any internal single quotes.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
