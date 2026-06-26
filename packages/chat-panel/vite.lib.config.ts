import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Inline the bundled CSS Modules into the JS entry and self-inject a <style> tag
// at runtime, so consumers get one importable artifact with no separate CSS import.
// Mirrors packages/web-shell/vite.lib.config.ts (CSP-guarded, dedup by data attr).
function injectCssModules(): Plugin {
  return {
    name: 'inject-chat-panel-css-modules',
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
        if (!item.isEntry) continue;
        item.code =
          `const __qwenChatPanelCss=${escapedCss};\n` +
          `if(typeof document!=="undefined"&&!document.querySelector('style[data-qwen-chat-panel="component"]')){` +
          `const s=document.createElement("style");s.dataset.qwenChatPanel="component";s.textContent=__qwenChatPanelCss;try{document.head.appendChild(s);}catch(e){console.warn("[qwen-chat-panel] CSS injection blocked by CSP:",e);}}\n` +
          item.code;
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), injectCssModules()],
  esbuild: { jsxDev: false },
  build: {
    emptyOutDir: false,
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      // Hosts own React + the daemon SDK; never bundle them.
      external: [
        'react',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        'react-dom',
        'react-dom/client',
        '@qwen-code/sdk',
        '@qwen-code/webui',
        '@qwen-code/webui/daemon-react-sdk',
      ],
    },
  },
});
