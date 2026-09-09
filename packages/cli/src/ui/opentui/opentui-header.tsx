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
import { C } from './theme.js';
import { shortAsciiLogo } from '../components/AsciiArt.js';
import { getAsciiArtWidth, getCachedStringWidth } from '../utils/textUtils.js';
import {
  pickAsciiArtTier,
  resolveCustomBanner,
} from '../utils/customBanner.js';

const LOGO_GRADIENT = ['#4796E4', '#847ACE', '#C3677F'];

function lerpHex(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return (
    '#' +
    pa
      .map((v, i) =>
        Math.round(v + (pb[i] - v) * t)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}

function gradientAt(stops: string[], t: number): string {
  if (stops.length === 0) return C.accent;
  if (stops.length === 1) return stops[0];
  const seg = Math.min(stops.length - 1, Math.floor(t * (stops.length - 1)));
  const lt = t * (stops.length - 1) - seg;
  return lerpHex(stops[seg], stops[seg + 1], lt);
}

/** ASCII logo with the original horizontal gradient (themes GradientColors). */
function GradientLogo({ logo }: { logo: string }) {
  const lines = logo.replace(/^\n/, '').split('\n');
  const w = Math.max(...lines.map((l) => [...l].length), 1);
  return (
    <box flexDirection="column" flexShrink={0}>
      {lines.map((line, li) => (
        <box key={li} flexDirection="row">
          {[...line].map((ch, ci) => (
            <text key={ci} fg={gradientAt(LOGO_GRADIENT, ci / w)}>
              {ch}
            </text>
          ))}
        </box>
      ))}
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
    [showBanner, config, settings, width],
  );
  return banner;
}
