import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json' with { type: 'json' };

function injectCssModules(): Plugin {
  return {
    name: 'inject-web-shell-css-modules',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const css = Object.entries(bundle)
        .filter(
          ([, item]) => item.type === 'asset' && item.fileName.endsWith('.css'),
        )
        .map(([fileName, item]) => {
          delete bundle[fileName];
          return typeof item.source === 'string'
            ? item.source
            : Buffer.from(item.source).toString('utf8');
        })
        .join('\n');
      if (!css) return;
      const escapedCss = JSON.stringify(css);
      for (const item of Object.values(bundle)) {
        if (item.type !== 'chunk') continue;
        if (
          !item.isEntry &&
          !item.facadeModuleId?.endsWith('/client/index.ts')
        ) {
          continue;
        }
        item.code =
          `const __qwenWebShellCss=${escapedCss};\n` +
          `if(typeof document!=="undefined"&&!document.querySelector('style[data-qwen-web-shell="component"]')){` +
          `const s=document.createElement("style");s.dataset.qwenWebShell="component";s.textContent=__qwenWebShellCss;try{document.head.appendChild(s);}catch(e){console.warn("[qwen-web-shell] CSS injection blocked by CSP:",e);}}\n` +
          item.code;
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), injectCssModules()],
  build: {
    emptyOutDir: false,
    lib: {
      entry: 'client/index.ts',
      formats: ['es'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      external: [
        'react',
        'react/jsx-runtime',
        'react-dom',
        'react-dom/client',
        '@qwen-code/sdk',
        /^@qwen-code\/sdk\//,
        'react-markdown',
        'remark-gfm',
        'remark-math',
        'rehype-katex',
        'shiki',
        'mermaid',
        'katex',
        /^katex\//,
        'codemirror',
        /^@codemirror\//,
      ],
    },
  },
  define: {
    __WEB_SHELL_VERSION__: JSON.stringify(pkg.version),
  },
});
