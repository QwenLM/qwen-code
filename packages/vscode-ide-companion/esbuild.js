/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: 'esbuild-problem-matcher',

  setup(build) {
    build.onStart(() => {
      console.log('[watch] build started');
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        console.error(
          `    ${location.file}:${location.line}:${location.column}:`,
        );
      });
      console.log('[watch] build finished');
    });
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

      // For ClaudeCodeStyles.css, we need to resolve @import statements
      if (args.path.endsWith('ClaudeCodeStyles.css')) {
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
    logLevel: 'silent',
    plugins: [cssInjectPlugin, esbuildProblemMatcherPlugin],
    jsx: 'automatic', // Use new JSX transform (React 17+)
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
