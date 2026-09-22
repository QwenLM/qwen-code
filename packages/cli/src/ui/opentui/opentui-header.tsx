/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenTUI header banner — visual-parity restore of the ink `AppHeader`/`Header`
 * (ASCII logo + info panel), ported back from the pre-batch
 * `feat/opentui-migrate` implementation that the batched merge dropped.
 *
 * Stable by construction: depends only on config/settings/width, so it does not
 * re-render on streaming; resize re-renders without flicker via the erase-free
 * painter. Honours the same custom-banner resolution as ink (hideBanner /
 * customAsciiArt / customBannerTitle / customBannerSubtitle) and suppresses in
 * screen-reader mode.
 */

import { useMemo } from 'react';
import { useTerminalDimensions } from '@opentui/react';
import type { Config } from '@qwen-code/qwen-code-core';
import {
  findProviderByCredentials,
  resolveMetadataKey,
  shortenPath,
  tildeifyPath,
} from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import { formatVersionLabel } from '../../utils/version.js';
import { C, GRADIENT, THEME_REVISION } from './theme.js';
import { shortAsciiLogo } from '../components/AsciiArt.js';
import { getAsciiArtWidth, getCachedStringWidth } from '../utils/textUtils.js';
import {
  pickAsciiArtTier,
  resolveCustomBanner,
} from '../utils/customBanner.js';

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function rgbToHex(rgb: readonly number[]): string {
  return (
    '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
  );
}

/**
 * One line of the wordmark, sampled the way ink samples it. `ink-gradient`
 * wraps ink's `Transform`, which runs `gradient.multiline()` per laid-out
 * line, so each line builds its own `tinygradient.rgb(steps)`: the segments
 * between stops get `round((steps - 1) / segments)` substeps, rebalanced
 * until they sum to `steps - 1`, and each segment then steps from its own
 * start. Sharing one ramp across lines, or lerping on a plain
 * `t = i / (len - 1)`, drifts a unit or two per channel and leaves a shorter
 * line one step short of the last stop.
 */
function lineRamp(stops: string[], steps: number): string[] {
  const rgb = stops.map(hexToRgb);
  const segments = rgb.length - 1;
  const substeps = Array.from({ length: segments }, () =>
    Math.max(1, Math.round((steps - 1) / segments)),
  );
  let total = substeps.reduce((sum, n) => sum + n, 1);
  while (total !== steps) {
    const grow = total < steps;
    const target = grow ? Math.min(...substeps) : Math.max(...substeps);
    substeps[substeps.indexOf(target)] += grow ? 1 : -1;
    total += grow ? 1 : -1;
  }
  const ramp: string[] = [];
  for (let s = 0; s < segments; s++) {
    const from = rgb[s];
    const to = rgb[s + 1];
    const n = substeps[s];
    ramp.push(rgbToHex(from));
    for (let i = 1; i < n; i++) {
      ramp.push(rgbToHex(from.map((v, k) => ((to[k] - v) / n) * i + v)));
    }
  }
  ramp.push(rgbToHex(rgb[segments]));
  return ramp;
}

/** ASCII logo with the active theme's horizontal gradient (ink `ui.gradient`). */
function GradientLogo({ logo }: { logo: string }) {
  const stops = GRADIENT;
  const lines = logo.replace(/^\n/, '').split('\n');
  return (
    <box flexDirection="column" flexShrink={0}>
      {lines.map((line, li) => {
        const chars = [...line];
        const ramp =
          stops.length >= 2
            ? lineRamp(stops, Math.max(chars.length, stops.length))
            : [];
        return (
          <box key={li} flexDirection="row">
            {chars.map((ch, ci) => (
              <text key={ci} fg={ramp[ci]}>
                {ch}
              </text>
            ))}
          </box>
        );
      })}
    </box>
  );
}

/**
 * Faithful port of the ink `Header`: a single-border info panel with 4 lines —
 * title(+version), blank spacer (or subtitle), auth|model(+hint), directory —
 * laid out two-column (gradient logo + panel) when wide, panel-only when
 * narrow. Same data sources as the original, including the AppHeader
 * custom-banner resolution.
 */
function buildBanner(config: Config, settings: LoadedSettings, width: number) {
  const versionLabel = formatVersionLabel(config.getCliVersion() ?? 'unknown');
  const cg = config.getContentGeneratorConfig();
  const model = config.getModelDisplayName();
  const targetDir = config.getTargetDir();
  // auth label (mirrors AppHeader.getAuthDisplayType)
  let authLabel = '';
  try {
    if (cg?.authType) {
      const matched = findProviderByCredentials(cg.baseUrl, cg.apiKeyEnvKey);
      authLabel =
        (matched && resolveMetadataKey(matched) && matched.label) ||
        (cg.authType === 'qwen-oauth' ? 'Qwen OAuth' : 'API Key');
    }
  } catch {
    authLabel = '';
  }
  const authModelText = authLabel ? `${authLabel} | ${model}` : model;
  const hint = ' (/model to change)';

  const custom = resolveCustomBanner(settings);
  const containerMarginX = 2;
  const logoGap = 2;
  const infoPanelChromeWidth = 2 + 1 * 2; // border(2) + paddingX(1*2)
  const minInfoPanelWidth = 40 + infoPanelChromeWidth;
  const available = Math.max(0, width - containerMarginX * 2);
  // ink Header parity: a fitting custom tier wins; custom art that fits
  // nowhere hides the logo column (no silent fallback to the bundled logo —
  // that would undo a white-label deployment on narrow terminals); no custom
  // art falls through to the bundled shortAsciiLogo.
  const hasCustomArt = Boolean(custom.asciiArt.small || custom.asciiArt.large);
  const customTier = pickAsciiArtTier(
    custom.asciiArt.small,
    custom.asciiArt.large,
    available,
    logoGap,
    minInfoPanelWidth,
    getAsciiArtWidth,
  );
  const displayLogo = customTier ?? (hasCustomArt ? '' : shortAsciiLogo);
  const logoWidth = getAsciiArtWidth(displayLogo);
  const showLogo =
    displayLogo !== '' && available >= logoWidth + logoGap + minInfoPanelWidth;
  const maxInfoPanelWidth = 60;
  const infoPanelWidth = showLogo
    ? Math.min(available - logoWidth - logoGap, maxInfoPanelWidth)
    : available;
  const maxPathLength = Math.max(0, infoPanelWidth - infoPanelChromeWidth);
  const infoPanelContentWidth = Math.max(
    0,
    infoPanelWidth - infoPanelChromeWidth,
  );
  const showModelHint =
    infoPanelContentWidth > 0 &&
    getCachedStringWidth(authModelText + hint) <= infoPanelContentWidth;
  const shortenedPath = shortenPath(
    tildeifyPath(targetDir),
    Math.max(3, maxPathLength),
  );
  const displayPath =
    maxPathLength <= 0
      ? ''
      : shortenedPath.length > maxPathLength
        ? shortenedPath.slice(0, maxPathLength)
        : shortenedPath;

  const infoPanel = (
    <box
      flexDirection="column"
      borderStyle="single"
      borderColor={C.borderDefault}
      paddingX={1}
      width={infoPanelWidth}
      flexGrow={showLogo ? 0 : 1}
    >
      <box flexDirection="row">
        <text fg={C.accent} attributes={1}>
          {custom.title ?? '>_ Qwen Code'}
        </text>
        <text fg={C.dim}>{` (${versionLabel})`}</text>
      </box>
      {/* Subtitle (when set) replaces the blank spacer row so the auth line
       * keeps its vertical position (ink Header parity). */}
      {custom.subtitle ? (
        <text fg={C.dim}>{custom.subtitle}</text>
      ) : (
        <text> </text>
      )}
      <box flexDirection="row">
        <text fg={C.dim}>{authModelText}</text>
        {showModelHint && <text fg={C.dim}>{hint}</text>}
      </box>
      <text fg={C.dim}>{displayPath}</text>
    </box>
  );

  if (!showLogo) {
    return (
      <box
        marginLeft={containerMarginX}
        marginRight={containerMarginX}
        flexShrink={0}
      >
        {infoPanel}
      </box>
    );
  }
  return (
    <box
      flexDirection="row"
      alignItems="center"
      marginLeft={containerMarginX}
      marginRight={containerMarginX}
      flexShrink={0}
    >
      <GradientLogo logo={displayLogo} />
      <box width={logoGap} />
      {infoPanel}
    </box>
  );
}

export interface OpenTuiBannerProps {
  config: Config;
  settings: LoadedSettings;
}

/**
 * Renders the header banner, or nothing when suppressed (screen-reader mode or
 * `ui.hideBanner`). Memoized on its inputs so streaming does not re-render it.
 */
export function OpenTuiBanner({ config, settings }: OpenTuiBannerProps) {
  const { width } = useTerminalDimensions();
  const showBanner =
    !config.getScreenReader() && !settings.merged.ui?.hideBanner;
  const banner = useMemo(
    () => (showBanner ? buildBanner(config, settings, width) : null),
    // The palette is mutated in place and `settings` keeps its identity when
    // `/theme` writes it, so the revision is the only dep that sees a repaint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [showBanner, config, settings, width, THEME_REVISION],
  );
  return banner;
}
