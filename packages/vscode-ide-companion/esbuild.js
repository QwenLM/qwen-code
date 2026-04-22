/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import esbuild from 'esbuild';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wasmLoader } from 'esbuild-plugin-wasm';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');
const rootRequire = createRequire(resolve(repoRoot, 'package.json'));

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: 'esbuild-problem-matcher',

  setup(build) {
    const isWatchMode = build.initialOptions.watch;
    build.onStart(() => {
      if (isWatchMode) {
        console.log('[watch] build started');
      }
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        console.error(
          `    ${location.file}:${location.line}:${location.column}:`,
        );
      });
      if (isWatchMode) {
        console.log('[watch] build finished');
      }
    });
  },
};

/**
 * Ensure a single React copy in the webview bundle by resolving from repo root.
 * Prevents mixing React 18/19 element types when nested node_modules exist.
 * @type {import('esbuild').Plugin}
 */
const resolveFromRoot = (moduleId) => {
  try {
    return rootRequire.resolve(moduleId);
  } catch {
    return null;
  }
};

const reactDedupPlugin = {
  name: 'react-dedup',
  setup(build) {
    const aliases = [
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
    ];

    for (const alias of aliases) {
      build.onResolve({ filter: new RegExp(`^${alias}$`) }, () => {
        const resolved = resolveFromRoot(alias);
        if (!resolved) {
          return undefined;
        }
        return { path: resolved };
      });
    }
  },
};

/**
 * Resolve `*.wasm?binary` imports to embedded Uint8Array content.
 * This keeps the companion bundle compatible with core's inline-WASM loader.
 * @type {import('esbuild').Plugin}
 */
const wasmBinaryPlugin = {
  name: 'wasm-binary',
  setup(build) {
    build.onResolve({ filter: /\.wasm\?binary$/ }, (args) => {
      const specifier = args.path.replace(/\?binary$/, '');
      const localRequire = createRequire(
        resolve(args.resolveDir || repoRoot, '_dummy_.js'),
      );
      return {
        path: localRequire.resolve(specifier),
        namespace: 'wasm-binary',
      };
    });

    build.onLoad({ filter: /.*/, namespace: 'wasm-binary' }, (args) => ({
      contents: readFileSync(args.path),
      loader: 'binary',
    }));
  },
};

/**
 * @type {import('esbuild').Plugin}
 */
const cssInjectPlugin = {
  name: 'css-inject',
  setup(build) {
    // Handle CSS files
    build.onLoad({ filter: /\.css$/ }, async (args) => {
      const fs = await import('fs');
      const postcss = (await import('postcss')).default;
      const tailwindcss = (await import('tailwindcss')).default;
      const autoprefixer = (await import('autoprefixer')).default;

      let css = await fs.promises.readFile(args.path, 'utf8');

      // For styles.css, we need to resolve @import statements
      if (args.path.endsWith('styles.css')) {
        // Read all imported CSS files and inline them
        const importRegex = /@import\s+'([^']+)';/g;
        let match;
        const basePath = args.path.substring(0, args.path.lastIndexOf('/'));
        while ((match = importRegex.exec(css)) !== null) {
          const importPath = match[1];
          // Resolve relative paths correctly
          let fullPath;
          if (importPath.startsWith('./')) {
            fullPath = basePath + importPath.substring(1);
          } else if (importPath.startsWith('../')) {
            fullPath = basePath + '/' + importPath;
          } else {
            fullPath = basePath + '/' + importPath;
          }

          try {
            const importedCss = await fs.promises.readFile(fullPath, 'utf8');
            css = css.replace(match[0], importedCss);
          } catch (err) {
            console.warn(`Could not import ${fullPath}: ${err.message}`);
          }
        }
      }

      // Process with PostCSS (Tailwind + Autoprefixer)
      const result = await postcss([tailwindcss, autoprefixer]).process(css, {
        from: args.path,
        to: args.path,
      });

      return {
        contents: `
          const style = document.createElement('style');
          style.textContent = ${JSON.stringify(result.css)};
          document.head.appendChild(style);
        `,
        loader: 'js',
      };
    });
  },
};

async function main() {
  // Build extension
  const extensionCtx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/extension.cjs',
    external: ['vscode'],
    logLevel: 'silent',
    banner: {
      js: `const import_meta = { url: require('url').pathToFileURL(__filename).href };`,
    },
    define: {
      'import.meta.url': 'import_meta.url',
    },
    plugins: [
      wasmBinaryPlugin,
      wasmLoader({ mode: 'embedded' }),
      /* add to the end of plugins array */
      esbuildProblemMatcherPlugin,
    ],
    loader: { '.node': 'file' },
  });

  // Build webview
  const webviewCtx = await esbuild.context({
    entryPoints: ['src/webview/index.tsx'],
    bundle: true,
    format: 'iife',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'browser',
    outfile: 'dist/webview.js',
    // @qwen-code/qwen-code-core is a peer dependency of @qwen-code/webui.
    // Since @qwen-code/webui marks it as external in its own Vite build, the
    // browser bundle must also mark it external to avoid bundling Node.js-only
    // modules (undici, @grpc/grpc-js, fs, stream, etc.) into the webview.
    // The wildcard ensures deep sub-path imports (e.g.
    // '@qwen-code/qwen-code-core/src/core/tokenLimits.js') are also excluded;
    // without it esbuild only matches the bare package name and attempts to
    // bundle the sub-path, which triggers "Dynamic require is not supported"
    // at runtime in the browser.
    external: ['@qwen-code/qwen-code-core', '@qwen-code/qwen-code-core/*'],
    logLevel: 'silent',
    plugins: [reactDedupPlugin, cssInjectPlugin, esbuildProblemMatcherPlugin],
    jsx: 'automatic', // Use new JSX transform (React 17+)
    loader: {
      '.png': 'dataurl',
    },
    define: {
      'process.env.NODE_ENV': production ? '"production"' : '"development"',
    },
  });

  if (watch) {
    await Promise.all([extensionCtx.watch(), webviewCtx.watch()]);
  } else {
    await Promise.all([extensionCtx.rebuild(), webviewCtx.rebuild()]);
    await Promise.all([extensionCtx.dispose(), webviewCtx.dispose()]);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
