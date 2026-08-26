#!/usr/bin/env node
/**
 * Brand creation script for the Tauri desktop shell.
 *
 * Patches packages/desktop-shell so a branded desktop app can be built from
 * a minimal brand.json. Replaces the Electron-era brand-create.ts that was
 * removed together with packages/desktop.
 *
 * Usage:
 *   node brand-create.mjs --shell-root /path/to/packages/desktop-shell \
 *     --config /path/to/brand.json
 *
 * Requires Node >= 18. No external dependencies.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const BRAND_ID_RE = /^[a-z][a-z0-9-]*$/;
const USAGE =
  'Usage: node brand-create.mjs --shell-root /path/to/packages/desktop-shell --config /path/to/brand.json';

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function fail(message) {
  console.error(`brand-create: ${message}`);
  process.exit(1);
}

function shellRootFromArgs() {
  const value = argValue('--shell-root');
  if (!value) fail(USAGE);
  const shellRoot = resolve(value);
  if (!existsSync(join(shellRoot, 'src-tauri', 'tauri.conf.json'))) {
    fail(`desktop-shell package not found: ${shellRoot}`);
  }
  return shellRoot;
}

// Common acronyms that should be fully capitalized in derived names.
const ACRONYMS = new Set(['ai', 'api', 'cli', 'ide', 'sdk', 'ui', 'url']);

function titleWords(brandId) {
  return brandId
    .split('-')
    .filter(Boolean)
    .map((part) =>
      ACRONYMS.has(part) ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1),
    );
}

function deriveAppId(website, brandId) {
  if (website) {
    try {
      const withProtocol = website.includes('://')
        ? website
        : `https://${website}`;
      const host = new URL(withProtocol).hostname.replace(/^www\./, '');
      const parts = host.split('.').filter(Boolean);
      if (parts.length >= 2) {
        return `${parts.reverse().join('.')}.desktop`;
      }
    } catch {
      // Fall through to the deterministic fallback.
    }
  }
  return `app.${brandId}.desktop`;
}

function loadConfig(path) {
  let input;
  try {
    input = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`cannot read brand config ${path}: ${error.message}`);
  }

  const brandId = input.brandId?.trim();
  const logo = input.logo ? resolve(input.logo) : undefined;

  if (!brandId || !BRAND_ID_RE.test(brandId)) {
    fail(`brandId must match ${BRAND_ID_RE}`);
  }
  if (!logo || !existsSync(logo)) {
    fail(`logo must be an existing file path, got: ${input.logo}`);
  }

  const words = titleWords(brandId);
  return {
    brandId,
    logo,
    website: input.website?.trim() || undefined,
    appName: input.appName?.trim() || words.join(' '),
    appId: input.appId?.trim() || deriveAppId(input.website, brandId),
    artifactPrefix: input.artifactPrefix?.trim() || words.join('-'),
    updaterEndpoints: Array.isArray(input.updaterEndpoints)
      ? input.updaterEndpoints
      : [],
  };
}

function patchTauriConfig(shellRoot, brand) {
  const configPath = join(shellRoot, 'src-tauri', 'tauri.conf.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));

  config.productName = brand.appName;
  config.identifier = brand.appId;
  if (config.bundle) {
    config.bundle.shortDescription = `${brand.appName} desktop shell for the Qwen Code Web Shell`;
  }
  // A branded build must never poll the official updater feed, and the
  // official feed must never update a branded build. Empty endpoints
  // disable in-app updates unless the brand supplies its own feed.
  if (config.plugins?.updater) {
    config.plugins.updater.endpoints = brand.updaterEndpoints;
  }

  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return configPath;
}

function generateIcons(shellRoot, brand) {
  const result = spawnSync(
    'npx',
    ['--yes', '@tauri-apps/cli', 'icon', brand.logo],
    { cwd: shellRoot, stdio: 'inherit' },
  );
  if (result.status === 0) {
    return 'regenerated via tauri icon';
  }
  // Fallback: keep the build moving but flag that only icon.png changed.
  const logoExt = extname(brand.logo).toLowerCase();
  if (logoExt === '.png') {
    copyFileSync(brand.logo, join(shellRoot, 'src-tauri', 'icons', 'icon.png'));
  }
  console.warn(
    'brand-create: WARNING: `tauri icon` failed; only icons/icon.png was ' +
      'replaced (other sizes still show the Qwen Code logo). Regenerate ' +
      'with: npx --yes @tauri-apps/cli icon <logo>',
  );
  return 'fallback: icon.png only';
}

function patchBootstrap(shellRoot, brand) {
  const bootstrapDir = join(shellRoot, 'bootstrap');
  const logoExt = extname(brand.logo).toLowerCase() || '.png';
  const brandLogoName = `brand-logo${logoExt}`;
  copyFileSync(brand.logo, join(bootstrapDir, brandLogoName));

  const patched = [];
  for (const file of ['index.html', 'bootstrap.js']) {
    const filePath = join(bootstrapDir, file);
    if (!existsSync(filePath)) continue;
    let text = readFileSync(filePath, 'utf8');
    const before = text;
    text = text.replaceAll('Qwen Code', brand.appName);
    if (file === 'index.html') {
      text = text.replaceAll('qwen-code-logo.svg', brandLogoName);
    }
    if (text !== before) {
      writeFileSync(filePath, text);
      patched.push(file);
    }
  }
  return patched;
}

function main() {
  const configPath = argValue('--config');
  if (!configPath) fail(USAGE);
  const shellRoot = shellRootFromArgs();
  const brand = loadConfig(resolve(configPath));

  const configPathPatched = patchTauriConfig(shellRoot, brand);
  const iconResult = generateIcons(shellRoot, brand);
  const bootstrapFiles = patchBootstrap(shellRoot, brand);

  console.log(
    JSON.stringify(
      {
        brandId: brand.brandId,
        appName: brand.appName,
        appId: brand.appId,
        artifactPrefix: brand.artifactPrefix,
        updaterEndpoints: brand.updaterEndpoints,
        tauriConfig: configPathPatched,
        icons: iconResult,
        bootstrapPatched: bootstrapFiles,
      },
      null,
      2,
    ),
  );
}

main();
