#!/usr/bin/env node
// .fork/rewrite-package-identity.js
//
// Reads manifest.json and rewrites package.json name + publishConfig
// across all workspace packages. Idempotent in both directions.
//
// Usage:
//   node .fork/rewrite-package-identity.js           # apply fork identity
//   node .fork/rewrite-package-identity.js --reverse  # restore upstream identity

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.join(__dirname, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

const reverse = process.argv.includes('--reverse');
const dryRun = process.argv.includes('--dry-run');

const { registry, mappings, excludeRegistry = [] } = manifest.packageIdentity;
const excludeSet = new Set(excludeRegistry);
let changed = 0;

function getUpstreamName(pkgPath) {
  try {
    const raw = execFileSync('git', ['show', `upstream/main:${pkgPath}`], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return JSON.parse(raw).name;
  } catch {
    return null;
  }
}

// Detect indentation used in the file (defaults to 2 spaces)
function detectIndent(raw) {
  const match = raw.match(/^(\s+)"/m);
  return match ? match[1] : '  ';
}

for (const [pkgPath, forkName] of Object.entries(mappings)) {
  const fullPath = path.resolve(pkgPath);
  if (!fs.existsSync(fullPath)) {
    console.warn(`SKIP: ${pkgPath} (not found)`);
    continue;
  }

  const raw = fs.readFileSync(fullPath, 'utf-8');
  const pkg = JSON.parse(raw);
  const indent = detectIndent(raw);
  const originalName = pkg.name;

  if (reverse) {
    const upstreamName = pkg._upstreamName || getUpstreamName(pkgPath);
    if (!upstreamName) {
      console.error(`ERROR: cannot determine upstream name for ${pkgPath} (no _upstreamName field and git show upstream/main:${pkgPath} failed)`);
      process.exit(1);
    }
    if (pkg.name !== upstreamName) {
      pkg.name = upstreamName;

      // Remove publishConfig.registry if it matches our fork registry
      if (pkg.publishConfig?.registry === registry) {
        delete pkg.publishConfig.registry;
        if (Object.keys(pkg.publishConfig).length === 0) {
          delete pkg.publishConfig;
        }
      }

      // Remove _upstreamName helper field
      delete pkg._upstreamName;

      const updated = JSON.stringify(pkg, null, indent) + '\n';
      if (updated !== raw) {
        if (dryRun) {
          console.log(`WOULD: ${pkgPath}  ${originalName} → ${upstreamName}`);
        } else {
          fs.writeFileSync(fullPath, updated);
          console.log(`RESTORE: ${pkgPath}  ${originalName} → ${upstreamName}`);
        }
        changed++;
      }
    }
  } else {
    let modified = false;

    if (pkg.name !== forkName) {
      pkg.name = forkName;
      modified = true;
    }

    // Add publishConfig.registry if not present (skip excluded packages)
    if (
      !excludeSet.has(pkgPath) &&
      (!pkg.publishConfig?.registry || pkg.publishConfig.registry !== registry)
    ) {
      if (!pkg.publishConfig) {
        pkg.publishConfig = {};
      }
      pkg.publishConfig.registry = registry;
      modified = true;
    }

    if (modified) {
      const updated = JSON.stringify(pkg, null, indent) + '\n';
      if (dryRun) {
        console.log(`WOULD: ${pkgPath}  ${originalName} → ${forkName}`);
      } else {
        fs.writeFileSync(fullPath, updated);
        console.log(`REWRITE: ${pkgPath}  ${originalName} → ${forkName}`);
      }
      changed++;
    }
  }
}

console.log(`\n${reverse ? 'Restored' : 'Rewrote'} ${changed} package(s)`);
