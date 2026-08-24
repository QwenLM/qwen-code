/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandContext, SlashCommand } from './types.js';
import { CommandKind } from './types.js';
import type { HistoryItemDoctor } from '../types.js';
import { runDoctorChecks } from './doctorChecks.js';
import {
  collectMemoryPressureSamples,
  formatMemoryDiagnostics,
  formatMemoryPressureSamples,
  getMemoryDiagnostics,
  isHighHeapPressure,
  writeMemoryHeapSnapshot,
} from '../../utils/memoryDiagnostics.js';
import {
  isCpuProfileRecording,
  startCpuProfile,
  stopCpuProfile,
} from '../../utils/cpuProfiler.js';
import { rollbackStandaloneUpdate } from '../standalone-update.js';
import { getInstallationInfo } from '../../utils/installationInfo.js';
import { t } from '../../i18n/index.js';
import {
  collectMemoryDiagnostics,
  analyzeToolResultRetention,
  canonicalToolName,
  COMBINED_PASS_TOLERANCE_FACTOR,
  createDebugLogger,
  resolveSlimmingConfig,
  ToolDisplayNamesMigration,
  type MemoryDiagnostics,
  type ToolResultRetentionStats,
} from '@qwen-code/qwen-code-core';
import { formatMemoryUsage } from '../utils/formatters.js';

const debugLogger = createDebugLogger('DOCTOR_MEMORY');

const MEMORY_SUBCOMMAND = 'memory';
const CPU_PROFILE_SUBCOMMAND = 'cpu-profile';
const ROLLBACK_SUBCOMMAND = 'rollback';
const DOCTOR_SUBCOMMANDS = [
  MEMORY_SUBCOMMAND,
  CPU_PROFILE_SUBCOMMAND,
  ROLLBACK_SUBCOMMAND,
] as const;
function getHeapSnapshotSensitiveDataWarning(): string {
  return t(
    'Heap snapshot may contain prompts, file contents, tool results, and other sensitive data. Do not share it publicly without reviewing it first.',
  );
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatHeapSnapshotErrorMessage(error: unknown): string {
  const message = formatErrorMessage(error);
  return message.startsWith('Heap snapshot')
    ? message
    : `${t('Heap snapshot failed:')} ${message}`;
}

export const doctorCommand: SlashCommand = {
  name: 'doctor',
  get description() {
    return t('Run installation and environment diagnostics');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  argumentHint:
    '[memory|cpu-profile|rollback] [--sample] [--snapshot] [--duration]',
  examples: [
    '/doctor',
    '/doctor memory',
    '/doctor memory --sample',
    '/doctor memory --snapshot',
    '/doctor cpu-profile',
    '/doctor cpu-profile --duration 10',
    '/doctor rollback',
  ],
  completion: async (_context, partialArg) => {
    const trimmed = partialArg.trimStart();
    return DOCTOR_SUBCOMMANDS.filter((candidate) =>
      candidate.startsWith(trimmed),
    );
  },
  action: async (context, args) => {
    const executionMode = context.executionMode ?? 'interactive';
    const abortSignal = context.abortSignal;
    const subCommandArgs =
      args?.trim().toLowerCase().split(/\s+/).filter(Boolean) ?? [];
    const subCommand = subCommandArgs[0] ?? '';
    const shouldWriteHeapSnapshot = subCommandArgs.includes('--snapshot');
    const shouldSampleMemory = subCommandArgs.includes('--sample');

    if (subCommand === ROLLBACK_SUBCOMMAND) {
      if (executionMode === 'acp') {
        return {
          type: 'message' as const,
          messageType: 'error' as const,
          content: t('Rollback is not available in ACP mode.'),
        };
      }
      return rollbackDoctorAction(context);
    }

    if (subCommand === MEMORY_SUBCOMMAND) {
      if (abortSignal?.aborted) {
        return;
      }

      const diagnostics = getMemoryDiagnostics();

      if (abortSignal?.aborted) {
        return;
      }

      let report = formatMemoryDiagnostics(diagnostics);
      const toolResultRetention = collectToolResultRetention(context);
      if (toolResultRetention) {
        report = `${report}\n\n${formatToolResultRetention(toolResultRetention)}`;
      }
      let messageType: 'info' | 'error' = 'info';
      let heapSnapshotWritten = false;

      if (abortSignal?.aborted) {
        return;
      }

      if (shouldSampleMemory) {
        const samples = await collectMemoryPressureSamples({
          sampleCount: 3,
          intervalMs: 1000,
          signal: abortSignal,
        });
        report = `${report}\n\n${formatMemoryPressureSamples(samples)}`;

        if (abortSignal?.aborted) {
          if (executionMode === 'interactive') {
            context.ui.addItem(
              {
                type: 'info',
                text: report,
              },
              Date.now(),
            );
            return;
          }

          return {
            type: 'message' as const,
            messageType: 'info' as const,
            content: report,
          };
        }
      }

      if (shouldWriteHeapSnapshot) {
        if (abortSignal?.aborted) {
          return;
        }

        if (executionMode === 'interactive') {
          context.ui.setPendingItem({
            type: 'info',
            text: t('Writing heap snapshot, this may take a moment...'),
          });
        }

        try {
          const latestDiagnostics = shouldSampleMemory
            ? getMemoryDiagnostics()
            : diagnostics;
          if (isHighHeapPressure(latestDiagnostics)) {
            throw new Error(
              t(
                'Heap snapshot skipped: V8 heap pressure is already high, and writing a synchronous heap snapshot could make the process unresponsive or trigger OOM. Restart Qwen Code first if it is unstable, or retry before memory pressure reaches the warning threshold.',
              ),
            );
          }

          const heapSnapshotPath = writeMemoryHeapSnapshot();
          heapSnapshotWritten = true;
          report = `${report}\n\n${t('Heap snapshot written:')} ${heapSnapshotPath}\n${getHeapSnapshotSensitiveDataWarning()}`;
        } catch (error) {
          messageType = 'error';
          report = `${report}\n\n${formatHeapSnapshotErrorMessage(error)}`;
        } finally {
          if (executionMode === 'interactive') {
            context.ui.setPendingItem(null);
          }
        }
      }

      if (
        abortSignal?.aborted &&
        shouldWriteHeapSnapshot &&
        !heapSnapshotWritten
      ) {
        return;
      }

      if (executionMode === 'interactive') {
        context.ui.addItem(
          {
            type: messageType === 'error' ? 'error' : 'info',
            text: report,
          },
          Date.now(),
        );
        return;
      }

      return {
        type: 'message' as const,
        messageType,
        content: report,
      };
    }

    if (subCommand === CPU_PROFILE_SUBCOMMAND) {
      return cpuProfileDoctorAction(context, subCommandArgs.slice(1).join(' '));
    }

    if (executionMode === 'interactive') {
      context.ui.setPendingItem({
        type: 'info',
        text: t('Running diagnostics...'),
      });
    }

    try {
      const checks = await runDoctorChecks(context);

      if (abortSignal?.aborted) {
        return;
      }

      const summary = {
        pass: checks.filter((c) => c.status === 'pass').length,
        warn: checks.filter((c) => c.status === 'warn').length,
        fail: checks.filter((c) => c.status === 'fail').length,
      };

      if (executionMode === 'interactive') {
        const doctorItem: Omit<HistoryItemDoctor, 'id'> = {
          type: 'doctor',
          checks,
          summary,
        };
        context.ui.addItem(doctorItem, Date.now());
        return;
      }

      return {
        type: 'message' as const,
        messageType: (summary.fail > 0 ? 'error' : 'info') as 'error' | 'info',
        content: JSON.stringify({ checks, summary }, null, 2),
      };
    } finally {
      if (executionMode === 'interactive') {
        context.ui.setPendingItem(null);
      }
    }
  },
  subCommands: [
    {
      name: 'memory',
      get description() {
        return t('Show current process memory diagnostics');
      },
      kind: CommandKind.BUILT_IN,
      supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
      argumentHint: '[--json] [--sample] [--snapshot]',
      action: memoryDoctorAction,
    },
    {
      name: 'cpu-profile',
      get description() {
        return t('Record a CPU profile for Chrome DevTools analysis');
      },
      kind: CommandKind.BUILT_IN,
      supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
      argumentHint: '[--duration <seconds>]',
      action: cpuProfileDoctorAction,
    },
    {
      name: 'rollback',
      get description() {
        return t('Roll back a standalone update to the previous version');
      },
      kind: CommandKind.BUILT_IN,
      supportedModes: ['interactive', 'non_interactive'] as const,
      action: rollbackDoctorAction,
    },
  ],
};

const MEMORY_USAGE_HINT = '/doctor memory [--json] [--sample] [--snapshot]';

async function memoryDoctorAction(context: CommandContext, args = '') {
  if (context.abortSignal?.aborted) {
    return;
  }

  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const unknown = tokens.filter(
    (token) =>
      token !== '--json' && token !== '--sample' && token !== '--snapshot',
  );
  if (unknown.length > 0) {
    return {
      type: 'message' as const,
      messageType: 'error' as const,
      content: `${t('Unknown argument(s)')}: ${unknown.join(', ')}. ${t('Usage')}: ${MEMORY_USAGE_HINT}`,
    };
  }

  const shouldSampleMemory = tokens.includes('--sample');
  const shouldWriteHeapSnapshot = tokens.includes('--snapshot');
  if (shouldSampleMemory || shouldWriteHeapSnapshot) {
    return doctorCommand.action?.(
      context,
      [MEMORY_SUBCOMMAND, ...tokens.filter((token) => token !== '--json')].join(
        ' ',
      ),
    );
  }

  try {
    const diagnostics = await collectMemoryDiagnostics({
      sessionId: context.services.config?.getSessionId(),
      qwenVersion: context.services.config?.getCliVersion(),
    });

    if (context.abortSignal?.aborted) {
      return;
    }

    const toolResultRetention = collectToolResultRetention(context);

    return {
      type: 'message' as const,
      messageType:
        diagnostics.analysis.risks.length > 0
          ? ('warning' as const)
          : ('info' as const),
      content: tokens.includes('--json')
        ? JSON.stringify(
            {
              ...diagnostics,
              ...(toolResultRetention ? { toolResultRetention } : {}),
            },
            null,
            2,
          )
        : formatCoreDiagnostics(diagnostics) +
          (toolResultRetention
            ? `\n\n${formatToolResultRetention(toolResultRetention)}`
            : ''),
    };
  } catch (error) {
    if (context.abortSignal?.aborted) {
      return;
    }

    return {
      type: 'message' as const,
      messageType: 'error' as const,
      content: `${t('Failed to collect memory diagnostics')}: ${formatErrorMessage(error)}`,
    };
  }
}

// resourceUsage CPU times are microseconds; convert to seconds for display.
function formatCpuMicroseconds(micros: number): string {
  return `${(micros / 1_000_000).toFixed(2)}s`;
}

function formatHeapSpaces(
  spaces: MemoryDiagnostics['v8HeapSpaces'],
): string | undefined {
  if (!spaces || spaces.length === 0) {
    return undefined;
  }
  const top = [...spaces].sort((a, b) => b.used - a.used).slice(0, 4);
  const lines = top.map(
    (space) =>
      `  - ${space.name}: used ${formatMemoryUsage(space.used)} / size ${formatMemoryUsage(space.size)}`,
  );
  if (spaces.length > top.length) {
    lines.push(`  - … ${spaces.length - top.length} more`);
  }
  return lines.join('\n');
}

function formatSmapsRollup(smapsRollup: string | null): string {
  if (!smapsRollup) {
    return t('unavailable');
  }

  const rssLine = smapsRollup
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .find((line) => line.startsWith('Rss:'));
  if (rssLine) {
    return rssLine;
  }

  const preview = smapsRollup.slice(0, 80).trim().replace(/\s+/g, ' ');
  return `${t('parse error')}: ${preview}`;
}

function formatCoreDiagnostics(diagnostics: MemoryDiagnostics): string {
  const risks =
    diagnostics.analysis.risks.length > 0
      ? diagnostics.analysis.risks
          .map((risk) => `  - ${risk.type}: ${risk.message}`)
          .join('\n')
      : `  ${t('none')}`;

  const lines: string[] = [
    t('Memory Diagnostics'),
    `timestamp: ${diagnostics.timestamp}`,
    `uptimeSeconds: ${diagnostics.uptimeSeconds.toFixed(1)}`,
    `heapUsed: ${formatMemoryUsage(diagnostics.memoryUsage.heapUsed)}`,
    `heapTotal: ${formatMemoryUsage(diagnostics.memoryUsage.heapTotal)}`,
    `rss: ${formatMemoryUsage(diagnostics.memoryUsage.rss)}`,
    `external: ${formatMemoryUsage(diagnostics.memoryUsage.external)}`,
    `arrayBuffers: ${formatMemoryUsage(diagnostics.memoryUsage.arrayBuffers)}`,
    `v8HeapLimit: ${formatMemoryUsage(diagnostics.v8HeapStats.heapSizeLimit)}`,
    `v8MallocedMemory: ${formatMemoryUsage(diagnostics.v8HeapStats.mallocedMemory)}`,
    `v8PeakMallocedMemory: ${formatMemoryUsage(diagnostics.v8HeapStats.peakMallocedMemory)}`,
    `detachedContexts: ${diagnostics.v8HeapStats.detachedContexts}`,
    `nativeContexts: ${diagnostics.v8HeapStats.nativeContexts}`,
    `maxRSS: ${formatMemoryUsage(diagnostics.resourceUsage.maxRSS)}`,
    `userCPUTime: ${formatCpuMicroseconds(diagnostics.resourceUsage.userCPUTime)}`,
    `systemCPUTime: ${formatCpuMicroseconds(diagnostics.resourceUsage.systemCPUTime)}`,
    `activeHandles: ${diagnostics.activeHandles}`,
    `activeRequests: ${diagnostics.activeRequests}`,
    `openFileDescriptors: ${diagnostics.openFileDescriptors ?? t('unavailable')}`,
    `smapsRollup: ${formatSmapsRollup(diagnostics.smapsRollup)}`,
  ];

  const heapSpaces = formatHeapSpaces(diagnostics.v8HeapSpaces);
  if (heapSpaces) {
    lines.push('v8HeapSpaces:', heapSpaces);
  }

  lines.push(
    'risks:',
    risks,
    `recommendation: ${diagnostics.analysis.recommendation}`,
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tool result retention diagnostics (issue #4184, phase 1)
// ---------------------------------------------------------------------------

interface ToolResultRetentionReport extends ToolResultRetentionStats {
  /** Tool outputs rendered in UI history above their tool's budget. */
  largeOutputsInUIHistory: number;
  /** Whether oversized results in live history are fed to compression input. */
  presentInCompressionInput: boolean;
}

function collectToolResultRetention(
  context: CommandContext,
): ToolResultRetentionReport | null {
  try {
    const config = context.services.config;
    const history = config?.getGeminiClient()?.getHistoryShallow();
    if (!history) {
      return null;
    }
    // History records raw request names (legacy aliases like `task`), while
    // the registry is keyed by canonical names — canonicalize before lookup.
    const resolveToolBudgetChars = (name: string): number | undefined =>
      config?.getToolRegistry?.()?.getTool(canonicalToolName(name))
        ?.maxOutputChars;
    // UI history stores display names (e.g. 'Shell'), not registry keys (e.g.
    // 'run_shell_command'), so getTool(displayName) returns undefined. Build a
    // display-name → budget map from the registry to bridge the gap.
    const displayNameBudgets = new Map<string, number | undefined>();
    for (const tool of config?.getToolRegistry?.()?.getAllTools() ?? []) {
      if (tool.displayName) {
        displayNameBudgets.set(tool.displayName, tool.maxOutputChars);
      }
    }
    const stats = analyzeToolResultRetention(history, {
      // Compare each result against its own tool's declared budget (mirroring
      // the scheduler), so compliant high-budget results (e.g. MCP) are not
      // flagged; tools declaring none fall back to the configured global
      // threshold — the bound the scheduler applies to them.
      resolveToolBudgetChars,
      thresholdChars: config?.getTruncateToolOutputThreshold?.(),
      imageTokenEstimate: resolveSlimmingConfig(config?.getChatCompression?.())
        .imageTokenEstimate,
    });
    const threshold =
      config?.getTruncateToolOutputThreshold?.() ??
      stats.oversizedThresholdChars;
    // Tool outputs live in `tool_group` items as `tools[].resultDisplay`
    // strings; scanning top-level text items would count model responses.
    // Each display is compared against its own tool's budget, matching the
    // API-history calibration.
    //
    // Phase-1 scope: only string `resultDisplay` values are measured.
    // Structured display objects (file diffs, ANSI captures, agent result
    // summaries) carry their own rendering contracts and are not
    // char-comparable in the same way; they are left for a follow-up PR.
    let largeOutputsInUIHistory = 0;
    for (const item of context.ui.history ?? []) {
      if (item.type !== 'tool_group') {
        continue;
      }
      for (const tool of item.tools) {
        if (typeof tool.resultDisplay !== 'string') {
          continue;
        }
        const migratedName =
          ToolDisplayNamesMigration[
            tool.name as keyof typeof ToolDisplayNamesMigration
          ] ?? tool.name;
        const budget =
          displayNameBudgets.get(tool.name) ??
          displayNameBudgets.get(migratedName) ??
          resolveToolBudgetChars(tool.name) ??
          threshold;
        if (
          Number.isFinite(budget) &&
          tool.resultDisplay.length > budget * COMBINED_PASS_TOLERANCE_FACTOR
        ) {
          largeOutputsInUIHistory += 1;
        }
      }
    }
    return {
      ...stats,
      largeOutputsInUIHistory,
      // Derived assumption: compression reads the live history by reference
      // (getHistoryShallow; see chatCompressionService). If compression input
      // assembly ever changes to copy or filter history, this derivation must
      // be revisited.
      presentInCompressionInput: stats.oversizedResultCount > 0,
    };
  } catch (error) {
    // Diagnostics must never break /doctor memory; degrade to "unavailable",
    // but leave a greppable trace so a silently dying section is debuggable.
    debugLogger.warn(
      `Tool result retention diagnostics unavailable: ${formatErrorMessage(error)}`,
    );
    return null;
  }
}

function formatToolResultRetention(stats: ToolResultRetentionReport): string {
  const lines = [
    'Tool result retention',
    `  Tool results in history: ${stats.toolResultCount}`,
    `  Total retained: ${stats.totalChars} chars`,
    `  Largest result: ${stats.largestResultChars} chars`,
    `  Oversized results (above tool budget): ${stats.oversizedResultCount}`,
    `  Oversized also rendered in UI history: ${stats.largeOutputsInUIHistory} item(s)`,
    `  Oversized also in compression input: ${stats.presentInCompressionInput ? 'yes (shared by reference, no extra copy)' : 'no'}`,
  ];
  if (stats.oversizedResultCount > 0) {
    lines.push(
      '  Hint: oversized tool results stay in context and tax every later turn; /compress can reclaim space.',
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// /doctor cpu-profile
// ---------------------------------------------------------------------------

const CPU_PROFILE_USAGE_HINT = '/doctor cpu-profile [--duration <seconds>]';
const DEFAULT_CPU_PROFILE_DURATION_SEC = 30;
const MAX_CPU_PROFILE_DURATION_SEC = 300;

function parseCpuProfileDuration(raw: string | undefined): number {
  if (!raw || !/^\d+$/.test(raw)) {
    return NaN;
  }
  return Number(raw);
}

async function cpuProfileDoctorAction(
  context: CommandContext,
  args = '',
): Promise<void | {
  type: 'message';
  messageType: 'info' | 'error';
  content: string;
}> {
  const executionMode = context.executionMode ?? 'interactive';
  const abortSignal = context.abortSignal;

  if (abortSignal?.aborted) return;

  const tokens = args.trim().split(/\s+/).filter(Boolean);

  // Parse --duration flag
  let durationSec = DEFAULT_CPU_PROFILE_DURATION_SEC;
  const durationIdx = tokens.indexOf('--duration');
  if (durationIdx !== -1) {
    const rawVal = tokens[durationIdx + 1];
    const val = parseCpuProfileDuration(rawVal);
    if (
      !Number.isFinite(val) ||
      val < 1 ||
      val > MAX_CPU_PROFILE_DURATION_SEC
    ) {
      const errorMsg = `${t('Duration must be between 1 and {max} seconds', { max: String(MAX_CPU_PROFILE_DURATION_SEC) })}. ${t('Usage')}: ${CPU_PROFILE_USAGE_HINT}`;
      if (executionMode === 'interactive') {
        context.ui.addItem({ type: 'error', text: errorMsg }, Date.now());
        return;
      }
      return { type: 'message', messageType: 'error', content: errorMsg };
    }
    durationSec = val;
  }

  // Validate unknown arguments
  const knownTokens = new Set(['--duration']);
  const unknown = tokens.filter((token, idx) => {
    if (knownTokens.has(token)) return false;
    // Skip the value after --duration
    if (idx > 0 && tokens[idx - 1] === '--duration') return false;
    return true;
  });
  if (unknown.length > 0) {
    const errorMsg = `${t('Unknown argument(s)')}: ${unknown.join(', ')}. ${t('Usage')}: ${CPU_PROFILE_USAGE_HINT}`;
    if (executionMode === 'interactive') {
      context.ui.addItem({ type: 'error', text: errorMsg }, Date.now());
      return;
    }
    return { type: 'message', messageType: 'error', content: errorMsg };
  }

  // Check if already recording
  if (isCpuProfileRecording()) {
    const errorMsg =
      process.platform === 'win32'
        ? t('CPU profiling is already in progress. Wait for it to complete.')
        : t(
            'CPU profiling is already in progress. Send SIGUSR1 or wait for it to complete.',
          );
    if (executionMode === 'interactive') {
      context.ui.addItem({ type: 'error', text: errorMsg }, Date.now());
      return;
    }
    return { type: 'message', messageType: 'error', content: errorMsg };
  }

  // Start recording
  const startResult = await startCpuProfile();
  if (!startResult.ok) {
    if (executionMode === 'interactive') {
      context.ui.addItem(
        { type: 'error', text: startResult.error },
        Date.now(),
      );
      return;
    }
    return {
      type: 'message',
      messageType: 'error',
      content: startResult.error,
    };
  }

  if (abortSignal?.aborted) {
    const abortResult = await stopCpuProfile();
    if (abortResult.ok) {
      const msg = t('CPU profile aborted early. Profile saved: {path}', {
        path: abortResult.filePath,
      });
      if (executionMode === 'interactive') {
        context.ui.addItem({ type: 'info', text: msg }, Date.now());
      }
    } else {
      const msg = `${t('CPU profile aborted but failed to stop cleanly')}: ${abortResult.error}`;
      if (executionMode === 'interactive') {
        context.ui.addItem({ type: 'error', text: msg }, Date.now());
      }
    }
    return;
  }

  // Show progress in interactive mode
  if (executionMode === 'interactive') {
    context.ui.setPendingItem({
      type: 'info',
      text: t('Recording CPU profile for {duration}s...', {
        duration: String(durationSec),
      }),
    });
  }

  // Wait for duration or abort. Timer is NOT unref'd so non-interactive
  // mode keeps the process alive for the full recording window.
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, durationSec * 1000);
    if (abortSignal) {
      abortSignal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    }
  });

  if (executionMode === 'interactive') {
    context.ui.setPendingItem(null);
  }

  // Stop and write profile. If profiler is no longer recording (e.g., SIGUSR1
  // stopped it during the wait), treat as success — the profile was already written.
  const stopResult = await stopCpuProfile();
  if (!stopResult.ok) {
    const alreadyStopped = stopResult.error.includes('not recording');
    if (alreadyStopped) {
      const infoMsg =
        process.platform === 'win32'
          ? t(
              'CPU profile was stopped externally. Check ~/.qwen/cpu-profiles/ for the output.',
            )
          : t(
              'CPU profile was stopped externally (e.g., via SIGUSR1). Check ~/.qwen/cpu-profiles/ for the output.',
            );
      if (executionMode === 'interactive') {
        context.ui.addItem({ type: 'info', text: infoMsg }, Date.now());
        return;
      }
      return { type: 'message', messageType: 'info', content: infoMsg };
    }
    if (executionMode === 'interactive') {
      context.ui.addItem({ type: 'error', text: stopResult.error }, Date.now());
      return;
    }
    return { type: 'message', messageType: 'error', content: stopResult.error };
  }

  const successMsg = `${t('CPU profile written:')} ${stopResult.filePath}\n${t('Open in Chrome DevTools → Performance tab → Load profile')}`;
  if (executionMode === 'interactive') {
    context.ui.addItem({ type: 'info', text: successMsg }, Date.now());
    return;
  }
  return { type: 'message', messageType: 'info', content: successMsg };
}

function rollbackDoctorAction(context: CommandContext) {
  const installInfo = getInstallationInfo(process.cwd(), false);
  if (!installInfo.isStandalone || !installInfo.standaloneDir) {
    const msg = t('Rollback is only available for standalone installations.');
    if (context.executionMode === 'interactive') {
      context.ui.addItem({ type: 'info', text: msg }, Date.now());
      return;
    }
    return {
      type: 'message' as const,
      messageType: 'info' as const,
      content: msg,
    };
  }

  if (process.platform === 'win32') {
    const winMsg = t(
      'Rollback on Windows requires manual intervention. Rename qwen-code.old to qwen-code in your installation directory.',
    );
    if (context.executionMode === 'interactive') {
      context.ui.addItem({ type: 'info', text: winMsg }, Date.now());
      return;
    }
    return {
      type: 'message' as const,
      messageType: 'info' as const,
      content: winMsg,
    };
  }

  const result = rollbackStandaloneUpdate(installInfo.standaloneDir);
  let msg: string;
  let messageType: 'info' | 'error';
  if (result.ok) {
    msg = t(
      'Rollback successful. Restart your terminal to use the previous version.',
    );
    messageType = 'info';
  } else {
    msg = `${t('Rollback failed:')} ${result.detail}`;
    messageType = 'error';
  }

  if (context.executionMode === 'interactive') {
    context.ui.addItem({ type: messageType, text: msg }, Date.now());
    return;
  }
  return {
    type: 'message' as const,
    messageType: messageType as 'info' | 'error',
    content: msg,
  };
}
