/**
 * Centralized branding configuration.
 *
 * Supports multiple brand presets (e.g. "qwen-code", "openwork").
 * Select at runtime via the CRAFT_BRAND environment variable.
 * Default: "qwen-code" (backward-compatible).
 */

// ---------------------------------------------------------------------------
// Brand config type
// ---------------------------------------------------------------------------

export interface BrandConfig {
  /** Internal identifier */
  id: string;
  /** User-visible application name */
  appName: string;
  /** macOS/Windows/Linux bundle identifier */
  appId: string;
  /** electron-builder productName */
  productName: string;
  /** Artifact file-name prefix (no spaces) */
  artifactPrefix: string;
  /** Copyright line */
  copyright: string;
  /** Git co-author line inserted into commits */
  coAuthorLine: string;
  /** Name the assistant uses to refer to itself in prompts */
  selfReferName: string;
  /** Session viewer base URL */
  viewerUrl: string;
  /** Stable desktop auto-update source for packaged app builds. */
  updates?: {
    provider: 'github';
    owner: string;
    repo: string;
    releasePageUrl: string;
  };
  /** Brand-owned external links shown in the Help menu */
  helpMenuLinks: Array<{ labelKey: string; url: string; icon: string }>;
  /** Brand-specific Electron resource paths, relative to apps/electron/ */
  assets: {
    /** Folder containing app icons and other brand-owned assets */
    resourceDir: string;
    /** Renderer logo/symbol asset */
    rendererSymbol: string;
    /** macOS app and DMG icon */
    macIcon: string;
    /** Windows installer/app icon */
    winIcon: string;
    /** Linux AppImage icon */
    linuxIcon: string;
    /** Optional macOS development Dock icon PNG */
    devDockIcon?: string;
    /** Optional SVG source icon for regeneration workflows */
    iconSvg?: string;
    /** Optional macOS 26+ Liquid Glass compiled icon asset */
    liquidGlassAssetsCar?: string;
  };
  /** Multi-line credits text shown in the About panel */
  credits: string;
  /** One-line credits summary */
  creditsShort: string;
  /** Structured credits for custom About dialog */
  creditsEntries: Array<{ name: string; role: string; url: string }>;
}

// ---------------------------------------------------------------------------
// Brand presets
// ---------------------------------------------------------------------------

const QWEN_CODE_BRAND: BrandConfig = {
  id: 'qwen-code',
  appName: 'Qwen Code Desktop',
  appId: 'com.alibaba.qwen-code',
  productName: 'Qwen Code Desktop',
  artifactPrefix: 'Qwen-Code-Desktop',
  copyright: 'Copyright © 2026 Alibaba Group.',
  coAuthorLine: 'Co-Authored-By: Qwen Code <agents-noreply@craft.do>',
  selfReferName: 'Qwen Code',
  viewerUrl: 'https://agents.craft.do',
  updates: {
    provider: 'github',
    owner: 'QwenLM',
    repo: 'qwen-code',
    releasePageUrl: 'https://github.com/QwenLM/qwen-code/releases',
  },
  helpMenuLinks: [
    {
      labelKey: 'menu.homepage',
      url: 'https://qwen.ai/qwencode',
      icon: 'House',
    },
  ],
  assets: {
    resourceDir: 'resources/brands/qwen-code',
    rendererSymbol: 'resources/brands/qwen-code/icon.svg',
    macIcon: 'resources/brands/qwen-code/icon.icns',
    winIcon: 'resources/brands/qwen-code/icon.ico',
    linuxIcon: 'resources/brands/qwen-code/icon.png',
    devDockIcon: 'resources/brands/qwen-code/dock.png',
    iconSvg: 'resources/brands/qwen-code/icon.svg',
    liquidGlassAssetsCar: 'resources/brands/qwen-code/Assets.car',
  },
  credits: '',
  creditsShort: '',
  creditsEntries: [],
};

const BRANDS: Record<string, BrandConfig> = {
  'qwen-code': QWEN_CODE_BRAND,
  openwork: {
    id: 'openwork',
    appName: 'OpenWork',
    appId: 'com.alibaba.openwork',
    productName: 'OpenWork',
    artifactPrefix: 'OpenWork',
    copyright: 'Copyright © 2026 Alibaba Group.',
    coAuthorLine: 'Co-Authored-By: OpenWork <noreply@alibaba.com>',
    selfReferName: 'OpenWork',
    viewerUrl: 'https://agents.craft.do',
    updates: {
      provider: 'github',
      owner: 'modelstudioai',
      repo: 'openwork',
      releasePageUrl: 'https://github.com/modelstudioai/openwork/releases',
    },
    helpMenuLinks: [
      {
        labelKey: 'menu.homepage',
        url: 'https://github.com/modelstudioai/openwork',
        icon: 'House',
      },
    ],
    assets: {
      resourceDir: 'resources/brands/openwork',
      rendererSymbol: 'resources/brands/openwork/symbol.png',
      macIcon: 'resources/brands/openwork/icon.icns',
      winIcon: 'resources/brands/openwork/icon.png',
      linuxIcon: 'resources/brands/openwork/icon.png',
      devDockIcon: 'resources/brands/openwork/dock.png',
      liquidGlassAssetsCar: 'resources/brands/openwork/Assets.car',
    },
    credits: 'Architecture: craft-agents-oss | Agent: Qwen Code',
    creditsShort: 'Based on craft-agents-oss & Qwen Code',
    creditsEntries: [
      {
        name: 'Qwen Code',
        role: 'AI Agent Engine',
        url: 'https://github.com/QwenLM/qwen-code',
      },
      {
        name: 'Craft Agents OSS',
        role: 'Desktop Architecture',
        url: 'https://github.com/craft-ai-agents/craft-agents-oss',
      },
    ],
  },
};

/** Active brand, selected by CRAFT_BRAND env var (default: "qwen-code"). */
export const BRAND: BrandConfig =
  BRANDS[process.env.CRAFT_BRAND || 'qwen-code'] ?? QWEN_CODE_BRAND;

// ---------------------------------------------------------------------------
// App version (renderer-safe — avoids the version barrel which pulls in Node deps)
// ---------------------------------------------------------------------------

import pkg from '../package.json';

/** Application version from package.json (safe for renderer/browser use). */
export const APP_VERSION: string = pkg.version;

// ---------------------------------------------------------------------------
// Legacy exports (unchanged, still used by OAuth callback pages etc.)
// ---------------------------------------------------------------------------

export const CRAFT_LOGO = [
  '  ████████ █████████    ██████   ██████████ ██████████',
  '██████████ ██████████ ██████████ █████████  ██████████',
  '██████     ██████████ ██████████ ████████   ██████████',
  '██████████ ████████   ██████████ ███████      ██████  ',
  '  ████████ ████  ████ ████  ████ █████        ██████  ',
] as const;

/** Logo as a single string for HTML templates */
export const CRAFT_LOGO_HTML = CRAFT_LOGO.map((line) => line.trimEnd()).join(
  '\n',
);

/** Session viewer base URL */
export const VIEWER_URL = BRAND.viewerUrl;
