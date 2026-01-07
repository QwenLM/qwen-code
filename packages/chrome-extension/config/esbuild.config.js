/**
 * esbuild configuration for Chrome Extension Side Panel React App
 * Bundles React components with Tailwind CSS
 */

import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';

const isWatch = process.argv.includes('--watch');
const isProduction = process.argv.includes('--production');

/**
 * Custom CSS plugin that processes CSS through PostCSS/Tailwind
 * and injects it as inline JavaScript
 */
const cssInjectPlugin = {
  name: 'css-inject',
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, async (args) => {
      const cssPath = args.path;
      let cssContent = await fs.promises.readFile(cssPath, 'utf8');

      // Handle @import statements
      const importRegex = /@import\s+['"]([^'"]+)['"]\s*;/g;
      let match;
      while ((match = importRegex.exec(cssContent)) !== null) {
        const importPath = path.resolve(path.dirname(cssPath), match[1]);
        if (fs.existsSync(importPath)) {
          const importedContent = await fs.promises.readFile(importPath, 'utf8');
          cssContent = cssContent.replace(match[0], importedContent);
        }
      }

      // Process with PostCSS and Tailwind
      const result = await postcss([
        tailwindcss({
          config: path.resolve(process.cwd(), 'config/tailwind.config.js'),
        }),
        autoprefixer,
      ]).process(cssContent, {
        from: cssPath,
      });

      // Convert to JavaScript that injects CSS
      const minifiedCss = isProduction
        ? result.css.replace(/\s+/g, ' ').trim()
        : result.css;

      const jsContent = `
        (function() {
          const style = document.createElement('style');
          style.textContent = ${JSON.stringify(minifiedCss)};
          document.head.appendChild(style);
        })();
      `;

      return {
        contents: jsContent,
        loader: 'js',
      };
    });
  },
};

async function build() {
  const ctx = await esbuild.context({
    entryPoints: ['src/sidepanel/index.tsx'],
    bundle: true,
    format: 'iife',
    minify: isProduction,
    sourcemap: !isProduction,
    platform: 'browser',
    outfile: 'extension/sidepanel/dist/sidepanel-app.js',
    jsx: 'automatic',
    define: {
      'process.env.NODE_ENV': isProduction ? '"production"' : '"development"',
    },
    plugins: [cssInjectPlugin],
    loader: {
      '.tsx': 'tsx',
      '.ts': 'ts',
    },
  });

  if (isWatch) {
    console.log('Watching for changes...');
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
    console.log('Build complete!');
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
