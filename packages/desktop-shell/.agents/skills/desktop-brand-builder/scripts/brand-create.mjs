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
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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
  if (!logo || !existsSync(logo) || !statSync(logo).isFile()) {
    fail(`logo must be an existing file path, got: ${input.logo}`);
  }
  const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.svg', '.ico', '.webp']);
  const logoExt = extname(logo).toLowerCase();
  if (!IMAGE_EXTS.has(logoExt)) {
    fail(`logo must be an image file (.png/.jpg/.jpeg/.svg/.ico/.webp), got: ${input.logo}`);
  }

  const updaterEndpoints = Array.isArray(input.updaterEndpoints)
    ? input.updaterEndpoints
    : [];
  const updaterPubkey = input.updaterPubkey?.trim() || undefined;

  // When a brand supplies its own updater feed it MUST also supply the
  // matching signing pubkey. Using the official pubkey with a custom feed
  // (or no pubkey at all) would silently break in-app updates: the
  // updater verifies signatures against this key, so a mismatch means
  // every update check fails verification and the app can never update.
  if (updaterEndpoints.length > 0 && !updaterPubkey) {
    fail(
      'updaterEndpoints is non-empty but updaterPubkey is missing. ' +
        'Provide the base64 public key that matches your ' +
        'TAURI_SIGNING_PRIVATE_KEY so the updater can verify your feed.',
    );
  }

  const words = titleWords(brandId);
  const appName = input.appName?.trim() || words.join(' ');

  // The single-use guard (detectAlreadyBranded) keys on productName
  // changing away from the pristine default. If the brand's appName
  // equals that default, the guard never fires on run 1, so run 2
  // proceeds and doubles brand strings in bootstrap files. Reject this
  // at load time so the error is clear and no files are mutated.
  if (appName === 'Qwen Code Desktop') {
    fail(
      'appName must not be "Qwen Code Desktop" — that is the pristine ' +
        'shell default and would defeat the re-run guard. Choose a ' +
        'distinct name or use a different brandId.',
    );
  }

  return {
    brandId,
    logo,
    website: input.website?.trim() || undefined,
    appName,
    appId: input.appId?.trim() || deriveAppId(input.website, brandId),
    artifactPrefix: input.artifactPrefix?.trim() || words.join('-'),
    updaterEndpoints,
    updaterPubkey,
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
  // When endpoints are cleared we must also disable createUpdaterArtifacts
  // and remove the official pubkey so the Tauri bundler does not attempt
  // to produce signed updater artifacts that no feed will serve.
  if (config.plugins?.updater) {
    config.plugins.updater.endpoints = brand.updaterEndpoints;
    if (brand.updaterEndpoints.length === 0) {
      // Keep pubkey as an empty string rather than deleting it: the
      // tauri-plugin-updater schema declares `pubkey: String` with no
      // serde default, so removing the field causes deserialization to
      // fail at startup. An empty string is harmless when endpoints is
      // also empty (no update check will run).
      config.plugins.updater.pubkey = '';
    } else if (brand.updaterPubkey) {
      // A brand supplying its own feed must pair it with the matching
      // signing pubkey. loadConfig enforces this invariant.
      config.plugins.updater.pubkey = brand.updaterPubkey;
    }
  }
  if (brand.updaterEndpoints.length === 0 && config.bundle) {
    config.bundle.createUpdaterArtifacts = false;
  }

  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return configPath;
}

function resolveTauriCli(shellRoot) {
  // Resolve the Tauri CLI entry point directly so the logo path never
  // passes through a command interpreter. This eliminates shell injection
  // via crafted filenames (e.g. $(cmd) or `cmd` in the path).
  try {
    const require = createRequire(join(shellRoot, 'package.json'));
    return require.resolve('@tauri-apps/cli/tauri.js');
  } catch {
    return null;
  }
}

function generateIcons(shellRoot, brand) {
  // Invoke the Tauri CLI directly via Node so the logo path is passed as
  // a plain argv element — no shell interpretation, no quoting games.
  const tauriCli = resolveTauriCli(shellRoot);
  const result = tauriCli
    ? spawnSync(
        process.execPath,
        [tauriCli, 'icon', brand.logo],
        { cwd: shellRoot, stdio: 'inherit' },
      )
    : spawnSync(
        'npx',
        ['--yes', '@tauri-apps/cli', 'icon', brand.logo],
        { cwd: shellRoot, stdio: 'inherit' },
      );
  if (result.status === 0) {
    return 'regenerated via tauri icon';
  }
  // Fallback: keep the build moving but report what actually happened.
  const logoExt = extname(brand.logo).toLowerCase();
  if (logoExt === '.png') {
    copyFileSync(brand.logo, join(shellRoot, 'src-tauri', 'icons', 'icon.png'));
    console.warn(
      'brand-create: WARNING: `tauri icon` failed; only icons/icon.png was ' +
        'replaced (other sizes still show the Qwen Code logo). Regenerate ' +
        'with: npx --yes @tauri-apps/cli icon <logo>',
    );
    return 'fallback: icon.png only';
  }
  // Non-PNG logo and tauri icon failed — nothing was replaced.
  console.warn(
    `brand-create: WARNING: \`tauri icon\` failed and the logo is not PNG ` +
      `(${logoExt}); no icon files were replaced. Convert the logo to PNG ` +
      `and re-run: npx --yes @tauri-apps/cli icon <logo>`,
  );
  return 'fallback: no icons replaced';
}

function patchBootstrap(shellRoot, brand) {
  const bootstrapDir = join(shellRoot, 'bootstrap');
  const logoExt = extname(brand.logo).toLowerCase() || '.png';
  const brandLogoName = `brand-logo${logoExt}`;
  copyFileSync(brand.logo, join(bootstrapDir, brandLogoName));

  // Build content safe to splice into the single-quoted JS string literals
  // of bootstrap.js. JSON.stringify escapes backslashes, newlines and other
  // control characters, not just quotes; then strip the surrounding double
  // quotes and escape single quotes for the single-quoted context. Escaping
  // single quotes alone is insufficient: an appName ending in a backslash
  // (e.g. "Bob's App\") would otherwise escape the literal's closing quote.
  const appNameJsSafe = JSON.stringify(brand.appName)
    .slice(1, -1)
    .replace(/'/g, "\\'");

  const patched = [];
  for (const file of ['index.html', 'bootstrap.js']) {
    const filePath = join(bootstrapDir, file);
    if (!existsSync(filePath)) continue;
    let text = readFileSync(filePath, 'utf8');
    const before = text;
    // Use function replacers to avoid `$` pattern interpretation
    // (e.g. `$&` in the replacement string would expand to the matched text).
    if (file === 'bootstrap.js') {
      // JS file: appName appears inside single-quoted string literals,
      // so it must be fully JS-literal-escaped (quotes, backslashes,
      // newlines); see appNameJsSafe above.
      text = text.replaceAll('Qwen Code', () => appNameJsSafe);
    } else {
      text = text.replaceAll('Qwen Code', () => brand.appName);
    }
    if (file === 'index.html') {
      text = text.replaceAll('qwen-code-logo.svg', () => brandLogoName);
    }
    if (text !== before) {
      writeFileSync(filePath, text);
      patched.push(file);
    }
  }
  return patched;
}

function detectAlreadyBranded(shellRoot) {
  const configPath = join(shellRoot, 'src-tauri', 'tauri.conf.json');
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    // The pristine shell always ships productName === 'Qwen Code Desktop'.
    // If it has already been changed, this tree was branded before and
    // re-running would produce stale results (bootstrap patches key on
    // the original literals, pubkey/endpoints mutations are not reversible).
    return config.productName && config.productName !== 'Qwen Code Desktop';
  } catch {
    return false;
  }
}

function main() {
  const configPath = argValue('--config');
  if (!configPath) fail(USAGE);
  const shellRoot = shellRootFromArgs();

  if (detectAlreadyBranded(shellRoot)) {
    fail(
      'this shell-root appears to be already branded (productName is no ' +
        'longer "Qwen Code Desktop"). brand-create is not idempotent — ' +
        'start from a fresh clone for each brand.',
    );
  }

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
