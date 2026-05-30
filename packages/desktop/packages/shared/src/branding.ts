/**
 * Centralized branding configuration.
 *
 * Supports multiple brand presets (e.g. "qwen-code", "modelstudio").
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
  credits: '',
  creditsShort: '',
  creditsEntries: [],
};

const BRANDS: Record<string, BrandConfig> = {
  'qwen-code': QWEN_CODE_BRAND,
  modelstudio: {
    id: 'modelstudio',
    appName: 'ModelStudio Desktop',
    appId: 'com.alibaba.modelstudio-desktop',
    productName: 'ModelStudio Desktop',
    artifactPrefix: 'ModelStudio-Desktop',
    copyright: 'Copyright © 2026 Alibaba Group.',
    coAuthorLine: 'Co-Authored-By: ModelStudio Desktop <noreply@alibaba.com>',
    selfReferName: 'ModelStudio Desktop',
    viewerUrl: 'https://agents.craft.do',
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
