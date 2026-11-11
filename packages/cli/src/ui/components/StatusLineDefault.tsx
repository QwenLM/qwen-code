/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { I18nService } from '@qwen-code/core';

import type React from 'react';
import { useReducer, useEffect } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import {
  getDisplayString,
  shortenPath,
  tildeifyPath,
  calculateTokenWarningStateForContextWindow,
  getRawContextWindowSize,
  getSummaryReserveTokens,
  uiTelemetryService,
  type Model,
} from '@qwen-code/core';
import { useUIState } from '../contexts/UIStateContext.js';
import { useConfig, useModel } from '../contexts/ConfigContext.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { useVimMode } from '../contexts/VimModeContext.js';
import { useSessionStats } from '../contexts/SessionContext.js';
import type { formatEffortLabel } from '../utils/reasoningEffort.js';
import { formatContextWindowLabel } from '../utils/contextWindow.js';
import { useI18nService } from '../i18n/index.js';
import { getCachedStringWidth } from '../utils/textUtils.js';

/**
 * Resolves a theme color for Ink's `<Text color={…}>` prop.
 * Some themes (e.g. ANSI) use `''` for "default terminal foreground".
 * Ink cannot handle an empty string — pass `undefined` instead so it
 * falls back to the terminal's native foreground colour.
 */
function resolveColor(color: string | undefined): string | undefined {
  return color && color.length > 0 ? color : undefined;
}

/**
 * Map of natural-language color names (and common aliases) to Ink-compatible
 * color values.  Users can write e.g. `"colors": { "model": "ocean blue" }`
 * or `"model": "scarlet"` in settings.json and it Just Works™.
 *
 * The lookup is case-insensitive and ignores leading/trailing whitespace.
 * If the value is already a valid CSS hex (`#abc123`), `rgb(…)`, or a bare
 * ANSI name recognised by Ink (`red`, `cyan`, …) it is returned as-is.
 */
const NATURAL_COLOR_MAP: Record<string, string> = {
  // Direct ANSI names — kept for completeness so the map is authoritative
  red: 'red',
  green: 'green',
  yellow: 'yellow',
  blue: 'blue',
  magenta: 'magenta',
  cyan: 'cyan',
  white: 'white',
  black: 'black',
  gray: 'gray',
  grey: 'gray',

  // Bright variants
  'bright red': 'redBright',
  'bright green': 'greenBright',
  'bright yellow': 'yellowBright',
  'bright blue': 'blueBright',
  'bright magenta': 'magentaBright',
  'bright cyan': 'cyanBright',
  'bright white': 'whiteBright',
  'light red': 'redBright',
  'light green': 'greenBright',
  'light yellow': 'yellowBright',
  'light blue': 'blueBright',
  'light magenta': 'magentaBright',
  'light cyan': 'cyanBright',

  // Natural-language aliases
  orange: '#ff8800',
  coral: '#ff6f61',
  salmon: '#fa8072',
  scarlet: '#ff2400',
  crimson: '#dc143c',
  pink: '#ff69b4',
  hotpink: '#ff69b4',
  'hot pink': '#ff69b4',
  rose: '#ff007f',
  fuchsia: 'magenta',
  purple: '#800080',
  violet: '#8b00ff',
  lavender: '#b57edc',
  indigo: '#4b0082',
  navy: '#000080',
  'sky blue': '#87ceeb',
  'ocean blue': '#0077be',
  teal: '#008080',
  aqua: 'cyan',
  mint: '#98ff98',
  lime: '#32cd32',
  olive: '#808000',
  forest: '#228b22',
  'forest green': '#228b22',
  gold: '#ffd700',
  amber: '#ffbf00',
  bronze: '#cd7f32',
  brown: '#8b4513',
  chocolate: '#d2691e',
  tan: '#d2b48c',
  beige: '#f5f5dc',
  peach: '#ffdab9',
  ivory: '#fffff0',
  silver: '#c0c0c0',
  charcoal: '#36454f',
  slate: '#708090',
};

/**
 * Resolve a user-supplied color string, which may be:
 *   1. A natural-language name ("ocean blue", "scarlet")
 *   2. A CSS hex color ("#ff6600")
 *   3. An `rgb(r,g,b)` string
 *   4. A bare Ink/ANSI name ("red", "cyanBright")
 *   5. Empty / undefined → returns `undefined` (use theme default)
 */
function resolveNaturalColor(raw: string | undefined): string | undefined {
  if (!raw || raw.length === 0) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;

  // Already a hex colour or rgb(…) — pass through
  if (trimmed.startsWith('#') || trimmed.startsWith('rgb(')) {
    return trimmed;
  }

  const key = trimmed.toLowerCase();
  return NATURAL_COLOR_MAP[key] ?? trimmed; // fall through to Ink as-is
}

/**
 * Resolve the effective model ID, falling back to the server default model
 * when the current model is empty (for example after settings change during
 * an active session).
 */
function resolveModelId(listed: Model | undefined, model: string): string {
  return model || listed?.key || model;
}

/** 默认状态栏只展示模型名，不附加内部 provider 标识。 */
function getStatusLineModelLabel(
  listed: Model | undefined,
  model: string,
  t: I18nService['get'],
): string {
  const displayName = listed?.displayName ?? getDisplayString(listed, model);
  return t('status.modelSuffix', { model: displayName });
}

function getReasoningEffortStatusLabel(
  listed: Model | undefined,
  effort: Parameters<typeof formatEffortLabel>[0] | undefined,
  t: I18nService['get'],
): string | undefined {
  if (!effort) return undefined;
  if (
    listed &&
    !listed.capabilities.reasoning.supportedEfforts.includes(effort)
  ) {
    return undefined;
  }
  return effort === 'none'
    ? t('status.effortDisabled')
    : t(
        (
          {
            low: 'models.effort.low.label',
            medium: 'models.effort.medium.label',
            high: 'models.effort.high.label',
            xhigh: 'models.effort.xhigh.label',
            max: 'models.effort.max.label',
          } as const
        )[effort],
      );
}

const SEP = ' \u00b7 '; // " · "
const SEP_WIDTH = 3;

/**
 * A segment to potentially render in the status line.
 * Mandatory segments are always included; optional segments are dropped
 * right-to-left when the terminal is too narrow (priority-based truncation).
 */
interface StatusLineSegment {
  id: string;
  /** Character width of this segment's text content. */
  width: number;
  /** If true, this segment is always included regardless of available width. */
  mandatory: boolean;
  /** Render the segment's React nodes. */
  render: () => React.ReactNode;
}

/**
 * Built-in default status line renderer.
 *
 * Displays: `model · workspace · +N -N`
 *
 * Features:
 * - Text colors follow the active theme by default
 * - Users can override individual segment colors via `statusLine.colors`
 * - Lower-priority segments are dropped when terminal width is insufficient
 *   (footer-style priority-based truncation)
 */
const StatusLineDefaultInner: React.FC = () => {
  const i18n = useI18nService();
  const uiState = useUIState();
  const config = useConfig();
  const settings = useSettings();
  const { vimEnabled, vimMode } = useVimMode();
  const { stats: sessionStats } = useSessionStats();

  // Force re-render via useReducer — immune to React's same-value bailout.
  // Read the token count directly from the singleton on every render.
  const [, forceRender] = useReducer((c: number) => c + 1, 0);
  useEffect(() => {
    const handler = () => {
      forceRender();
    };
    uiTelemetryService.on('update', handler);
    return () => {
      uiTelemetryService.off('update', handler);
    };
  }, []);
  // Always read the latest value synchronously from the singleton —
  // this is guaranteed fresh because the 'update' event fires AFTER the
  // value is written.
  const promptTokenCount = uiTelemetryService.getLastPromptTokenCount();

  const listed = useModel(config, uiState.currentModel);
  const model = resolveModelId(listed, uiState.currentModel);
  const targetDir = config.getTargetDir();
  const terminalWidth = uiState.terminalWidth;
  const added = sessionStats.metrics.files.totalLinesAdded;
  const removed = sessionStats.metrics.files.totalLinesRemoved;

  // Context window usage — promptTokenCount is updated via direct event
  // subscription above (guaranteed fresh on every API response).
  const contextWindowSize = getRawContextWindowSize(
    listed,
    config.getEffectiveContextWindow(listed, model),
  );
  const usedPercentage =
    contextWindowSize > 0
      ? Math.round((promptTokenCount / contextWindowSize) * 100)
      : 0;
  const warningContextWindowSize = Math.max(
    0,
    contextWindowSize - getSummaryReserveTokens(listed),
  );

  // User-customizable colors — empty string means "use theme default".
  // `resolveNaturalColor` converts natural-language names ("ocean blue",
  // "scarlet") and passes hex/rgb values through. An empty/undefined value
  // falls back to `resolveColor(theme.text.secondary)`.
  const customColors = settings.merged.statusLine.colors;
  const modelColor =
    resolveNaturalColor(customColors.model) ??
    resolveColor(theme.text.secondary);
  const workspaceColor =
    resolveNaturalColor(customColors.branch) ??
    resolveColor(theme.text.secondary);
  const separatorColor =
    resolveNaturalColor(customColors.separator) ??
    resolveColor(theme.text.secondary);

  // --- Build segments in render order ---
  const segments: StatusLineSegment[] = [];

  // Vim mode indicator (system-level, mandatory when active)
  if (vimEnabled && vimMode) {
    const vimStr = `[${vimMode}]`;
    segments.push({
      id: 'vim',
      width: vimStr.length,
      mandatory: true,
      render: () => (
        <Text color={resolveColor(theme.text.secondary)}>{vimStr}</Text>
      ),
    });
  }

  // Model name — mandatory, always shown
  const modelBase = getStatusLineModelLabel(listed, model, i18n.get);
  const contextWindowLabel =
    uiState.currentContextWindow !== undefined
      ? formatContextWindowLabel(uiState.currentContextWindow)
      : undefined;
  const modelStr = [
    modelBase,
    getReasoningEffortStatusLabel(
      listed,
      uiState.currentReasoningEffort,
      i18n.get,
    ),
    contextWindowLabel,
  ]
    .filter((part): part is string => part !== undefined)
    .join(' · ');
  segments.push({
    id: 'model',
    width: getCachedStringWidth(modelStr),
    mandatory: true,
    render: () => <Text color={modelColor}>{modelStr}</Text>,
  });

  // Context window usage progress bar — optional, shown before workspace
  {
    const BAR_WIDTH = 10;
    const rawFilled = Math.round((usedPercentage / 100) * BAR_WIDTH);
    const filled = Math.max(0, Math.min(rawFilled, BAR_WIDTH));
    const empty = BAR_WIDTH - filled;
    const barFilled = '\u2593'.repeat(filled); // ▓
    const barEmpty = '\u2591'.repeat(empty); // ░
    const pctStr = `${usedPercentage}%`;
    const ctxStr = `${i18n.get('status.contextPrefix')} ${barFilled}${barEmpty} ${pctStr}`;
    // Color follows the same warning ladder as ContextUsageDisplay
    const warningState = calculateTokenWarningStateForContextWindow(
      promptTokenCount,
      warningContextWindowSize,
    );
    let ctxColor: string | undefined = resolveColor(theme.text.secondary);
    if (warningState.isAtBlockingLimit || warningState.isAboveErrorThreshold) {
      ctxColor = resolveColor(theme.status.error);
    } else if (warningState.isAboveWarningThreshold) {
      ctxColor = resolveColor(theme.status.warning);
    }
    segments.push({
      id: 'context',
      width: getCachedStringWidth(ctxStr),
      mandatory: false,
      render: () => <Text color={ctxColor}>{ctxStr}</Text>,
    });
  }

  // Workspace — optional, dropped first when terminal is narrow.
  // Dynamically compute the max path length based on remaining terminal width
  // after mandatory segments (vim, model) and their separators.
  const available = terminalWidth - 2; // paddingX={1} each side
  let mandatoryUsed = getCachedStringWidth(modelStr);
  if (vimEnabled && vimMode) {
    mandatoryUsed += `[${vimMode}]`.length + SEP_WIDTH;
  }
  const changesReserve =
    added > 0 || removed > 0 ? SEP_WIDTH + `+${added} -${removed}`.length : 0;
  const dynamicWorkspaceMax = Math.max(
    10,
    available - mandatoryUsed - SEP_WIDTH - changesReserve,
  );
  const workspacePath = shortenPath(
    tildeifyPath(targetDir),
    dynamicWorkspaceMax,
  );
  segments.push({
    id: 'workspace',
    width: workspacePath.length,
    mandatory: false,
    render: () => <Text color={workspaceColor}>{workspacePath}</Text>,
  });

  // Code changes — optional, lowest priority
  if (added > 0 || removed > 0) {
    const changeWidth = `+${added} -${removed}`.length;
    segments.push({
      id: 'changes',
      width: changeWidth,
      mandatory: false,
      render: () => (
        <Text>
          <Text color={resolveColor(theme.status.success)}>+{added}</Text>
          <Text> </Text>
          <Text color={resolveColor(theme.status.error)}>-{removed}</Text>
        </Text>
      ),
    });
  }

  // --- Priority-based width fitting ---
  // Mandatory segments are always included.
  // Optional segments are included left-to-right only if they fit.
  // (available = terminalWidth - 2, already computed above)
  const included: StatusLineSegment[] = [];
  let usedWidth = 0;

  for (const seg of segments) {
    const gap = included.length > 0 ? SEP_WIDTH : 0;
    if (seg.mandatory || usedWidth + gap + seg.width <= available) {
      included.push(seg);
      usedWidth += gap + seg.width;
    }
  }

  if (included.length === 0) return null;

  return (
    <Box paddingX={1}>
      <Text wrap="truncate">
        {included.map((seg, idx) => (
          <Text key={seg.id}>
            {idx > 0 && <Text color={separatorColor}>{SEP}</Text>}
            {seg.render()}
          </Text>
        ))}
      </Text>
    </Box>
  );
};

export const StatusLineDefault = StatusLineDefaultInner;
