#!/usr/bin/env bun
/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Rewrites packages/core/src/generated/embedded-assets-bun.ts so that
 * `bun build --compile` embeds policy and skill assets
 * into the resulting binary.
 *
 * Usage:
 *   bun run scripts/generate-embedded-assets.ts           # populate with assets
 *   bun run scripts/generate-embedded-assets.ts --assets=builtin-skills
 *   bun run scripts/generate-embedded-assets.ts --stub    # restore empty stub
 *
 * The stub form is seeded by generate-git-commit-info.js. bun-binary-compiler.ts
 * calls populateEmbeds() before Bun.build and restores stubs in a finally block
 * so dev/Vitest runs on Node never see Bun-specific `with` attributes.
 */

import { readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeAssetManifest } from './runtime_asset_manifest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const target = path.join(
  root,
  'packages/core/src/generated/embedded-assets-bun.ts',
);
const targetDir = path.dirname(target);

const HEADER = `/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// This file is rewritten in-place by scripts/generate-embedded-assets.ts
// during the Bun bundle step, which adds \`import ... with { type: 'file' }\`
// statements so that \`bun build --compile\` embeds each asset into the final
// binary. After the build completes, bun-binary-compiler.ts restores this stub
// so the file stays Node/Vitest-safe in dev and tests.
//
// Keys are repo-relative paths (the third argument to resolveRuntimeAssetPath);
// values are absolute paths that Bun resolves to /$bunfs/... at runtime.
`;

const STUB_BODY = `export const EMBEDDED_ASSETS: Readonly<Record<string, string>> = {};
`;

type AssetDir = {
  /** Absolute path to the source directory. */
  abs: string;
  /** Repo-relative path (matches the third arg of resolveRuntimeAssetPath). */
  repoRel: string;
  /** Optional filter: only include files whose basename matches. */
  filter?: (basename: string) => boolean;
  /** Recurse into subdirectories. */
  recursive: boolean;
};

function walk(dir: AssetDir): string[] {
  const out: string[] = [];
  function visit(abs: string) {
    let entries: string[];
    try {
      entries = readdirSync(abs);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = path.join(abs, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (dir.recursive) visit(full);
        continue;
      }
      if (dir.filter && !dir.filter(name)) continue;
      out.push(full);
    }
  }
  visit(dir.abs);
  return out;
}

function relKeyFor(dir: AssetDir, absFile: string): string {
  const relFromAbs = path.relative(dir.abs, absFile);
  // Normalise to forward slashes so the key matches repoRelativePath callers
  // pass into resolveRuntimeAssetPath (which is always POSIX-style).
  return `${dir.repoRel}/${relFromAbs.split(path.sep).join('/')}`;
}

function importPathFor(absFile: string): string {
  const rel = path.relative(targetDir, absFile).split(path.sep).join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

async function populate() {
  const assetArg = process.argv.find((arg) => arg.startsWith('--assets='));
  const assetIds = assetArg?.slice('--assets='.length).split(',');
  const assets = assetIds
    ? runtimeAssetManifest.filter((entry) => assetIds.includes(entry.id))
    : runtimeAssetManifest;

  const imports: string[] = [];
  const entries: string[] = [];
  let counter = 0;
  for (const entry of assets) {
    const dir: AssetDir = {
      abs: path.join(root, entry.sourceRel ?? entry.repoRel),
      repoRel: entry.repoRel,
      filter: entry.include,
      recursive: entry.recursive,
    };
    const files = walk(dir).sort();
    for (const abs of files) {
      const binding = `a${counter++}`;
      const importPath = importPathFor(abs);
      const key = relKeyFor(dir, abs);
      imports.push(
        `import ${binding} from '${importPath}' with { type: 'file' };`,
      );
      entries.push(`  ${JSON.stringify(key)}: ${binding},`);
    }
  }

  const body =
    imports.length === 0
      ? STUB_BODY
      : `${imports.join('\n')}\n\nexport const EMBEDDED_ASSETS: Readonly<Record<string, string>> = {\n${entries.join('\n')}\n};\n`;

  writeFileSync(target, HEADER + '\n' + body);
  console.log(
    `embedded-assets-bun.ts: populated with ${imports.length} asset(s).`,
  );
}

function stub() {
  writeFileSync(target, HEADER + '\n' + STUB_BODY);
  console.log('embedded-assets-bun.ts: restored stub.');
}

const mode = process.argv.includes('--stub') ? 'stub' : 'populate';
if (mode === 'stub') {
  stub();
} else {
  await populate();
}
